# 常驻开发服务与托管应用监督者

`src/service.c` 只负责 C 生命周期和邮箱，不包含 QuickJS API。devd 网络线程使用自己的
JSON context；应用任务拥有应用 JSContext。监督者是 `px_devd_take_action()` 的唯一消费者。

## 主入口接线

将 `src/service.c` 加入应用构建。启动任务应保持 8KiB 栈，并在平台/Wi-Fi/存储初始化后：

```c
struct px_service_config config = {
  .devd = {
    .storage_root = "/data/apps",
    .port = 8765,
    .name = "PixelBox",
    .model = "ESP32-S3-Touch-AMOLED-2.16",
    .firmware = "当前固件版本"
  },
  .app = options,
  .run_app = px_run,
  .start_on_boot = true,
  .app_priority = CONFIG_INTERPRETERS_PIXELBOX_PRIORITY
};
struct px_service *service = NULL;
int result = px_service_create(&config, &service);
if (!result) {
  result = px_service_run(service); /* 启动任务留在这里常驻 */
  int destroyed = px_service_destroy(service);
  if (!result) result = destroyed;
}
```

示例的版本字符串由主入口填入真实值。`config.app` 是运行参数模板；
已提交 `current` 应用的 root/entry 优先。没有 `current` 时，非 NULL 的
`config.app.app_root` 作为回退；未指定 entry 时传给 runtime 的 entry 仍为 NULL，
由 runtime 尝试 `main.js`，不存在时保留内置欢迎程序和自动联网。不能把这个缺省入口
改写成显式 `"main.js"`，否则 runtime 会将 ENOENT 当成应用启动失败。
不需要旧路径回退时将 app_root 设为 NULL。
没有应用时保持空闲，后续 push/restart 仍可启动应用。

配置字符串在 create 时复制，不依赖栈上字符串长期存活。
`config.app.eval_source` 必须为 NULL，诊断 `--eval` 不走该监督者。
`devd.notify_action` / `opaque` 由监督者接管。

可注入 `config.network_status` 与 `network_opaque`：监督线程启动后立即读取一次，
随后最多每 1000 毫秒调用一次，把缓存中的 IP、MAC 和 heap 统计传给 `px_devd_network()`。
回调不能阻塞、等待网络或访问 JS，服务不持 mutex 调用；返回负错误保留上一份状态。
opaque 必须存活到 destroy 完成。该刷新与事件等待都基于 monotonic 时间。

NuttX 应用使用独立 `task_create("pixelbox-app", ..., PX_SERVICE_APP_STACK_BYTES, ...)`，
栈大小取 `CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE`（缺省 32KiB）。
启动任务是它的父任务，监督者在应用完成后 `waitpid()`；不使用 `task_delete()`。
NSH 应由主入口创建为另一个 8KiB 任务，不能取代常驻监督循环。
host 使用至少 1MiB pthread 栈，方便独立集成测试。

当前 `CONFIG_TLS_NELEM=0`，所以 service 不依赖 pthread TLS。
NuttX 唤醒使用 semaphore；macOS 不支持 `sem_init()`，host 使用非阻塞写端 pipe。
这不要求为板端开启 `CONFIG_PIPES`。等待事件不依赖实时时钟，NTP 校时不会改变等待行为。

## runtime 接线

在 `px_run()` 所在线程最初取得句柄并保存在 runtime 结构：

```c
struct px_service_vm *managed = px_service_vm_current();
```

非托管 NSH/宿主诊断调用得到 NULL。只有 service 启动的应用线程能取得托管句柄，
不会因为系统有运行中的托管应用就让诊断 VM 抢走 EVAL。
runtime 仍需要全局 trylock，防止非托管诊断 VM 与托管应用同时访问全局屏幕/音频资源。

JSContext 就绪后调用 `px_service_vm_enter(managed)`。NULL 是无操作；
`-ECANCELED` 表示启动过程中已有停止请求，应进入正常清理。
不要把 enter 放在 JS 尚未建立、但仍可能失败的任意硬件初始化之前。

QuickJS 中断回调只新增：

```c
if (px_service_vm_should_stop(managed)) return 1;
```

该函数仅原子读取停止标记，不取锁、不消费邮箱、不执行 JS，也不喂 watchdog。
不要从 interrupt 回调调用 `take_eval`、`complete_eval`、`log` 或其它 service API。

每轮事件循环在 VM 自己的线程消费调试请求：

