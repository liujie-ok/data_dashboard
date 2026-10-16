#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <math.h>

#include "pico/stdlib.h"
#include "pico/stdio.h"

/*
 * Raspberry Pi Pico 2 dashboard test firmware
 * Uses the Pico's native USB CDC serial interface (no external UART adapter).
 * Binary protocol: F1 | type | payload_length | ASCII payload | checksum | F6
 * checksum = sum(payload bytes) modulo 256
 */
#define FRAME_START   0xF1
#define FRAME_END     0xF6
#define MAX_PAYLOAD   64
#define TELEMETRY_MS  100

#define TYPE_READ_PARAMS 0x60

typedef struct {
    uint8_t type;
    uint8_t length;
    uint8_t payload[MAX_PAYLOAD];
    uint8_t checksum;
} frame_t;

typedef enum {
    RX_WAIT_START,
    RX_TYPE,
    RX_LENGTH,
    RX_PAYLOAD,
    RX_CHECKSUM,
    RX_END
} rx_state_t;

typedef struct {
    rx_state_t state;
    frame_t frame;
    uint8_t index;
} parser_t;

/* Same parameter IDs as the dashboard's app.js. */
static const uint8_t parameter_types[8] = {
    0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58
};
static float parameters[8] = {
    120.0f, 100.0f, 500.0f, 45.0f,
    80.0f, 30.0f, 20000.0f, 1.0f
};

static void parser_reset(parser_t *parser) {
    parser->state = RX_WAIT_START;
    parser->frame.type = 0;
    parser->frame.length = 0;
    parser->frame.checksum = 0;
    parser->index = 0;
}

static void usb_cdc_send_bytes(const uint8_t *data, size_t length) {
    /* Explicit length is important: protocol frames contain binary bytes. */
    stdio_put_string((const char *)data, (int)length, false, false);
}

static void send_frame(uint8_t type, const char *payload) {
    uint8_t bytes[MAX_PAYLOAD + 5];
    size_t length = payload ? strlen(payload) : 0;
    if (length > MAX_PAYLOAD) return;

    uint8_t checksum = 0;
    bytes[0] = FRAME_START;
    bytes[1] = type;
    bytes[2] = (uint8_t)length;
    for (size_t i = 0; i < length; ++i) {
        bytes[3 + i] = (uint8_t)payload[i];
        checksum = (uint8_t)(checksum + bytes[3 + i]);
    }
    bytes[3 + length] = checksum;
    bytes[4 + length] = FRAME_END;
    usb_cdc_send_bytes(bytes, length + 5);
}

static void send_parameter(size_t index) {
    char text[24];
    if (index >= 8) return;
    /* Send numeric ASCII text; the web page parses it with Number(). */
    if (index == 3 || index == 7) {
        snprintf(text, sizeof(text), "%.1f", (double)parameters[index]);
    } else {
        snprintf(text, sizeof(text), "%.0f", (double)parameters[index]);
    }
    send_frame(parameter_types[index], text);
}

static void send_all_parameters(void) {
    for (size_t i = 0; i < 8; ++i) {
        send_parameter(i);
        sleep_ms(12); /* keep frames easy for simple/older receivers */
    }
}

static int find_parameter(uint8_t type) {
    for (int i = 0; i < 8; ++i) {
        if (parameter_types[i] == type) return i;
    }
    return -1;
}

static void handle_frame(const frame_t *frame) {
    if (frame->type == TYPE_READ_PARAMS) {
        send_all_parameters();
        return;
    }

    const int index = find_parameter(frame->type);
    if (index >= 0 && frame->length > 0 && frame->length < MAX_PAYLOAD) {
        char text[MAX_PAYLOAD + 1];
        memcpy(text, frame->payload, frame->length);
        text[frame->length] = '\0';
        char *endptr = NULL;
        const float value = strtof(text, &endptr);
        if (endptr != text && *endptr == '\0' && isfinite(value)) {
            /* Test firmware only: store in RAM, no flash writes. */
            parameters[index] = value;
            send_parameter((size_t)index); /* echo updated value to update UI */
        }
    }
}

static void parser_consume(parser_t *parser, uint8_t byte) {
    switch (parser->state) {
        case RX_WAIT_START:
            if (byte == FRAME_START) parser->state = RX_TYPE;
            break;
        case RX_TYPE:
            parser->frame.type = byte;
            parser->state = RX_LENGTH;
            break;
        case RX_LENGTH:
            parser->frame.length = byte;
            parser->index = 0;
            if (byte > MAX_PAYLOAD) {
                parser_reset(parser);
            } else {
                parser->state = byte == 0 ? RX_CHECKSUM : RX_PAYLOAD;
            }
            break;
        case RX_PAYLOAD:
            parser->frame.payload[parser->index++] = byte;
            if (parser->index >= parser->frame.length) parser->state = RX_CHECKSUM;
            break;
        case RX_CHECKSUM:
            parser->frame.checksum = byte;
            parser->state = RX_END;
            break;
        case RX_END: {
            if (byte == FRAME_END) {
                uint8_t sum = 0;
                for (uint8_t i = 0; i < parser->frame.length; ++i) {
                    sum = (uint8_t)(sum + parser->frame.payload[i]);
                }
                if (sum == parser->frame.checksum) handle_frame(&parser->frame);
            }
            /* Recover even if the frame was corrupt. */
            parser_reset(parser);
            if (byte == FRAME_START) parser->state = RX_TYPE;
            break;
        }
        default:
            parser_reset(parser);
            break;
    }
}

static void send_telemetry(uint32_t elapsed_ms) {
    /* Deterministic moving test values, intentionally not real sensor data. */
    const float phase = (float)(elapsed_ms % 20000u) / 20000.0f * 6.2831853f;
    const float cadence = 82.0f + 18.0f * sinf(phase);
    const float resistance = 35.0f + 25.0f * (0.5f + 0.5f * sinf(phase * 0.63f));
    const float speed = 22.0f + 8.0f * sinf(phase * 0.72f);
    const float power = 120.0f + 80.0f * (0.5f + 0.5f * sinf(phase * 1.17f));
    char text[24];

    snprintf(text, sizeof(text), "%.1f", (double)cadence);
    send_frame(0x41, text); /* cadence / RPM */
    snprintf(text, sizeof(text), "%.1f", (double)resistance);
    send_frame(0x44, text); /* throttle / resistance percent */
    snprintf(text, sizeof(text), "%.1f", (double)speed);
    send_frame(0x42, text); /* speed km/h */
    snprintf(text, sizeof(text), "%.1f", (double)power);
    send_frame(0x4A, text); /* power W */
}

int main(void) {
    /* USB CDC is the data channel. Do not print debug text to this interface,
       because any extra bytes would corrupt the dashboard's binary frames. */
    stdio_init_all();

    parser_t parser;
    parser_reset(&parser);

    uint32_t last_telemetry_ms = to_ms_since_boot(get_absolute_time());
    while (true) {
        int input;
        while ((input = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
            parser_consume(&parser, (uint8_t)input);
        }

        const uint32_t now_ms = to_ms_since_boot(get_absolute_time());
        if ((uint32_t)(now_ms - last_telemetry_ms) >= TELEMETRY_MS) {
            send_telemetry(now_ms);
            last_telemetry_ms = now_ms;
        }
        tight_loop_contents();
    }
    return 0;
}
