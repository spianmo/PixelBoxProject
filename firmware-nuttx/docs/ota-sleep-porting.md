# NuttX OTA 与深睡恢复移植记录

审查日期：2026-10-01。本记录对应 ESP32-S3-Touch-AMOLED-2.16、SimpleBoot、16 MiB Flash，以及后 8 MiB 已有应用数据的约束。

2026-10-02 更新：定时深睡已完成默认关闭接线、宿主状态机测试和独立无无线 profile 的完整镜像生成；当前准确状态见 [timed-sleep.md](timed-sleep.md)。无线完整停稳与真机睡眠/唤醒仍未验证，下文的深睡实施顺序保留为后续硬件验收依据。

当前独立交付只实现 `px.system.otaCheck()`。它已通过 host QuickJS 和真实本机 TCP/HTTP 回归，尚未据此声明整机 OTA、烧录、定时深睡或唤醒成功。本次未执行 Flash 写入、分区擦除、SDK 修改、真机深睡或主构建接线。

## 已实现的只读查询

文件：`src/prelude_ota.js`。

公共签名沿用 `sdk/types/pixelbox.d.ts:180`：

```ts
otaCheck(manifestUrl: string):
  Promise<{version: string; url: string; notes?: string} | null>;
```

行为依据是原 `firmware/components/bindings_net/src/mod_system_net.cpp#js_ota_check:166` 与 `#semver_cmp:145`：

- 未传 URL 同步抛出 `otaCheck(manifestUrl) 缺少 URL`；显式传入的值按原字符串转换语义处理。
- 复用现有 `fetch(url, {timeoutMs: 10000})`，DNS、TCP/TLS、HTTP body 和重定向共用 10 秒截止时间。
- 仅 HTTP 200 进入 JSON 解析。其他状态拒绝为 `OTA manifest 获取失败: HTTP <status>`；传输错误保留 `OTA manifest 获取失败: <原因>`。
- JSON 语法异常保持原异常。`version` 或 `url` 为空时拒绝为 `manifest 缺少 version/url 字段`。
- `version/url/notes` 按原 `js_helpers.cpp#opt_str_prop:248` 转换：`null`/缺字段为空串，数字和布尔值转为字符串；输出只保留这三个字段，空 `notes` 省略。
- 版本比较读取前三段十进制数字，允许 `v`/`V`，缺段补零，忽略预发布、构建和第四段后缀；相同或更旧版本返回 `null`。超大版本段改用十进制字符串比较，避免原 C `int` 溢出及 JS `Number` 精度丢失。
- 当前固件版本来自闭包中的静态 `firmwareVersion`。查询不调用 `px.system.info()`：该方法原先会通过 `px.ble.available()` 触发能力探测（`src/prelude.js:26–30`）。
- 应用退出时立即拒绝未完成的查询，清除集合，忽略迟到的 HTTP/JSON 结果。既有网络 owner 负责关闭 socket，runtime 销毁阶段清除 timer：`src/prelude_net.js:103`、`src/runtime.c#run_locked:1017`。本片段没有新增 timer、文件写入、Flash 操作或硬件探测。

集成方需在主 prelude 构造 `px.system` 前建立唯一的静态版本源，例如 `const firmwareVersion = '0.1.0';`，让 `info()` 返回同一个常量；在 `prelude_http.js` 之后 include `prelude_ota.js`。闭包依赖为 `g`、`px`、`firmwareVersion`、`exitHandlers`。本交付没有自行修改主 prelude、Makefile、CMake 或共享配置。

验证命令：

```sh
node firmware-nuttx/tests/test_ota_contract.mjs
python3 firmware-nuttx/tests/test_ota.py firmware-nuttx/build/pixelbox -v
```

已通过 13 组 JS 契约和 6 项真实 QuickJS/HTTP 回归。覆盖更新/旧版本、字段转换、无副作用版本读取、HTTP/JSON/传输错误、缺字段、并发、中文分块、退出和迟到结果。真实 HTTP 测试先延迟重定向 1.25 秒，再让第二个连接挂起，仍从首次请求开始约 10.001 秒超时，并由服务端确认 TCP 关闭；应用完整退出也确认关闭 TCP。

本次验证日志：

```text
/var/folders/h6/fr6f0j_s5l980qwpdc1yz3vw0000gn/T/pixelbox-ota-validation-20261001-v4vc808q/summary.json
/var/folders/h6/fr6f0j_s5l980qwpdc1yz3vw0000gn/T/pixelbox-ota-validation-20261001-v4vc808q/contract.log
/var/folders/h6/fr6f0j_s5l980qwpdc1yz3vw0000gn/T/pixelbox-ota-validation-20261001-v4vc808q/quickjs-http.log
```

