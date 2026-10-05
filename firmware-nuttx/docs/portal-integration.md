# NuttX 网页配网门户接线说明

当前已接入门户核心、JS 绑定、service 生命周期、系统配网键，以及 main/runtime/Make/Kconfig 的显式构建开关；默认关闭和显式开启两种宿主构建均已通过。独立 APSTA + 门户 + MN7 的完整 NuttX 镜像已编译、链接并通过 Simple Boot 摘要校验。**主 `configs/esp32s3.config` 仍不启用门户；真机 APSTA、手机 DHCP、实体按键/屏幕与运行时内存高水位未验证**。门户验证没有切换 Mac 的网络或访问串口。下面的宿主测试使用真实 SDK/devd/QuickJS/HTTP，只有 AP/Wi-Fi/DHCP 是可控桩，不能等同真机通过。

**门户线程已改为按会话创建，硬件启用仍需核对内部 SRAM。** `src/portal.c#px_portal_init` 只初始化轻状态，启用构建在空闲和 VM 运行期不分配门户线程栈。service 完全 join/waitpid 旧 VM 后，`px_portal_begin` 才分配 32 KiB 控制栈与 8 KiB DHCP 包装栈；会话清理后 `px_portal_reap` 确认两个 worker 完成、join 成功，才释放 `wifi_owned` 并允许下一代 VM 创建。门户活动期两线程需 40 KiB，加上上游 DHCPD 的 8 KiB 栈，三栈合计 48 KiB；退出旧 32 KiB VM 后净增加约 16 KiB 栈预算，另需线程元数据、APSTA 和缓冲区。主任务此前测到 BLE 后内部堆一度仅余约 1.3 KiB，不能只根据缩栈配置认定新预算足够。当前 Xtensa 的 task/kthread/pthread 栈均走内部堆，改创建 API 不会将栈移入 PSRAM；必须核对真机最大连续空闲块和高水位，再启用门户。

## 文件与接口

- `include/pixelbox_portal.h`：生命周期、服务请求、状态快照契约。
- `src/portal.c`：按会话创建/回收控制与 DHCP worker、4 连接非阻塞 HTTP、Wi-Fi 单消费者、凭据原子保存及退出恢复。
- `src/portal_platform.c`：真实 AP MAC、每次随机 8 位密码、绑定 `wlan1` 的 DHCPD 适配；DHCPD 调用只在独立 worker。
- `src/portal_binding.c` / `src/prelude_portal.js`：`px.wifi.portal.start()/stop()/status()`，安装函数 `px_install_portal(ctx, native)`。
- `src/portal_html.inc`：与原 ESP-IDF `firmware/components/wifi_portal/src/portal.html` 逐字一致；`scripts/embed_portal.py --check` 校验，直接运行该脚本可重新生成。
- `scripts/softap_adapter_patch.py`、`scripts/portal_dhcp_patch.py`：只修补复制的 SDK 快照，禁止修改 `.deps` 源。
- `src/service.c` / `include/pixelbox_service.h`：显式启用后由常驻监督器接管门户，等待 VM 完整退出和门户完整收尾。
- `src/system_keys.c` / `include/pixelbox_system_keys.h`：默认不启用配网；监督器 init 成功后开启 BOOT+USER 能力，门户期间 PWR 短按返回应用。

原四个 HTTP 接口保持兼容：`GET /`、`GET /status`、`GET /scan`、`POST /connect`。未知 GET 路径 302 跳转 `http://192.168.4.1/`；HTTP 只绑定 `192.168.4.1`，不监听 STA 地址。状态和网页响应不包含 AP 或 STA 密码。屏幕可通过 C 状态快照读取当前 AP 密码。

SSID 1..32 字节，开放网络密码为空；WPA 密码 8..63 字节，64 字节只接受十六进制 PSK。扫描最多 9 秒，同名保留最强信号、按信号排序、最多 24 条。连接最多 15 秒；真实取得 IP 且结果 SSID 匹配后，才原子写入 `/data/.pixelbox-wifi.json`，格式继续使用 `{"ssid":"...","password":"..."}`。成功展示 3 秒后收尾。

## service 的实际启用方式

