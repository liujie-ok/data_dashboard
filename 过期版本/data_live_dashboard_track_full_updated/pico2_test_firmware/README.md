# Raspberry Pi Pico 2：USB CDC 测试固件说明

## 1. 固件用途

固件以 C 语言和 Raspberry Pi Pico C/C++ SDK 编写，通过 Pico 2 板载 USB 接口枚举为 USB CDC 虚拟串口。它每 100 ms 发送模拟转速、油门、速度、功率、海拔及 GPS 经纬度，并处理网页的参数读取/写入请求。经纬度沿与网页示例赛道 CSV 一致的椭圆轨迹变化。

本程序仅用于测试 Data Live Dashboard，不是电机/车辆控制固件。参数写入只更新 RAM，重启后恢复默认值。不要在相同 USB CDC 通道中输出调试字符串，因为网页使用该通道接收二进制帧。

## 2. 源文件

- `main.c`：协议常量、帧结构、接收状态机、参数表、模拟遥测发送和主循环。
- `CMakeLists.txt`：声明工程语言与目标文件，启用 USB CDC stdio，关闭 UART stdio，并要求 SDK 生成 UF2 输出。
- `pico_sdk_import.cmake`：从本机 SDK 环境导入 Pico SDK 的 CMake 配置。

## 3. 编译

首先安装 Raspberry Pi Pico SDK、CMake 和可用的编译工具链，并设置 `PICO_SDK_PATH` 环境变量指向本机 SDK 根目录。然后在本目录执行：

```bash
cmake -S . -B build -DPICO_BOARD=pico2
cmake --build build
```

目标文件为 `build/pico2_dashboard_test.uf2`。如果 CMake 找不到 `pico_sdk_import.cmake` 指向的 SDK，请先检查 `PICO_SDK_PATH`，并确保安装的 SDK 支持 Pico 2。

## 4. 烧录与连接

1. 拔掉 Pico 2 的 USB 线。
2. 按住 BOOTSEL 按钮，并连接 USB 数据线。
3. 电脑出现 `RPI-RP2` 磁盘后松开 BOOTSEL。
4. 将 `pico2_dashboard_test.uf2` 复制到 `RPI-RP2` 磁盘。复制成功后磁盘通常会自动卸载，Pico 2 会重启。
5. 启动网页，在“遥测界面”点击“连接设备”，选择系统中出现的 Pico 2 USB CDC 串口。

网页使用桌面版 Chrome/Edge，并建议通过 `http://localhost:8000` 打开。USB CDC 的实际数据经过 USB 传输；网页保留波特率设置只是因为 Web Serial API 需要传入 `baudRate` 配置。

## 5. 协议概要

帧格式：`F1 | type | length | ASCII payload | checksum | F6`。`length` 是载荷字节数；校验和是载荷字节累加后取低 8 位。

| 帧类型 | 含义 |
|---:|---|
| `0x41` | 转速（RPM） |
| `0x44` | 油门/阻力（%） |
| `0x42` | 速度（km/h） |
| `0x4A` | 功率（W） |
| `0x45` | 设备高度（m） |
| `0x46` | 设备纬度（十进制度） |
| `0x47` | 设备经度（十进制度） |
| `0x51`–`0x58` | 8 个可读写参数 |
| `0x60` | 读取全部参数的请求 |

参数写入会回传更新后的数值，方便网页刷新输入框。所有参数均只存于 RAM。

## 6. 功能测试建议

1. 确认四项实时遥测数据持续变化。
2. 开始记录约 10–20 秒，停止记录并导出 CSV。第一列应如 `00:00.00`、`00:00.25`、`00:00.50` 显示。
3. 在“数据分析”加载导出的 CSV，选择不同数值列并测试三图同步缩放。
4. 在“参数设置”读取八个参数，修改后写入，确认输入值收到回传更新。
5. 进入赛道显示界面，加载 `dashboard_refactor/sample_track.csv`，观察模拟设备标记沿椭圆赛道移动。
6. 在赛道页下方切换“设备当前高度”及转速、油门、功率、速度曲线。
7. 主动断开或拔掉 USB，检查网页停止记录并禁用开始/导出按钮。

## 7. 常见问题

- **没有 `RPI-RP2` 磁盘：** 检查是否按住 BOOTSEL 后再插线，并确保 USB 线支持数据传输。
- **烧录后没有串口：** 查看设备管理器或系统串口列表；确认 UF2 是针对 `pico2` 编译的，并检查 SDK 是否支持 Pico 2。
- **网页能连接但没有数据：** 确保烧录的是本工程固件；不要往 USB CDC 混发日志；检查协议标记和类型编号是否与前端一致。
- **无法编译：** 检查 `PICO_SDK_PATH`、CMake 工具链和 Pico SDK 版本。

本机 Pico SDK 和实体板并未在生成环境中实际运行；请在自己的 SDK 环境编译并完成硬件联调。
