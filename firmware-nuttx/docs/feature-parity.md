# ESP32-S3-Touch-AMOLED-2.16 能力对照与验收范围

更新日期：**2026-10-02**。当前最新验收镜像为 **flash16a**；flash13 已通过正常热推送及三种中止/断线回滚。
flash16a 在真实 Obeing 内两轮语音双工通过，公开麦克风连续采集各约20秒且峰值为109/129；手机协议回归通过（166个上行包、播放后恢复采音）。
flash15 的全零采音与 `EOVERFLOW` 保留为历史失败证据，不能覆盖 flash16a 的新镜像结果。
物理亮屏、声学效果和生产语音服务尚未确认。本文区分源码、宿主、特定镜像真机测试和实际外设效果；
旧镜像的失败不自动成为新镜像现状，旧镜像的通过也不自动覆盖新源码。

`capabilities.* = true`、I²C 探测、`/dev/fb0` 注册、非零 PCM 和编译成功均不等于外设效果通过。
下述函数名用于定位实现；源码持续变更时以函数名检索最新行号。未把本地 Wi-Fi 凭据写入本文。

## 本板硬件基线

原 ESP-IDF 的板定义是 `firmware/components/boards/src/board_waveshare_amoled_216.c`：

| 外设 | 原板配置依据 | 当前 NuttX 对应入口 |
| --- | --- | --- |
| CO5300 AMOLED | `s_display:33`；480×480，QSPI CS12/CLK38/D0–D3=4/5/6/7，RST39 | `firmware-nuttx/boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_co5300.c#pixelbox_board_display_initialize:163` |
| ES8311 播放、ES7210 采集 | `s_audio:50`；I2S MCLK42/BCLK9/WS45/DOUT8/DIN10，功放使能46 | `pixelbox_board.c#pixelbox_es8311_register:77`、`pixelbox_board_mic_prepare:204`；GPIO 见 `firmware-nuttx/configs/esp32s3.config:83` |
| CST9220 触摸 | `s_touch:69`，0x5A，INT11/RST40 | `pixelbox_board.c#pixelbox_board_touch_read:497` |
| QMI8658 IMU | `s_imu:75`，0x6B，INT17/21 | `pixelbox_board.c#pixelbox_qmi8658_configure:264`、`pixelbox_board_imu_read:458` |
| AXP2101 电源/电池 | 原板 `axp2101_init` 与 I2C 总线配置 | `firmware-nuttx/src/power.c#px_power_init:153`、`px_power_read_battery:196` |
| PCF85063 RTC | `s_rtc:81`，0x51 | 原板有器件配置，原 SDK 与本次 NuttX 路径均未确认实际 RTC 消费实现；不能记作原 SDK 已完成而迁移丢失 |
| 摄像头、GPS、LED | `s_caps:91` 明确 `camera=false/gps=false/led=false` | 继续不支持，属于原板能力基线 |

上表缩写 `pixelbox_board.c` 均指
`firmware-nuttx/boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_board.c`。
共享 I2C 引脚为 SDA15/SCL14，见原板 `s_i2c:62`。

## 功能对照

