# NuttX 执行健康看门狗

该模块监视每个 VM 或长驻服务是否推进实际工作。独立 `px-watchdog` 内核任务每秒检查所有 busy 槽；全部健康或所有槽空闲时，才向 `/dev/watchdog0` 发 `WDIOC_KEEPALIVE`。一个 VM 挂住不能被另一个 VM 的心跳掩盖。

## 构建和启动钩子

集成方添加 `src/watchdog.c`，并在隔离 NuttX 配置中启用：

```text
CONFIG_WATCHDOG=y
CONFIG_ESP32S3_MWDT0=y
# CONFIG_WATCHDOG_AUTOMONITOR is not set
# CONFIG_WATCHDOG_PANIC_NOTIFIER is not set
```

`esp32s3-devkit` 的 `esp32s3_bringup.c` 在 `CONFIG_WATCHDOG` 下调用板级 WDT 初始化，公共 `esp32s3_board_wdt.c` 在 `CONFIG_ESP32S3_MWDT0` 下注册 `/dev/watchdog0`。自定义 bringup 必须保留此入口。

在 `pixelbox_main()` 完成板级 bringup 后、开始执行 JS 前调用 `px_watchdog_start()`。返回 0 表示独立任务已经成功打开设备、设置 15000 ms 超时、启动并通过 `GETSTATUS` 确认 ACTIVE+RESET 模式。设备缺失或启动失败返回负 errno，必须记录真实错误。若 2 秒内设备启动没有完成则返回 `-EINPROGRESS`；再次调用只查询现有启动状态，不创建第二个监督任务。

监督者使用 `kthread_create()`，拥有独立 task group，并由自己打开设备；应用从 NSH 调用后退出时不会连带结束监督者或关闭它的 fd。无条件硬件定时喂狗与 panic 自动停狗配置会在编译时报错，防止覆盖本模块的故障处理。

## runtime 中的最少钩子

给 `struct px_runtime` 添加 `uint32_t watchdog_handle`。在 `px_run()` 刚进入时注册并 begin，最迟要覆盖 `JS_NewRuntime2()`、`JS_NewContext()`、原生模块安装和 JS 执行。必须处理创建失败的提前返回：每次正常退出都在完整资源清理后 `end()` 再 `unregister()`。

```c
int result = px_watchdog_register(&runtime.watchdog_handle);
if (result == 0) result = px_watchdog_begin(runtime.watchdog_handle);
/* 失败时记录并按主程序故障策略处理，不把它报告为已受保护。 */
```

在这些位置调用 `px_watchdog_beat(runtime.watchdog_handle)`：

- `evaluate()` 的 JS 调用、异常处理和引用清理全部返回之后。
- `drain_jobs()` 完成整批 Promise 微任务并处理拒绝之后。
- `event_loop()` 一整轮原生事件、定时回调和 Promise 工作返回之后；当前空闲 sleep 最长 50 ms，仍可正常推进。
- 耗时原生初始化若分为多个明确完成的阶段，可在阶段完成处报告一次进展。

**不要在 `interrupt()`、定时器中断、后台 poll 或 worker 活动中刷新 VM 的心跳。** 这些位置仍可能运行，但 JS/native 调用或主事件循环已经卡住。也不要在每次微任务开始时刷新，否则递归微任务能一直逃过检测。

退出应先完成 `JS_FreeContext()`、`JS_FreeRuntime()` 及其他 native 释放，再 `end()`/`unregister()`。这样析构阻塞也能触发硬件保护。若程序崩溃而没有执行退出钩子，busy 槽保持活动并最终触发复位。切换到正常空闲 NSH 前应已注销 VM，此时监督任务继续检查后喂狗，不因用户未输入命令而重启。

## 时限和故障边界

默认进展期限 `PX_WATCHDOG_STALL_MS=5000`，硬件超时 `PX_WATCHDOG_HARDWARE_MS=15000`，每秒监督一次。忙碌槽达到 5 秒未推进即锁存故障；此后即使迟到的 `beat()`、`end()` 或其他 VM 恢复也不再喂狗。因此从最后进展到硬件重启大约为 19–20 秒，15 秒是最后一次硬件喂狗后的期限。

`begin()` 不支持嵌套，重复调用返回 `-EALREADY` 且不刷新时间。busy 槽不能直接注销，返回 `-EBUSY`。handle 注销后失效，槽复用时分配新的 handle。最多 8 个注册客户端。

启动时发现设备已 ACTIVE 会返回 `-EBUSY`，不会接管或停止其他服务的看门狗。只有本模块刚刚启动却未通过状态验证时才尝试 STOP；进入 RUNNING 后的健康故障、喂狗 ioctl 失败或单调时钟异常均会锁存错误并停止喂狗，不执行 STOP。

可用 `px_watchdog_get_status()` 读取启动状态、锁存原因、失败 handle、注册数、busy 数和最后喂狗时间。`running=true` 表示已启动硬件，不代表事件循环仍健康；必须同时查看 `fault_latched`。

## 验证和真机验收

```sh
python3 tests/test_watchdog.py
python3 tests/test_watchdog.py --ubsan
```

17 项确定性状态与设备交互测试覆盖：空闲 NSH、正常长期运行、VM/native 阻塞、多个 VM 隔离、迟到 end 无法取消故障、handle/容量边界、喂狗失败、时钟故障、设备缺失、配置/启动/状态验证错误、错误 capture 模式、已被占用、任务创建失败和启动延迟。所有 ioctl 为测试替身，不会操作真机。

宿主单测和交叉语法检查不能证明硬件已经复位。最终固件必须验证：1）空闲 NSH 超过 30 秒不复位；2）正常 JS 事件循环持续超过 30 秒；3）故意让一个受监控的 native 调用停止推进，确认日志锁存失败并在期限内由 MWDT0 重启；4）重启原因与启动日志一致。现有 QuickJS 1 秒执行超时通常会先中断纯 JS 死循环，因此纯 JS 异常返回本身不应触发硬件复位。