构建 service 时显式定义 `PX_SERVICE_PORTAL`，并链接门户实现。没有该宏时，默认 host 和旧固件不增加门户链接依赖，`enable_portal=true` 会使 `px_service_create` 返回 `-ENOTSUP`。仅定义宏不会启用网络行为，还必须设置：

```c
struct px_service_config config = {
  /* 保留现有 devd、app、run_app、network_status 等参数。 */
  .enable_portal = true,
  .portal = {
    .credentials_path = "/data/.pixelbox-wifi.json", /* NULL 同此默认路径 */
    .http_port = 0, /* 真机为 80；PX_PORTAL_HOST_TEST 下为临时端口 */
    .timeout_ms = 0, /* 默认 180000 ms；无人操作也会安全收尾 */
  },
};
```

`src/main.c` 已在 `#ifdef PX_SERVICE_PORTAL` 下完成上述启用接线。`src/runtime.c` 同条件安装 native；`prelude_portal.js` 在默认关闭构建中保留公开方法并明确抛出 `ENOTSUP`。显式开启但尚未初始化 service 时，公开方法返回 `ENODEV`，不会自行启动 AP。

boot 先初始化 Wi-Fi 和系统按键，再照原流程 create/run service。**main/VM 不要另行调用 `px_portal_init`**：`px_service_run` 在常驻任务中准备轻状态，`create` 会复制凭据路径，不借用调用者的临时缓冲区。控制线程用 32 KiB 栈、DHCP 包装线程用 8 KiB 栈，仅在旧 VM 完全退出后的 begin 创建；HTTP 和凭据文件均由控制线程创建、关闭。轻状态初始化失败时 run 返回原负 errno 并禁止启动 VM；`-EALREADY` 不会接管或销毁其他代码已初始化的门户。begin 遇到内存不足保留真实负 errno，第一线程创建失败不留栈；第二线程失败则异步通知已创建线程退出，仍保持 ownership 到 reap 成功。

service 已实现以下次序：

1. JS `px.wifi.portal.start()` 仅调用 `px_portal_request_start()`；BOOT+USER 保持 2 秒产生系统请求，由 service 排队。`start()` 返回 `undefined`，不返回需要旧 VM 存活的 Promise。系统请求的负 `result` 原样记录，不会强行覆盖成成功。
2. service 消费 START，记住恢复原应用或设置页的意图，请求旧 VM 协作退出。`reap_finished` 必须完成 join/waitpid 后，`refresh_portal` 才能 `begin`；旧 VM 的退出清理、Wi-Fi Promise 和资源回收均先结束。空闲进入门户，普通退出后仍保持空闲。
3. `begin` 立即设置 `wifi_owned=true` 并创建两线程；若 take 之后已被 stop 撤销，返回 `-ECANCELED`，不会迟到分配线程或打开 AP。门户期间 service 不调用 `px_wifi_poll` 或关闭 STA；devd 仍接收 hello/logs/push，EVAL 明确返回 application stopped。状态 API 保持只读；service 每轮调用 `reap`，未完成清理时立即返回，完成后才 join 回收线程。
4. 普通门户 stop 或成功自动收尾后，恢复进入前的应用/设置页。远程 STOP 取消恢复，RESTART/push 排队启动已提交的用户应用；BOOT 转设置页，PWR 返回用户应用。上述切换都先请求 portal stop，且只有 `wifi_owned=false` 才启动新 VM。
5. `px_service_request_shutdown` 停止 VM、撤销待进入门户请求，等待门户清理和两线程 reap 后 shutdown 轻状态。普通会话退出同样回收线程，不等到整机 service 退出。DHCP 卡住时 run 保持 supervising，reap 不 join 活跃线程，devd/状态仍可用。再次远程 stop/restart 可触发明确的 DHCP 停止重试；不会每 25 ms 盲目重试。join 报错也保留 ownership 和未回收的线程句柄，禁止提前恢复 VM。
6. `px_service_get_status` 增加 `portal_enabled/pending/owned/phase/error`，只读快照不阻塞。空闲门户退出会将 devd app.state 恢复为 stopped，不遗留 updating。