```c
struct px_service_eval request;
int taken = px_service_vm_take_eval(managed, &request);
if (taken == 1) {
  /* 在当前JSContext执行request.code，提取普通C结果字符串。 */
  int completed = px_service_vm_complete_eval(managed, request.token,
                                              success, result_text);
  if (completed && completed != -ECANCELED) {
    completed = px_service_vm_complete_eval(managed, request.token,
                                             false, "eval result unavailable");
    if (completed && completed != -ECANCELED)
      px_service_vm_abandon_eval(managed, request.token);
  }
  /* ECANCELED表示停止/重启已取消token；其它提交失败先短文本重试，再清除inflight。
   * 即使极端OOM无法复制错误文本，也不能让之后的EVAL永久返回EBUSY。
   */
  px_service_eval_free(&request);
}
```

`complete_eval` 同步复制 C 字符串，返回后即可释放字符串。不允许把 JSValue、JSContext、
JSRuntime 或回调传给监督者/开发服务。一次只能有一个正在执行的 EVAL；完成后再取下一项。
停止时，尚在邮箱中的 code 由监督者释放；已经 take 的 code 始终由 VM 释放。
停止中的 in-flight token 会返回取消错误，迟到结果不发送到下一代 VM 或其它客户端。

console/logger 可调用 `px_service_vm_log(managed, level, tag, text)` 转发已形成的 C 文本。
函数同步复制，NULL 句柄为无操作；其它线程即使持有句柄，也不能冒充 VM 转发日志或消费请求。

清理完所有 JS 值、context/runtime 和本应用资源后调用 `px_service_vm_leave(managed)`。
wrapper 在 `run_app` 返回后还会兜底执行 leave；两次调用安全。句柄仅在 `run_app` 调用期间
有效，不可保存到其它线程、计时任务或下一代 VM。

## 停止、重启与恢复边界

系统按键动作最多每 25 毫秒读取一次。BOOT 短按请求内置设置页，设置页中再次 BOOT
短按会重载设置；仅在设置页中 PWR 短按返回当前应用。切换依然经过旧 VM 协作停止和
完整回收后再建新 VM，设置页源码通过 `px_builtin_app_get(PX_BUILTIN_SETTINGS)` 取得，
不写入 current/prev/manifest。USER 短按的亮屏切换由显示队列处理，不经过 service。
不支持的长按动作只记录明确的错误，不触发休眠、配网或卸载。

按键模式只在 VM 真正进入运行阶段后更新，退出时清除。设置页内收到 devd RESTART 或
push 后也恢复已提交的普通应用；STOP 保持停止。网络状态刷新仍独立限制为每秒一次。

- RESTART 设置停止标记并记录重启意图。监督者继续处理 devd 动作，旧应用完成清理、
  返回并被 join/waitpid 后，才创建新一代应用。
- STOP 清除重启意图并请求协作退出。短时间的 RESTART→STOP 合并为停止；多个 RESTART
  在旧应用退出前合并为一次后续启动。
- `app.push_begin` 先完整校验 manifest/路径/大小/摘要，再异步提交 `PUSH_PREPARE`。
  监督者请求旧应用退出，直到 join/waitpid 完成才通过纯 C token 确认；devd 收到确认后
  才调用 `px_store_begin()` 创建 staging。等待期间网络线程仍处理 hello/日志，旧 VM
  不会与 LittleFS 擦写并行而被闪存/cache 暂停误判为 watchdog 失活。
  上传期间 VM 保持停止，commit 成功才从原子提交的 current 启动。
- 上传参数在暂停前非法时不影响旧 VM；暂停后 chunk/校验/存储失败、owner 断线、30 秒
  无数据或 `app.push_abort` 会丢弃 staging，并按原运行/设置状态恢复旧应用。上传期间
  最新 STOP/RESTART 意图覆盖原恢复意图，成功提交也不能撤销 STOP。
  同时只允许一个上传；配网运行时先请求停止门户，等待 Wi-Fi ownership 和门户线程回收
  后才准备 staging；定时休眠和 shutdown 中拒绝新上传。
  devd 为 COMMIT/ABORT 留一个动作邮箱槽，防止队列满而遗失恢复通知。
- 旧应用仍存在时状态为 `updating`；只有回收后广播 `stopped`。正常自然退出保持空闲，
  非零自然退出报告 `crashed`；之后可通过 push/restart 恢复。
