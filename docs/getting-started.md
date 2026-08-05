# 从零跑通 PixelBox 全链路

> 目标读者:资深软件工程师,但**没有嵌入式经验**。跟着本文从"什么都没有"走到:
> 真机上跑起自己写的像素动画(热更新),并完成一次语音大模型对话。
>
> 全程 6 步,首次完整走完约半天(大部分时间在等 ESP-IDF 下载和快递)。
> 不想等快递?先走「零硬件路线」:[第 6 步 模拟器 IDE](#6-模拟器-ide零硬件也能玩) 可以在没有任何硬件的情况下体验全部 API。

## 路线总览

```
买板(第1步) ──► 装 ESP-IDF(第2步) ──► 编译烧录固件(第3步)
                                              │
        模拟器 IDE(第6步) ◄──────────────────┤
                                              ▼
                  CLI 热更新第一个动画(第4步) ──► 语音对话(第5步)
```

---

## 1. 购板:微雪 ESP32-S3-Touch-AMOLED-1.8

Stage A 方案只需要这一块板子(喇叭/电池/外壳都可以后补,见 [hardware/devboard.md](./hardware/devboard.md))。

| 项 | 内容 |
|---|---|
| 型号 | **Waveshare(微雪)ESP32-S3-Touch-AMOLED-1.8** |
| 渠道 | 微雪官网商城(waveshare.net)、微雪淘宝/天猫官方店、AliExpress(海外) |
| 参考价 | 约 **¥230 左右**(2026 年参考,不同套餐/汇率有浮动,**以店铺现价为准**) |
| 注意 | 有的套餐含外壳/喇叭/电池,有的是裸板——**建议选带喇叭的套餐**,省一次焊接;下单前核对商品页配置清单 |
| 资料 | 微雪 wiki 搜索板卡型号,可下载**原理图 PDF**(后续硬件章节会用到) |

配件(可选,现在不买也不影响本文流程):

- USB-C 数据线一根(必须是**数据线**,纯充电线烧录不了——遇到"找不到串口"先怀疑线)。
- 喇叭(8Ω 1W)与 3.7V 锂电池,选型见 [hardware/devboard.md](./hardware/devboard.md)。

---

## 2. 安装 ESP-IDF v5.5

ESP-IDF 是乐鑫官方 SDK,相当于这块板子的"Node.js + npm"。**固件必须用 v5.5 编译**(项目锁定版本)。

### 2.1 macOS

```bash
# 1) 依赖(需要已安装 Homebrew)
brew install cmake ninja dfu-util python3

# 2) 克隆 IDF v5.5(体积大,国内网络建议用乐鑫官方极狐镜像)
mkdir -p ~/esp && cd ~/esp
git clone -b v5.5 --recursive https://github.com/espressif/esp-idf.git
# 国内镜像替代(乐鑫官方维护):
# git clone -b v5.5 --recursive https://jihulab.com/esp-mirror/espressif/esp-idf.git

# 3) 安装工具链(只装 esp32s3 目标,省时间)
cd ~/esp/esp-idf
# 国内网络加速(可选):
# export IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"
./install.sh esp32s3

# 4) 每次开新终端都要先激活环境(建议在 ~/.zshrc 里加 alias)
. ~/esp/esp-idf/export.sh
# alias get_idf='. ~/esp/esp-idf/export.sh'
```

验证:`idf.py --version` 输出 `ESP-IDF v5.5...` 即成功。

### 2.2 Windows

用官方图形安装器,最省事:

1. 打开乐鑫官网下载页(搜 "ESP-IDF Windows Installer"),下载 **Offline Installer**,版本选 **v5.5**。
2. 安装时勾选目标芯片 ESP32-S3;安装器会自动装好 Python、Git、工具链与驱动。
3. 装完桌面会出现 **"ESP-IDF 5.5 PowerShell"** 快捷方式——**之后所有 idf.py 命令都在这个终端里执行**(它已激活环境)。

> 也可以两个平台都用 VS Code 的 "ESP-IDF" 官方扩展安装管理,体验类似。

### 2.3 心智模型速记(嵌入式 ≈ 你熟悉的东西)

| 嵌入式概念 | 类比 |
|---|---|
| `idf.py build` | `npm run build`(CMake + ninja 编译出 .bin) |
| `idf.py flash` | `npm publish` 到设备(把 .bin 写进板子 Flash) |
| `idf.py monitor` | `tail -f` 设备日志(Ctrl+] 退出) |
| `idf.py menuconfig` | 交互式编辑 `.env`/feature flags(Kconfig) |
| 分区表 partitions.csv | 磁盘分区方案(固件 A/B 分区 + 数据区) |

