# hal_periph — 外设 HAL

PixelBox 外设硬件抽象层,不含任何 QuickJS 依赖,JS 绑定见 `bindings_periph`。

## 模块清单

| 模块 | 文件 | 说明 |
|---|---|---|
| 共享 I2C | `i2c_bus.cpp` | 经 `hal_common/board.h` 的 `board_i2c_bus()` 取总线,读写统一走 `board_i2c_lock/unlock` |
| 触摸 | `touch_ft3168.cpp` | FT3168 寄存器级驱动;INT 引脚门控 + 10ms 轮询任务;地址/引脚来自 `board_touch_config()` |
| 按键 | `button_input.cpp` | BOOT 键,基于组件注册表 `espressif/button` v4(click/doubleClick/longPress 状态机) |
| IMU | `imu_qmi8658.cpp` | QMI8658 寄存器级驱动(±8g / ±512dps);采样任务同时驱动数据流与摇一摇/姿态检测 |
| BLE | `ble_hal.cpp` | NimBLE 封装:peripheral 动态 GATT 建表 + central 扫描/连接/GATT 客户端(串行操作队列 + 服务发现缓存) |
| GPS | `gps_hal.cpp` | UART NMEA 读取任务 + 失锁判定(5s 无有效语句 → lost) |
| 摄像头 | `camera_hal.cpp` | esp32-camera 封装,工作任务 + 命令队列,帧缓冲 PSRAM |
| 灯带 | `led_hal.cpp` | espressif/led_strip(RMT WS2812),逻辑色缓冲 + show 时亮度缩放 |
| 纯逻辑 | `nmea_parser.cpp` `px_uuid.cpp` `storage_paths.cpp` | 可在宿主机单测(见 `host_test/`) |

## 线程模型

所有驱动回调(触摸轮询任务 / iot_button 任务 / IMU 采样任务 / NimBLE host 任务 /
GPS 读取任务 / 摄像头工作任务)都在**各自任务上下文**触发;
`bindings_periph` 负责经 `jsvm::Callback` / `jsvm::post` 投递到 JS 线程,
本层不做任何 JS 调用。

## Kconfig

- `PX_ENABLE_BLE`(默认开)— 还需 sdkconfig 开启 `CONFIG_BT_ENABLED` + `CONFIG_BT_NIMBLE_ENABLED`,否则自动降级为 stub(`available()==false`)
- `PX_ENABLE_CAMERA` / `PX_ENABLE_GPS` / `PX_ENABLE_LED`(默认关)— Stage B 定制板外设;运行期可用性 = 编译开关 AND `board_caps()` 对应能力位
- 摄像头 DVP / GPS UART / 灯带引脚暂收敛在本组件 Kconfig(boards 尚未提供对应 getter,提供后应迁移)

## 宿主机单元测试

```bash
cd firmware/components/hal_periph/host_test
./run_host_tests.sh   # 需要本机 c++ (clang/gcc), 测 NMEA 解析 / UUID 解析 / 路径解析
```
