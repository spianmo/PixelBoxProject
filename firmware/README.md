# PixelBox 固件 (ESP-IDF v5.5)

ESP32-S3 固件工程:QuickJS-ng JS 运行时 + 应用热更新 + devd 开发服务。

## 目录结构

```
firmware/
├── CMakeLists.txt         # 工程入口 (PROJECT_VER = 固件版本)
├── partitions.csv         # 分区表: OTA 双分区 + littlefs storage
├── sdkconfig.defaults     # esp32s3 / 16MB Flash / Octal PSRAM 默认配置
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

- `BOARD_WAVESHARE_AMOLED_18`(默认):微雪 ESP32-S3-Touch-AMOLED-1.8
- `BOARD_CUSTOM_V1`:定制 PCB(Stage B,引脚在 Kconfig 中配置)

所有引脚都收敛在 `components/boards`,其他组件一律通过
`hal_common/board.h` 的 getter 获取,禁止硬编码引脚。

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
