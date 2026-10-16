# 使用 Pico SDK 提供的 CMake 导入文件。
cmake_minimum_required(VERSION 3.13)
include(pico_sdk_import.cmake)

# 本工程主程序使用 C 语言；保留 SDK 构建系统所需的 C++/ASM 语言支持。
project(pico2_dashboard_test C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
pico_sdk_init()

# 将 main.c 编译为 Pico 2 可执行固件。
add_executable(pico2_dashboard_test main.c)
target_link_libraries(pico2_dashboard_test pico_stdlib pico_stdio_usb hardware_timer m)

# 启用板载 USB CDC 标准输入/输出，并关闭 UART stdio。
pico_enable_stdio_usb(pico2_dashboard_test 1)
pico_enable_stdio_uart(pico2_dashboard_test 0)
pico_add_extra_outputs(pico2_dashboard_test)
