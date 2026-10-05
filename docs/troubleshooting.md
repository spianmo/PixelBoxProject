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

**定位**: Waveshare ESP32-S3-Touch-AMOLED-2.16 板载 USB-C 连接的是 ESP32-S3 原生 USB-Serial-JTAG，不是 CH34x/CP210x。macOS 执行
`ls /dev/cu.usbmodem*`，Linux 执行 `ls /dev/ttyACM* /dev/ttyUSB*`，Windows 在设备管理器查看
`USB Serial/JTAG` 对应的 COM 口；端口出现后再执行
`esptool --chip esp32s3 --port PORT chip_id`。

| 现象 | 原因 | 修复 |
|---|---|---|
| 完全没有串口设备 | 芯片未上电或未真正复位、线缆只充电、Hub/扩展坞未枚举，或 USB D+/D- 硬件路径异常（2.16 为 D-=GPIO19、D+=GPIO20） | 换确认支持数据传输的 USB-C 线并直连电脑；接着电池时先按下方流程进入下载模式，不能仅按 BOOT 拔插 USB。确认真正重新上电后仍无 USB 设备，再检查供电、Type-C 插座和 D+/D- |
| 有设备但 `Failed to connect` | 芯片没进下载模式或端口被其他程序占用 | 关闭占用端口的 monitor/IDE，按下方流程进入下载模式后重试。该板的 GPIO18 按键不直接连接 CHIP_PU/EN，不能当作 MCU 硬复位键 |
| 误以为需要 CH34x/CP210x 驱动 | 2.16 的板载 USB-C 使用原生 USB-Serial-JTAG | 不要为 2.16 安装 USB-UART 驱动；只有外接 USB-UART 转接板才按其芯片安装驱动 |
| 烧录中途断开 | USB 供电不足/hub 供电差 | 直连电脑端口,不经 hub |

### 2.16 接着电池时进入下载模式

**拔掉 USB 不等于断电。** BOOT 接 GPIO0，只在芯片复位时选择启动模式；PWR 接
AXP2101 的 PWRON。原理图第三键虽注明“丝印用 RST”，实际接 GPIO18，而非
CHIP_PU/EN。按丝印 BOOT/PWR 操作，不要混用原理图 Key1/Key2 与软件的按键编号。

以下顺序于 2026-10-01 在接着电池、USB-C 直连 Mac 的 2.16 真机上恢复了下载通信：

1. 保持 USB 连接，按住 **BOOT**，直到第 4 步结束才松开。
2. 同时按住 **PWR 约 10 秒**，然后只松开 PWR。
3. 再按住 **PWR 约 2 秒**，松开 PWR。
4. 再等约 3 秒，松开 BOOT，刷新电脑端串口列表。

这里的时长是此次成功的操作步骤，不代表已读回或修改 AXP2101 的按键阈值。
实测出现 `USB JTAG/serial debug unit`（VID:PID=`303A:1001`）及
`/dev/cu.usbmodem2101`；实际端口编号以本机为准。屏幕当时仍然全黑，不能仅凭屏幕或
指示灯判断下载模式是否成功。用 esptool 4.x 做只读探测并保持下载模式：

```bash
python3 -m esptool --chip esp32s3 --port PORT --baud 115200 \
  --before no_reset --after no_reset --no-stub chip_id
```

此次 `chip_id`、`flash_id`、`get_security_info` 均成功返回，识别到 ESP32-S3、
8 MB PSRAM、16 MB Flash。退出下载模式后，现有 NuttX 启动到 `nsh>`，
`echo ESP32S3_SERIAL_RECOVERY_OK` 与 `uname -a` 均有正确响应，确认串口双向通信恢复。
现有固件报告屏幕尺寸 `0×0`，不能把黑屏继续解释为串口不可用；本次没有重写 Flash，
这些检查不代表新镜像烧录或显示功能验证通过。

若上述按键流程仍失败，只有同时断开 USB 和电池才能排除持续供电；仅在电池插头
可安全接触时断开，完全断电后再按住 BOOT 接 USB，随后检查设备枚举。

端口已经出现但烧录仍失败时，先确认芯片和端口：

```bash
esptool --chip esp32s3 --port PORT chip_id
idf.py -p PORT flash monitor
```

NuttX 镜像不经过 `idf.py`，端口出现后使用工程自己的 runner：

```bash
python3 firmware-nuttx/scripts/nuttx.py flash \
  --target esp32s3 --port /dev/cu.usbmodemXXX
```

烧录波特率(`-b`)与 monitor 波特率是两个设置；monitor 默认 115200。若板载 USB 仍无法枚举，
可用外部 USB-UART 连接 UART0：TX=`GPIO43`、RX=`GPIO44`、GND 共地。该方式只能观察 UART0，
不能证明板载原生 USB 路径正常。

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

微雪 **ESP32-S3-Touch-AMOLED-2.16** 使用 CO5300 AMOLED 和 CST9220 触摸，屏幕、触摸复位分别连接 GPIO39、GPIO40；供电和 I2C 均走 GPIO15(SDA)/GPIO14(SCL)，顺序排查:

