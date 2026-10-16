#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <math.h>

#include "pico/stdlib.h"
#include "pico/stdio.h"

/**
 * @file main.c
 * @brief Raspberry Pi Pico 2 的 USB CDC 仪表板测试固件。
 *
 * 本固件通过 Pico 2 板载 USB 接口枚举为 USB CDC 虚拟串口，不使用 GP0/GP1 UART。
 * 程序每 100 ms 发送一组模拟遥测数据，并响应网页发来的参数读取/写入帧。
 * 参数仅保存于 RAM，掉电或复位后恢复初值；该程序只用于网页联调，不控制真实电机。
 *
 * 通信帧格式：F1 | 类型 | 载荷长度 | ASCII 载荷 | 校验和 | F6。
 * 校验和为所有载荷字节之和的低 8 位。请勿通过同一 USB CDC 端口输出 printf 调试文本，
 * 否则普通文本字节可能混入二进制数据流，导致网页端帧解析失败。
 */
/* 帧边界标记、单帧载荷上限以及遥测发送周期。 */
#define FRAME_START   0xF1
#define FRAME_END     0xF6
#define MAX_PAYLOAD   64
#define TELEMETRY_MS  100

#define TYPE_READ_PARAMS 0x60

/* 一帧解析后的内容：类型、载荷长度、ASCII 数据以及校验和。 */
typedef struct {
    uint8_t type;
    uint8_t length;
    uint8_t payload[MAX_PAYLOAD];
    uint8_t checksum;
} frame_t;

/* 接收状态机依序寻找起始标记、解析头部和载荷，最后检查校验和及结束标记。 */
typedef enum {
    RX_WAIT_START,
    RX_TYPE,
    RX_LENGTH,
    RX_PAYLOAD,
    RX_CHECKSUM,
    RX_END
} rx_state_t;

/* 跨越多次 USB 读取调用保存解析状态，允许一帧被拆成多次到达。 */
typedef struct {
    rx_state_t state;
    frame_t frame;
    uint8_t index;
} parser_t;

/* 参数类型编号和默认值必须与 dashboard_refactor/app.js 的 elements.params 保持一致。
 * 0x51 最大转速、0x52 最大油门、0x53 最大功率、0x54 最大速度，
 * 0x55 最大相电流、0x56 最大电池电流、0x57 PWM 频率、0x58 电流增益。
 */
static const uint8_t parameter_types[8] = {
    0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58
};
static float parameters[8] = {
    120.0f, 100.0f, 500.0f, 45.0f,
    80.0f, 30.0f, 20000.0f, 1.0f
};

/** 将接收解析器清零，回到等待帧起始标记的状态。 */
static void parser_reset(parser_t *parser) {
    parser->state = RX_WAIT_START;
    parser->frame.type = 0;
    parser->frame.length = 0;
    parser->frame.checksum = 0;
    parser->index = 0;
}

/** 通过 Pico SDK 的 USB CDC stdio 输出指定长度的原始二进制数据。 */
static void usb_cdc_send_bytes(const uint8_t *data, size_t length) {
    /* 必须显式指定字节长度，因为帧中含有二进制标记字节，不是以 '\0' 结尾的普通字符串。 */
    stdio_put_string((const char *)data, (int)length, false, false);
}

/** 封装并发送一帧；payload 使用 ASCII 文本，校验和只覆盖载荷部分。 */
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

/** 按网页约定格式发送单个参数的当前值。 */
static void send_parameter(size_t index) {
    char text[24];
    if (index >= 8) return;
    /* 参数以 ASCII 数字文本发送，网页端再将文本转换为数值。 */
    if (index == 3 || index == 7) {
        snprintf(text, sizeof(text), "%.1f", (double)parameters[index]);
    } else {
        snprintf(text, sizeof(text), "%.0f", (double)parameters[index]);
    }
    send_frame(parameter_types[index], text);
}

