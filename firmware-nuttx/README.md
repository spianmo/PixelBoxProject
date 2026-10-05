# PixelBox NuttX 固件

这是与 `firmware/` 的 ESP-IDF 实现并行的独立固件工程。内核使用 Apache NuttX，JS 引擎继续固定为 **QuickJS-ng v0.10.1**，上层继续使用 `sdk/types/pixelbox.d.ts` 中的 `px` / `pixelbox` 命名空间和原有应用 IIFE bundle。项目运行时不包含 ESP-IDF/FreeRTOS 头文件，不调用 `idf.py`，不要求安装完整 ESP-IDF SDK，也不需要 ESP-IDF bootloader。NuttX 的 ESP32-S3 移植会下载并编译上游 `esp-hal-3rdparty`（Espressif 抽取的 HAL），因此“不依赖 ESP-IDF 工程/工具链流程”不表示所有芯片底层代码均与 Espressif HAL 无关。

当前目标为 `esp32s3-devkit:nsh` 基础配置加项目的 `configs/esp32s3.config`，使用 NuttX **Simple Boot**。默认 profile 针对 16 MiB flash / 8 MiB octal PSRAM；实际模块必须与配置一致。配置、构建和刷写由 `scripts/nuttx.py` 管理，espIDE 可以选择此实现创建工程。

## 当前实现与验证范围

以 2026-10-01 的 P13/P14 真机记录为基准：USB 串口、ROM 刷写/校验、软件重启、Wi-Fi、devd、应用 stop/restart 与 KV 持久化、HTTP/WebSocket、NTP/HTTPS 以及 mDNS 双向发现已有证据。P14 在未初始化 BLE 时通过播放自然结束、取消后重播、活动播放期间 VM 停止/重启，以及多轮麦克风非零采样；初始化 BLE 后曾出现网络/音频回归，修复仍需新版真机复验。面板实际成像和声学输出未确认。完整差异与脱敏验收摘要见 [能力对照](docs/feature-parity.md)。

| 能力 | 本实现行为 |
| --- | --- |
| JS 执行 | QuickJS-ng、原有 `px === pixelbox`、console、Promise 微任务、带参数的定时器、应用退出钩子 |
| 系统 | POSIX 时间/时区、NTP、芯片温度、真实 JS 堆统计、NuttX `mallinfo` 空闲堆；可选 `CONFIG_BOARDCTL_RESET` 对接 `boardctl(BOARDIOC_RESET)` |
| 文件 | POSIX `/app` 只读包、`/data` 可写文件；读取、写入、追加、目录、元数据、删除；拒绝 `..`、NUL、符号链接逃逸 |
| KV | LittleFS/宿主文件系统中的 JSON 持久化；临时文件 `fsync` 后 `rename` 原子提交，进程重启后仍保留；存储不可用时报错，不退回内存 |
| 应用 | manifest/资源/退出钩子；常驻 devd、单 VM 监督器、分块推送/哈希校验、`staging/current/prev` 原子提交、远程 eval/stop/restart、日志订阅；设置页运行在独立 VM |
| 工具 | 共享 UTF-8/Base64/颜色 prelude；原生 CRC32、SHA-256、`/dev/urandom`；点集混合/投影/合并、UUID |
| 图形 | CPU 离屏 Canvas、字体渲染、PNG/JPEG/GIF 解码；CO5300 QSPI/framebuffer 480×480 RGB565、亮度/旋转/电源已接线，实际成像未验收 |
| 外设 | CST9220 触摸、QMI8658 IMU、AXP2101 电池/电源键已接线；P12 读到了电池与温度，交互/姿态/充放电全流程仍需逐项验收 |
| 网络 | Wi-Fi station、TCP/UDP/TLS、HTTP(S)/WebSocket；mDNS/DNS-SD 共享 worker 与 devd TXT 已接线，宿主默认不广播 |
| 音频/语音 | IMA ADPCM、WAV/MP3 解码、ES8311 播放、ES7210 采集与 JS/云端 speech/voice 已接线；P14 未初始化 BLE 时通过播放/采集及 VM 生命周期，声学效果和云端连续对话未验收 |

`system.info().capabilities` 根据驱动探测报告 IMU、触摸、电池、麦克风和扬声器准备状态；它不是完整功能验收结果。AXP2101 不可用或没有电池时返回不可用电池值，正常硬件读取实际电量/电压。宿主 `heapFree/psramFree` 为 0（未推测操作系统剩余内存），NuttX 的 `heapFree` 来自真实 allocator；独立 PSRAM 空闲量暂未区分。启用 `ESP32S3_EFUSE` 时，`deviceId` 和 Wi-Fi 状态中的 `mac` 经 `/dev/efuse` 的 `EFUSEIOC_READ_FIELD` 读取芯片 factory MAC，设备 ID 保持 `pxb-` 加 MAC 的原有格式；代码不写入 eFuse。宿主或 eFuse 不可用时 ID 回退为 hostname，无法作为硬件认证标识。Devkit 未实现 `board_uniqueid()`，因此没有启用 `BOARDIOC_UNIQUEID`。