| 能力 | 原 ESP-IDF 依据 | 当前 NuttX 接线与真实状态 |
| --- | --- | --- |
| JS、工具、定时器、存储 | `firmware/components/jsvm/` 与 SDK prelude | 已接线；最新宿主runtime30项通过。flash13真实JS、KV跨VM restart、stop/restart及恢复Obeing通过 |
| 启动、USB 串口、ROM 刷写 | USB Serial/JTAG、ROM下载器 | flash13/14/15/16a整镜像flash校验通过且回到应用。flash16a 通过软件复位启动并保留 LittleFS；不能据此声称所有复位原因已消除 |
| devd、应用热推送、VM监督 | `firmware/components/devd/src/devd.cpp` | flash13正常推送74,951字节Obeing应用、SHA核对及不复位通过；显式中止、上传断线、prepare阶段断线三种回滚均恢复原SHA且boot不变。flash12 push watchdog是历史失败；未覆盖掉电写入等全部故障 |
| Wi-Fi station | `hal_net/src/wifi_manager.cpp` | station、binding/prelude已接；flash13/14在应用恢复、BLE和录放测试后保持联网。无线切换/长时断网恢复未全验收 |
| TCP/UDP/TLS、HTTP、WS | 原网络bindings | flash13基础HTTP/WS/HTTPS200通过；flash14真实Obeing内WS、NTP后HTTPS200通过。多地址连接回退修复后已有成功证据，仍不等于全部地址/超时/TLS场景通过 |
| mDNS/DNS-SD | `mod_net.cpp`、`devd.cpp#mdns_setup` | `mdns.c` 与 devd/runtime 已接；flash12 设备发现 Mac 服务、Mac Bonjour 发现 devd 通过。旧 P13 另有端口/TXT、广播停止 goodbye、跨 VM 生存记录；未把旧用例全部继承到 flash12 |
| 字体、PNG/JPEG/GIF、Canvas、点云投影 | 原jsvm/graphics | 原生混合/投影/批量矩形已上板；Float32/像素/缓冲/中断宿主专项通过。flash14含framebuffer dirty更新；软件性能改进不代表物理画面已验收 |
| 显示、亮度、旋转、屏幕电源 | 原 CO5300 与板定义 | `pixelbox_co5300.c`、`framebuffer.c` 已接，flash12 软件屏幕480×480。首帧/驱动状态是软件证据；**物理亮屏、颜色、旋转和可见刷新效果未确认** |
| 触摸、IMU | 原 CST9220、QMI8658 实现 | flash12 触摸订阅成功、IMU连续10次读数有变化；实体触摸、手势、多点和姿态准确性未验收 |
| 电池、电源键、设置 | 原 `boards/src/axp2101.c` 和系统按键 | `power.c`、`system_keys.c`、settings/service 已接。flash12 电池读数100%/4180mV；设置VM切换有宿主验证，实体按键效果未确认 |
| 播放、解码 | 原`hal_audio` | flash13基础tone/local say/duplex完成；flash16a真实Obeing local say与两轮voice duplex通过。扬声器声学和全部文件解码未确认 |
| 麦克风、speech/voice | 原`bindings_speech`、`voicechat`、ES7210 | flash16a公开mic两轮各160帧/655360字节、20.50/20.48秒、峰值109/129、结束active=false；内建voice duplex两轮均通过。手机协议上行166包（170980字节/339968样本），播放后恢复采音，配对数据恢复。flash15的峰值0与EOVERFLOW仅为旧镜像失败；生产云端STT仍未验证 |
| NTP、芯片温度 | 原`mod_system_net.cpp`等 | 已接线；flash13一个NTP地址先超时、后续地址成功，flash14NTP和HTTPS200通过；不能抹去首次地址失败。温度早期真机已读，全部时钟/证书边界未全验收 |
| BLE | 原`ble_hal.cpp`、`mod_ble.cpp` | flash13基础scan18/广播startstop及有限录放通过；flash14原应用scan25、广播startstop、local say通过。对端收到广播、GATT和全部长时并发未验收 |
| 本地 MultiNet7 | 原 `bindings_speech/src/speech_engine.cpp#Engine::wake` | `INTERPRETERS_PIXELBOX_MULTINET7`默认关闭；专用`esp32s3-multinet7` profile、Make/runtime和真实模型准备已接。最新独立Xtensa整机镜像6,237,192字节链接成功；内存故障/worker/JS专项通过。**未烧录、未验证真机推理和实际峰值**，见[移植记录](multinet7-port.md) |
| SoftAP、网页配网 | 原 `mod_wifi.cpp#js_start_ap`、`wifi_portal.cpp#start` | 门户Kconfig默认关闭；Make/CMake/runner的APSTA+DHCP、settings/service已显式接线。ON/OFF宿主、真实SDK/devd/QuickJS/HTTP与线程故障注入UBSan通过，模块Xtensa编译通过。**门户APSTA整机链接/真机配网未验证**；公共`px.wifi.startAP`仍ENOTSUP |
| 深睡眠 | 原 `mod_system.cpp` 调 `esp_deep_sleep_start()` | `TIMED_SLEEP`默认关闭；独立无无线profile及定时1..86400000ms入口已接，宿主service/真实SDK/运行时门禁通过。无线固件即使开启入口仍明确ENOTSUP，不能停稳Wi-Fi/BLE前进入睡眠；清理10秒观察超时拒绝请求。**无真机睡眠/唤醒验收**，不依赖用户按键恢复 |
| 固件 OTA | 原 `mod_system_net.cpp#js_ota_check/js_ota_apply` | 只读`otaCheck`已接，flash12从本机清单取得版本/URL/说明且宿主6项通过；不下载/写入镜像。`otaApply`仍ENOTSUP，Simple Boot数据布局尚无安全双槽升级。应用push不等于固件OTA |

