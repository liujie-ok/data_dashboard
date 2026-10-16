#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"

typedef struct {
    float maxCadence;
    float maxThrottle;
    float maxPower;
    float maxSpeed;
    float maxPhaseCurrent;
    float maxBatteryCurrent;
    float pwmFrequency;
    float currentGain;
} DeviceParams;

DeviceParams current_params = {
    .maxCadence = 120.0f,
    .maxThrottle = 100.0f,
    .maxPower = 1500.0f,
    .maxSpeed = 60.0f,
    .maxPhaseCurrent = 50.0f,
    .maxBatteryCurrent = 30.0f,
    .pwmFrequency = 20.0f,
    .currentGain = 1.5f
};

bool is_blinking = false;
absolute_time_t last_toggle_time;
bool led_state = false;
int toggle_count = 0;
const int max_toggles = 24; // 3秒 * 4次/秒 * 2

uint8_t calculate_checksum(uint8_t type, uint8_t len, const uint8_t *payload) {
    uint8_t crc = type ^ len;
    for (int i = 0; i < len; i++) {
        crc ^= payload[i];
    }
    return crc;
}

void send_binary_packet(uint8_t type, const uint8_t *payload, uint8_t len) {
    uint8_t checksum = calculate_checksum(type, len, payload);
    putchar_raw(0xAA);
    putchar_raw(type);
    putchar_raw(len);
    for (int i = 0; i < len; i++) {
        putchar_raw(payload[i]);
    }
    putchar_raw(checksum);
    putchar_raw(0x55);
}

void send_params_binary() {
    uint16_t raw_params[8] = {
        (uint16_t)(current_params.maxCadence * 10),
        (uint16_t)(current_params.maxThrottle * 10),
        (uint16_t)(current_params.maxPower * 10),
        (uint16_t)(current_params.maxSpeed * 10),
        (uint16_t)(current_params.maxPhaseCurrent * 10),
        (uint16_t)(current_params.maxBatteryCurrent * 10),
        (uint16_t)(current_params.pwmFrequency * 10),
        (uint16_t)(current_params.currentGain * 10)
    };
    send_binary_packet(0x03, (uint8_t *)raw_params, sizeof(raw_params));
}

void update_params_from_binary(const uint8_t *payload) {
    const uint16_t *raw = (const uint16_t *)payload;
    current_params.maxCadence         = raw[0] / 10.0f;
    current_params.maxThrottle        = raw[1] / 10.0f;
    current_params.maxPower           = raw[2] / 10.0f;
    current_params.maxSpeed           = raw[3] / 10.0f;
    current_params.maxPhaseCurrent    = raw[4] / 10.0f;
    current_params.maxBatteryCurrent  = raw[5] / 10.0f;
    current_params.pwmFrequency       = raw[6] / 10.0f;
    current_params.currentGain        = raw[7] / 10.0f;

    // 触发 LED 写入成功闪烁：每秒4下，持续3秒
    is_blinking = true;
    last_toggle_time = get_absolute_time();
    toggle_count = 0;
    led_state = true;

    uint8_t dummy = 0;
    send_binary_packet(0x04, &dummy, 0);
}

int main() {
    stdio_init_all();

    const uint LED_PIN = 25; 
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    gpio_put(LED_PIN, 0);

    absolute_time_t last_telemetry_time = get_absolute_time();
    absolute_time_t rx_timeout_timer = get_absolute_time();
    int sim_counter = 0;

    typedef enum { STATE_START, STATE_TYPE, STATE_LEN, STATE_PAYLOAD, STATE_CHKSUM, STATE_END } RxState;
    RxState rx_state = STATE_START;
    uint8_t rx_type = 0, rx_len = 0, rx_chksum = 0;
    uint8_t rx_payload[32];
    int rx_payload_idx = 0;

    while (true) {
        // 1. 带超时保护的非阻塞二进制串口解析状态机
        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT) {
            rx_timeout_timer = get_absolute_time(); // 收到字节，刷新超时计时
            uint8_t byte = (uint8_t)c;
            switch (rx_state) {
                case STATE_START:
                    if (byte == 0xAA) rx_state = STATE_TYPE;
                    break;
                case STATE_TYPE:
                    rx_type = byte;
                    rx_state = STATE_LEN;
                    break;
                case STATE_LEN:
                    rx_len = byte;
                    rx_payload_idx = 0;
                    if (rx_len > 0 && rx_len <= sizeof(rx_payload)) {
                        rx_state = STATE_PAYLOAD;
                    } else if (rx_len == 0) {
                        rx_state = STATE_CHKSUM;
                    } else {
                        rx_state = STATE_START;
                    }
                    break;
                case STATE_PAYLOAD:
                    rx_payload[rx_payload_idx++] = byte;
                    if (rx_payload_idx >= rx_len) {
                        rx_state = STATE_CHKSUM;
                    }
                    break;
                case STATE_CHKSUM:
                    rx_chksum = byte;
                    rx_state = STATE_END;
                    break;
                case STATE_END:
                    if (byte == 0x55) {
                        if (rx_chksum == calculate_checksum(rx_type, rx_len, rx_payload)) {
                            if (rx_type == 0x02) { 
                                send_params_binary();
                            } else if (rx_type == 0x03) { 
                                update_params_from_binary(rx_payload);
                            }
                        }
                    }
                    rx_state = STATE_START;
                    break;
            }
        } else {
            // 【防卡死保护】如果超过 100ms 没有收完一整包，自动重置状态机，防止死锁
            if (rx_state != STATE_START) {
                if (absolute_time_diff_us(rx_timeout_timer, get_absolute_time()) > 100000) {
                    rx_state = STATE_START;
                }
            }
        }

        // 2. LED 闪烁状态机（每秒4下，持续3秒）
        if (is_blinking) {
            if (absolute_time_diff_us(last_toggle_time, get_absolute_time()) >= 125000) {
                last_toggle_time = get_absolute_time();
                led_state = !led_state;
                gpio_put(LED_PIN, led_state);
                toggle_count++;
                if (toggle_count >= max_toggles) {
                    is_blinking = false;
                    gpio_put(LED_PIN, 0);
                }
            }
        }

        // 3. 每隔 250ms 发送一次二进制遥测数据
        if (absolute_time_diff_us(last_telemetry_time, get_absolute_time()) > 250000) {
            last_telemetry_time = get_absolute_time();
            sim_counter++;

            uint16_t cadence = 60 + (sim_counter % 30);
            uint8_t throttle = 40 + (sim_counter % 50);
            uint16_t power = cadence * throttle / 2;
            uint16_t speed = (uint16_t)((cadence * 0.22f) * 10);

            uint8_t payload[7];
            payload[0] = cadence & 0xFF;
            payload[1] = (cadence >> 8) & 0xFF;
            payload[2] = throttle;
            payload[3] = power & 0xFF;
            payload[4] = (power >> 8) & 0xFF;
            payload[5] = speed & 0xFF;
            payload[6] = (speed >> 8) & 0xFF;

            send_binary_packet(0x01, payload, 7);
        }
    }
    return 0;
}