BLE 已进入主构建/运行入口，但 P14 实际配置缺失 RAW HCI 注册路由，初始化失败及共存回归尚待新版真机复验。SoftAP/网页配网、本地 MultiNet7 唤醒、深睡眠和固件 OTA 尚未进入已验收主固件；部分模块已有独立源码和宿主测试。摄像头、GPS、LED 在原 ESP-IDF 的本板能力表中就为 false，并非本次迁移丢失。未支持的动作仍按 SDK 契约返回 ENOTSUP；不要把接口存在、能力探测或独立宿主测试当作真机已通过。

## 主机验证：无需 NuttX 工具链或硬件

依赖 CMake ≥ 3.20、C11 编译器、Python ≥ 3.9 和 QuickJS-ng v0.10.1 源码。仓库已有 `firmware/components/jsvm/quickjs-ng` 时直接复用源码目录；只导入 QuickJS 和共享纯 JS 文件，不链接 ESP-IDF。独立工程使用自身 `quickjs-ng/` 和 `shared/prelude_core.js`。

```sh
cmake -S firmware-nuttx -B firmware-nuttx/build -DCMAKE_BUILD_TYPE=Release
cmake --build firmware-nuttx/build -j 4
ctest --test-dir firmware-nuttx/build --output-on-failure --timeout 60
firmware-nuttx/build/pixelbox --timeout-ms 2000 firmware-nuttx/examples/hello.js
```

也可以显式指定 `-DPX_QUICKJS_DIR=/path/to/quickjs-ng`。CMake 自动运行 `tools/prepare.py`；它验证 QuickJS 版本、在构建目录暂存源码和嵌入 prelude。NuttX 单线程编译关闭 QuickJS Worker/Atomics，不修改共享 QuickJS 源。

主机测试直接运行编译出的二进制，验证自动从 SDK 类型声明提取的全部 `px.*` 域/继承/嵌套成员、返回类型约定、异步 ENOTSUP、真实文件与跨进程 KV、哈希标准向量、图形/编码算法、事件循环、未处理拒绝、路径隔离和死循环超时。独立工程不附 SDK 声明时仅跳过“从 SDK 动态提取成员”这一项，其余运行测试照常执行。

## NuttX 集成

支持 Linux、macOS；Windows 使用 WSL2。准备以下独立工具和源码（不要求 ESP-IDF）：

- 同一个 **Apache NuttX 12.9.0** release 的 `nuttx` 与 `nuttx-apps` 源码树。
- `xtensa-esp32s3-elf-gcc` 工具链以及对应 binutils，编译器所在目录加入 `PATH`。
- GNU Make（macOS 可名为 `gmake`）、Bash、Git、宿主 C 编译器、`gperf`、`flex`、`bison`、`patch`、`unzip` 和下载源码依赖所需的 `curl`/`wget`。runner 会优先把本工程的 `tools/flock` 放入构建子进程 `PATH`，因此 macOS 不需要额外安装系统 `flock`；若从独立 NuttX apps 目录直接调用 Make，才需要提供可执行的 `flock`。
- Python 3、Kconfig frontends 的 `kconfig-conf` 与 `kconfig-tweak`。runner 会从 `KCONFIG_FRONTENDS_PATH`、工程工具目录和 NuttX `tools/kconfig-frontends/bin` 自动发现，并通过 `KCONFIG_CONF` / `KCONFIG_TWEAK` 传给 Make。
- 当前 `nuttx-apps` 的 LVGL 配置使用 `imply` 语法；推荐同时准备 Python `kconfiglib` 命令（`menuconfig` / `olddefconfig`），并通过 `KCONFIGLIB_PATH` 指向其 `bin` 目录。runner 会优先使用它完成 Kconfig 解析，旧 frontends 仍用于 `kconfig-tweak`。
- `esptool.py`：用于生成 ESP32-S3 镜像和串口刷写；P12 构建日志使用4.8.1，真机刷写校验使用4.12.0。Python 包可安装在项目虚拟环境中。

把内核和 apps 放在固件工程目录外，通过环境变量或 runner 参数指定。示例（用真实路径替换）：

