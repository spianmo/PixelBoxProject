# PixelBox 周期性语音拥堵排查（2026-09-09）

## 当前状态

尚未证明周期性拥堵已消除。手机 APK 已安装 ADPCM 解码版本；example06 已使用 IMA ADPCM 上行。
完整帧发送的固件已经编译，首次 app-flash 在约 26% 时 USB 消失，降速重试因串口不存在而失败。
应用分区必须重新完整烧写并校验后才能继续实机验证；NVS、分区表、配对存储未擦除。

## 已确认的证据

- example06 `BufferedUplink.audio()` 在应用待发队列超过 64000 个原始 PCM 字节（2 秒）时恢复采音。
  此提示指设备向手机发送麦克风音频积压，不能据此认定云端 TTS 服务故障。
- 原 480 像素宽的双 32 行显示 DMA 占用 60 KiB 内部 RAM，采音时仅剩约 3.7 KiB。
  缩到双 8 行（15 KiB）后余量改善，但单独修改仍会周期性恢复。
- 静态 Wi-Fi TX 池 8 槽时观察到 `fail_oom`；增加到 16 后不再出现该错误，仍有 TCP 重传停顿。
- 慢写主要是等待 TCP 可写（例如 2513ms），实际写入只有 3ms。手机回调通常 1–5ms、锁等待 0–1ms。
- IMA ADPCM 将 128ms 上行块从 4096 字节降至 1030 字节；压缩有损，手机解码回 16k PCM。
  队列限制仍按原始采样时长计算，没有增加两秒限制或隐藏拥堵提示。
- ADPCM 与强制 802.11g 组合在约 93 秒仍恢复一次。全局强制 11g 已撤销，恢复默认 b/g/n。
- 最新候选调整为在 WebSocket 客户端的 TX 锁内合并帧头和负载写入，避免短帧头单独发送。
  **仅主机测试与固件构建通过，尚未取得该调整的实机改善证据。**

## 已执行验证

- Android debug APK、androidTest APK、PixelBox JVM 单测和 lint 构建成功；40 项 JVM 测试通过。
- 手机仪器测试 9 项通过（既有连接、账号、配对与下行测试）。
- example06 回归 45 项通过；example06 与模拟器 TypeScript 检查通过。
- 固件与模拟器 IMA 编码固定样本逐字节一致，Java 解码保持样本数且固定正弦测试归一化 RMS 误差低于 5%。
- 显示 graphics / DMA / pixels_compat 三组主机测试通过。
- 新增 WebSocket 主机测试覆盖长度、掩码、控制帧、延续帧、部分写、失败与整帧超时。
- 之前的持续采音验证失败；不得用上述单元测试替代真实连续采音通过结论。

## 恢复设备后必须完成

1. 使用 ESP-IDF 5.5、正确板型 `pixelbox-s3-216` 执行 `idf.py build app-flash -p <实际串口>`，确认 Hash verified。
   仅刷应用，保留现有 NVS；若应用无法启动，使用 BOOT + RESET 进入下载模式。
2. 确认 example06 自动恢复手机连接，无需重新输入配对码。
3. 执行 `node tools/observe-obeing-uplink.mjs <设备IP> 600`：要求零恢复、零断线且保持同一 socket。
4. 暂停真实连接后执行 `check-websocket-transport.mjs`、`check-websocket-backpressure.mjs`、
   `check-obeing-uplink.mjs`（60 秒）与 `check-obeing-audio.mjs`（20 秒）。测试结束恢复自动发现。
5. 若仍出现恢复，继续定位无线链路与 TCP 停顿；不能仅提高缓冲门限、延长超时或去掉提示作为修复。