1. **I2C 外设有没有认到**:日志找 `CO5300`、`CST9220`、`QMI8658` 的初始化输出。没有 → 检查 I2C 总线(SDA=15/SCL=14,`menuconfig → PixelBox Board`)和 PWR 电源。
2. **屏幕复位线**:确认 GPIO39 在初始化时产生复位脉冲并拉高；触摸复位同理检查 GPIO40。2.16 没有 1.8 英寸版本使用的 TCA9554/AXP2101 复位链路。
3. **QSPI 引脚**:CO5300 使用 CS=GPIO12、SCLK=GPIO38、D0=GPIO4、D1=GPIO5、D2=GPIO6、D3=GPIO7；引脚错误会导致初始化后仍黑屏。
4. **分辨率与亮度**:面板为 480×480，`js.eval` 执行 `px.screen.setBrightness(80); px.screen.fillRect(0,0,480,480,0xFF0000); px.screen.flush()`。

## 5. 触摸无响应

- 日志找 TAG `px.touch` 的初始化输出；CST9220 地址为 `0x5a`，INT 引脚为 GPIO11，复位为 GPIO40。
- 确认 I2C 总线 GPIO15(SDA)/GPIO14(SCL) 已初始化，再检查 GPIO11 是否能产生触摸中断。
- 快速验证:`pixelbox eval "px.input.onTouch(e=>console.log(JSON.stringify(e)))"` 然后点屏看日志。

## 6. 无声 / 麦克风无输入(重点:I2S 方向待核对项)

微雪 2.16 官方头文件中 I2S DOUT/DIN 两组宏方向矛盾,固件当前默认 **DOUT=8(播放)/ DIN=10(麦克风)**,这是**已知待上板核对项**:

1. 先验证扬声器:`pixelbox eval "px.audio.setVolume(80); px.audio.player.tone(1000, 500)"` —— 应有 1kHz 蜂鸣。
2. 没声 → `menuconfig → PixelBox Board`,把 `BOARD_WS216_I2S_DOUT`(默认 8)与 `BOARD_WS216_I2S_DIN`(默认 10)**对调**,重编烧录再试。
3. tone 有声但麦克风无输入 → `pixelbox eval "px.audio.mic.start({onData:b=>console.log('pcm',b.byteLength)})"`,若无 `pcm ...` 日志且引脚已核对,检查功放使能脚 `BOARD_WS216_PA_ENABLE`(默认 46)是否与麦克风增益冲突、ES8311 是否在 I2C 上被认到(TAG `hal_audio`)。
4. 外接喇叭:8Ω 1W,焊接极性与腔体见 `docs/hardware/devboard.md`。

## 7. WiFi 连不上

- `pixelbox eval "px.wifi.connect('SSID','PASS').then(s=>console.log(JSON.stringify(s))).catch(e=>console.log('ERR',e.message))"`
- 成功标志:日志 `已获取 IP: x.x.x.x`(TAG `px_wifi`)。凭据会持久化到 NVS,开机自连、断线指数退避重连。
- 只支持 2.4GHz;公司网络注意 802.1X 不支持,用手机热点先验证。

## 8. `pixelbox devices` 发现不了设备

- 前提:设备已联网(§7)且 devd 已启动(日志 `devd 已启动: ws://<ip>:8765/devd` 与 `mDNS: xxx._pixelbox._tcp:8765`)。
- 电脑与设备必须**同网段**;路由器开了 **AP 隔离**(访客网络常见)会挡 mDNS——关掉或换网络。
- 手工验证:`dns-sd -B _pixelbox._tcp`(macOS);绕过 mDNS 直接 `pixelbox push --device <设备IP>`。

## 8.1 设备 ping 得通, 但 devd 全部无响应(已修复, 旧固件需按 RESET)

**症状**:`ping` 正常、串口日志还在刷,但 `pixelbox push/logs/eval` 全部超时,
连新的 WebSocket 都握不上手;串口里刷屏:

```
W httpd_txrx httpd_sock_err: error in send : 128
W httpd_ws   httpd_ws_send_frame_async: Failed to send WS header
```

**原因**:触发条件不是「粗暴断开」——进程直接退出、`kill -9`、拔网线,内核都会发
FIN/RST,httpd 下次 `select` 到可读、`recv` 得 0 就正常走 `close_fn` 回收(已实测)。
真凶是**连接还开着、但对端不再读**:客户端进程被 `SIGSTOP`、笔记本合盖休眠、
停在调试器断点上,或纯粹消费不过来。这时 TCP 窗口被填满,设备侧发送一路阻塞到
httpd 的 send 超时才失败,而 httpd 永远收不到 EOF,`close_fn` 不会触发,fd 就一直
留在 `s_clients`/`s_log_subs` 里。而每次发送失败,esp_http_server 自己会打一条
`httpd_txrx` 警告,这条警告又要广播给那个死 fd —— **自我放大的死循环**,把 httpd
任务打满。

**已修复**(`firmware/components/devd/src/devd.cpp`,两道防线缺一即复发):

