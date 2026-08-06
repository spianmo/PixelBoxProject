# PixelBox 固件 (ESP-IDF v5.5)

多目标固件工程(esp32s3 默认 / esp32c6 / esp32p4):QuickJS-ng JS 运行时
+ 应用热更新 + devd 开发服务。多目标能力矩阵见 docs/architecture.md §3.1,
C6/P4 落地细节见 docs/hardware/multi-target.md,构建命令与实测见下文「多目标构建」。

## 目录结构

```
firmware/
├── CMakeLists.txt         # 工程入口 (PROJECT_VER = 固件版本)
├── partitions.csv         # 分区表: OTA 双分区 + littlefs storage
├── partitions_wakeword.csv# 唤醒词构建分区表 (storage 压缩, 尾部加 model 分区)
├── sdkconfig.defaults     # esp32s3 / 16MB Flash / Octal PSRAM 默认配置
├── sdkconfig.wakeword     # 唤醒词叠加配置 (见「启用唤醒词」)
├── main/                  # app_main: 板级初始化 → appmgr → devd → jsvm
└── components/
    ├── hal_common/        # 板级抽象接口 (纯头文件, 无依赖)
    ├── boards/            # 板型实现 (Kconfig 选择) + AXP2101/TCA9554 驱动
    ├── jsvm/              # QuickJS-ng 集成 + JS 事件循环 + 模块注册表
    ├── appmgr/            # littlefs 挂载 + 应用包管理 + 热更新原子切换
    ├── devd/              # 开发服务: WS :8765/devd + mDNS + 日志广播
    └── ...                # hal_display / bindings_* 等 (其他领域组件)
```

## 环境准备