NuttX 的未写完整路径文件均相对 `firmware-nuttx/src/`；原网络绑定相对
`firmware/components/bindings_net/src/`。默认关闭的独立profile不计入已验收主固件功能。

## flash13/14/15/16a 真机证据与当前失败

归档位于`tmp/recovery-20261002-flash-13/`、`tmp/recovery-20261002-flash-14/`、`tmp/recovery-20261002-flash-15/`和`tmp/recovery-20261002-flash-16a/`；四份镜像重新计算
文件SHA/长度均匹配`state.json`，各自`verify.log`记录地址0起全镜像`verify OK (digest matched)`。

| 镜像 | 字节数 | 完整文件SHA-256 |
| --- | ---: | --- |
| flash13 | 3,413,128 | `a95024e825d0cb096c6ab41ba65bb1487a14b42e2ba1a8c18966673b9b69339f` |
| flash14 | 3,413,840 | `1aaf815340cedc92972fb53a1cec0446aa6e1fe2ba3b8c855a48f874705e1f8d` |
| flash15 | 3,413,376 | `6148064de5a0c34b00f54d41d441e7b1f8b6466e7fb1e90fbea8387c27924dcb` |
| flash16a | 3,414,168 | `fbe78dbb6fbc9e6dfad119192c3cc0efecf4fb46785edb53ae6d916a4c0201b9` |

| 日志 | 可确认结果 | 限制/失败 |
| --- | --- | --- |
| flash13 `acceptance.log` | HTTP、WS、只读OTA、IMU、触摸订阅、tone、两次短mic、后续NTP/HTTPS200、BLE scan18/startstop、local say/duplex、KV/VM生命周期及恢复Obeing | 首个NTP地址超时；最小验收应用、本机relay、软件触摸订阅不等于完整产品验收 |
| flash13 `push-optimized-obeing.log` | 真正推送74,951字节；应用SHA匹配、应用恢复、`reset:false` | 不代表全部flash掉电/存储故障恢复 |
| flash13 `push-rollback.log` | 写入1024字节后中止、上传连接断开、prepare未返回时断开均恢复原Obeing SHA；staging不存在、boot不变；prepare期间另一个连接hello约1ms | 三个实际场景通过，不扩展为任意并发负载均有相同响应时间 |
| flash14 `obeing-audio.log` | 真实Obeing中WS、NTP、HTTPS200、BLE scan25/广播startstop、local say通过；公开mic两轮各160帧/655360字节、20.58/20.73秒、峰值137/101、结束active=false | **voice双工两轮均`microphone capture failed: EOVERFLOW`**；公开mic成功不能覆盖它。日志末应用仍在 |


| flash15 `obeing-audio-ready.log` | local say完成；两轮mic各160帧/655360字节、20.60/20.58秒、结束active=false | 两轮mic峰值均0；voice双工两轮仍EOVERFLOW，不能记作有效采音或双工通过 |
| flash15 `voice-profile.log` | 采音轮询14次共8860ms、最大880ms；其他音频timer最大10ms | voice双工仍两轮EOVERFLOW；计时只定位消费者路径成本，不代替音频质量验证 |
| flash15 `obeing-phone.log` | 手机中继模拟触发原Obeing采音 | 首次采音EOVERFLOW，上行/完整手机会话未通过 |
| flash16a `obeing-audio.log` | WS、NTP、HTTPS200、BLE scan17/广播startstop、local say；两轮voice duplex均为`["thinking","speaking","idle"]`；公开mic两轮各160帧/655360字节、20.50/20.48秒、峰值109/129、结束active=false | 仅证明本机回环与设备音频链路；扬声器声学、生产云端STT未验证 |
| flash16a `obeing-phone.log` | 手机协议三次认证/采音启动；上行166包、170980字节、339968样本；`AUDIO_PLAYED`后恢复采音；最终`PASS`，`played=true`、`resumed=true`、`micStarts=5`，并恢复原配对数据 | 使用本机协议测试服务，`cloud=false`；不等于生产云端服务验收 |