从 `begin` 起未成功完成配网的总会话默认最多 **3 分钟**（`PX_PORTAL_DEFAULT_SESSION_MS=180000`，`config.portal.timeout_ms=0` 取默认值）。HTTP 请求不延长此期限。到期保存 `-ETIMEDOUT`、关闭 HTTP 并走与 stop 相同的安全收尾：无切网时保留原 STA，连接已发起但未保存成功时取消并恢复原凭据，最后才恢复 VM。成功已保存后改走原 3 秒成功展示期限。该上限限制继续接受配网，不代表能强制中断卡住的 DHCP/驱动：收尾仍保持 ownership，不会以超时为由强启另一 VM。

系统键能力由 service 自动维护：`px_system_keys_set_provisioning_enabled(true)` 仅在 init 成功后调用；默认关闭时组合键仍报告 `-ENOTSUP`。`px_system_keys_set_provisioning_active(true)` 只影响门户期间 PWR 返回，不把门户误标为设置 VM；关闭能力同时清除 active。

**屏幕绘制仍待主固件接线**：当前 service 没有绘制 AP SSID/密码。可以从 C `px_portal_get_status` 获取提示内容，但只能在旧 VM 完整退出后接管显示，不应运行一个还会消费 Wi-Fi 的 JS VM 作为门户 UI。`active=false` 不等于 `wifi_owned=false`，不能据此恢复 VM。

直接 AP 启停只改 `wlan1`，不会断开 Finger STA 或改默认路由。只有用户在网页提交新网络才会发起 STA 连接。若当前已连接但磁盘中没有与当前 SSID 一致的恢复凭据，`POST /connect` 返回 409，避免不可恢复地丢失现有远程入口。提交失败/取消后退出会用原凭据恢复；恢复失败会明确保留错误，不声称恢复成功。

## 停止与阻塞边界

- 没有 Wi-Fi 作业时，退出不调用 `px_wifi_disconnect`。
- 停止时有扫描：继续独占消费其最多 9 秒的超时结果；不能用 disconnect 取消扫描，因为现有 API 会断开 STA。
- 停止时有门户发起的连接：调用 disconnect 取消，并消费取消结果；驱动清理暂时返回 `-EBUSY` 时保留 ownership，之后重连原凭据。迟到成功不得覆盖原凭据。
- DHCPD 的 start/stop 包含无超时 `sem_wait`。包装 worker 承担这些阻塞，状态/stop 请求仍即时响应。启动未完成就取消时，迟到 start 后会立即补 stop。
- 进入 DHCP 收尾等待超过 2 秒仍未完成时，状态报告 `-ETIMEDOUT` 和 stopping，保留 AP/Wi-Fi ownership，**不会伪报退出，也不会启动新 VM**。底层返回错误时再次 stop 可重试；永久卡死需要先修复底层，不应强杀/释放活跃线程。
- DHCP 确认退出后才关闭 AP；AP 回滚/停止失败保留 owned 标志，允许重试。

## SDK 修补及配置

`scripts/nuttx.py#prepare` 仅在 profile 显式设置 `CONFIG_INTERPRETERS_PIXELBOX_PORTAL=y` 时，自动在私有快照、Kconfig configure 之前执行这两个补丁；正常构建无需手动调用。对应动作是：

```sh
python3 scripts/softap_adapter_patch.py build/esp32s3/nuttx/arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c
python3 scripts/portal_dhcp_patch.py build/esp32s3/apps/netutils/dhcpd/dhcpd.c
```

`configs/esp32s3-portal.fragment` 是供独立工程副本合并到其 `configs/esp32s3.config` 的片段，runner 不会自动读取 `.fragment`。不要直接修改主 profile 或既有 build 的 `.config`；profile 指纹改变时 runner 会拒绝复用旧快照。`prepare` 在首次和复用配置时检查显式请求未被 Kconfig 丢弃；最终门户配置必须包含 APSTA、无线 ioctl、DHCPD、接口绑定，以及与 `192.168.4.1` 匹配的固定 DHCP 地址池和关闭的 DNS 选项。

两个脚本都锁定原函数 SHA-256、验证幂等、拒绝漂移/残缺补丁/符号链接。AP 补丁同时支持 STA-only、AP-only、APSTA。当前完整 AP 补丁必须包含 `pixelbox_wifi_apsta_safe`、`pixelbox_wifi_softap_running`、`pixelbox_wifi_softap_sync` 三个接口。