1. 安装 [ESP-IDF v5.5](https://docs.espressif.com/projects/esp-idf/zh_CN/v5.5/esp32s3/get-started/index.html) 并 `. ./export.sh`。
2. 拉取 vendored 依赖 (quickjs-ng v0.10.1):

```bash
../tools/fetch_deps.sh
```

## 构建与烧录

```bash
cd firmware
idf.py set-target esp32s3
idf.py build

# 烧录 + 串口监视 (板载 USB-C 即 USB-Serial-JTAG)
idf.py -p /dev/cu.usbmodem* flash monitor
```

首次烧录后 `storage` 分区为空,固件会自动格式化 littlefs 并运行内置欢迎应用;
之后用 SDK CLI 推送应用即可热更新(无需重新烧录):

```bash
pixelbox push            # 自动 mDNS 发现设备
pixelbox dev             # watch 构建 + 自动推送 + 日志
```

## 板型选择

`idf.py menuconfig` → `PixelBox Board`:

- `BOARD_WAVESHARE_AMOLED_18`(esp32s3 默认):微雪 ESP32-S3-Touch-AMOLED-1.8
- `BOARD_CUSTOM_V1`:定制 PCB(Stage B,引脚在 Kconfig 中配置;仅 esp32s3)
- `BOARD_GENERIC_SPI`(esp32c6 默认):通用 SPI 屏(ST7789 240x240,
  引脚全 Kconfig;无触摸/IMU/PMU,能力位如实 false)
- `BOARD_HEADLESS`(esp32p4 默认):无屏调试板(px.screen 抛 ENOTSUP)

所有引脚都收敛在 `components/boards`,其他组件一律通过
`hal_common/board.h` 的 getter 获取,禁止硬编码引脚。

## 多目标构建 (esp32c6 / esp32p4)

三个目标共用一套源码,能力按芯片诚实降级(矩阵见 docs/architecture.md §3.1,
细节见 docs/hardware/multi-target.md)。目标差异走 IDF 原生
`sdkconfig.defaults.<target>` 叠加机制;独立构建目录 + 显式 `-D SDKCONFIG`
(避免改写默认 S3 构建的 `./sdkconfig`),以下命令均已实测:

```bash
cd firmware

# ESP32-C6 (8MB Flash, 无 PSRAM; 板型默认 BOARD_GENERIC_SPI, ST7789 240x240)
idf.py -B build_c6 -D SDKCONFIG=build_c6/sdkconfig set-target esp32c6 build

# ESP32-P4 (16MB Flash + PSRAM, 无片上 WiFi/BT; 板型默认 BOARD_HEADLESS)
idf.py -B build_p4 -D SDKCONFIG=build_p4/sdkconfig set-target esp32p4 build
```

要点:

- **C6**:无 PSRAM → JS 堆默认收缩为 256KB(内部堆,`CONFIG_JSVM_MEM_LIMIT_KB`
  按 `!SPIRAM` 取默认);显示走 ST7789 SPI 后端 + 行带 flush(中转缓冲
  18.75KB 替代整帧 112.5KB,`CONFIG_PX_DISPLAY_STRIP_LINES`);音频栈
  `PX_ENABLE_AUDIO` 默认关(px.audio/px.voice 注册 ENOTSUP 桩,
  esp_codec_dev/esp_audio_codec/esp-sr 不参与链接);分区表
  `partitions_8mb.csv`(OTA 双分区收缩为 3.25MB)。
- **P4**:无片上 WiFi/BT → `CONFIG_SOC_WIFI_SUPPORTED=n` 条件编译:
  hal_net/bindings_net 切换 ENOTSUP 桩(px.wifi/px.net/fetch/WebSocket
  按 d.ts 契约注册,status() 如实返回未连接),devd/mDNS 跳过启动不报错;
  联网需 esp_hosted(P4+C6 组合)——TODO 见 docs/hardware/multi-target.md §3.3。
- **S3 零回归**:默认 `idf.py build` 产物与改造前一致(见下表)。

### 多目标实测 (2026-08-06, ESP-IDF v5.5, 整包编译)

| 项目 | esp32s3 (build/) | esp32c6 (build_c6/) | esp32p4 (build_p4/) |
| --- | --- | --- | --- |
| 板型 | WAVESHARE_AMOLED_18 | GENERIC_SPI (ST7789) | HEADLESS |
| `pixelbox.bin` | 2,728,560 B (0x29A270) | 3,018,672 B (0x2E0FB0) | 2,326,576 B (0x238030) |
| app 分区 / 余量 | 6MB / 57% | 3.25MB / 11% | 6MB / 63% |
| Flash .text | 1,836,032 B | 2,132,862 B | 1,574,442 B |
| Flash .rodata | 728,604 B | 715,360 B | 643,728 B |
| 静态 DIRAM | 179,291 B (52.5%) | 205,491 B (45.5%, 余 246,621 B) | 126,967 B (22.0%, 余 449,497 B) |
| JS 堆默认 | 4096KB @PSRAM | 256KB @内部堆 | 4096KB @PSRAM |
| 帧缓冲策略 | 整帧中转 @PSRAM (322KB×2) | 行带 flush (FB 112.5KB + 行带 18.75KB, 内部堆) | 无屏 |
| WiFi / BLE | ✅ / ✅ | ✅ / ✅ | ENOTSUP 桩 / 无 |
| 音频栈 | ✅ | 裁剪 (ENOTSUP 桩) | 编译在, 板无 codec |

C6 内存预算:静态 DIRAM 205.5KB 后余 246.6KB,运行期再扣帧缓冲
112.5KB + 行带 18.75KB + js_task 栈 32KB 与 WiFi/LWIP 缓冲;JS 堆 256KB
为上限而非预分配,图形应用实际可用约 60-90KB(详见
docs/hardware/multi-target.md §2.2 预算表与调优项)。S3 基线与改造前
一致(2,728,560 B vs 基线 2,728,416 B,差 +144 B ≈ 0.005%,为
wifi_manager strncpy→memcpy 修正所致)。

## 启用唤醒词 (esp-sr WakeNet)

默认构建不含唤醒词:esp-sr 为 voicechat 的常驻依赖,但无符号被引用时被
链接器整库裁剪(已复核 map,esp-sr/esp-dsp/dl_fft 对默认镜像贡献为零字节)。
启用需用独立构建目录 + 叠加配置(以下命令均已实测):

```bash
cd firmware
idf.py -B build_wakeword \
       -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.wakeword" \
       -D SDKCONFIG=build_wakeword/sdkconfig \
       build

# 烧录 + 监视 (flash 目标已自动包含 srmodels.bin → model 分区 @0xF98000)
idf.py -B build_wakeword -p /dev/cu.usbmodem* flash monitor
```

要点:

- `-D SDKCONFIG=build_wakeword/sdkconfig` **必须显式指定**,否则会改写默认
  构建共用的 `./sdkconfig`;两套构建目录互不干扰,可并存。
- `sdkconfig.wakeword` 做三件事:`PX_ENABLE_WAKEWORD=y`(编译 wakeword.cpp
  的 wakenet 路径)、切换 `partitions_wakeword.csv`、选择 wn9 模型。
- 分区表差异仅为 `storage` 压缩 352KB 腾出 `model` 分区;app/nvs/otadata
  布局与默认表一致,**两种固件可互相 OTA**(见 docs/architecture.md §4.2)。
- 模型打包走 esp-sr 官方机制:分区表存在名为 `model` 的分区时,esp-sr 构建
  系统自动把 menuconfig 所选模型打包为 `srmodels.bin` 并挂入 flash 目标,
  无需手工烧录。
- 更换唤醒词:`idf.py -B build_wakeword menuconfig` → `ESP Speech
  Recognition` → `Load Multiple Wake Words (WakeNet9)`(默认"Hi,乐鑫"
  `wn9_hilexin`);选更大的模型时注意同步扩大 `model` 分区并保留 ~20% 余量。
- 组件注册表不稳(首次配置报 "Server returned invalid or empty JSON")时,
  前缀 `IDF_COMPONENT_STORAGE_URL=https://components-file.espressif.cn` 重试。
- JS 侧行为:`px.voice.configure({serverUrl, wakeword:true})` 后 idle 态
  待机侦听,命中 → `'wake'` 事件 → 自动进入 listening;`stop()` 同时停止
  侦听。未烧录 model 分区或 PSRAM 不足时投递 `error` 事件并降级为手动模式
  (其余 px.voice 功能不受影响)。

### 实测数据 (2026-08-05, ESP-IDF v5.5, esp-sr v2.4.7)

| 项目 | 默认构建 (build/) | 唤醒词构建 (build_wakeword/) |
| --- | --- | --- |
| `pixelbox.bin` | 2,728,480 B (0x29A220) | 2,840,256 B (0x2B56C0), +111,776 B (+4.1%) |
| 6MB app 分区余量 | 3,563,040 B (57%) | 3,451,200 B (55%) |
| Flash Code (.text) | 1,836,032 B | 1,930,684 B |
| Flash Data (.rodata) | 728,524 B | 736,220 B |
| DIRAM | 179,291 B (52.5%) | 188,755 B (55.2%, 余 153,005 B) |
| `srmodels.bin` (wn9_hilexin) | — | 291,149 B |
| `model` 分区 | — | 352KB @0xF98000, 余 69,299 B (23.8%) |
| `storage` 分区 | 3904KB | 3552KB |

默认构建加入 esp-sr 常驻依赖后体积不受影响(与启用依赖前基线 2,728,416 B
相比 +64 B ≈ 0.002%,map 中无任何 esp-sr 贡献);唤醒词构建的 wakenet 运行
时工作区走 PSRAM(初始化失败自动降级),`rm -rf build_wakeword` 后按上述
命令重建已验证可复现(产物字节数一致)。

## 常用调试

- devd 开发服务:`ws://<设备IP>:8765/devd`(JSON 协议见 docs/architecture.md §5)
- mDNS 发现:`_pixelbox._tcp`(TXT 携带 model/fw/app)
- REPL:通过 devd `js.eval` 方法直接在设备 JS 环境求值

## 附录: 固件体积报告 (idf.py size / size-components)

> 2026-08-05 真机整包编译 (ESP-IDF v5.5, target=esp32s3, 默认板型
> `BOARD_WAVESHARE_AMOLED_18`, `-O2`, BLE NimBLE 已启用)。

### 二进制与分区余量

| 项目 | 数值 |
| --- | --- |
| `pixelbox.bin` | 0x29A1E0 (2,728,416 字节, 约 2.60 MB) |
| 应用分区 (ota_0/ota_1) | 各 0x600000 (6 MB) |
| 分区余量 | 0x365E20 (3,563,040 字节, 57% free) |
| bootloader.bin | 0x5760 (32% free) |

### 内存段占用 (idf.py size)

| 段 | 已用 | 占比 | 备注 |
| --- | --- | --- | --- |
| Flash Code (.text) | 1,835,968 B | — | |
| Flash Data (.rodata) | 728,524 B | — | |
| DIRAM | 179,291 B | 52.5% | 余 162,469 B |
| IRAM | 16,384 B | 100% | .text 15,356 + .vectors 1,028 (固定段) |
| RTC FAST | 112 B | 1.4% | |

### 主要组件贡献 (idf.py size-components, Top 15)

| 归档 | 总计 (字节) | 说明 |
| --- | --- | --- |
| libjsvm.a | 510,674 | QuickJS-ng 运行时 (最大单项) |
| libhal_display.a | 302,548 | 绘图引擎 + 内嵌像素字体 + 图片解码 |
| libesp_app_format.a | 199,778 | 含 mbedTLS CA 证书包 rodata |
| libnet80211.a | 155,010 | WiFi MAC |
| liblwip.a | 103,259 | TCP/IP |
| libmbedtls.a | 97,752 | TLS |
| libc.a | 93,973 | newlib |
| libbtdm_app.a | 92,704 | BT 控制器 |
| libbt.a | 88,414 | NimBLE 主机栈 |
| libmbedcrypto.a | 83,497 | 加密原语 |
| libbindings_net.a | 73,502 | px.net/http/ws/mqtt 绑定 |
| libesp_new_jpeg.a | 70,661 | JPEG 编解码 |
| libpp.a | 64,132 | WiFi PHY 协议处理 |
| libwpa_supplicant.a | 63,117 | WPA |
| libbindings_periph.a | 46,863 | px.gpio/led/ble 等绑定 |

结论: 开启 BLE (NimBLE) 后整包 2.60 MB, 6 MB OTA 分区仍有 57% 余量,
`-O2` 无需降级; IRAM 为固定大小段, DIRAM 余量充足 (约 159 KB), JS 堆
与大缓冲均走 8 MB Octal PSRAM, 无 iram/flash 压力。
