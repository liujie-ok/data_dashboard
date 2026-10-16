# Pico SDK 官方导入脚本的薄封装。
# 请通过 CMake 变量或环境变量 PICO_SDK_PATH 指定本机 pico-sdk 根目录。
if (DEFINED ENV{PICO_SDK_PATH} AND (NOT PICO_SDK_PATH))
    set(PICO_SDK_PATH $ENV{PICO_SDK_PATH})
endif()

if (NOT PICO_SDK_PATH)
    message(FATAL_ERROR "Please set PICO_SDK_PATH to your Raspberry Pi Pico SDK directory.")
endif()

include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)
