#include <stdio.h>
#include "pico/stdlib.h"

// Pico 2 默认板载 LED 引脚定义（如果是使用标准 RP2350 核心或 Pico 2，通常板载 LED 在 GPIO 25 或使用 cyw43）
#ifndef PICO_DEFAULT_LED_PIN
#define PICO_DEFAULT_LED_PIN 25
#endif

// 协议帧头尾定义
#define FRAME_START 0xF1
#define FRAME_END   0xF6

// 发送一帧格式化数据给网页 (格式: 0xF1, Type, Len, [Digits...], Checksum, 0xF6)
void send_frame(uint8_t type, int value) {
    // 将数值转为 ASCII 字符数组（逆序）
    char digits[16];
    int len = 0;
    if (value == 0) {
        digits[0] = '0';
        len = 1;
    } else {
        int temp = value;
        while (temp > 0 && len < 15) {
            digits[len++] = (temp % 10) + '0';
            temp /= 10;
        }
    }

    // 计算校验和
    uint8_t checksum = 0;
    for (int i = 0; i < len; i++) {
        checksum = (checksum + (uint8_t)digits[i]) & 0xFF;
    }

    // 组装并发送数据包
    putchar(FRAME_START);
    putchar(type);
    putchar((uint8_t)len);
    for (int i = len - 1; i >= 0; i--) {
        putchar(digits[i]); // 高位先发
    }
    putchar(checksum);
    putchar(FRAME_END);
}

// LED 闪烁 3 秒（写入成功触发）
void led_flash_success() {
    for (int i = 0; i < 6; i++) { // 闪烁 6 次，每次 500ms = 3 秒
        gpio_put(PICO_DEFAULT_LED_PIN, 1);
        sleep_ms(250);
        gpio_put(PICO_DEFAULT_LED_PIN, 0);
        sleep_ms(250);
    }
}

int main() {
    stdio_init_all();

    // 初始化板载 LED 引脚
    gpio_init(PICO_DEFAULT_LED_PIN);
    gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
    gpio_put(PICO_DEFAULT_LED_PIN, 0);

    absolute_time_t next_telemetry_time = get_absolute_time();

    // 模拟测试初始动态变量
    int test_cadence = 60;
    int test_resistance = 20;
    int test_power = 150;

    while (true) {
        // 1. 检查串口是否有上位机（网页）发送来的指令
        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT) {
            // 简单模拟：如果收到来自网页的任意控制命令/字节，或者可以根据具体协议判断
            // 当网页点击“写入参数”时，Pico 收到对应触发指令后执行闪烁
            // 此处为通用测试：若收到特定字符或命令，触发写入成功闪烁 3 秒
            if (c == 'W' || c == 'w') { // 假设 'W' 代表写入指令
                led_flash_success();
            }
        }

        // 2. 定时向网页发送遥测数据（每 250 毫秒推送一次）
        if (absolute_time_diff_us(get_absolute_time(), next_telemetry_time) <= 0) {
            // 动态改变一点测试数据模拟真实设备
            test_cadence = (test_cadence % 120) + 1;
            test_resistance = (test_resistance % 80) + 5;
            test_power = test_cadence * test_resistance / 2;

            // 发送遥测数据帧
            send_frame(0x41, test_cadence);    // 0x41: 转速 (RPM)
            send_frame(0x44, test_resistance); // 0x44: 油门 (%)
            send_frame(0x4A, test_power * 10); // 0x4A: 功率 (内部放大10倍，网页端会除以10还原)

            next_telemetry_time = delayed_by_ms(get_absolute_time(), 250);
        }

        tight_loop_contents();
    }

    return 0;
}