DHCP 补丁修复：内存申请失败唤醒 start；监听口绑定成功之后才报告 RUNNING；退出关闭 socket；start 返回真实失败并拒绝借用已运行的外部 DHCPD；stop 传播 kill 错误并允许 STOP_REQUESTED 重试；信号打断的 sem_wait 重试。状态采用 `<nuttx/atomic.h>` 的 32 位 `atomic_t` 与 `atomic_read_acquire/atomic_set_release`，避免 Xtensa 未提供字节原子符号。导出 `pixelbox_dhcpd_safe/status`，未应用补丁时平台层拒绝启动。固件必须由门户独占 DHCPD 全局单实例。旧实验版 atomic_uchar 补丁会被当前精确校验拒绝，应重建干净 SDK 快照后应用新版。

需要的配置：

```text
# CONFIG_ESPRESSIF_WIFI_STATION is not set
CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP=y
CONFIG_NETUTILS_DHCPD=y
CONFIG_NET_BINDTODEVICE=y
CONFIG_NETUTILS_DHCPD_STARTIP=0xc0a80402
CONFIG_NETUTILS_DHCPD_NETMASK=0xffffff00
CONFIG_NETUTILS_DHCPD_ROUTERIP=0xc0a80401
CONFIG_NETUTILS_DHCPD_DNSIP=0x0
CONFIG_NETUTILS_DHCPD_MAXLEASES=4
CONFIG_NETUTILS_DHCPD_STACKSIZE=8192
CONFIG_INTERPRETERS_PIXELBOX_PORTAL=y
```

保留现有 FDCLONE_STDIO、TCP backlog、write buffers、WLAN ioctl、网络启动和 watchdog 配置。DNS 选项必须为 0，因为首版没有 DNS 劫持服务；不声称手机自动弹 captive portal。手机可以手动访问 `http://192.168.4.1/`。

Make 已按开关添加 `softap.c portal.c portal_platform.c portal_binding.c`、`PX_SERVICE_PORTAL` 宏和 `portal_html.inc` 重编译依赖；runner 逐文件 staging 也已包含 `.inc`。runtime 按开关安装 `px_install_portal`；prelude 在 `prelude_wifi.js` 之后包含 `prelude_portal.js`。原 JS VM 的 startAP/stopAP 仍需另行明确是否映射到配网 UI，这个实现只提供 `px.wifi.portal`。

## 已运行的验证与剩余真机验证

2026-10-02 构建接线验证使用仓库根目录下独立 `tmp/portal-host-default-20261002` 和 `tmp/portal-host-enabled-20261002`，后者传 `-DPX_ENABLE_PORTAL=ON`；两种 `cmake --build` 均成功。按需线程改造后，两种完整 CTest 各 4 项通过，包括运行时、OTA、门户门控和默认关闭的 MultiNet7。`test_portal_build.py` 直接通过完整主 prelude 检查冻结公开 API、native 不泄露及开关对应的 `ENOTSUP`/`ENODEV`，不初始化网络。门户接线时 `python3 -m unittest firmware-nuttx.tests.test_build_runner -q` 60 项通过，新增覆盖真实补丁仅写临时 SDK 且幂等、门户 HTML staging、补丁早于 configure，以及首次/复用配置丢失门户时拒绝成功；后续其它模块可继续增加 runner 用例。

门户四个 C 模块先通过真实 Xtensa 参数的单文件编译，输出在 `tmp/portal-stack-20261002`。`-fstack-usage` 显示编译优化后的最大函数栈帧为 `poll_wifi` 2960 字节、`restore_previous` 1680 字节、`load_credentials` 1088 字节和控制 worker 672 字节；这些是局部栈帧，不含递归 QuickJS/系统调用总调用链。正式代码现使用 32 KiB OS 栈搭配 12 KiB QuickJS 栈限制；降低 JSON 上限同时为错误回溯及外层调用保留余量。隔离压力验证使用真实 pthread 自配 32 KiB 栈、上下保护页和 0xA5 高水位，覆盖 32 AP、24 项输出、最大凭据深嵌套/坏 JSON；macOS ARM 观测峰值 20,632 B，余 12,136 B。该结果和 Xtensa 静态帧共同支持此候选，不能替代真机高水位，也不证明 APSTA 动态内存足够。