## `otaApply` 的现有启动边界

以下是已读取的代码事实：

1. `configs/esp32s3.config:5,61–62` 使用 `CONFIG_ESPRESSIF_SIMPLE_BOOT=y`，数据区始终为 `[0x800000, 0x1000000)`。`scripts/nuttx.py:26–27,223–224,936–937` 把这个边界固定在代码中，并在打包前检查按擦除粒度取整的镜像上界。
2. `.deps/nuttx/arch/xtensa/src/esp32s3/esp32s3_start.c:90–92` 在 SimpleBoot 下将 `PRIMARY_SLOT_OFFSET` 固定为 0；`#__start:468` 将 IROM/DROM 的 load address 加上这个 offset 后建立 XIP 映射。把同一 `.bin` 写到另一个地址，不能建立可切换的第二启动槽。
3. 同目录 `Bootloader.mk:90–93` 的 SimpleBoot 分支没有独立二阶段 OTA 引导器。`Kconfig:2441–2454` 将 SimpleBoot 与 MCUboot/legacy 格式分开，MCUboot 分支才选择 OTA 分区能力。
4. `flat_memory.ld:101–110` 的 SimpleBoot ROM 布局从 `0x20` 开始，满足 64 KiB MMU 映射同余；MCUboot 则另有镜像头和 metadata 布局。两种格式需重新生成，不能改扩展名或仅添加分区描述。
5. 原 ESP-IDF `mod_system_net.cpp#ota_task:243` 使用 `esp_https_ota_begin/perform/finish` 和另一个启动分区完成升级；当前 NuttX 不具备这条事务链。
6. 现有通用 `fetch` 最多缓存 2 MiB 响应（`src/prelude_http.js:2,70,101`）。2026-10-01 本次审查时 `build/esp32s3/nuttx/nuttx.bin` 为 3,407,472 字节（`0x33fe70`），已超过这个限制；`otaApply` 需要有界流式下载并写入已验证的非运行槽。

因此，当前 SimpleBoot 阶段 `otaApply` 继续明确返回 `ENOTSUP`。禁止运行中覆盖 offset 0，禁止把后 8 MiB 数据区用作下载暂存、scratch 或第二镜像，也不能用 `erase_flash` 进行迁移。

## 安全 OTA 的后续实施顺序

### 1. 先在独立构建中完成双槽引导验证

基于已存在的 NuttX MCUboot 支持生成应用和引导器，保持数据区原址与原大小。优先使用带回滚的 swap 模式，并确保 bootloader 与应用端 `bootutil` 使用同一版本、签名格式和 trailer 定义。

这一版本对齐需要主动处理：芯片配置 `ESP32S3_MCUBOOT_VERSION` 的默认 commit 与 `.deps/apps/boot/mcuboot/Kconfig#MCUBOOT_VERSION:23` 默认 commit 不同。不能直接启用两个默认配置后假定元数据兼容。

下面仅为计算空间上限的候选布局，尚未构建、验证或写入：

| 区域 | 起始 offset | 结束 offset（不含） | 大小 |
| --- | --- | --- | --- |
| 二阶段引导器及保留空间 | `0x000000` | `0x010000` | 64 KiB |
| primary 槽 | `0x010000` | `0x400000` | `0x3f0000` |
| secondary 槽 | `0x400000` | `0x7f0000` | `0x3f0000` |
| swap scratch | `0x7f0000` | `0x800000` | 64 KiB |
| 现有应用数据 | `0x800000` | `0x1000000` | 8 MiB，原址保留 |

每槽 `0x3f0000` 为 3.9375 MiB。必须用最终功能齐全的 MCUboot 签名镜像重新验算头、TLV、trailer 和实际擦除块；本次 3.25 MiB 的 SimpleBoot 产物不代表加入 MultiNet7 后仍装得下。如果任一完整镜像超过槽的有效容量，停止此布局，改为精简固件/模型布局或使用独立外部固件介质，不能扩大到用户数据区。

在 4 KiB 擦除块条件下每槽为 1008 块；所选 MCUboot 的扇区表上限和 trailer 大小必须覆盖实际几何参数，scratch 必须满足该 swap 算法的擦除块要求。不要套用默认 1 MiB 槽的设置。先读取 `MTDIOC_GEOMETRY` 的块信息；相关驱动为 `esp32s3_spiflash_mtd.c`。

原始接线点：

