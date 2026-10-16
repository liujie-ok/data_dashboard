#include <stdio.h>
#include "pico/stdlib.h"

// Raspberry Pi Pico 2 的板载 LED 通常在 GPIO 25 (或通过宏定义适配)
#ifndef PICO_DEFAULT_LED_PIN
#define PICO_DEFAULT_LED_PIN 25
#endif

// 发送一帧符合网页端解析规范的数据
// 网页端解析逻辑: 0xf1 + type + len + [digits...] + checksum + 0xf6
void send_telemetry_frame(uint8_t type, uint32_t val) {
    char buf[16];
    int len = sprintf(buf, "%lu", (unsigned long)val);
    if (len <= 0 || len > 10) return;

    uint8_t checksum = 0;
    for (int i = 0; i < len; i++) {
        checksum = (checksum + (uint8_t)buf[i]) & 0xff;
    }

    putchar(0xf1);                  // 帧头
    putchar(type);                  // 类型: 0x41(转速), 0x44(油门), 0x4a(功率*10)
    putchar((uint8_t)len);          // 长度
    for (int i = 0; i < len; i++) {
        putchar(buf[i]);            // 数据位
    }
    putchar(checksum);              // 校验和
    putchar(0xf6);                  // 帧尾
}

// LED 闪烁 3 秒函数（每 250ms 翻转一次）
void flash_led_3seconds() {
    for (int i = 0; i < 12; i++) {
        gpio_put(PICO_DEFAULT_LED_PIN, 1);
        sleep_ms(150);
        gpio_put(PICO_DEFAULT_LED_PIN, 0);
        sleep_ms(150);
    }
}

int main() {
    // 初始化标准输入输出（启用 USB 虚拟串口）
    stdio_init_all();

    // 初始化板载 LED 引脚
    gpio_init(PICO_DEFAULT_LED_PIN);
    gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
    gpio_put(PICO_DEFAULT_LED_PIN, 0);

    uint32_t counter = 0;
    absolute_time_t next_telemetry_time = get_absolute_time();

    while (true) {
        // 1. 模拟遥测与参数数据上报（每 250ms 发送一次模拟数据）
        if (absolute_time_diff_us(get_absolute_time(), next_telemetry_time) <= 0) {
            counter++;
            
            // 模拟动态数据
            uint32_t mock_cadence = 60 + (counter % 30);      // 转速 RPM
            uint32_t mock_resistance = 20 + (counter % 50);   // 油门 %
            uint32_t mock_power = (150 + (counter % 100)) * 10; // 功率 (网页端会除以10)

            send_telemetry_frame(0x41, mock_cadence);
            send_telemetry_frame(0x44, mock_resistance);
            send_telemetry_frame(0x4a, mock_power);

            next_telemetry_time = delayed_by_ms(next_telemetry_time, 250);
        }

        // 2. 检查网页端通过串口下发的数据（例如点击“写入参数”时）
        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT) {
            // 如果收到来自网页端写入参数的指令触发字符（例如 'W' 或特定协议包）
            if (c == 'W' || c == 'w') {
                // 执行参数写入成功逻辑：LED 闪烁 3 秒
                flash_led_3seconds();
            }
        }
    }

    return 0;
}