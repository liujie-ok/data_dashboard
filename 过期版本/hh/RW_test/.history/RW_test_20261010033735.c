#stdio.h>
#stdlib.h>
#pico/stdlib.h>
#hardware/timer.h>

// 定义 Raspberry Pi Pico 2 的板载 LED 引脚 (通常为 GPIO 25，若为 Pico 2 W 则可能需要改用 CYW43 驱动，此处按标准 GPIO 25 处理)
#define LED_PIN 25

// 帧格式定义：起始符 0xF1，类型，长度，数据(ASCII字符)，校验和，结束符 0xF6
// 用于向网页发送遥测数据 (转速、油门、功率)
void send_telemetry_frame(uint8_t type, int value) {
    // 将数值转为 ASCII 字符数组
    char buf[16];
    int len = snprintf(buf, sizeof(buf), "%d", value);
    if (len <= 0) return;

    uint8_t checksum = 0;
    for (int i = 0; i < len; i++) {
        checksum = (checksum + (uint8_t)buf[i]) & 0xFF;
    }

    // 发送完整数据帧
    putchar_raw(0xF1);          // 起始符
    putchar_raw(type);          // 类型 (0x41:转速, 0x44:油门, 0x4a:功率)
    comm_put_len:
    putchar_raw((uint8_t)len);  // 长度
    for (int i = 0; i < len; i++) {
        putchar_raw(buf[i]);    // 数据内容
    }
    putchar_raw(checksum);      // 校验和
    putchar_raw(0xF6);          // 结束符
}

// 写入成功时，LED 闪烁 3 秒
void trigger_success_blink() {
    // 3秒内以 200ms 间隔闪烁 (亮 100ms, 灭 100ms 共 15次)
    for (int i = 0; i < 15; i++) {
        gpio_put(LED_PIN, 1);
        sleep_ms(100);
        gpio_put(LED_PIN, 0);
        sleep_ms(100);
    }
}

int main() {
    // 初始化标准输入输出（启用 USB 虚拟串口通信）
    stdio_init_all();

    // 初始化 LED 引脚
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    gpio_put(LED_PIN, 0);

    // 模拟的动态遥测数据初始值
    int mock_cadence = 60;   // 转速 RPM
    int mock_resistance = 25;// 油门 %
    int mock_power = 150;    // 功率 W (网页端会除以10，所以发 1500 代表 150W，或者根据协议调整)

    absolute_time_t next_telemetry_time = get_absolute_time();

    while (true) {
        // 1. 处理来自网页端的串口输入（模拟读取参数、写入参数等控制）
        int ch = getchar_timeout_us(0);
        if (ch != PICO_ERROR_TIMEOUT) {
            // 收到网页端的指令，可以根据具体业务逻辑判断
            // 示例：如果收到字符 'W' 或特定指令，模拟一次“写入参数成功”
            if (ch == 'W' || ch == 'w') {
                trigger_success_blink();
            }
        }

        // 2. 定时向网页发送遥测数据（每 250ms 发送一次，与网页图表刷新频率同步）
        if (absolute_time_diff_us(get_absolute_time(), next_telemetry_time) <= 0) {
            
            // 模拟数据小幅波动，让前端图表动起来
            mock_cadence = 60 + (rand() % 15);
            mock_resistance = 20 + (rand() % 10);
            mock_power = 1400 + (rand() % 300); // 对应 140W ~ 170W

            // 发送各项指标帧
            send_telemetry_frame(0x41, mock_cadence);    // 0x41 -> 转速 (Cadence)
            send_telemetry_frame(0x44, mock_resistance); // 0x44 -> 油门 (Resistance)
            send_telemetry_frame(0x4a, mock_power);      // 0x4A -> 功率 (Power, 内部会自动 /10)

            // 设置下一次发送时间 (250毫秒后)
            next_telemetry_time = delayed_by_ms(get_absolute_time(), 250);
        }

        // 稍微让出 CPU，避免死循环满载
        tight_loop_contents();
    }

    return 0;
}