```sh
export PATH="/opt/xtensa-esp32s3-elf/bin:/opt/nuttx-venv/bin:$PATH"
export NUTTX_PATH=/opt/nuttx-12.9.0/nuttx
export NUTTX_APPS_PATH=/opt/nuttx-12.9.0/apps
# 也可以用环境变量显式指定独立工具目录（不读取 IDF_PATH）：
# export NUTTX_TOOLCHAIN_PATH=/opt/xtensa-esp32s3-elf
# export KCONFIG_FRONTENDS_PATH=/opt/kconfig-frontends
# export ESPTOOL_PATH=/opt/nuttx-venv/bin/esptool.py
```

runner 将本应用放在 NuttX apps 的 `interpreters/pixelbox/`。`Make.defs` 在 `CONFIG_INTERPRETERS_PIXELBOX=y` 时将它加入 `CONFIGURED_APPS`，入口符号是 `pixelbox_main`，注册命令为 `pixelbox`。runner 先准备依赖再配置 NuttX：

```sh
python3 firmware-nuttx/tools/prepare.py
# 可选：--quickjs-dir DIR --repo-root ROOT --output DIR
python3 firmware-nuttx/scripts/nuttx.py configure --target esp32s3
python3 firmware-nuttx/scripts/nuttx.py build --target esp32s3
# 设备与串口确认后再手动刷写：
python3 firmware-nuttx/scripts/nuttx.py flash --target esp32s3 --port /dev/ttyUSB0
```

具体 runner 参数以 `python3 firmware-nuttx/scripts/nuttx.py --help` 为准。不要用 ESP-IDF 的 `export.sh` 或 `idf.py` 构建此版本。NuttX 编译依赖如下：

NuttX SDK、apps、工程和 Python 的路径需仅包含英文字母、数字以及 `_ . / + - @` 等 runner 允许的安全字符（`@` 用于 Homebrew 版本目录）；不要包含空格或 shell 字符，避免上游 Make 二次解释路径。更换同一路径中的 SDK/apps 源码版本后须先执行 runner 的 `clean`，再 `configure` / `build`，以重新生成隔离的构建副本。

runner 把 SDK/apps 快照复制到本工程 `build/esp32s3/`，不在原始源码树编译；复用现有快照时会在日志提示。项目应用源码/头文件以文件级链接加入该快照，修改本工程代码仍可正常增量编译。切换来源路径或清理时只操作本工程拥有的构建目录。`merge` 输出 Simple Boot 的可刷写镜像，不生成 ESP-IDF bootloader/分区表组合。

Flash QIO 取指采用 ROM DIO 载入、RAM 中官方 QE 验证后切换的启动流程；两套 Kconfig、隔离补丁、IRAM/DRAM 依赖及实际模式核验见 [SimpleBoot Flash QIO](docs/flash-qio.md)。配置启用不代表真机模式与性能已验收。

- C11、POSIX 文件/目录/时钟、`LIBM_TOOLCHAIN=y`、`DEV_URANDOM=y`；不需要 C++/STL。QuickJS 使用 `log1p`、`hypot`、`lrint` 等函数，精简 `LIBM=y` 无法满足链接；使用独立 Xtensa 工具链提供的完整数学库。`LIBC_LOCALTIME=y` 提供 `tzset` 和 POSIX TZ 字符串（例如 `UTC0` / `CST-8`）；若主动裁剪此配置，`setTimezone()` 明确返回 ENOTSUP。没有启用会下载完整时区数据库的 `LIBC_ZONEINFO`。
- 文件持久化需要可写文件系统；现有 profile 使用 SPI flash MTD + LittleFS，并预留 flash 的后 8 MiB 为数据区。
- `BOARD_LATE_INITIALIZE` 先初始化设备；`main.c` 只尝试 `mount("/dev/esp32s3flash", "/data", "littlefs", 0, NULL)`，失败输出原因，**绝不自动格式化或清空原有分区**。`NSH_ARCHINIT=n` 防止进入控制台时重复注册板级设备。
- 原生任务栈默认 64 KiB，JS 堆默认 4 MiB；由 `INTERPRETERS_PIXELBOX_STACKSIZE` / `INTERPRETERS_PIXELBOX_HEAP_SIZE` 调整。
- QuickJS 编译需要 `-fno-strict-aliasing`、`NO_TM_GMTOFF`、`__STDC_NO_ATOMICS__=1`，Makefile 已设置。

首次使用需要明确地初始化 LittleFS 分区并把已打包的应用放入 `/data/app/`，含 `main.js`、`manifest.json`、`assets/`。没有默认入口时运行内置欢迎与系统诊断；指定了不存在的入口则返回失败。没有挂载持久化存储时欢迎仍可执行，但 `px.storage.*` 写入会真实失败。

