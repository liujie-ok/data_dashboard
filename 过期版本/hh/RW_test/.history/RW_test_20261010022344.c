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

// 简单粗暴解析上位机发过来的 SET_PARAMS JSON 字符串
void parse_and_update_params(const char* json_str) {
    // 示例查找并更新字段（实际生产可用更完整的 JSON 库，如 cJSON，此处用 sscanf/strstr 简化演示）
    const char *p;
    
    if ((p = strstr(json_str, "\"maxCadence\":"))) current_params.maxCadence = atof(p + 13);
    if ((p = strstr(json_str, "\"maxThrottle\":"))) current_params.maxThrottle = atof(p + 14);
    if ((p = strstr(json_str, "\"maxPower\":"))) current_params.maxPower = atof(p + 11);
    if ((p = strstr(json_str, "\"maxSpeed\":"))) current_params.maxSpeed = atof(p + 11);
    if ((p = strstr(json_str, "\"maxPhaseCurrent\":"))) current_params.maxPhaseCurrent = atof(p + 18);
    if ((p = strstr(json_str, "\"maxBatteryCurrent\":"))) current_params.maxBatteryCurrent = atof(p + 20);
    if ((p = strstr(json_str, "\"pwmFrequency\":"))) current_params.pwmFrequency = atof(p + 15);
    if ((p = strstr(json_str, "\"currentGain\":"))) current_params.currentGain = atof(p + 14);

    // 回发确认
    printf("LOG: Parameters updated successfully on Pico 2!\n");
}

int main() {
    // 初始化标准输入输出（支持 USB CDC 虚拟串口和 UART）
    stdio_init_all();

    // 状态指示灯 (Pico 2 板载 LED 引脚，若无或使用核心板可忽略)
    const uint LED_PIN = 25; 
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);

    absolute_time_t last_telemetry_time = get_abstime();
    int sim_counter = 0;

    char rx_buf[256];
    int rx_idx = 0;

    while (true) {
        // 1. 非阻塞轮询读取串口输入的一行指令
        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT) {
            if (c == '\n' || c == '\r') {
                if (rx_idx > 0) {
                    rx_buf[rx_idx] = '\0';
                    
                    // 判断指令类型
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

        // 2. 每隔 250ms 模拟并主动上报一次遥测数据（兼容网页图表与实时数字显示）
        if (absolute_time_diff_us(last_telemetry_time, get_abstime()) > 250000) {
            last_telemetry_time = get_abstime();
            sim_counter++;

            // 模拟动态变化数据
            int cadence = 60 + (sim_counter % 30);
            int throttle = 40 + (sim_counter % 50);
            int power = cadence * throttle / 2;

            // 按照前端网页能够解析的自定义格式上报（或者你也可以用二进制帧）
            // 这里我们用带标记的文本或直接输出给前端识别
            // 如果网页端需要配合旧的二进制帧，也可以用你在 script 里写好的 0xF1 协议。
            // 此处为了配合网页升级后的 JSON/文本交互，我们做个兼容打印：
            printf("CAD:%d,THR:%d,PWR:%d\n", cadence, throttle, power);

            gpio_put(LED_PIN, sim_counter % 2);
        }
    }

    return 0;
}