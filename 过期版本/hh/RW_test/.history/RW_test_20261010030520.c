#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"

// 定义结构体存储 8 个配置参数
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

// LED 闪烁状态机变量 (写入成功时：每秒4下，持续3秒)
bool is_blinking = false;
absolute_time_t last_toggle_time;
bool led_state = false;
int toggle_count = 0;
const int max_toggles = 24;

void send_params_json() {
    printf("{\"maxCadence\":%.1f,\"maxThrottle\":%.1f,\"maxPower\":%.1f,\"maxSpeed\":%.1f,\"maxPhaseCurrent\":%.1f,\"maxBatteryCurrent\":%.1f,\"pwmFrequency\":%.1f,\"currentGain\":%.1f}\n",
        current_params.maxCadence,
        current_params.maxThrottle,
        current_params.maxPower,
        current_params.maxSpeed,
        current_params.maxPhaseCurrent,
        current_params.maxBatteryCurrent,
        current_params.pwmFrequency,
        current_params.currentGain
    );
}

void parse_and_update_params(const char* json_str) {
    const char *p;
    if ((p = strstr(json_str, "\"maxCadence\":"))) current_params.maxCadence = atof(p + 13);
    if ((p = strstr(json_str, "\"maxThrottle\":"))) current_params.maxThrottle = atof(p + 14);
    if ((p = strstr(json_str, "\"maxPower\":"))) current_params.maxPower = atof(p + 11);
    if ((p = strstr(json_str, "\"maxSpeed\":"))) current_params.maxSpeed = atof(p + 11);
    if ((p = strstr(json_str, "\"maxPhaseCurrent\":"))) current_params.maxPhaseCurrent = atof(p + 18);
    if ((p = strstr(json_str, "\"maxBatteryCurrent\":"))) current_params.maxBatteryCurrent = atof(p + 20);
    if ((p = strstr(json_str, "\"pwmFrequency\":"))) current_params.pwmFrequency = atof(p + 15);
    if ((p = strstr(json_str, "\"currentGain\":"))) current_params.currentGain = atof(p + 14);

    is_blinking = true;
    last_toggle_time = get_absolute_time();
    toggle_count = 0;
    led_state = true;

    printf("LOG: Parameters updated successfully on Pico 2!\n");
}

// 发送标准二进制遥测数据包
void send_telemetry_binary(uint16_t cadence, uint8_t throttle, uint16_t power, uint16_t speed_x10) {
    uint8_t payload[7];
    payload[0] = cadence & 0xFF;
    payload[1] = (cadence >> 8) & 0xFF;
    payload[2] = throttle;
    payload[3] = power & 0xFF;
    payload[4] = (power >> 8) & 0xFF;
    payload[5] = speed_x10 & 0xFF;
    payload[6] = (speed_x10 >> 8) & 0xFF;

    // 计算异或校验和
    uint8_t checksum = 0;
    for (int i = 0; i < 7; i++) {
        checksum ^= payload[i];
    }

    // 写入原生二进制字节流
    putchar_raw(0xAA); // 帧头
    putchar_raw(0x01); // 类型
    putchar_raw(0x07); // 长度
    for (int i = 0; i < 7; i++) {
        putchar_raw(payload[i]);
    }
    putchar_raw(checksum); // 校验和
    putchar_raw(0x55); // 帧尾
}

int main() {
    stdio_init_all();

    const uint LED_PIN = 25; 
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    gpio_put(LED_PIN, 0);

    absolute_time_t last_telemetry_time = get_absolute_time();
    int sim_counter = 0;

    char rx_buf[256];
    int rx_idx = 0;

    while (true) {
        // 1. 非阻塞轮询读取串口输入（兼容文本指令）
        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT) {
            if (c == '\n' || c == '\r') {
                if (rx_idx > 0) {
                    rx_buf[rx_idx] = '\0';
                    if (strcmp(rx_buf, "GET_PARAMS") == 0) {
                        send_params_json();
                    } else if (strncmp(rx_buf, "SET_PARAMS:", 11) == 0) {
                        parse_and_update_params(rx_buf + 11);
                    }
                    rx_idx = 0;
                }
            } else {
                if (rx_idx < sizeof(rx_buf) - 1) {
                    rx_buf[rx_idx++] = (char)c;
                }
            }
        }

        // 2. 非阻塞 LED 闪烁状态机（每秒4下，持续3秒）
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

        // 3. 每隔 250ms 以二进制高效上报遥测数据
        if (absolute_time_diff_us(last_telemetry_time, get_absolute_time()) > 250000) {
            last_telemetry_time = get_absolute_time();
            sim_counter++;

            uint16_t cadence = 60 + (sim_counter % 30);
            uint8_t throttle = 40 + (sim_counter % 50);
            uint16_t power = cadence * throttle / 2;
            uint16_t speed_x10 = (uint16_t)((float)cadence * 2.2f); 

            send_telemetry_binary(cadence, throttle, power, speed_x10);
        }
    }

    return 0;
}