---

## 3. 编译并烧录固件

```bash
# 0) 激活 IDF 环境(macOS: . ~/esp/esp-idf/export.sh;Windows: 打开 ESP-IDF PowerShell)
cd <仓库根目录>/firmware

# 1) 拉取 vendored 依赖(QuickJS-ng 等,只需一次)
../tools/fetch_deps.sh

# 2) 设定目标芯片(只需一次,会生成 sdkconfig)
idf.py set-target esp32s3

# 3) (可选)检查配置:板型默认就是微雪 AMOLED 1.8,无需改动
idf.py menuconfig
#    → PixelBox Board Selection → Waveshare ESP32-S3-Touch-AMOLED-1.8(默认)
#    → 也可在此预置默认 Wi-Fi SSID/密码(以 firmware/README.md 为准)

# 4) 编译(首次约 5-15 分钟)
idf.py build

# 5) 用 USB-C 线连接板子,烧录 + 看日志
idf.py -p <串口> flash monitor
```

**串口怎么找**:

- macOS:`ls /dev/cu.usbmodem*`(S3 原生 USB,免驱)。
- Windows:设备管理器 → 端口(COM 和 LPT)→ `COMx`。
- 不指定 `-p` 时 idf.py 会尝试自动探测,多设备时才必须手动指定。

烧录成功后 `monitor` 里会滚动启动日志,屏幕点亮显示默认应用。记下日志里打印的 **设备 IP**(配好 Wi-Fi 后出现)。

**首次配网**:推荐在 `menuconfig` 中预置家里/办公室 Wi-Fi 的 SSID/密码后编译烧录;
设备端应用也可调用 `px.wifi.connect()`(凭据自动持久化,开机自动重连)。
具体入口以 `firmware/README.md` 为准。

---

## 4. SDK CLI:创建并热更新第一个像素动画

前提:Node.js ≥ 18(建议 20+)。**电脑和板子必须在同一个局域网**(mDNS 发现依赖同网段)。

```bash
# 1) 安装并构建 SDK(monorepo 内使用)
cd <仓库根目录>/sdk
npm install          # 失败时: npm install --registry=https://registry.npmmirror.com
npm run build
npm link             # 把 pixelbox 命令挂到全局(或用 node dist/cli.js 直接跑)

# 2) 创建应用
cd ~/projects
pixelbox create my-first-anim
cd my-first-anim
npm install

# 3) 确认能发现设备(mDNS _pixelbox._tcp)
pixelbox devices
# 输出形如: pixelbox-XXXX  192.168.1.42  fw=0.1.0 app=...

# 4) 开发模式:watch 构建 + 自动推送 + 日志回传
pixelbox dev
# 多台设备或 mDNS 不通时: pixelbox dev --device 192.168.1.42
```

打开 `src/main.ts`,写个最小动画(全部 API 有 d.ts 补全):

```ts
// 一个在屏幕上弹跳的像素方块
let x = 0, y = 0, vx = 3, vy = 2;
const S = 24;

px.screen.setFps(30);
px.screen.onFrame(() => {
  px.screen.clear(0x000000);
  px.screen.fillRect(x, y, S, S, px.color.hsv((x + y) % 360, 100, 100));
  px.screen.drawText('Hello PixelBox', 8, 8, { font: 'pixel12', color: px.color.WHITE });
  x += vx; y += vy;
  if (x < 0 || x + S > px.screen.width) vx = -vx;
  if (y < 0 || y + S > px.screen.height) vy = -vy;
});
```

