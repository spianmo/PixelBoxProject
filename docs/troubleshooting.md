# PixelBox 真机联调排错手册

> 按症状组织:**症状 → 定位命令 → 原因 → 修复**。开始前先跑一键体检:
>
> ```bash
> ./tools/doctor/doctor.sh            # 环境/USB 设备/固件产物/网络服务 四段体检
> ./tools/doctor/doctor.sh --flash    # 检测到设备且 build 存在时直接烧录
> ./tools/doctor/doctor.sh --monitor  # 烧录后看串口日志(Ctrl+] 退出)
> ```
>
> 所有 `idf.py` 命令都要先激活环境:`. ~/esp/esp-idf/export.sh`,工作目录 `firmware/`。

---

## 1. 烧录失败(连不上 / 超时 / permission denied)

**定位**:`ls /dev/cu.usbmodem* /dev/cu.wchusbserial*`(macOS);`esptool.py --port /dev/cu.usbmodemXXX chip_id`

| 现象 | 原因 | 修复 |
|---|---|---|
| 完全没有串口设备 | 线缆只充电不带数据 | 换带数据的 USB-C 线(最常见原因,先换线再查别的) |
| 有设备但 `Failed to connect` | 芯片没进下载模式 | **按住 BOOT 键再插线**(或按住 BOOT 点按 RESET),重试烧录 |
| `wchusbserial` 不出现 | CH34x 驱动未装(外置串口芯片的板子) | 微雪 AMOLED-1.8 走 USB-Serial-JTAG(`usbmodem`),一般无需驱动;定制板若用 CH343 需装 WCH 驱动 |
| 烧录中途断开 | USB 供电不足/hub 供电差 | 直连电脑端口,不经 hub |

## 2. 启动死循环(反复重启 / Guru Meditation)

**定位**:`idf.py monitor` —— monitor 会**自动把 panic 地址符号化**成函数名与行号,直接看回溯第一行属于哪个组件。

- 回溯落在 `jsvm`/`quickjs`:多为 JS 堆或栈问题。默认 JS 堆上限 4MB PSRAM、任务栈 32KB 内部 RAM(`menuconfig → PixelBox JSVM`);OOM 时 jsvm 会打诊断并自动重启 VM,连续崩溃看 `devd` 广播的 `app.state: crashed`。
- 回溯落在 `hal_display`/`hal_audio` 初始化:多为引脚/I2C 地址不匹配,见 §5/§7。
- 上电即 `rst:0x10 (RTCWDT_RTC_RESET)` 循环:多为电源问题(电池馈电/USB 供电不足)。

## 3. PSRAM 未识别(`PSRAM ID read error` 或可用内存异常少)

**定位**:启动日志开头应有 `octal psram: vendor id ...` 与 8MB 识别信息;或跑 `js.eval` 看 `px.system.memory().psramFree`。

- 本项目 sdkconfig.defaults 已按 **ESP32-S3R8(Octal PSRAM)** 配置。如果你的模组是 QSPI PSRAM(如 N16R2),改 `menuconfig → Component config → ESP PSRAM → Mode` 为 Quad 后重编。
- PSRAM 失败会连锁导致帧缓冲/JS 堆分配失败——先解决 PSRAM 再排查其他。

## 4. 屏幕黑屏排查链(按顺序)

微雪板的屏幕复位/触摸复位走 **TCA9554 IO 扩展器**,供电走 **AXP2101**,顺序排查:

1. **AXP2101 有没有认到**:日志找 `初始化完成 (addr=0x34 id=...)`(TAG `axp2101`)。没有 → I2C 总线问题(SDA=15/SCL=14,`menuconfig → PixelBox Board`)。
2. **TCA9554 有没有认到**:日志找 `初始化完成 (addr=0x20)`(TAG `tca9554`)。它负责拉高 LCD_RST/TP_RST(Kconfig:`BOARD_WS18_EXIO_LCD_RST`/`BOARD_WS18_EXIO_TP_RST`,EXIO 编号待上板核对)。
3. **供电轨**:当前 board_init 未主动配置 ALDO/BLDO(依赖上电默认,与微雪例程一致)。若上述都正常仍黑屏,对照微雪 wiki 原理图确认 AMOLED 供电轨挂在哪路 LDO,在 `firmware/components/boards/src/axp2101.c` 补开对应轨。
4. **QSPI 引脚**:`menuconfig → PixelBox Board`(CS=4 SCLK=5 D0=6 D1=7 D2=11 D3=12,以微雪 wiki 为准)。
5. **亮度**:屏幕点亮但全黑也可能是亮度 0,`js.eval` 执行 `px.screen.setBrightness(80); px.screen.fillRect(0,0,368,448,0xFF0000); px.screen.flush()`。