- EVAL 邮箱最多 8 项，含 in-flight；devd 自身也限制 8 个 pending 请求和代码长度。
  空闲、正在停止、正在启动但未 active 的应用拒绝 EVAL，不会阻塞 devd。
- 主线程永久卡在不可中断 native 调用时，监督者不会强杀任务，也不会启动第二个 VM。
  **软件复位由 runtime/watchdog 提供**：watchdog 必须覆盖整个托管 `px_run` 及清理过程，
  不能在 interrupt 回调或监督线程代替卡住应用更新健康进展。
- service 的 shutdown 是协作请求，没有声称可以强制终止任意卡住的 C 代码。
  boot 空闲的事件等待是常驻设计；有动作、应用完成或 shutdown 时由信号量/pipe 唤醒。

host 测试结束顺序：`px_service_request_shutdown(service)`，等待运行
`px_service_run()` 的监督线程退出并 join，然后 `px_service_destroy(service)`。
运行中 destroy 返回 `-EBUSY`。destroy 先 stop/join devd，再销毁唤醒资源，防止迟到通知
访问已释放内存。不能在信号处理函数中直接调用 request_shutdown（它使用 mutex）；
信号处理函数只设置标记，由普通线程发出请求。

## 验证

```sh
python3 firmware-nuttx/tests/test_service.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
python3 firmware-nuttx/tests/test_service_runtime.py firmware-nuttx/build/pixelbox
```

测试链接真实 `service/devd/net/tls/ws/store/sha256` 与已有 QuickJS 静态库，
调用现有 SDK 的 `DevdClient`，并在独立应用 pthread 中执行真正的 JS。
已覆盖无应用启动、push 后启动、restart 清空 JS 全局、停止无限 JS、native hold 时仍能
控制服务、停止排队 EVAL、RESTART→STOP、旧应用清理日志先于新应用启动、失败应用后
push 恢复、日志转发、断线迟到结果、非托管线程隔离、shutdown、重复 create/destroy 和 fd 回收。
上传回归还覆盖 native hold/20ms 析构期间控制可用且 staging 尚不存在、取消/SHA 错误/
存储准备失败恢复、暂停中的 owner 断线、STOP/RESTART 意图及提交后保持停止。
日志回放使用背压保留游标和控制响应槽；100 条回放不会挤满 32 条输出队列误断连。
系统动作替身另覆盖设置页进入/重载/PWR 返回、current 和版本保留、未支持动作只日志，
以及设置页中远程 restart 恢复用户应用；该测试不代替真实实体按键验证。
网络回调另验证首次 0.0.0.0、至少 1000 毫秒后新的 IP/MAC/heap 能从 SDK hello 读到。

每条编译/SDK 子进程最多 60 秒，服务启动等候最多 10 秒，测试清理的协作退出最多 10 秒。
测试所有文件位于临时目录，没有操作串口/硬件，也没有更改共享主入口或构建。
`test_service.py` 使用精简 runtime fixture；`test_service_runtime.py` 直接运行已有
`pixelbox --serve --port 0` 二进制与完整 runtime/prelude，验证缺省 main.js 的 welcome
保活、没有 timer 的托管应用、嵌套 src/main.js 入口、manifest/asset、错误和超大 EVAL、
单轮超时、控制连接停止无限 JS、六代 VM 的退出钩子顺序与持久 KV、启动失败后 push
恢复及自然退出后重启。此脚本先通过 SDK 停止应用，再用 SIGTERM 结束空闲宿主进程；
它没有声称验证 CLI 的进程协作 shutdown。NuttX 目标构建和真机由主流程验证，
不能以宿主通过替代任务组、硬件 watchdog 和真实网络检查。

2026-10-02 的 flash-13 真机验证已完成上传回滚三个场景：主动 `app.push_abort`、
收到 begin 后部分写入再断线、PREPARE 等待旧 VM 退出时断线。脚本
`tmp/live-push-rollback-20261002.cjs` 始终未提交替换应用；日志
`tmp/recovery-20261002-flash-13/push-rollback.log` 的 65、139、221～222 行确认
三个场景均恢复 `com.obeing.pixel.assistant`，当前入口 SHA-256 保持
`3e0ca618ce0c3e65b0aaaa45306d340e2816dab0cf5df29f92783c26cbf7fa5f`，
manifest 保持一致，staging 已清理、旧 VM 的临时全局变量已消失，
boot 标识始终为 `609051241`。这证明本轮回滚未依赖硬件重启；它不证明原应用的
麦克风与绘图并发问题已经解决。