flash13仅降低渲染FPS未解决采音；flash14加入C同率采样提取、JS同率批量合帧/录音和原生RMS后，
公开mic持续采集通过。flash15加入TTS同率批量与原生ADPCM后仍出现队列溢出和全零采音。后续镜像
flash16a 的语音双工、连续公开mic与手机协议均通过，证明该版本已消除上述真机失败；flash15日志仍保留
作回归对照。物理亮屏、声学效果和生产云端STT仍需独立验收。

## 关键宿主证据与复现

完整独立host CTest **5/5**（runtime30项、OTA6项和默认关闭门禁）通过。原生图形UBSan包含
TypedArray偏移/分离、Float32及半像素舍入、400组Canvas像素对照和不可catch的40ms原生绘制超时。
音频17项mic、15项voice、9项speech契约、真实采集worker测试通过；RMS 500组及ADPCM 600组
对原数学/字节定义完全等价，含offset/detach/输入不变。采集新增批量跨ring有序测试，voice验证批量/单帧
PCM与VAD等价、精确240ms打断和回调重开隔离；真实QuickJS/POSIX/WS回环120000字节有序、
背压、排空及取消通过，音频DMA为替身。门户32KiB控制栈宿主guard/sentinel压力通过，最低余12136字节；
不等于Xtensa高水位。最新MN7独立镜像已链接/校验，未烧录，详见[MultiNet7](multinet7-port.md)。

```sh
ctest --test-dir tmp/projection-review-host-20261002 --output-on-failure --timeout 60
python3 firmware-nuttx/tests/test_mic_binding.py --quickjs-library tmp/sleep-host-enabled-20261002/libpixelbox_quickjs.a --sanitize undefined
python3 firmware-nuttx/tests/test_audio_binding.py --quickjs-library tmp/sleep-host-enabled-20261002/libpixelbox_quickjs.a --sanitize undefined
python3 firmware-nuttx/tests/test_voice_loopback.py tmp/sleep-host-enabled-20261002/libpixelbox_quickjs.a
python3 firmware-nuttx/tests/test_portal_stack.py tmp/sleep-host-enabled-20261002/libpixelbox_quickjs.a
```

同宿主QuickJS固定输入，16k公开mic合帧约45.7倍、ADPCM约118.8倍、Obeing图形路径约17.9倍加速。
后续100秒PCM的真实QuickJS语音consumer基准118.210ms→31.324ms（约3.77倍），跨语言帧10000→1000；
驱动为替身，见`tmp/mic-batch-benchmark-20261002/results.json`。这些是CPU路径对比，**不是MCU FPS或完整语音吞吐**；原始脚本与日志分别保存于
`tmp/mic-same-rate-benchmark-20261002.*`、`tmp/adpcm-benchmark-20261002.*`、
`tmp/projection-review-budget-benchmark-20261002.log`。

## 历史记录与下一步

P12/P13/P14属于2026-10-01历史镜像。P13播放与mDNS、P14未初始化BLE时录放/VM生命周期的通过
仍可用于追溯；P14初始化BLE后网络/音频失败不能描述为后续镜像的BLE状态。归档镜像摘要：

| 历史镜像 | 字节数 | 完整文件SHA-256 |
| --- | ---: | --- |
| P12 | 3,245,276 | `ce9e46bfb98837625a212bc4e2f7f4e93ee5ea45bf3b6553d2a7f1ee4fec49f2` |
| P13 | 3,248,604 | `13b49ba53acad4419441aff3b068a659e6cae85eec070a20ca0ff2bab3eedba8` |
| P14 | 3,407,472 | `37ccf12f84efd078789595b5e59988d7e8960015956924d71f600eac158d6ed4` |

1. 新主镜像归档SHA、flash校验和启动证据；保留正常push/回滚回归，重点复验Obeing原应用语音双工，保留失败日志与恢复结果。
2. 核查多地址TCP连接回退，再重复HTTPS及BLE前后网络/录放/VM生命周期；不能只跑最小验收应用。
3. 物理亮屏、颜色、触摸、扬声器/麦克风音质需要真实观察/交互，软件状态不能代验。
4. MN7、门户、定时睡眠按独立profile逐项进入硬件验收；固件OTA apply仍需安全分区与恢复设计。
