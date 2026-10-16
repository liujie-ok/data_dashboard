#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "hardware/uart.h"

// 内部参数存储变量
int param_max_cadence = 120;
int param_max_resistance = 100;
int param_max_power = 500;
int param_max_speed = 250;      // 实际值 25.0 km/h (放大10倍传输)
int param_max_phase_current = 50;
int param_max_battery_current = 30;
int param_pwm_frequency = 16000;
int param_current_gain = 10;

// 发送打包好的二进制帧到 USB 串口
void send_frame(uint8_t type, const char *str_val) {
    uint8_t len = strlen(str_val);
    uint8_t checksum = 0;
    for (int i = 0; i < len; i++) {
        checksum += str_val[i];
    }
    checksum &= 0xFF;

    putchar_raw(0xF1);          // 帧头
    putchar_raw(type);          // 类型
    putchar_raw(len);           // 长度
    for (int i = 0; i < len; i++) {
        putchar_raw(str_val[i]);// 数据 (ASCII)
    }
    putchar_raw(checksum);      // 校验和
    putchar_raw(0xF6);          // 帧尾
    uart_default_tx_wait_blocking();
}

// 发送当前所有参数回显给网页
void send_all_parameters() {
    char buf[32];

    sprintf(buf, "%d", param_max_cadence);
    send_frame(0x51, buf);
    sprintf(buf, "%d", param_max_resistance);
    send_frame(0x52, buf);
    sprintf(buf, "%d", param_max_power);
    send_frame(0x53, buf);
    sprintf(buf, "%.1f", (float)param_max_speed / 10.0f);
    send_frame(0x54, buf);
    sprintf(buf, "%d", param_max_phase_current);
    send_frame(0x55, buf);
    sprintf(buf, "%d", param_max_battery_current);
    send_frame(0x56, buf);
    sprintf(buf, "%d", param_pwm_frequency);
    send_frame(0x57, buf);
    sprintf(buf, "%d", param_current_gain);
    send_frame(0x58, buf);
}

// 解析来自网页端的数据帧（修复了写入参数未实现的Bug）
void parse_rx_frame(const uint8_t *data, uint8_t len, uint8_t type) {
    char val_str[32] = {0};
    if (len >= sizeof(val_str)) len = sizeof(val_str) - 1;
    memcpy(val_str, data, len);
    
    int int_val = atoi(val_str);

    switch (type) {
        case 0x60: // 网页端请求读取参数
            send_all_parameters();
            break;
        case 0x51: 
            param_max_cadence = int_val; 
            break;
        case 0x52: 
            param_max_resistance = int_val; 
            break;
        case 0x53: 
            param_max_power = int_val; 
            break;
        case 0x54: // 速度带小数，按放大10倍保存
            param_max_speed = (int)(atof(val_str) * 10.0f); 
            break;
        case 0x55: 
            param_max_phase_current = int_val; 
            break;
        case 0x56: 
            param_max_battery_current = int_val; 
            break;
        case 0x57: 
            param_pwm_frequency = int_val; 
            break;
        case 0x58: 
            param_current_gain = int_val; 
            break;
        default:
            break;
    }
}

// 接收状态机
typedef enum {
    S_WAIT_HEADER = 0,
    S_WAIT_TYPE,
    S_WAIT_LEN,
    S_WAIT_DATA,
    S_WAIT_CHECKSUM,
    S_WAIT_TAIL
} rx_state_t;

int main() {
    stdio_init_all();

    rx_state_t state = S_WAIT_HEADER;
    uint8_t rx_type = 0;
    uint8_t rx_len = 0;
    uint8_t rx_data[64];
    uint8_t rx_data_idx = 0;
    uint8_t rx_sum = 0;

    absolute_time_t last_telemetry_time = get_absolute_time();

    while (true) {
        int ch = getchar_timeout_us(0);
        if (ch != PICO_ERROR_TIMEOUT) {
            uint8_t byte = (uint8_t)ch;

            switch (state) {
                case S_WAIT_HEADER:
                    if (byte == 0xF1) state = S_WAIT_TYPE;
                    break;
                case S_WAIT_TYPE:
                    rx_type = byte;
                    state = S_WAIT_LEN;
                    break;
                case S_WAIT_LEN:
                    rx_len = byte;
                    rx_data_idx = 0;
                    rx_sum = 0;
                    if (rx_len == 0) {
                        state = S_WAIT_CHECKSUM;
                    } else if (rx_len < sizeof(rx_data)) {
                        state = S_WAIT_DATA;
                    } else {
                        state = S_WAIT_HEADER;
                    }
                    break;
                case S_WAIT_DATA:
                    rx_data[rx_data_idx++] = byte;
                    rx_sum += byte;
                    if (rx_data_idx >= rx_len) {
                        state = S_WAIT_CHECKSUM;
                    }
                    break;
                case S_WAIT_CHECKSUM:
                    if (byte == (rx_sum & 0xFF)) {
                        state = S_WAIT_TAIL;
                    } else {
                        state = S_WAIT_HEADER;
                    }
                    break;
                case S_WAIT_TAIL:
                    if (byte == 0xF6) {
                        parse_rx_frame(rx_data, rx_len, rx_type);
                    }
                    state = S_WAIT_HEADER;
                    break;
            }
        }

        // 定时上报遥测数据 (每 250ms)
        if (absolute_time_diff_us(last_telemetry_time, get_absolute_time()) >= 250000) {
            last_telemetry_time = get_absolute_time();

            static int step = 0;
            step++;
            char buf[32];

            // 0x41: 转速
            sprintf(buf, "%d", 80 + (step % 30));
            send_frame(0x41, buf);

            // 0x44: 油门
            sprintf(buf, "%d", 40 + (step % 30));
            send_frame(0x44, buf);

            // 0x42: 车速 (放大10倍发送，如 185 代表 18.5 km/h，契合网页端 n / 10)
            sprintf(buf, "%d", 150 + (step % 70));
            send_frame(0x42, buf);

            // 0x4A: 功率 (放大10倍发送，如 2000 代表 200.0 W)
            sprintf(buf, "%d", 1500 + ((step % 100) * 10));
            send_frame(0x4a, buf);
        }
    }
    return 0;
}