保存 → 终端里看到构建/推送日志 → **1~2 秒后真机屏幕上的动画就变了**。这就是热更新:
只替换 JS 应用包并重启 JS VM,芯片不重启。

---

## 5. 语音对话:起 server + 配 .env

语音链路:设备麦克风 → WS 中继服务器 → STT → LLM(流式)→ TTS → 推回设备播放。
服务器只是"翻译官",三段服务都用 **OpenAI 兼容接口**,国内可用硅基流动等平台一个 key 全搞定。

```bash
cd <仓库根目录>/server
npm install          # 失败时加 --registry=https://registry.npmmirror.com
cp .env.example .env
```

编辑 `.env`(字段名以 server/.env.example 为准),典型配置:

```ini
# 三段可以是同一个平台,也可以混搭;都是 OpenAI 兼容接口
STT_BASE_URL=https://api.siliconflow.cn/v1
STT_API_KEY=sk-xxxx
STT_MODEL=...            # 平台提供的 ASR 模型名

LLM_BASE_URL=https://api.siliconflow.cn/v1
LLM_API_KEY=sk-xxxx
LLM_MODEL=...            # 任意 chat 模型

TTS_BASE_URL=https://api.siliconflow.cn/v1
TTS_API_KEY=sk-xxxx
TTS_MODEL=...            # 平台提供的 TTS 模型名(要求支持 PCM/WAV 输出)
```

启动:

```bash
npm run dev    # 监听 ws://0.0.0.0:8787/realtime
```

设备端跑一个语音应用(可直接推 `examples/` 里的语音助手示例,或自己写):

```ts
px.voice.configure({ serverUrl: 'ws://<你电脑的局域网IP>:8787/realtime' });
px.voice.on('stateChange', (s) => console.log('voice:', s));
px.voice.on('assistantText', (t) => console.log('AI:', t));
px.input.onButton((ev) => {
  if (ev.type === 'click') px.voice.start();   // 按一下开始一轮对话
});
```

按下板上按键 → 对屏幕说话 → 停顿约 0.8s(VAD 判定说完)→ 盒子思考后开口回答。
说话打断它(barge-in)会立即停播并重新聆听。

> 注意 `serverUrl` 填**电脑的局域网 IP**(如 192.168.1.100),不是 127.0.0.1——那是设备视角的地址。

---

## 6. 模拟器 IDE(零硬件也能玩)

```bash
cd <仓库根目录>/simulator
npm install    # 失败时加 --registry=https://registry.npmmirror.com
npm run dev    # 启动 Electron 模拟器
```

- 左侧打开你的应用文件夹(如上面的 `my-first-anim`),中间 Monaco 编辑器自带全量 `px.*` 补全。
- 右侧是 368×448 的虚拟像素屏 + 虚拟外设面板:按键、摇一摇、电池电量、GPS、灯带都能手动模拟。
- 麦克风/扬声器走电脑声卡,语音对话与真机**同协议**直连中继服务器——不买板子也能调语音应用。
- 工具栏「推送到真机」与 CLI 的 `pixelbox push` 等价(devd 协议 + mDNS 发现)。

---

## 7. 常见报错排查表

> 真机联调更完整的按症状排错(烧录/黑屏/无声/语音链路/唤醒词/引脚核对),见 **[真机联调排错手册](troubleshooting.md)**;一键体检:`./tools/doctor/doctor.sh`。

### 环境与编译

