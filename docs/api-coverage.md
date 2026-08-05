# PixelBox API 覆盖矩阵(三端契约一致性)

> 基准:`sdk/types/pixelbox.d.ts`(唯一契约)。本表由审计阶段(contract-audit)逐条核对产出。
>
> 状态说明:
> - ✅ 已实现且与 d.ts 签名一致
> - ⚠️ 受 Kconfig / 平台限制(默认关闭或行为降级;遵守 `available() === false` + 其余方法抛 `Error("ENOTSUP")` 的约定,或以模拟数据替代)
> - ❌ 缺失(与契约不一致,需修复)
>
> 固件实现位置:`firmware/components/{jsvm, appmgr, bindings_*, voicechat}`;
> 模拟器实现位置:`simulator/src/renderer/src/device-sim/sandbox/runtime/`。
> 审计结论:**三端无 ❌ 缺口**;所有 ⚠️ 均为有意设计(Kconfig 默认关闭的 Stage B 外设、模拟器物理不可为的能力),且遵守 ENOTSUP 约定。

## 标准全局

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `console.log/info/warn/error/debug` | ✅ | ✅ | 固件转发到 ESP_LOG 与 devd 日志;模拟器代理到底部控制台 |
| `setTimeout` / `clearTimeout` | ✅ | ✅ | 固件由 jsvm 事件循环实现;模拟器用 iframe 原生 |
| `setInterval` / `clearInterval` | ✅ | ✅ | 同上 |
| `queueMicrotask` | ✅ | ✅ | |
| `fetch(url, init?)` | ✅ | ✅ | 固件 esp_http_client + 证书包;模拟器经 main 进程代理(免 CORS) |
| `PxResponse.status/ok/statusText/headers/url` | ✅ | ✅ | |
| `PxResponse.text()/json()/arrayBuffer()` | ✅ | ✅ | |
| `WebSocket`(构造/静态常量/readyState/url/binaryType) | ✅ | ✅ | 固件 esp_websocket_client;模拟器包装原生 WS 为契约事件形状 |
| `WebSocket.onopen/onmessage/onclose/onerror/send/close` | ✅ | ✅ | 二进制一律 ArrayBuffer |
| `TextEncoder.encode` / `TextDecoder.decode` | ✅ | ✅ | 固件为 prelude_core.js 纯 JS UTF-8 实现 |
| `atob` / `btoa` | ✅ | ✅ | |
| `performance.now()` | ✅ | ✅ | 固件包装 esp_timer 高精度时钟 |

## px.system

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `info()` | ✅ | ✅ | 模拟器 model 为 `pixelbox-sim`,capabilities 反映面板状态 |
| `memory()` | ✅ | ✅ | 模拟器 heapFree/psramFree 为拟真常数,jsHeapUsed 取 Chromium `performance.memory`(可用时) |
| `battery()` | ✅ | ✅ | 模拟器由右侧面板电量/充电控件驱动 |
| `restart()` | ✅ | ✅ | 模拟器语义 = 重启应用沙箱 |
| `deepSleep(ms?)` | ✅ | ⚠️ | 模拟器以熄屏模拟,ms 到期后重启应用 |
| `now()` | ✅ | ✅ | |
| `ntpSync(server?)` | ✅ | ✅ | 固件 esp_sntp(bindings_net/mod_system_net);模拟器宿主时钟即准,直接 resolve |
| `setTimezone(tz)` | ✅ | ⚠️ | 模拟器沿用宿主时区,仅记录日志 |
| `temperature()` | ✅ | ✅ | 模拟器返回拟真随机值 |
| `otaCheck(manifestUrl)` | ✅ | ⚠️ | 模拟器无固件 OTA,恒返回 null |
| `otaApply(firmwareUrl, onProgress?)` | ✅ | ⚠️ | 模拟器 reject `Error("ENOTSUP: …")` |
| `on('lowBattery' \| 'chargingChange')` | ✅ | ✅ | 模拟器由面板电量变化触发(<15% 触发 lowBattery) |

## px.app

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `name` / `id` / `version` | ✅ | ✅ | 来自 manifest(pixelbox.json) |
| `readAsset(path)` / `readAssetText(path)` | ✅ | ✅ | 相对 assets/ 路径 |
| `onExit(cb)` | ✅ | ✅ | 停止/热更新前回调 |
| `exit()` | ✅ | ✅ | 固件仅停 JS VM;模拟器停止沙箱 |

## px.storage

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `kv.get/getJSON/set/remove/keys/clear` | ✅ | ✅ | 固件 NVS;模拟器内存镜像 + 防抖写穿 userData |
| `fs.readText/readBytes/writeText/writeBytes/append` | ✅ | ✅ | 固件 LittleFS(/data 可写、/app 只读);模拟器同路径空间语义 |
| `fs.exists/remove/mkdir/readDir/stat` | ✅ | ✅ | |