/** 收到读取请求后依次发送全部八个参数帧。 */
static void send_all_parameters(void) {
    for (size_t i = 0; i < 8; ++i) {
        send_parameter(i);
        sleep_ms(12); /* 帧与帧之间留出短暂间隔，兼容处理速度较慢的接收端。 */
    }
}

/** 将帧类型映射到参数数组索引，不属于参数的类型返回 -1。 */
static int find_parameter(uint8_t type) {
    for (int i = 0; i < 8; ++i) {
        if (parameter_types[i] == type) return i;
    }
    return -1;
}

/** 分发完整帧：处理参数读取命令，或校验并更新指定参数。 */
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
            /* 测试固件仅更新 RAM，不写入 Flash；复位后会恢复默认值。 */
            parameters[index] = value;
            send_parameter((size_t)index); /* 回传新值，便于网页同步更新输入框。 */
        }
    }
}

/** 向接收状态机输入一个字节，成功拼出帧后调用 handle_frame()。 */
static void parser_consume(parser_t *parser, uint8_t byte) {
    switch (parser->state) {
        /* 等待起始标记，屏蔽帧边界以外的数据。 */
        case RX_WAIT_START:
            if (byte == FRAME_START) parser->state = RX_TYPE;
            break;
        /* 按固定帧头顺序接收类型与载荷长度。 */
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
        /* 按 LENGTH 精确读取载荷，防止一帧拆成多个 USB 数据块时丢失状态。 */
        case RX_PAYLOAD:
            parser->frame.payload[parser->index++] = byte;
            if (parser->index >= parser->frame.length) parser->state = RX_CHECKSUM;
            break;
        /* 保存校验和字节，下一字节必须是结束标记。 */
        case RX_CHECKSUM:
            parser->frame.checksum = byte;
            parser->state = RX_END;
            break;
        /* 只有帧尾正确且载荷校验和匹配时才分发完整帧。 */
        case RX_END: {
            if (byte == FRAME_END) {
                uint8_t sum = 0;
                for (uint8_t i = 0; i < parser->frame.length; ++i) {
                    sum = (uint8_t)(sum + parser->frame.payload[i]);
                }
                if (sum == parser->frame.checksum) handle_frame(&parser->frame);
            }
            /* 无论帧是否损坏，都重置状态机以便继续寻找下一帧。 */
            parser_reset(parser);
            if (byte == FRAME_START) parser->state = RX_TYPE;
            break;
        }
        default:
            parser_reset(parser);
            break;
    }
}

/** 按时间生成平滑变化的模拟遥测值，并依协议逐项发送。 */
static void send_telemetry(uint32_t elapsed_ms) {
    /* 生成可重复的平滑模拟值，仅用于网页测试，不代表真实传感器读数。 */
    const float phase = (float)(elapsed_ms % 20000u) / 20000.0f * 6.2831853f;
    const float cadence = 82.0f + 18.0f * sinf(phase);
    const float resistance = 35.0f + 25.0f * (0.5f + 0.5f * sinf(phase * 0.63f));
    const float speed = 22.0f + 8.0f * sinf(phase * 0.72f);
    const float power = 120.0f + 80.0f * (0.5f + 0.5f * sinf(phase * 1.17f));
    char text[24];

    snprintf(text, sizeof(text), "%.1f", (double)cadence);
    send_frame(0x41, text); /* 转速，单位 RPM。 */
    snprintf(text, sizeof(text), "%.1f", (double)resistance);
    send_frame(0x44, text); /* 油门/阻力百分比。 */
    snprintf(text, sizeof(text), "%.1f", (double)speed);
    send_frame(0x42, text); /* 速度，单位 km/h。 */
    snprintf(text, sizeof(text), "%.1f", (double)power);
    send_frame(0x4A, text); /* 功率，单位 W。 */
}

/** 程序入口：初始化 USB CDC，然后持续解析主机命令并周期性发送遥测。 */
int main(void) {
    /* USB CDC 是正式数据通道。不要向该接口输出 printf 调试文本，
       否则多余字节会混入二进制帧流并破坏网页协议解析。 */
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