## 5. 触摸无响应

- 日志找 TAG `px.touch` 的初始化输出;FT3168 地址/INT 引脚在 `menuconfig → PixelBox Board`(`BOARD_WS18_TP_INT`)。
- TP_RST 由 TCA9554 控制,先确认 §4 第 2 步通过。
- 快速验证:`pixelbox eval "px.input.onTouch(e=>console.log(JSON.stringify(e)))"` 然后点屏看日志。

## 6. 无声 / 麦克风无输入(重点:I2S 方向待核对项)

微雪官方头文件中 I2S DOUT/DIN 两组宏方向矛盾,固件当前默认 **DOUT=10(播放)/ DIN=8(麦克风)**,这是**已知待上板核对项**:

1. 先验证扬声器:`pixelbox eval "px.audio.setVolume(80); px.audio.player.tone(1000, 500)"` —— 应有 1kHz 蜂鸣。
2. 没声 → `menuconfig → PixelBox Board`,把 `BOARD_WS18_I2S_DOUT`(默认 10)与 `BOARD_WS18_I2S_DIN`(默认 8)**对调**,重编烧录再试。
3. tone 有声但麦克风无输入 → `pixelbox eval "px.audio.mic.start({onData:b=>console.log('pcm',b.byteLength)})"`,若无 `pcm ...` 日志且引脚已核对,检查功放使能脚 `BOARD_WS18_PA_ENABLE`(默认 46)是否与麦克风增益冲突、ES8311 是否在 I2C 上被认到(TAG `hal_audio`)。
4. 外接喇叭:8Ω 1W,焊接极性与腔体见 `docs/hardware/devboard.md`。

## 7. WiFi 连不上

- `pixelbox eval "px.wifi.connect('SSID','PASS').then(s=>console.log(JSON.stringify(s))).catch(e=>console.log('ERR',e.message))"`
- 成功标志:日志 `已获取 IP: x.x.x.x`(TAG `px_wifi`)。凭据会持久化到 NVS,开机自连、断线指数退避重连。
- 只支持 2.4GHz;公司网络注意 802.1X 不支持,用手机热点先验证。

## 8. `pixelbox devices` 发现不了设备

- 前提:设备已联网(§7)且 devd 已启动(日志 `devd 已启动: ws://<ip>:8765/devd` 与 `mDNS: xxx._pixelbox._tcp:8765`)。
- 电脑与设备必须**同网段**;路由器开了 **AP 隔离**(访客网络常见)会挡 mDNS——关掉或换网络。
- 手工验证:`dns-sd -B _pixelbox._tcp`(macOS);绕过 mDNS 直接 `pixelbox push --device <设备IP>`。

## 9. 推送失败(sha256 校验不过 / 中断)

- devd 落盘到 staging 并逐文件 SHA-256 校验,校验失败自动回滚不影响当前应用——重推即可。
- 反复失败:确认 `pixelbox build` 产物完整(`dist/main.js` + `pixelbox.json`);littlefs 满了看日志 `littlefs 已挂载 /flash: 已用/总量 KB`,可 `pixelbox eval` 清理 `/data` 下大文件。

## 10. JS 应用 crashed

- `pixelbox logs` 常驻看日志:JS 异常带完整栈(TAG `js`);devd 同时广播 `app.state: crashed`。
- 修好后 `pixelbox push` 热更新,或 `pixelbox eval "1+1"` 先确认 VM 存活。
- 应用崩溃只重启 JS VM 不重启芯片;连续 OOM 3 次 jsvm 自动重启 VM 并打内存诊断。

## 11. 语音链路逐段排查(说了没反应)

按数据流向逐段确认,每段都有独立观测点:

1. **麦克风**:§6 第 3 步,确认 `onData` 有 PCM 帧。
2. **VAD/状态机**:订阅 `px.voice.on('stateChange', s=>console.log(s))` 与 `on('level', ...)`——说话时 level 应跳动,状态应 idle→listening→thinking。
3. **中继连接**:`voice.configure({serverUrl:'ws://<电脑IP>:8787/realtime'})` 的 IP 必须是电脑局域网 IP(不是 localhost);server 侧 `npm run dev` 日志应打出会话建立。
4. **STT/LLM/TTS**:server 日志逐段看哪步报错(.env 的 key/baseURL/model);`curl http://<电脑IP>:8787/healthz` 先确认服务活着。
5. **播放**:`on('assistantDelta')` 有文本但没声音 → §6 扬声器排查。

## 12. 唤醒词不触发

- 唤醒词需要**专用构建**(esp-sr 模型要烧进 model 分区):见 `firmware/README.md`「启用唤醒词」小节(`sdkconfig.wakeword` 构建配置),默认构建不含唤醒词。
- 已用唤醒词构建仍不触发:看 TAG `px.voice.wake` 日志;确认 `voice.configure({wakeword:true})`;安静环境清晰说"Hi,乐鑫"(默认模型)。

---

## 附 A:首次上电点亮 SOP(日志 checkpoint 清单)

`idf.py flash monitor` 后按顺序核对(TAG 与文案取自固件源码,任何一步缺失即从该组件开始排查):

| # | TAG | 预期日志(关键片段) | 含义 |
|---|---|---|---|
| 1 | (bootloader) | `boot: ESP-IDF v5.5` | 二级引导正常 |
| 2 | (esp_psram) | `octal psram` + 8MB 识别 | PSRAM 就绪(§3) |
| 3 | `axp2101` / `tca9554` | `初始化完成 (addr=0x..)` | I2C 电源/IO 扩展就绪(§4) |
| 4 | 板型文件 | `板级初始化完成: <型号>` | board_init 完成 |
| 5 | `appmgr` | `littlefs 已挂载 /flash: 已用/总量 KB` | 文件系统就绪 |
| 6 | `appmgr` | `加载应用: <id> v<版本>` 或 `运行内置欢迎应用` | 应用包解析 |
| 7 | `devd` | `devd 已启动: ws://<ip>:8765/devd` | 热更新服务就绪 |
| 8 | `devd` | `mDNS: xxx._pixelbox._tcp:8765 (host=xxx.local)` | 局域网可发现(联网后) |
| 9 | `jsvm` | `js_task 已启动 (core 1, 栈 32KB, JS 堆上限 4096KB)` | JS 线程就绪 |
| 10 | `jsvm` | `启动 JS VM (generation 0), 内部堆 ... / PSRAM ... 空闲` | VM 运行 |
| 11 | `main` | `PixelBox 启动完成 (<型号>)` | 全部启动编排完成 |
| 12 | (屏幕) | 内置欢迎应用:星空 + 弹跳方块 + push 提示 | 显示链路端到端 OK |

## 附 B:引脚待核对三项(上板一次性核对流程)

| 待核对项 | 位置 | 核对方法 |
|---|---|---|
| I2S DOUT/DIN 方向 | `menuconfig → PixelBox Board`(`BOARD_WS18_I2S_DOUT/DIN`,默认 10/8) | §6:tone 无声→对调重编;麦克风同理 |
| TCA9554 复位线归属 | 同上(`BOARD_WS18_EXIO_TP_RST/EXIO_LCD_RST`) | 屏亮+触摸响应即正确;只有一样不工作→两根 EXIO 对调 |
| QMI8658 I2C 地址 | `firmware/components/boards/src/board_waveshare_amoled_18.c:73`(默认 `0x6B`,注释标注可试 `0x6A`) | 日志 TAG `px.imu` 初始化失败→改 0x6A 重编;成功后 `pixelbox eval "px.sensors.imu.start({onData:d=>console.log(d.ax,d.ay,d.az)})"` 晃动板子看数值 |

三项都核对后,建议把结论回填到 Kconfig 默认值/板型文件注释,并提交一次 git。