- 芯片 OTA offset/size：`.deps/nuttx/arch/xtensa/src/esp32s3/Kconfig:1843–1873`。
- 引导器生成参数：同目录 `Bootloader.mk:63–74`。
- 应用侧 swap 策略：`.deps/apps/boot/mcuboot/Kconfig:68–101`。
- 现有 `/data` MTD 创建：`.deps/nuttx/boards/xtensa/esp32s3/common/src/esp32s3_board_spiflash.c#init_storage_partition:275`。此函数创建的是一般存储分区；OTA 还需明确注册独立的槽设备和 flash map，不能把 `/data` 的 MTD 别名当 OTA 槽。

首轮交付是可离线审查的布局清单、链接 map、签名产物、完整尺寸和镜像头检查、flash map 单测，以及模拟 Flash 的故障注入结果。该轮无需改变真机启动格式。

### 2. 实现有界、可失败的 OTA worker

`otaApply` 的公共签名及 `download/write/verify` 回调保留原 SDK；native worker 必须满足以下明确行为：

- 单实例排他；旧 VM 退出后不向旧 QuickJS context 回调。
- 使用验证证书与主机名的 HTTPS 传输，固定连接/读取超时和整个作业的截止时间。采用小块流式缓冲，不把整固件留在 JS heap/PSRAM。
- 在操作前核对目标板、镜像格式、允许版本、签名公钥和可写槽范围；下载过程中累计长度不能越过有效镜像容量。未知长度、错误/冲突长度、重定向和提前 EOF 都需明确处理。
- 写入对象只能是非运行槽；所有擦除范围按硬件粒度核对，不接触 bootloader、运行槽和后 8 MiB。处理每次 erase/write/read 的返回值和短写，失败不设置 pending。
- 下载完成后读回校验完整长度、hash、镜像结构和签名。然后使用所选 MCUboot 的试运行事务设置 pending，检查返回值。进度 `verify=100` 只能在真实验证通过后产生。
- 新固件首先完成 `/data` 原址挂载、USB/NSH 恢复、看门狗、显示和基本音频/网络自检，再提交 confirmed。启动失败或未确认时回滚旧固件。

可查的原始 API 示例：`.deps/apps/examples/mcuboot/update_agent/mcuboot_agent_main.c:196,282` 使用 `FLASH_AREA_IMAGE_SECONDARY(0)`、`boot_set_pending_multi(0, 0)`；`slot_confirm/mcuboot_confirm_main.c:43` 使用 `boot_set_confirmed_multi(0)`。这些示例的 sink 未检查 `flash_area_write` 返回值，确认示例也未检查结果；产品实现必须补齐这些失败分支，不能直接照搬示例当完成品。

### 3. 最后验证迁移与回滚

建立可恢复的下载/复位通道后，再将独立构建得到的二阶段引导器和 primary 初始镜像通过受控有线迁移写入前 8 MiB。SimpleBoot 到 MCUboot 的首次迁移本身不属于可在原运行镜像上安全完成的常规 OTA。

在测试介质/备用设备上逐阶段断电，覆盖 header、body、trailer、pending、swap 和首启确认；验证下一次启动能继续事务或回滚，后 8 MiB 内容保持不变。当前用户无法人工复位，单板上不先做引导器替换或断电故障注入。

## 定时深睡与恢复的现有边界

原 SDK `deepSleep(ms?: number): void`（`sdk/types/pixelbox.d.ts:170`）对应 `firmware/components/jsvm/src/mod_system.cpp#js_deep_sleep:226`：`ms > 0` 时配置 timer，否则不配置定时唤醒；随后进入不返回的深睡。原长按关机另外配置 GPIO18 的 ext1 低电平唤醒（`firmware/main/system_keys.cpp#shutdown_sequence:69–100`）。

当前 NuttX 主配置未启用 `CONFIG_PM`，前端仍 `ENOTSUP`。已核对的底层路径：

- `esp32s3_pm.c#esp32s3_sleep_enable_timer_wakeup:882` 设置 timer trigger 和微秒时长。
- `#esp32s3_timer_wakeup_prepare:446` 根据 RTC 校准值换算，减去睡眠开销并设置唤醒时间。需要验证慢时钟校准和时长换算，不能仅检查 JavaScript 定时器。
- `#esp32s3_pmsleep:1095` 配置 timer 后调用 `#esp32s3_deep_sleep_start:1050`。
- 深睡函数调用 `esp32s3_sleep_start()` 后没有检查其结果，并执行 `while (1)`（`:1072–1078`）。正常唤醒经过芯片启动路径重新创建整个系统，不能继续原 JS 栈。
- `esp32s3_reset_reasons.h:72` 明确区分 `RESET_REASON_CORE_DEEP_SLEEP=0x05`，与软件复位/看门狗复位不同。恢复验证必须记录这个原因。
- `esp32s3_idle.c#up_idlepm:149` 会在 governor 选择 `PM_SLEEP` 时自动调用睡眠，默认 20 秒；直接启用 `CONFIG_PM` 会扩展到自动空闲路径。`drivers/power/pm/Kconfig:72–89` 提供 `PM_GOVERNOR_EXPLICIT_RELAX=-1` 以在启动时锁定各电源等级。