随后 `tmp/portal-mn7-candidate-20261002` 使用同源码、同工具链独立构建纯 MN7 基线与 APSTA + 门户 + MN7 合并候选，runner 65 项测试及门户/service 的真实 TCP + QuickJS UBSan 回归通过。最终配置保留 `CONFIG_ARCH_SETJMP_H=y`、`CONFIG_XTENSA_CP_INITSET=0x0009`，PM/定时深睡关闭。合并镜像 6,244,056 B，4 KiB 对齐擦除上界为 `0x5f5000`，未触及后 8 MiB 数据区；最终配置、源码 SHA-256 和完整镜像摘要保存在该目录的 `validation.json`、`source-snapshot.json`。

该首个合并候选仍采用每接口 16 个静态 WLAN 包：链接器 DRAM 占用由 192,852 B 增至 218,772 B，**增加 25,920 B**；其中 `g_wlan_priv` 增加 24,688 B，来自第二接口的固定包池。内部堆起点相应由 `0x3fcb7154` 增至 `0x3fcbd694`。进一步核对 `esp32s3_imm.c#xtensa_imm_initialize` 后确认：当前内部堆从 `_sheap` 起固定分配 `0x38000`，静态增量不会自动缩小该堆，而是推进它的末地址；该首个候选末地址达到 `0x3fcf5694`，**保留用于静态比较，不上板**。不能将此前 STA 真机剩余内存直接沿用到 APSTA，也不能把静态增量简单当作已经从 imem 扣除。

后续 `tmp/portal-mn7-pktbuf8-20261002` 在隔离合并配置中设 `CONFIG_ESPRESSIF_WLAN_PKTBUF_NUM=8`，两接口合计仍为 16 包，保持固定池、不启用 `CONFIG_ESPRESSIF_WIFI_WLAN_BUFFER_OPTIMIZATION`。该轮同步了麦克风同率批量合帧、原生 RMS 和 framebuffer dirty 修复，并以同源纯 MN7 再次比较：DRAM 192,868 B → 194,404 B，**仅增加 1,536 B**，`_sheap` 为 `0x3fcb7764`；镜像 6,244,760 B，擦除上界仍为 `0x5f5000`，完整链接及 ROM 摘要通过。固定 imem 末址为 `0x3fcef764`，仍须先读取真机 `ets_rom_layout_p->dram0_rtos_reserved_start` 确认运行期堆边界；静态链接和 Flash 容量检查不覆盖这项。该改动减少每个接口的突发缓存，STA/AP 同时传输吞吐和丢包、音频并发、实际内存峰值仍需真机验证，未将其加入正式主配置或门户通用片段。细节见 `tmp/mn7-memory-review-20261002/heap-review.md`。

随后主任务通过 NSH 只读取得真实 ROM 布局，`dram0_rtos_reserved_start=0x3fceee34`（指针 `0x3ff1ae90`）。**上述旧 pktbuf8 候选超界 2352 B，旧 pktbuf16 候选超界 26720 B，均禁止烧录。**新的隔离配置把 `CONFIG_XTENSA_IMEM_REGION_SIZE` 减至 `0x36000`，并在构建后以 ELF `_sheap`、最终 `.config` 和这块实板的 ROM 端点检查至少 4096 B 普通尾区。该端点来自实板，不默认适用于所有 ESP32-S3 ECO。

栈压力已落实为正式 `tests/test_portal_stack.py`，先执行原 3 AP 完整回归，再单独编译生产栈大小的 fixture，执行 32 AP → 24 输出及 5 种不超过 1024 B 的嵌套/坏 JSON。`tests/portal_stack_probe.c` 只包装真实 pthread 分配，控制线程使用生产 32768 B 常量，栈两端为 `PROT_NONE`，join 后才扫描 `0xA5`。2026-10-02 的 `tmp/portal-stack-formal-20261002.json` 记录 16 个 controller 的最高写入范围 20,632 B、最低剩余 12,136 B，通过至少剩余 8192 B 的回归门槛。17 个 DHCP 包装线程受 macOS 最小栈限制实际使用 16 KiB，最高写入 368 B；其 DHCP 是桩，不构成真实 DHCPD 8 KiB 栈验证。

