#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "hardware/uart.h"

// 定义使用的 UART 接口（Pico 2 默认使用 UART0，引脚 GP0(TX), GP1(RX)）
#define UART_ID uart0
#define BAUD_RATE 19200
#define UART_TX_PIN 0
#define UART_RX_PIN 1

// 协议常量
#define FRAME_HEADER 0xF1
#define FRAME_FOOTER 0xF6

// 接收解析状态机枚举
typedef enum {
    STATE_WAIT_HEADER,
    STATE_WAIT_TYPE,
    STATE_WAIT_LEN,
    STATE_WAIT_PAYLOAD,
    STATE_WAIT_CHECKSUM,
    STATE_WAIT_FOOTER
} parse_state_t;

// 串口接收解析上下文
typedef struct {
    parse_state_t state;
    uint8_t type;
    uint8_t len;
    uint8_t payload[32];
    uint8_t payload_idx;
    uint8_t checksum;
} uart_parser_t;

static uart_parser_t parser = { .state = STATE_WAIT_HEADER };

// 发送一帧遥测数据到网页端
void send_telemetry_frame(uint8_t type, uint32_t val) {
    char buf[16];
    int len = snprintf(buf, sizeof(buf), "%lu", val);
    if (len <= 0 || len > 31) return;

    uint8_t sum = 0;
    for (int i = 0; i < len; i++) {
        sum += (uint8_t)buf[i];
    }

    uart_putc_raw(UART_ID, FRAME_HEADER);
    uart_putc_raw(UART_ID, type);
    uart_putc_raw(UART_ID, (uint8_t)len);
    for (int i = 0; i < len; i++) {
        uart_putc_raw(UART_ID, buf[i]);
    }
    uart_putc_raw(UART_ID, sum & 0xFF);
    uart_putc_raw(UART_ID, FRAME_FOOTER);
}

// 处理从网页端接收到的完整参数设置帧
void handle_received_frame(uint8_t type, const uint8_t *payload, uint8_t len) {
    char temp_str[32];
    if (len >= sizeof(temp_str)) len = sizeof(temp_str) - 1;
    memcpy(temp_str, payload, len);
    temp_str[len] = '\0';
    int val = atoi(temp_str);

    printf("收到参数设置指令 [类型: 0x%02X]: 数值 = %d\n", type, val);

    // 可根据 type 区分具体是哪个参数：
    // 0x51: 最大转速, 0x52: 最大油门, 0x53: 最大功率, 0x54: 最大速度
    // 0x55: 最大相电流, 0x56: 最大电池电流, 0x57: PWM频率, 0x58: 电流增益
    switch (type) {
        case 0x51: printf(" -> 更新配置: 最大转速\n"); break;
        case 0x52: printf(" -> 更新配置: 最大油门\n"); break;
        case 0x53: printf(" -> 更新配置: 最大功率\n"); break;
        case 0x54: printf(" -> 更新配置: 最大速度\n"); break;
        case 0x55: printf(" -> 更新配置: 最大相电流\n"); break;
        case 0x56: printf(" -> 更新配置: 最大电池电流\n"); break;
        case 0x57: printf(" -> 更新配置: PWM频率\n"); break;
        case 0x58: printf(" -> 更新配置: 电流增益\n"); break;
        default:   printf(" -> 未知参数类型\n"); break;
    }
}

// 逐字节解析接收到的串口数据
void parse_uart_byte(uint8_t byte) {
    switch (parser.state) {
        case STATE_WAIT_HEADER:
            if (byte == FRAME_HEADER) {
                parser.state = STATE_WAIT_TYPE;
            }
            break;

        case STATE_WAIT_TYPE:
            parser.type = byte;
            parser.state = STATE_WAIT_LEN;
            break;

        case STATE_WAIT_LEN:
            parser.len = byte;
            parser.payload_idx = 0;
            if (parser.len > 0 && parser.len < sizeof(parser.payload)) {
                parser.state = STATE_WAIT_PAYLOAD;
            } else {
                parser.state = STATE_WAIT_HEADER; // 长度异常重置
            }
            break;

        case STATE_WAIT_PAYLOAD:
            parser.payload[parser.payload_idx++] = byte;
            if (parser.payload_idx >= parser.len) {
                parser.state = STATE_WAIT_CHECKSUM;
            }
            break;

        case STATE_WAIT_CHECKSUM: {
            parser.checksum = byte;
            // 计算校验和
            uint8_t sum = 0;
            for (int i = 0; i < parser.len; i++) {
                sum = (sum + parser.payload[i]) & 0xFF;
            }

            if (sum == parser.checksum) {
                parser.state = STATE_WAIT_FOOTER;
            } else {
                printf("校验和错误！计算值: 0x%02X, 收到值: 0x%02X\n", sum, parser.checksum);
                parser.state = STATE_WAIT_HEADER;
            }
            break;
        }

        case STATE_WAIT_FOOTER:
            if (byte == FRAME_FOOTER) {
                handle_received_frame(parser.type, parser.payload, parser.len);
            }
            parser.state = STATE_WAIT_HEADER;
            break;
    }
}

int main() {
    stdio_init_all();

    // 初始化 UART
    uart_init(UART_ID, BAUD_RATE);
    gpio_set_function(UART_TX_PIN, GPIO_FUNC_UART);
    gpio_set_function(UART_RX_PIN, GPIO_FUNC_UART);

    printf("Raspberry Pi Pico 2 遥测与参数测试程序已启动\n");

    uint32_t counter = 0;
    absolute_time_t next_telemetry_time = make_timeout_time_ms(250); // 每 250ms 发送一次数据

    while (true) {
        // 1. 非阻塞读取并解析串口下发的参数
        while (uart_is_readable(UART_ID)) {
            uint8_t ch = uart_getc(UART_ID);
            parse_uart_byte(ch);
        }

        // 2. 定期向网页发送模拟遥测数据
        if (absolute_time_diff_us(get_absolute_time(), next_telemetry_time) <= 0) {
            next_telemetry_time = make_timeout_time_ms(250);
            counter++;

            // 模拟动态变化的骑行数据
            uint32_t cadence = 80 + (counter % 30);       // 转速: 80 ~ 110 RPM
            uint32_t throttle = 50 + (counter % 50);      // 油门: 50% ~ 100%
            uint32_t speed_x10 = 250 + (counter % 150);   // 车速: 25.0 ~ 40.0 km/h (放大10倍发送)
            uint32_t power_x10 = 1500 + (counter % 800);  // 功率: 150.0W ~ 230.0W (放大10倍发送)

            // 发送协议帧
            send_telemetry_frame(0x41, cadence);    // 0x41: 转速
            send_telemetry_frame(0x44, throttle);   // 0x44: 油门
            send_telemetry_frame(0x42, speed_x10);  // 0x42: 车速
            send_telemetry_frame(0x4a, power_x10);  // 0x4A: 功率
        }

        // 稍微让出CPU，避免占用过高
        tight_loop_contents();
    }

    return 0;
}