AXP2101 的整机断电与 ESP32 深睡需要分开处理。`src/power.c#px_power_shutdown:188` 目前只关闭驱动句柄，不表示关闭 PMU 电源。定时唤醒需要维持芯片 RTC 供电，不能通过 PMU 断电来实现 `deepSleep(ms)`。

## 深睡的后续实施顺序

1. **先做主机可验证的状态机。** 独立实现请求验证、一次性请求 ID、服务协调停止、忙状态、超时和恢复原因解释。正时长需要有限数、可表示的微秒值与 RTC 范围检查；无参数/非正时长需要已验证外部唤醒源。外部唤醒未完成时，明确返回 `ENOTSUP`，不能让用户设备进入无限睡眠。
2. **由 service 协调完整退出。** JS native 只登记请求并结束 VM，由设备服务依次停止语音、麦克风、播放、网络会话、mDNS、BLE、Wi-Fi，等已打开文件提交完成。`px_mic_stop/px_mic_quiesce(2000)` 和 `px_audio_shutdown/px_audio_quiesce(2000)` 的真实返回值必须通过；任何清理超时中止过渡，不能直接关时钟。相关入口位于 `src/runtime.c:1017–1040`、`include/pixelbox_audio.h:15–21`、`include/pixelbox_mic.h:17–19`。设备级 BLE 常驻 controller 还需独立停止/确认接口；仅 `px_ble_destroy` 销毁 VM 会话不足以证明整机无线已停止。
3. **锁住自动空闲睡眠，显式试定时入口。** 候选 PM 配置应从启动就阻止自动降级，例如 `CONFIG_PM_GOVERNOR_EXPLICIT_RELAX=-1`，由已验证的服务请求控制进入底层定时睡眠。先在独立构建核对配置展开、链接和 PM 初始化，不直接修改当前工作设备的共享配置。
4. **保留过渡期看门狗监督。** 在整个收尾阶段保留一个 busy health handle，只有每个步骤真实完成后才报告进度；进入深睡前最后报告一次后保持 busy。`src/watchdog.c#check_health_locked:70` 只对 busy 客户端检查 5 秒进度。若先注销全部 busy handle，底层睡眠失败返回后卡在 `while (1)`，监督线程仍能看到“所有客户端空闲”并持续喂狗，无法自动恢复。过渡 handle 能覆盖 CPU 仍运行时的失败；真正进入深睡后定时唤醒失效时，不能依赖已停止的普通看门狗作为恢复保证。
5. **用 RTC 一次性标记避免循环睡眠。** 候选标记包含 magic、结构版本、请求 ID、期望时长、状态和 CRC。在 service 自动启动应用前读取复位原因并消费一次；识别到定时深睡恢复时先保持应用停止，恢复 USB/NSH/显示后再允许显式恢复应用。现有链接脚本 `esp32s3_sections.ld:642` 提供 `.rtc.bss (NOLOAD)`；`esp32s3_pm.c:377` 保持 RTC FAST 存储。仍需验证 SimpleBoot warm boot 不清此区域，以及该段实际位于 retained fast memory。禁止覆盖已有 `.rtc_reserved` 的 24 字节。冷启动、CRC 错误、WDT 复位和不同固件版本必须有明确分支，不能盲信旧标记。
6. **熄屏与恢复走现有显示协议。** `boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_co5300.c#pixelbox_fb_setpower:582` 已发送 `0x28/0x10` 熄屏休眠；恢复执行 `0x11`、等待 600 ms、`0x29`、恢复亮度并刷新。深睡重启时需完整初始化屏幕及 I²C 外设，不能只调用背光或继续旧帧缓冲。
7. **最后做可恢复的短时真机验证。** 先验证一次 1 秒定时深睡：记录入睡请求、复位原因 `0x05`、RTC 标记消费、USB 重新枚举、NSH、显示、应用可重启以及原数据可读。随后覆盖重复唤醒、超时收尾、仍在 DMA 时拒绝、网络下载中拒绝，以及禁止自动睡眠的待机观察。只有这条恢复链已验证，再实施 GPIO18 外部唤醒和无时长深睡。

当前设备无法人工复位，深睡实现和 OTA 引导迁移均停留在可离线验证的阶段；保留现有可工作的 USB/NSH 与恢复固件，等上述恢复证据完整后才转入真机验证。只读 OTA 查询可独立接入，不依赖这两项危险路径。