| 现象 | 原因 | 解法 |
|---|---|---|
| `idf.py: command not found` | 没激活 IDF 环境 | macOS 执行 `. ~/esp/esp-idf/export.sh`;Windows 用 "ESP-IDF 5.5 PowerShell" |
| `install.sh` 下载工具链极慢/超时 | GitHub 直连不畅 | `export IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"` 后重跑;pip 慢再加 `export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple` |
| `git clone esp-idf` 慢/子模块失败 | 同上 | 改用极狐镜像 `https://jihulab.com/esp-mirror/espressif/esp-idf.git`;已 clone 的执行 `git submodule update --init --recursive` 续传 |
| CMake 报找不到组件/头文件 | 没拉 vendored 依赖 | 先跑 `tools/fetch_deps.sh` |
| 报 target 不匹配 | 之前 set 过别的芯片 | `idf.py fullclean && idf.py set-target esp32s3` |

### 烧录与串口

| 现象 | 原因 | 解法 |
|---|---|---|
| 找不到串口设备 | 用了纯充电线 / 驱动缺失 | 换数据线;Windows 若识别为未知设备,微雪 wiki 下载对应 USB 转串口驱动 |
| `Failed to connect to ESP32-S3: No serial data received` | 芯片没进下载模式 | **按住 BOOT 键不放 → 插线(或按一下 RESET)→ 松开 BOOT** 再烧 |
| 烧完无限重启(看 monitor 日志) | 分区/PSRAM 配置被改乱 | 恢复默认:删除 `sdkconfig` 后 `idf.py set-target esp32s3` 重新 build(sdkconfig.defaults 是对的) |
| `monitor` 全是乱码 | 波特率不对 | 项目默认 115200;`idf.py monitor` 一般自动正确,乱码时检查终端/换 `idf.py -b 115200 monitor` |
| Ctrl+C 退不出 monitor | 快捷键不同 | 退出是 **Ctrl+]**(Windows 下 Ctrl+] 或 Ctrl+T Ctrl+X) |

### CLI / 热更新 / 网络

| 现象 | 原因 | 解法 |
|---|---|---|
| `npm install` 失败(超时/ECONNRESET) | npm 源不畅 | `npm install --registry=https://registry.npmmirror.com` |
| `pixelbox devices` 列表为空 | 不在同网段 / 路由器开了 AP 隔离 / 设备没连上 Wi-Fi | 看 monitor 日志确认设备 IP;关闭路由器"AP 隔离/访客网络";绕过发现直接 `--device <ip>` |
| push 超时/中断 | Wi-Fi 信号差、防火墙拦 8765 端口 | 靠近路由器;macOS/Windows 防火墙放行 Node;重试(推送有会话校验,断了重推即可) |
| 推送成功但应用崩溃 | JS 运行时错误 | `pixelbox logs` 看异常栈;`app.state = crashed` 事件里带 error |

### 语音

| 现象 | 原因 | 解法 |
|---|---|---|
| 设备连不上 server | serverUrl 填了 127.0.0.1 / 防火墙 | 填电脑局域网 IP;放行 8787 端口 |
| `stt.final` 一直为空 | STT 配置错 / 采样率不符 | 看 server 终端日志;确认 `.env` 的 STT 模型名与 key;麦克风上行固定 16kHz PCM16 |
| 有识别没回答 | LLM key/模型错 | server 日志会打印上游 HTTP 错误;先用 curl 验证 LLM 接口可用 |
| 有文字没声音 | TTS 模型不支持 PCM/WAV 输出 / 音量为 0 / 喇叭没接 | 换支持 PCM/WAV 的 TTS;`px.audio.setVolume(80)`;检查喇叭焊接(见 devboard.md) |
| 回答频繁被误打断 | 环境噪音触发 barge-in | 调大 `vadSilenceMs`、降低环境噪音,或先用单轮 `start()` 代替 `startContinuous()` |

---

## 8. 下一步

- 翻 `examples/` 目录:时钟、宠物动画、语音助手、传感器仪表盘,复制着改最快。
- 给盒子"穿衣服":喇叭/电池/外壳落地看 [hardware/devboard.md](./hardware/devboard.md) 与 [hardware/enclosure.md](./hardware/enclosure.md)。
- 想加摄像头/GPS/灯带:进阶打板教程 [hardware/custom-pcb.md](./hardware/custom-pcb.md)。