## px.screen(含 PxDrawTarget / PxCanvas / PxAnimation)

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `width` / `height` | ✅ | ✅ | 368×448 |
| `clear/setPixel/getPixel/drawLine/drawRect/fillRect` | ✅ | ✅ | 双端均逐像素(Bresenham/中点),无抗锯齿 |
| `drawCircle/fillCircle` | ✅ | ✅ | |
| `drawText(text, x, y, style?)` | ✅ | ✅ | pixel8/pixel12/pixel16 三字体;模拟器用缝合像素字体 |
| `measureText(text, style?)` | ✅ | ✅ | |
| `drawImage(src, x, y, opts?)` | ✅ | ✅ | PNG/JPEG/路径/画布 + colorKey/裁剪/最近邻缩放 |
| `setBrightness/getBrightness/setPower/setRotation` | ✅ | ✅ | |
| `flush()` | ✅ | ✅ | onFrame 回调返回后自动 flush(双端一致) |
| `onFrame(cb)` / `setFps(fps)` | ✅ | ✅ | 模拟器由宿主 rAF 节流驱动 |
| `createCanvas(w, h)` → `PxCanvas` | ✅ | ✅ | 含 width/height/dispose + 全套绘图 API |
| `createAnimation(opts)` → `PxAnimation` | ✅ | ✅ | 固件在 prelude_screen.js 纯 JS 包装;帧数组与雪碧图均支持 |
| `loadGif(src)` → `PxAnimation` | ✅ | ✅ | 逐帧独立时长 |
| `PxAnimation.play/pause/stop/seek/draw/onEnd/dispose` | ✅ | ✅ | |
| `PxAnimation.playing/frameCount/currentFrame` | ✅ | ✅ | |

## px.input

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `onTouch(cb)` | ✅ | ✅ | 模拟器映射鼠标 |
| `onButton(cb)` | ✅ | ✅ | down/up/click/doubleClick/longPress 全事件;模拟器为面板 BOOT 键 |
| `onGesture(cb)` | ✅ | ✅ | 双端均由触摸合成 |

## px.audio

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `setVolume/getVolume` | ✅ | ✅ | |
| `mic.start(opts)/stop()` | ✅ | ✅ | 模拟器 getUserMedia + AudioWorklet(宿主采集) |
| `mic.active` | ✅ | ✅ | |
| `mic.setGain(percent)` | ✅ | ✅ | 模拟器在沙箱内做 PCM 增益 |
| `player.play(src)` | ✅ | ✅ | wav/mp3,/app、/data 路径或 http(s) URL |
| `player.playPcm(pcm, opts?)` | ✅ | ✅ | 模拟器同步返回延迟绑定句柄(契约同步签名) |
| `player.openPcmStream(opts?)`(feed/end/stop/onEnded/buffered) | ✅ | ✅ | TTS 流式播放路径 |
| `player.tone(freq, ms, volume?)` | ✅ | ✅ | |
| `player.stopAll()` / `player.playing` | ✅ | ✅ | |
| `PxPlayHandle.stop/pause/resume/playing/onEnded` | ✅ | ✅ | |
| `record(path, opts?)` | ✅ | ✅ | WAV 封装写 /data,返回实际时长毫秒 |

## px.voice

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `configure(opts)` | ✅ | ⚠️ | 模拟器忽略 `wakeword` 选项(无本地唤醒词) |
| `start()` / `startContinuous()` / `stop()` | ✅ | ✅ | 状态机 idle→connecting→listening→thinking→speaking |
| `interrupt()` | ✅ | ✅ | 双端均支持 barge-in(播报中检测人声自动打断) |
| `sendText(text)` | ✅ | ✅ | 上行 `{type:"text.input", text}` |
| `say(text)` | ✅ | ✅ | 上行扩展消息 `{type:"tts.request", text}`,仅 TTS 语义、不入 LLM 上下文(见 architecture.md §7);服务器兼容历史别名 `{type:"say"}` |
| `state()` | ✅ | ✅ | |
| `on('stateChange'/'speechStart'/'speechEnd'/'userText'/'assistantDelta'/'assistantText'/'level'/'error')` | ✅ | ✅ | |
| `on('wake')` | ⚠️ | ⚠️ | 固件需 `CONFIG_PX_ENABLE_WAKEWORD`(esp-sr,默认关);模拟器可订阅但不会触发 |

## px.wifi

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `scan()` | ✅ | ⚠️ | 模拟器返回内置假 AP 列表(浏览器无法真实扫描) |
| `connect(ssid, password?, opts?)` | ✅ | ⚠️ | 模拟器模拟连接耗时后返回状态;实际网络走宿主 |
| `disconnect()` / `status()` | ✅ | ⚠️ | 模拟器 status 反映宿主 `navigator.onLine` |
| `on('connected'/'disconnected'/'gotIp')` | ✅ | ✅ | 模拟器由宿主 online/offline 与模拟连接触发 |
| `startAP(ssid, password?)` / `stopAP()` | ✅ | ⚠️ | 模拟器仅日志记录(无真实热点能力) |