默认 `INTERPRETERS_PIXELBOX_CONSOLE_AFTER_APP=y`：启动任务同时维护 NSH 控制台和常驻服务，欢迎/用户应用退出后 devd 仍可接收远程控制。显式调用 `pixelbox /data/app/main.js` 只运行该脚本，结束后返回原控制台；后台监督器拥有已安装应用的生命周期。串口连接方式与避免误切下载态的说明见 [安全串口控制台](docs/serial-console.md)。

**首次初始化步骤**：先用 espIDE 串口日志/串口终端连接设备，在 NSH 执行 `mount` 查看挂载列表。若 `/data` 已挂载为 LittleFS，直接从 `mkdir` 开始，无须格式化。若此前挂载失败，先确认 flash 型号和 profile 的 `0x800000..0xffffff` 数据区没有需要保留的内容；下面带 `forceformat` 的命令会擦除该数据区，必须由操作者明确确认后在 NSH 手动输入，固件不会自行执行：

```text
nsh> mount -t littlefs -o forceformat /dev/esp32s3flash /data
nsh> mkdir /data/app
nsh> mkdir /data/app/assets
nsh> echo '{"name":"NuttX demo","id":"local.demo","version":"0.1.0"}' > /data/app/manifest.json
nsh> echo "console.log('hello NuttX', px.system.info().deviceId);" > /data/app/main.js
nsh> pixelbox /data/app/main.js
```

确认执行成功后重启，监督器优先启动已提交的 `/data/apps/current` 应用；没有已安装包时回退 `/data/app/main.js` 或内置欢迎。已有有效数据分区只需要普通 `mount -t littlefs /dev/esp32s3flash /data`；已经挂载时不重复挂载，不运行 `forceformat`。上述命令使用 NuttX 12.9 的 `littlefs_bind` 显式 `forceformat` 分支；格式化不是串口恢复或普通升级步骤。

devd 已支持现有 `DevdClient` 的 hello、eval、日志和应用分块热推送协议。设备端按 manifest/文件块接收、验证 SHA-256 并原子提交，不在板上实现 ZIP 解压。P13 已通过 mDNS 双向发现、真实端口/TXT、应用 goodbye 与 devd 跨 VM 存活；已知 IP 时可以直接连接 TCP 8765。设备应用推送与固件 OTA 是不同路径，后者仍未实现。生命周期与发现说明见 [常驻服务](docs/service-lifecycle.md)、[mDNS](docs/mdns.md)。

## Framebuffer

运行时先打开 `/dev/fb0`，通过 `FBIOGET_VIDEOINFO` / `FBIOGET_PLANEINFO` 验证格式、分辨率、stride 和长度，再 `mmap`；支持 RGB565、RGB24、RGB32，按行 stride 写像素。若启用 `FB_UPDATE` 则调用 `FBIO_UPDATE` 提交。`screen.setPower()` 使用 `FBIOSET_POWER`。

`boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_co5300.c` 提供微雪 2.16 的 CO5300 QSPI 初始化和 framebuffer lower-half：配置启用 `VIDEO_FB`、SPI2 QIO、`/dev/fb0`，分辨率为 480×480、像素格式为 RGB565，`FBIO_UPDATE` 按脏矩形向面板发送像素。若 QSPI 初始化或 framebuffer 校验失败，运行时会把 `screen.width/height` 设为 0，主屏绘制抛 `ENOTSUP`，离屏 `createCanvas` 仍可用。QSPI 时序、触摸联动、面板电源和真机图像效果仍需在实际板卡上验证。

## 运行边界

```sh
pixelbox --app-root /data/app --data-root /data /data/app/main.js
pixelbox --turn-timeout-ms 1000 --timeout-ms 30000 /data/app/main.js
```

每次同步 JS 调用与一批微任务默认最多 1000 ms；超时会退出并返回非零。`--timeout-ms` 默认 0，表示不限制应用总运行时间；主机测试显式设置总超时。最多 128 个存活 timer、每 timer 16 个透传参数；最多 32 个待判断的 Promise 拒绝，处理耗尽时明确失败。所有 JS 都在入口任务执行，原生回调不跨线程进入 QuickJS。

文件单次最大 4 MiB，随机字节单次最大 1 MiB，VM 使用自有分配头核算 QuickJS 内存上限。`px.app.exit()` 只停止当前 VM，退出钩子在销毁前执行。未处理异常/拒绝、未找到显式入口和超时均返回非零，供串口日志或宿主自动化识别。

当前宿主运行契约、P13/P14 启动与网络、mDNS 和未初始化 BLE 时的音频/麦克风生命周期已有验证证据；**实际显示、声学效果、完整外设交互以及 BLE 共存修复仍需对应验收**。通过结果不自动覆盖后续源码修改；镜像 SHA、验收范围和未通过项目记录在 [能力对照](docs/feature-parity.md)。无人值守刷写与软件恢复入口见 [恢复流程](docs/unattended-recovery.md)。
