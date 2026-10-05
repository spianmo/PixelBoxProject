# 默认关闭的定时深睡接线

2026-10-02：已实现服务状态机、QuickJS 接口、独立配置并完成无无线版 NuttX 链接和镜像校验。**未执行真机深睡，未验证 RTC 唤醒、USB 重枚举或唤醒后显示。无线版当前明确拒绝睡眠。** 普通 `esp32s3` profile 不启用 `PM` 或本功能。

## 对外行为

构建开关为 `CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP`，默认 `n`；宿主开关为 `PX_ENABLE_TIMED_SLEEP=ON`，默认 `OFF`。

`px.system.deepSleep(ms)` 仅接受数字类型、有限整数、`1..86400000` 毫秒。缺参数或 `undefined` 返回 `ENOTSUP`；非数字为 `TypeError`；越界、小数、NaN 和 Infinity 为 `RangeError`。未启用构建时所有调用继续 `ENOTSUP`。已启用但从非托管 NSH `--eval` 调用则为 `ENODEV`。

有效调用只排队服务请求并协作停止当前 VM，不表示设备已入睡，也不继续原 JS 栈。重复请求返回 `EBUSY`。它不提供无定时唤醒的关机，USER 长按仍保持原有明确拒绝；不依赖 PWR、BOOT 或 USB 唤醒。

## 清理与失败恢复

`service.c#px_service_vm_request_sleep` 记录请求时长及单调时钟截止时间，默认清理总预算为 10 秒。监督循环等待应用任务实际回收和门户 `wifi_owned=false` 后，检查应用退出结果，再调用 `prepare_sleep`。申请期间禁止应用重启及新门户启动；与热推送握手互斥。

应用清理失败、应用/门户超过预算、平台准备拒绝或者门户最终 shutdown 失败，均撤销睡眠授权。不会强杀尚在原生调用或 DMA 中的任务，不会释放仍有线程持有的资源。devd 继续监听，应用保持停止，显式 restart/push 可恢复；不自动重启同一个睡眠脚本。

准备通过后才让监督循环返回，`main.c#serve_app` 取走一次性授权、destroy/join devd，再检查 `px_mdns_shutdown()` 的真实返回值。这样推送存储写入必须先结束，不能在 devd 仍写 LittleFS 时进入睡眠。mDNS 关闭失败不入睡；平台 `px_sleep_enter` 任何返回都按失败处理。启动任务已有的 5 秒重试循环会重建 devd，并保持应用停止；从一次性 NSH `--serve` 调用失败则返回 NSH，不自动创建新 service。

## 平台限制

当前 `px_wifi_shutdown()` 为无错误返回的 void，并以无截止时间的 `pthread_join()` 回收；BLE 应用会话的 STOP 也未停止设备级常驻控制器。因此 `sleep.c#px_sleep_prepare` 在编译启用 `ESPRESSIF_WIFI`、`ESPRESSIF_BLE` 或 `NIMBLE` 的固件中直接返回 `ENOTSUP`。本实现没有把这些调用当作 radio 完整停稳的证据，没有为了深睡强制复位或断开现有无线恢复通道。

独立 `esp32s3-timed-sleep` profile 叠加普通板级配置，显式关闭上述 radio；其用途为离线编译以及日后可恢复条件下的受控测试，**不能拿它替换当前无人可按键的无线工作固件**。无无线时 HAL 不编入 mbedTLS，Make 同步关闭 TLS 后端宏，使 TLS 调用明确 `ENOTSUP`，而不是链接不存在符号或绕过证书验证。

该 profile 开启 `CONFIG_PM=y`、`CONFIG_PM_GOVERNOR_GREEDY=y`、`CONFIG_PM_GOVERNOR_EXPLICIT_RELAX=-1`。runner 在首次及复用配置时都检查最终开关，防止 olddefconfig 静默关闭请求或开启空闲自动睡眠。平台文件也有编译期检查，不调用 `pm_relax()`。板上无请求待机行为仍未验证。

`px_sleep_enter` 先持有 runtime 的 VM 独占锁，排除 service 回收后刚从 NSH 启动的非托管 VM，再次核对麦克风及音频回收状态，注册 busy 看门狗票据，打开显示设备并读取原电源状态、关闭屏幕，执行 `sync()`，最后调用 `esp32s3_pmsleep((uint64_t)ms * 1000)`。任一步骤返回错误则拒绝睡眠，尝试恢复原显示电源状态；恢复显示 ioctl 自身也可能失败，不能据此声称屏幕已恢复。看门狗只在真实阶段完成后报告进展，并在不返回的底层入口保持 busy。RTC 定时唤醒失败时不能依赖已停止的普通看门狗恢复。

ESP32-S3 底层 timer prepare 用有符号差值减去睡眠开销并把负数钳到 0，不存在最短 1 毫秒的无符号下溢；该时长并非实测精度承诺。深睡唤醒重新启动 OS。检测 CPU0 reset reason `0x05` 后保持旧应用停止，供显式 restart，避免启动脚本重复睡眠。本轮未使用未经验证的 RTC retained marker，也不声称其它复位原因是深睡恢复。

## 验证

- `python3 firmware-nuttx/tests/test_sleep.py`：UBSan、真实 service pthread，覆盖 7 个回收/失败/超时场景，包括未 join VM、门户仍 owned、拒绝后重启、VM 错误、VM/门户超时、门户最终关闭失败与外部 shutdown 撤销。
- `test_sleep_build.py <binary> ON|OFF`：完整 QuickJS 公开接口的参数、默认关闭和非托管调用门禁；两种 host 构建各 5/5 CTest 通过。
- `test_sleep_runtime.py <enabled-binary>`：真实 SDK/TCP/QuickJS 请求有效深睡，在宿主平台明确拒绝；devd hello 仍可用，等待后应用仍停止，显式 restart 后继续 EVAL。
- `test_build_runner.py`：65 项通过，包含 PM 与永久 idle lock 的最终配置检查。
- 独立构建：`tmp/sleep-isolated-20261002/firmware-nuttx/build/esp32s3-timed-sleep/`；实际 map 含 `px_sleep_enter`、`esp32s3_pmsleep`、`esp32s3_deep_sleep_start`，SimpleBoot 摘要校验通过。产物未烧录。

剩余工作是实现无线完整停止与失败恢复，再以可恢复硬件验证短时深睡、reset reason、USB/NSH、屏幕及原数据。编译和宿主结果不能替代这些真机证据。