## px.net

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `connectTcp(opts)` | ✅ | ✅ | 模拟器经 main 进程 net 桥;tls 支持 |
| `PxTcpSocket.send/close/connected/remoteHost/remotePort` | ✅ | ✅ | |
| `PxTcpSocket.onData/onClose/onError` | ✅ | ✅ | |
| `listenTcp(opts)` / `PxTcpServer.port/close` | ✅ | ✅ | 契约同步返回;模拟器内部异步建监听 |
| `createUdp(opts?)` / `PxUdpSocket.send/onMessage/close` | ✅ | ✅ | 模拟器 dgram 桥,就绪前发送排队 |
| `mdns.discover(service, opts?)` | ✅ | ✅ | 模拟器 bonjour-service |
| `mdns.advertise(opts)` | ✅ | ✅ | 返回 Unsubscribe |
| `hostname()` | ✅ | ✅ | |

## px.ble

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `available()` | ⚠️ | ⚠️ | 固件受 Kconfig(NimBLE)限制,默认板型可用性由 hal 上报;模拟器恒 false(浏览器无外设级 BLE) |
| `peripheral.start/notify/stop/onConnect/onDisconnect` | ⚠️ | ⚠️ | 未启用时抛 `Error("ENOTSUP")`(双端一致) |
| `central.scan/stopScan/connect` | ⚠️ | ⚠️ | 同上 |
| `PxBleConnection.services/read/write/subscribe/disconnect/onDisconnect` | ⚠️ | ⚠️ | 模拟器不可达(central.connect 抛 ENOTSUP) |

## px.camera

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `available()` | ⚠️ | ✅ | 固件为 Stage B 外设,Kconfig 默认关(available=false、其余 ENOTSUP);模拟器映射电脑摄像头 |
| `init(opts?)` | ⚠️ | ✅ | 分辨率含 720P;模拟器按分辨率约束 getUserMedia |
| `capture()` | ⚠️ | ✅ | jpeg 二进制 |
| `startStream(opts)/stopStream()/deinit()` | ⚠️ | ✅ | |

## px.gps

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `available()` | ⚠️ | ✅ | 固件 Stage B 外设,Kconfig 默认关;模拟器由面板经纬度控件驱动 |
| `start(opts)/stop()/last()` | ⚠️ | ✅ | 模拟器 500ms 模拟搜星后 fixed |

## px.sensors

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `imu.available()` | ✅ | ✅ | QMI8658 板载 |
| `imu.start(opts)/stop()` | ✅ | ✅ | 模拟器由面板滑条 + 少量噪声 |
| `imu.onShake(cb)` | ✅ | ✅ | 模拟器为面板"摇一摇"按钮 |
| `imu.onOrientation(cb)` | ✅ | ✅ | 由加速度计算姿态 |

## px.led

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `available()` / `count` | ⚠️ | ✅ | 固件 Stage B 外设,Kconfig 默认关;模拟器为面板虚拟灯带(可开关) |
| `setBrightness/set/fill/clear/show` | ⚠️ | ✅ | 未启用时抛 `Error("ENOTSUP")` |

## px.util

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `b64encode/b64decode/hexEncode/hexDecode/uuid` | ✅ | ✅ | 固件在 prelude_core.js 纯 JS 实现 |
| `crc32/sha256/randomBytes` | ✅ | ✅ | 固件 native(esp_rom_crc/mbedtls/esp_random);jsvm 与 bindings_periph 双注册为幂等"缺哪个补哪个"设计 |

## px.color

| API | 固件 | 模拟器 | 备注 |
|---|---|---|---|
| `rgb(r,g,b)` / `hsv(h,s,v)` / `lerp(a,b,t)` | ✅ | ✅ | |
| 常量 `BLACK/WHITE/RED/GREEN/BLUE/YELLOW/CYAN/MAGENTA/ORANGE/GRAY` | ✅ | ✅ | 值三端一致(ORANGE=0xFF8800 等) |

## 附:examples 用到的 API 核对

`examples/01-hello-pixel`、`02-pixel-clock`、`03-voice-assistant`、`04-sensor-playground` 四个示例源码
调用的全部 `px.*` API(screen 绘图/onFrame、input、audio.player.tone、storage.kv、system(now/ntpSync/setTimezone/memory/battery)、
voice(configure/start/startContinuous/stop/interrupt/on)、wifi.status、sensors.imu、color)均存在于 `pixelbox.d.ts`,
无一使用不存在的 API。
