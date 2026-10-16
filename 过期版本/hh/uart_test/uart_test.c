#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"

// 构造并发送 Peloton 协议数据包
// frame_type: 0x41(踏频), 0x44(阻力), 0x4A(功率*10)
void send_peloton_frame(uint8_t frame_type, int value) {
    char str_val[16];
    // 转换为字符串
    sprintf(str_val, "%d", value);
    uint8_t len = (uint8_t)strlen(str_val);

    uint8_t digits[16];
    uint8_t checksum = 0;

    // Peloton 协议要求 ASCII 数字倒序排列（低位在前）
    for (int i = 0; i < len; i++) {
        digits[i] = (uint8_t)str_val[len - 1 - i];
        checksum = (checksum + digits[i]) & 0xFF; // 计算校验和
    }

    // 打包帧: [0xF1, 类型, 长度, ...倒序ASCII数字, 校验和, 0xF6]
    putchar_raw(0xF1);
    putchar_raw(frame_type);
    putchar_raw(len);
    for (int i = 0; i < len; i++) {
        putchar_raw(digits[i]);
    }
    putchar_raw(checksum);
    putchar_raw(0xF6);

    // 立即刷新缓存发送至电脑
    stdio_flush();
}

int main() {
    // 初始化 USB 虚拟串口标准输入输出
    stdio_init_all();

    // 等待电脑端的连接与串口开启
    while (!stdio_usb_connected()) {
        sleep_ms(100);
    }

    int cadence = 60;      // 初始踏频 60 RPM
    int resistance = 30;   // 初始阻力 30 %
    int step = 1;

    while (true) {
        // 1. 模拟踏频在 50 ~ 110 RPM 之间平滑变动
        cadence += step;
        if (cadence >= 110 || cadence <= 50) {
            step = -step;
        }

        // 阻力随踏频平滑起伏
        resistance = 30 + (cadence - 50) / 2;

        // 估算功率 (Watts)
        int power = (int)(cadence * 0.85 + resistance * 2.8);

        // 2. 依次打包发送三个指标
        send_peloton_frame(0x41, cadence);           // 踏频 (0x41)
        sleep_ms(30);

        send_peloton_frame(0x44, resistance);        // 阻力 (0x44)
        sleep_ms(30);

        send_peloton_frame(0x4A, power * 10);        // 功率*10 (0x4A)
        sleep_ms(180); // 控制综合发送频率约为 4 次/秒
    }

    return 0;
}