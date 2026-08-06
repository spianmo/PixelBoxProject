# 多目标支持 (ESP32-C6 / ESP32-P4) 落地说明

> v2 交付。对应固件实现: `firmware/` 各组件的 `CONFIG_SOC_WIFI_SUPPORTED` /
> `CONFIG_PX_ENABLE_AUDIO` / `CONFIG_BOARD_*` 条件编译, 以及
> `hal_common/px_alloc.h` 的 PSRAM 可选分配。能力矩阵见
> docs/architecture.md §3.1; 三目标构建命令与 size 实测见 firmware/README.md「多目标」。

## 1. 设计原则

1. **编译级真实支持**: `idf.py set-target esp32c6 / esp32p4` 整包编译通过,
   不是"理论上能编"。S3 默认构建零回归。
2. **能力诚实降级**: 芯片没有的能力 (P4 无 WiFi/BT, C6 无 PSRAM,
   无屏板无屏) 一律按 d.ts 契约处理 — `available()`/状态接口如实返回,
   其余方法抛 `Error("ENOTSUP")`; 不静默假装成功。
3. **配置收敛**: 目标差异全部收敛在三处 —
   板型 Kconfig (`PixelBox Board`)、目标叠加配置
   (`sdkconfig.defaults.esp32c6/esp32p4`, IDF 原生按目标叠加机制)、
   各组件 Kconfig 的按目标默认值 (`default … if IDF_TARGET_*` / `!SPIRAM`)。

## 2. ESP32-C6 (单核 RISC-V 160MHz, ~512KB HP SRAM, 无 PSRAM, 8MB Flash)

### 2.1 板型: BOARD_GENERIC_SPI (默认)

通用 SPI 屏板型: 任意 C6 开发板 + ST7789 240×240 TFT (单线 SPI,
IDF `esp_lcd` 内置 `esp_lcd_new_panel_st7789`, 无额外组件依赖)。
引脚全部 Kconfig (`menuconfig → PixelBox Board`), 默认值:
SCLK=6 / MOSI=7 / CS=18 / DC=19 / RST=20 / BL=21 (LEDC PWM 调亮度),
色彩反转/BGR/面板偏移均可配。板上无触摸/IMU/PMU/codec,
`system.info().capabilities` 对应位如实 false, `battery()` 返回 level=-1。

### 2.2 内存策略 (核心差异: 无 PSRAM)

所有"大缓冲优先 PSRAM"的分配统一经 `hal_common/px_alloc.h` 的
`px_alloc_prefer_psram()` 系列 (v2 起替换散落的 heap_caps 双写):
`CONFIG_SPIRAM` 关闭时直接落内部堆, 开启时 PSRAM 优先、耗尽回退。

**显示帧缓冲**: 全屏逻辑帧缓冲仅在小分辨率可行 (240×240×2 = 112.5KB);
QSPI 后端的"整帧中转缓冲"策略在 C6 上不可承受, 因此 SPI 后端改为
**行带 (strip) flush**: 中转缓冲只有 `面板宽 × CONFIG_PX_DISPLAY_STRIP_LINES(默认40) × 2B`,
脏矩形按行带分段 gather → `draw_bitmap` → 等 DMA, 以 18.75KB 常驻替代整帧 112.5KB。

**内存预算表 (C6, 512KB HP SRAM, 实测静态占用见 firmware/README.md)**:

| 项目 | 预算 | 说明 |
|---|---|---|
| 静态 DIRAM (.text/.bss/.data) | 205.5KB (45%) | 整包实测 (idf.py size), 余 246.6KB |
| 逻辑帧缓冲 | 112.5KB | 240×240 RGB565, px_alloc → 内部堆 (运行期) |
| 行带中转缓冲 | 18.75KB | 40 行, DMA 内部内存 (运行期) |
| js_task 栈 | 32KB | 内部 RAM (littlefs 读写约束, 同 S3) |
| JS 堆上限 | 256KB | `CONFIG_JSVM_MEM_LIMIT_KB` 按 `!SPIRAM` 默认收缩 |

> JS 堆 256KB 是 QuickJS 分配上限而非预分配。静态占用后内部堆余
> 246.6KB, 扣除帧缓冲 (112.5+18.75KB)、js_task 栈与 WiFi/LWIP 运行期
> 缓冲后, JS 实际可用约 60-90KB —— 上限刻意设高给"关屏跑逻辑"类
> 场景留空间, 图形应用应控制画布数量; 内存吃紧时可调小
> `PX_DISPLAY_STRIP_LINES` 或降低分辨率板配。

### 2.3 音频 / esp-sr 裁剪

C6 目标 `CONFIG_PX_ENABLE_AUDIO` **默认 n** (`hal_audio/Kconfig`):
hal_audio 不编译源文件, bindings_audio/voicechat 编 ENOTSUP 桩
(px.audio/px.voice API 表面保留), esp_codec_dev / esp_audio_codec /
esp-sr / esp_websocket_client(voice) 不参与链接。唤醒词
`PX_ENABLE_WAKEWORD` 依赖 `PX_ENABLE_AUDIO` (esp-sr 官方有 C6 预编译库,
如需在 C6 开音频可手动打开, 注意内部内存预算)。

### 2.4 分区表 (8MB, partitions_8mb.csv)

OTA 双分区收缩为 3.25MB ×2 + storage 1.375MB (16MB 表为 6MB ×2 + 3.8MB);
nvs/otadata/phy 偏移与 16MB 表一致。C6 整包 (WiFi6 + NimBLE, 无音频栈)
实测 ≈2.88MB, 分区余量 11% (见 README size 报告); 需要更大余量时优先
裁 mbedTLS 完整证书包或关 BLE。

