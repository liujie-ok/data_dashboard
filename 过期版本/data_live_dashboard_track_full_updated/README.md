# Data Live Dashboard

请先阅读 [项目说明_中文.md](项目说明_中文.md)，其中说明了完整目录结构、前端各模块、CSV 时间格式、通信协议、网页运行方法和 Pico 2 固件编译步骤。

网页源码位于 `dashboard_refactor/`，Raspberry Pi Pico 2 USB CDC 测试固件位于 `pico2_test_firmware/`。

项目已包含 `.gitignore`，会忽略 Pico SDK 的构建输出和常见系统临时文件。


## 赛道显示功能

网页导航栏中“参数设置”右侧的路线图标会打开赛道页。进入后点击“加载赛道数据文件”，可选择 CSV 或 GPX 文件；工程中的 `dashboard_refactor/sample_track.csv` 与 Pico 2 测试固件模拟的 GPS 轨迹对应。连接设备后，赛道上的红色标记会随收到的经纬度变化；下方曲线可切换设备高度、转速、油门、功率或速度。新增扩展协议帧为 `0x45`（高度）、`0x46`（纬度）、`0x47`（经度），详细格式见中文项目说明文档。