1. **回收**:检查 `httpd_ws_send_frame_async()` 的返回值,同一 fd **连续**失败 3 次
   即判定对端已死,摘出队列并 `httpd_sess_trigger_close()`。用「连续」而不是「一次」
   是因为单次失败也可能只是短暂拥塞,不该把活客户端踢掉(一次成功即计数归零)。
2. **断环**:发送期间记住当前任务句柄,**该任务此刻打出的日志不再触发新的 flush**。
   否则在第 1 道防线判死之前(3 次超时要十几秒),雪崩早就发生了。日志仍进环形
   缓冲不会丢,下一条外部日志或 `logs.subscribe` 会把它带出去。

修复后的实测:卡死客户端在约 22 秒内被判死回收(串口 `客户端连续 3 次发送失败,
判定已断开并回收 (fd=55)`),期间 httpd 发送告警共 6 条即止,`js.eval` 与新连接握手
全程正常。

**仍建议**:客户端退出前正常关闭 WebSocket(发 close 帧),这样 fd 立刻回收,
不必等十几秒的超时判定。

## 9. 推送失败(sha256 校验不过 / 中断)

- devd 落盘到 staging 并逐文件 SHA-256 校验,校验失败自动回滚不影响当前应用——重推即可。
- 反复失败:确认 `pixelbox build` 产物完整(`dist/main.js` + `pixelbox.json`);littlefs 满了看日志 `littlefs 已挂载 /flash: 已用/总量 KB`,可 `pixelbox eval` 清理 `/data` 下大文件。

## 10. JS 应用 crashed

- `pixelbox logs` 常驻看日志:JS 异常带完整栈(TAG `js`);devd 同时广播 `app.state: crashed`。
- 修好后 `pixelbox push` 热更新,或 `pixelbox eval "1+1"` 先确认 VM 存活。
- 应用崩溃只重启 JS VM 不重启芯片;连续 OOM 3 次 jsvm 自动重启 VM 并打内存诊断。

## 10.1 设备屏幕上的报错卡片

未捕获的 JS 异常不再只进日志,**设备屏幕会直接显示**(模拟器虚拟屏同款),不必回电脑翻日志:

| 屏上表现 | 触发 | 收场 |
|---|---|---|
| 顶部红色横幅(标题 + 错误首行) | 应用还活着:事件回调 / 定时器 / onFrame / 微任务 / 未处理的 Promise 拒绝 | 5 秒自动消失,应用继续跑 |
| 全屏红色卡片(应用名 v版本 + 摘要 + 调用栈 + 底部提示) | 应用跑不下去:入口异常、VM 创建失败、热更新切换失败 | 常驻到下一次应用启动 |
| 全屏卡片 + 标题 `×N` | 同一条错误 **3 秒内累计 5 次**(典型:`onFrame` 每帧抛) | 判为刷屏,自动停应用,卡片常驻 |

- 卡片上的**应用名与版本**取自 `manifest.json`,可据此确认设备跑的是不是你刚推的那个包。
- **内置设置页**自己崩溃不弹卡片(它有自恢复:退出设置模式重启回应用/欢迎页)。
- 无屏板型(`BOARD_HEADLESS`)全部退化为只打日志。
- 卡片按 `键2 重启应用 · 键1 设置页` 收场(键位见 `firmware/main/system_keys.cpp`);
  模拟器上对应工具栏「重新加载」。
- 日志侧文案一字未改,仍是 `E js …` + 完整栈,`pixelbox logs` 的既有过滤照常可用。

## 11. 语音链路逐段排查(说了没反应)

按数据流向逐段确认,每段都有独立观测点:

1. **麦克风**:§6 第 3 步,确认 `onData` 有 PCM 帧。
2. **VAD/状态机**:订阅 `px.voice.on('stateChange', s=>console.log(s))` 与 `on('level', ...)`——说话时 level 应跳动,状态应 idle→listening→thinking。
3. **中继连接**:`voice.configure({serverUrl:'ws://<电脑IP>:8787/realtime'})` 的 IP 必须是电脑局域网 IP(不是 localhost);server 侧 `pnpm run dev` 日志应打出会话建立。
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
| I2S DOUT/DIN 方向 | `menuconfig → PixelBox Board`(`BOARD_WS216_I2S_DOUT/DIN`,默认 8/10) | §6:tone 无声→对调重编;麦克风同理 |
| 屏幕/触摸复位 | 同上(`BOARD_WS216_LCD_RST=39`、`BOARD_WS216_TP_RST=40`) | 屏亮+触摸响应即正确;单项不工作时检查对应 GPIO 波形 |
| QMI8658 I2C 地址 | `firmware/components/boards/src/board_waveshare_amoled_216.c`(默认 `0x6B`,可试 `0x6A`) | 日志 TAG `px.imu` 初始化失败→改 0x6A 重编;成功后 `pixelbox eval "px.sensors.imu.start({onData:d=>console.log(d.ax,d.ay,d.az)})"` 晃动板子看数值 |

三项都核对后,建议把结论回填到 Kconfig 默认值/板型文件注释,并提交一次 git。
