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

// 初始默认参数
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

// LED 闪烁状态机变量
bool is_blinking = false;
absolute_time_t last_toggle_time;
bool led_state = false;
int toggle_count = 0;
const int max_toggles = 24; // 3秒 * 4次/秒 * 2 (状态切换次数 = 24次)

// 发送当前参数的 JSON 字符串给上位机
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

// 解析上位机发过来的 SET_PARAMS JSON 字符串并触发写入成功提示
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

    // 触发 LED 写入成功闪烁：每秒4下，持续3秒
    is_blinking = true;
    last_toggle_time = get_absolute_time();
    toggle_count = 0;
    led_state = true;

    // 回发确认日志给网页
    printf("LOG: Parameters updated successfully on Pico 2!\n");
}

int main() {
    // 初始化标准输入输出（支持 USB CDC 虚拟串口）
    stdio_init_all();

    // 初始化板载 LED 引脚 (Pico 2 默认使用 25 号引脚)
    const uint LED_PIN = 25; 
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    gpio_put(LED_PIN, 0); // 默认熄灭

    absolute_time_t last_telemetry_time = get_absolute_time();
    int sim_counter = 0;

    char rx_buf[256];
    int rx_idx = 0;

    while (true) {
        // 1. 非阻塞轮询读取串口输入的指令
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

        // 2. 非阻塞 LED 闪烁状态机（仅在写入成功时触发：每秒4下，持续3秒）
        if (is_blinking) {
            // 125,000 微秒 = 125 毫秒（8次状态切换 = 4次完整闪烁/秒）
            if (absolute_time_diff_us(last_toggle_time, get_absolute_time()) >= 125000) {
                last_toggle_time = get_absolute_time();
                led_state = !led_state;
                gpio_put(LED_PIN, led_state);
                toggle_count++;
                
                if (toggle_count >= max_toggles) {
                    is_blinking = false;
                    gpio_put(LED_PIN, 0); // 闪烁结束，关闭 LED
                }
            }
        }

        // 3. 每隔 250ms 模拟并上报一次遥测数据给网页
        if (absolute_time_diff_us(last_telemetry_time, get_absolute_time()) > 250000) {
            last_telemetry_time = get_absolute_time();
            sim_counter++;

            int cadence = 60 + (sim_counter % 30);
            int throttle = 40 + (sim_counter % 50);
            int power = cadence * throttle / 2;

            printf("CAD:%d,THR:%d,PWR:%d\n", cadence, throttle, power);
        }
    }

    return 0;
}