## 3. ESP32-P4 (双核 RISC-V 360MHz, 有 PSRAM, 无片上 WiFi/BT)

### 3.1 板型: BOARD_HEADLESS (默认)

P4-Function-EV 裸板调试: 无屏, `px.screen` 全部抛 ENOTSUP
(`hal_display_none.cpp` 后端, `init()` 返回 `ESP_ERR_NOT_SUPPORTED`,
bindings_screen 据 `ready()==false` 走契约行为), `system.info().screen`
为 0×0。接 SPI 屏时可改选 `BOARD_GENERIC_SPI` (后端通用)。

### 3.2 网络: 无片上 WiFi/BT 的条件编译

以 `CONFIG_SOC_WIFI_SUPPORTED` (soc caps, P4 = n) 为唯一开关,
CMake 源文件级切换 + 桩实现 (REQUIRES 不允许依赖 CONFIG, 保持无条件;
esp_wifi 组件在 P4 上退化为仅头文件/netif 绑定, 依赖可保留):

| 组件 | P4 行为 |
|---|---|
| hal_net | `wifi_manager_stub.cpp`: 接口一致, 全部 `ESP_ERR_NOT_SUPPORTED`; net_poll (纯 lwip) 保留 |
| bindings_net | `mod_net_stub.cpp`: px.wifi / px.net / fetch / WebSocket / ntpSync / otaCheck / otaApply 按 d.ts 注册 ENOTSUP 行为; `px.wifi.status()` 如实返回未连接快照 (mac = eFuse 基础 MAC) |
| devd | `devd_stub.cpp`: `devd_start()` 记录一条日志后返回 ESP_OK — **跳过启动、不报错**, mDNS 不注册 |
| px.ble | `board_caps().ble=false` (无 NimBLE), `available()` 返回 false |
| deviceId | `mod_system` 用 `ESP_MAC_BASE` 派生 (无 WiFi MAC) |

### 3.3 TODO: esp_hosted 联网 (P4 + C6 组合)

P4 官方联网方案是 **esp_hosted-mcu**: P4 作 host, 板载 ESP32-C6-MINI-1
作 WiFi/BT co-processor (P4-Function-EV 板已含), 经 `esp_wifi_remote` +
`esp_hosted` 组件走 SDIO 转发, esp_wifi API 对上层透明。接入路径:

1. `bindings_net/idf_component.yml` 增加 `espressif/esp_wifi_remote` +
   `espressif/esp_hosted` (仅 P4 目标, 组件 manifest `rules: if target`);
2. 条件编译开关由 `CONFIG_SOC_WIFI_SUPPORTED` 扩展为
   `CONFIG_SOC_WIFI_SUPPORTED || CONFIG_ESP_WIFI_REMOTE_ENABLED`,
   hal_net/bindings_net/devd 切回真实实现;
3. 验证 devd/mDNS/OTA 全链路 (esp_hosted 的 SDIO 吞吐足够 devd 推送)。

在此之前 P4 无网络, 应用推送用 USB 串口烧录 (`idf.py -B build_p4 flash`)。

### 3.4 其余能力

- PSRAM: EV 板 32MB HEX PSRAM (`sdkconfig.defaults.esp32p4`:
  `SPIRAM_MODE_HEX` + 200MHz), JS 堆默认 4MB, px_alloc 优先 PSRAM;
- 音频: `PX_ENABLE_AUDIO` 默认 y (P4 I2S 可用), HEADLESS 板无 codec →
  能力位 mic/speaker=false, `hal_audio::init_from_board()` 如实返回
  NOT_SUPPORTED; 接 ES8311 板可在自定义板型中启用;
- esp-sr 官方提供 P4 预编译库, 唤醒词路径与 S3 相同 (需 model 分区)。

## 4. quickjs-ng 在 RISC-V GCC 下的告警

quickjs-ng (vendored, v0.10.1) 的编译告警抑制集中在
`firmware/components/jsvm/CMakeLists.txt` 的 `set_source_files_properties`:
xtensa GCC14 需要 `-Wno-error=incompatible-pointer-types` (int32_t=long 差异);
RISC-V GCC14 (C6/P4) 实测复用同一组抑制即可整包编译, 如后续 IDF 升级引入
新告警, 在同一处按需追加 (保持与 xtensa 注释同风格说明原因)。

## 5. 新增/修改文件速查

- 板型: `firmware/components/boards/{Kconfig, CMakeLists.txt, src/board_generic_spi.c, src/board_headless.c}`
- 显示后端: `firmware/components/hal_display/{Kconfig, src/hal_display_st7789.cpp, src/hal_display_none.cpp}`
- 网络桩: `firmware/components/hal_net/src/wifi_manager_stub.cpp`,
  `firmware/components/bindings_net/src/mod_net_stub.cpp`,
  `firmware/components/devd/src/devd_stub.cpp`
- 音频桩: `firmware/components/bindings_audio/src/bindings_audio_stub.cpp`,
  `firmware/components/voicechat/src/bindings_voice_stub.cpp`
- 分配辅助: `firmware/components/hal_common/include/hal_common/px_alloc.h`
- 目标配置: `firmware/sdkconfig.defaults.esp32c6`, `firmware/sdkconfig.defaults.esp32p4`,
  `firmware/partitions_8mb.csv`