以下命令各有外层 60 秒上限，均使用 UBSan，未宣称 ASan 或真机通过：

```sh
python3 tests/test_softap_adapter.py --sanitize undefined
python3 tests/test_softap.py --sanitize undefined
python3 tests/test_portal_dhcp.py --sanitize undefined
python3 tests/test_portal_platform.py --sanitize undefined
python3 tests/test_portal_runtime.py build/libpixelbox_quickjs.a --sanitize undefined
python3 tests/test_portal_stack.py build/libpixelbox_quickjs.a --report /tmp/portal-stack.json
python3 tests/test_portal_binding.py build/libpixelbox_quickjs.a --sanitize undefined
python3 tests/test_service.py build/libpixelbox_quickjs.a --sanitize undefined
python3 tests/test_service_portal.py build/libpixelbox_quickjs.a --sanitize undefined
python3 tests/test_system_keys.py --ubsan
```

真实 TCP + QuickJS 回归覆盖原 HTML/四接口、状态不泄密、扫描去重排序、非法/分片 HTTP、取消扫描不掉 STA、取消连接后恢复原网络、只有拿到 IP 才原子保存、迟到 DHCP 启动的取消、DHCP 停止挂起/失败重试、service 取请求后取消、3 代 JS VM 退出不撤销已交接请求。DHCP 补丁测试提取真实上游函数编译，以 fault injection 验证启动/停止/异常退出和 25 次启停 fd 归零；平台测试编译真实 NuttX 分支并验证 `wlan1`、DHCP 参数字节序、负 errno、真实 `/dev/urandom` 密码读取。

`test_service_portal.py` 使用真实 SDK → devd → service → 独立 QuickJS 与真实门户 HTTP，AP start 和每次 Wi-Fi poll 都断言活动 VM 为零，每次 VM 启动断言 ownership/AP/DHCP 已释放。覆盖原生阻塞调用期间进入取消、stop/restart/push、DHCP 停止阻塞与失败重试、扫描收尾保 STA、设置页恢复、系统队列负 errno、空闲进入/退出、PWR 返回、成功凭据、初始化冲突不接管 singleton、shutdown 等迟到 DHCP 收尾、重复 create/run/destroy 及 fd 归零。原未启用门户的 service SDK 回归保持通过；系统键 7 组测试包括真实采样 worker 的两次 2 秒组合键，验证关闭能力为 ENOTSUP、启用后为 0，以及门户 PWR 返回。

按需线程新增回归使用 `tests/portal_instrumented.c` 包装真实 `pthread_create/join`，不替换真实线程执行。断言 init/request 阶段创建数为 0，任一门户线程 create/join 时活动 VM 为 0，每代 VM 启动及 service 结束时未 join 的门户线程数为 0。注入第一个/第二个线程创建失败，验证原负 errno、无 AP 启动、部分创建线程回收、service 自动恢复原 VM 和 devd hello；注入 join 失败，验证即便网络已关闭仍保持 ownership，状态查询不自行回收，明确 reap 后才释放。两组完整门户/service 回归在 UBSan 和外层 60 秒上限内通过。

同一测试的超时用例把 `timeout_ms` 配成 **350 ms** 加速同一生产分支，验证无人操作后恢复 VM/保持 STA、连接失败和进行中超时后恢复原网络且凭据文件逐字不变、DHCP start 阻塞时到期仍保留 ownership，底层放行后补 stop 并恢复 VM。默认常量的 180000 ms 值有断言；没有把加速宿主测试表述为实际等待 3 分钟或真机超时验收。

集成后还必须由主代理独占真机验证：STA 连续性、AP 开关、手机 DHCP、网页提交/失败恢复/成功保存、PWR/VM 重启退出、反复进入退出资源、watchdog 心跳。不要自动切换 Mac 网络，不要为这个验证进入无定时唤醒的深睡眠，不要修改后 8 MiB 数据区布局。
