#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "hardware/uart.h"

// 内部参数存储变量（显式赋初值）
volatile int param_max_cadence = 120;
volatile int param_max_resistance = 100;
volatile int param_max_power = 500;
volatile int param_max_speed = 250;      // 25.0 km/h
volatile int param_max_phase_current = 50;
volatile int param_max_battery_current = 30;
volatile int param_pwm_frequency = 16000;
volatile int param_current_gain = 10;

// 发送二进制帧到网页端
void send_frame(uint8_t type, const char *str_val) {
    uint8_t len = strlen(str_val);
    uint8_t checksum = 0;
    for (int i = 0; i < len; i++) checksum += str_val[i];
    checksum &= 0xFF;

    putchar_raw(0xF1);
    putchar_raw(type);
    putchar_raw(len);
    for (int i = 0; i < len; i++) putchar_raw(str_val[i]);
    putchar_raw(checksum);
    putchar_raw(0xF6);
    stdio_flush();
}

// 回显当前所有参数给网页端
void send_all_parameters() {
    char buf[32];
    sprintf(buf, "%d", param_max_cadence); send_frame(0x51, buf); sleep_ms(5);
    sprintf(buf, "%d", param_max_resistance); send_frame(0x52, buf); sleep_ms(5);
    sprintf(buf, "%d", param_max_power); send_frame(0x53, buf); sleep_ms(5);
    sprintf(buf, "%.1f", (float)param_max_speed / 10.0f); send_frame(0x54, buf); sleep_ms(5);
    sprintf(buf, "%d", param_max_phase_current); send_frame(0x55, buf); sleep_ms(5);
    sprintf(buf, "%d", param_max_battery_current); send_frame(0x56, buf); sleep_ms(5);
    sprintf(buf, "%d", param_pwm_frequency); send_frame(0x57, buf); sleep_ms(5);
    sprintf(buf, "%d", param_current_gain); send_frame(0x58, buf); sleep_ms(5);
}

// 解析下行指令
void parse_rx_frame(const uint8_t *data, uint8_t len, uint8_t type) {
    if (type == 0x60) {
        // 收到读取请求
        send_all_parameters();
        return;
    }

    if (type == 0x59 && len >= 16) {
        // 采用小端模式解析（低字节在前，高字节在后，与前端对应更稳妥）
        // 或者直接按前端传过来的顺序：data[0]为高位，data[1]为低位
        param_max_cadence         = (data[0] << 8) | data[1];
        param_max_resistance      = (data[2] << 8) | data[3];
        param_max_power           = (data[4] << 8) | data[5];
        param_max_speed           = (data[6] << 8) | data[7];
        param_max_phase_current   = (data[8] << 8) | data[9];
        param_max_battery_current = (data[10] << 8) | data[11];
        param_pwm_frequency       = (data[12] << 8) | data[13];
        param_current_gain        = (data[14] << 8) | data[15];

        // 打印调试信息到 USB 串口（可在支持文本打印的调试助手中看到）
        printf("[Pico] Parameters Updated! Cadence:%d, Power:%d, Speed:%d\n", 
               param_max_cadence, param_max_power, param_max_speed);

        // 写入成功后立刻回显最新参数
        send_all_parameters();
    }
}

typedef enum { S_WAIT_HEADER = 0, S_WAIT_TYPE, S_WAIT_LEN, S_WAIT_DATA, S_WAIT_CHECKSUM, S_WAIT_TAIL } rx_state_t;

int main() {
    stdio_init_all();
    sleep_ms(1500); // 等待 USB 串口初始化稳定

    rx_state_t state = S_WAIT_HEADER;
    uint8_t rx_type = 0, rx_len = 0, rx_data[64], rx_data_idx = 0, rx_sum = 0;
    absolute_time_t last_telemetry_time = get_absolute_time();

    while (true) {
        int ch = getchar_timeout_us(0);
        while (ch != PICO_ERROR_TIMEOUT) {
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
                    if (rx_len == 0) state = S_WAIT_CHECKSUM;
                    else if (rx_len < sizeof(rx_data)) state = S_WAIT_DATA;
                    else state = S_WAIT_HEADER;
                    break;
                case S_WAIT_DATA:
                    rx_data[rx_data_idx++] = byte; 
                    rx_sum += byte;
                    if (rx_data_idx >= rx_len) state = S_WAIT_CHECKSUM;
                    break;
                case S_WAIT_CHECKSUM:
                    if (byte == (rx_sum & 0xFF)) state = S_WAIT_TAIL;
                    else state = S_WAIT_HEADER;
                    break;
                case S_WAIT_TAIL:
                    if (byte == 0xF6) {
                        parse_rx_frame(rx_data, rx_len, rx_type);
                    }
                    state = S_WAIT_HEADER;
                    break;
            }
            ch = getchar_timeout_us(0);
        }

        // 定时发送遥测数据 (每 500ms)
        if (absolute_time_diff_us(last_telemetry_time, get_absolute_time()) >= 500000) {
            last_telemetry_time = get_absolute_time();
            static int step = 0;
            step++;
            char buf[32];

            sprintf(buf, "%d", 80 + (step % 30)); send_frame(0x41, buf);
            sprintf(buf, "%d", 40 + (step % 30)); send_frame(0x44, buf);
            sprintf(buf, "%.1f", 15.0f + ((step % 70) * 0.1f)); send_frame(0x42, buf);
            sprintf(buf, "%.1f", 150.0f + (float)(step % 100)); send_frame(0x4a, buf);
        }
    }
    return 0;
}