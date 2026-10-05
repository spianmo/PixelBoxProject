# SoftAP 配网移植与安全边界

当前交付包含独立 AP 控制模块/驱动补丁及 DHCP/HTTP 门户、C/JS 绑定；完整接线契约见 `portal-integration.md`。主机回归已通过，尚未接入主固件，未验证真机 APSTA、手机 DHCP、网页配网、OTA 或深睡眠。没有修改 Mac 的网络连接。

## 原 ESP-IDF 的真实行为

- `firmware/components/wifi_portal/src/wifi_portal.cpp#portal_task`：停应用 VM；热点名为 `PixelBox-` 加 AP MAC 最后两字节；每次生成新的 8 位随机密码；保留 STA，开启 APSTA；屏幕显示热点、密码和 `http://192.168.4.1/`。
- `start_httpd`：80 端口，4 个连接；`GET /` 返回已有 `portal.html`，`GET /status` 返回 waiting/connecting/success/failed，`GET /scan` 扫描并同名去重保留最强信号、最多 24 条，`POST /connect` 接受最多 512 字节表单。
- `connect_handler`：SSID 为 1..32 字节；密码为空或 8..64 字节；拿到 IP 后才保存凭据。失败不覆盖原凭据，退出失败配网时恢复旧连接；成功后展示 3 秒，再关闭 AP 并恢复应用。
- `WifiManager::start_ap/stop_ap` 只调用 `esp_wifi_set_mode(APSTA/STA)`，不调用全局 `esp_wifi_stop()`。自动弹窗依赖 DHCP captive-portal URI；该选项失败会降级为手动打开浏览器，并不是配网失败。

## NuttX 的现有能力和缺口

`CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP=y` 对应 `wlan0` STA、`wlan1` AP。上游 `board_wlan_init` 已按该配置先后注册两张网卡，无须自行重复注册。当前工程只有 STA 模式。

上游 `esp_wifi_softap_start/stop` 会无条件停止整个无线模块；这会中断正在使用的 STA。`scripts/softap_adapter_patch.py` 针对本项目锁定版本替换四个 STA/AP 启停函数：

1. 所有角色都关闭时才允许 `esp_wifi_stop()`。
2. 从全部关闭启动时才调用 `esp_wifi_start()`。
3. STA ↔ APSTA、AP ↔ APSTA 只调用 `esp_wifi_set_mode()`。
4. 调用失败不提交 started 状态；同状态重复调用幂等。
5. 导出运行时标记及 AP 状态/配置同步接口；没有完整补丁时 AP 控制模块返回 `-ENOTSUP`。

补丁只接受四个上游函数的精确 SHA-256。先完成全部验证再修改；上游漂移、残缺补丁、符号链接都会拒绝。只应在项目复制出来的 SDK 快照上执行：

```sh
python3 scripts/softap_adapter_patch.py build/esp32s3/nuttx/arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c
```

首次 AP_START 事件异步初始化配置缓存。`pixelbox_wifi_softap_sync` 在应用配置前主动读取当前 AP 配置，避免第一条 ioctl 使用全零缓存。上游 `wlan_ifdown` 还会吞掉底层停止错误；控制模块再次读取真实 AP started 状态，错误返回 `-EIO`，保留所有权用于重试。

## 独立 AP 控制模块

`include/pixelbox_softap.h` / `src/softap.c` 提供：

```c
int px_softap_start(const char *ssid, const char *password);
int px_softap_stop(void);
int px_softap_get_status(struct px_softap_status *status);
```

- 使用固定 `wlan1`、`192.168.4.1/24`；不修改 STA、默认路由、DNS、已保存凭据。
- AP 已由外部功能启用时返回 `-EBUSY`；AP 网段与 STA 网段重叠时返回 `-EADDRINUSE`。
- 同一参数重复 start 幂等；改变参数须先 stop。停止时恢复 AP 原地址和掩码。
- 所有 socket 都在本次调用内创建并关闭；可跨调用线程启停，不保留来自短命 VM 任务组的整数 fd。
- 空密码为开放网络；非空密码限定 8..63 字节。上游 SoftAP auth 对固定 64 字节 password 使用 `strlen`，因此此模块拒绝 64 字节，避免越界。门户应继续生成 8 位随机密码。
- 调用者需要在常驻控制线程执行接口；独立 `portal.c` 负责 DHCP/HTTP 编排，service 监督器已接入并通过宿主生命周期与自动超时测试。main/runtime、构建与配置、屏幕状态显示及真机验证仍待主入口接线，详见 `portal-integration.md`。

## 最小接线顺序

1. 在 runner 的快照修补阶段调用上述脚本。共享配置改为 `CONFIG_ESPRESSIF_WIFI_STATION=n`、`CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP=y`；编译 `src/softap.c`。保留当前 FDCLONE_STDIO、backlog、write buffers 配置。
2. 在常驻 worker 中开启 AP，再启动绑定 `wlan1` 的 DHCP。若复用 apps 的 DHCPD，需要 `CONFIG_NETUTILS_DHCPD=y`、`CONFIG_NET_BINDTODEVICE=y`；客户端池可从 `192.168.4.2` 开始。`dhcpd_start/stop` 内有无超时的 `sem_wait`，不可放进 VM 或 service 调度线程，关闭需有独立可观测期限。
3. HTTP 只绑定 `192.168.4.1:80`，直接嵌入原 `portal.html`，保持四个现有接口。首版允许手动打开地址，暂不声称 DHCP captive URI/通配 DNS/客户端计数已实现。
4. 服务层进入配网时完整停止旧 VM，再把屏幕所有权移交配网视图。PWR 返回动作或成功展示 3 秒后退出；停止 HTTP/DHCP 后调用 `px_softap_stop()`，再恢复原应用。
5. `px_wifi_poll` 是单消费者，配网 worker 和 JS VM 不得同时消费同一个结果槽。由服务层在 VM 停止后明确转交；使用现有扫描/连接异步操作，获得 IP 后原子写 `/data/.pixelbox-wifi.json`。失败保留旧文件，退出时恢复旧凭据。
6. 除实体组合键外，提供受现有服务控制的显式软件入口，避免无人值守恢复依赖实体按键。AP 开关回归只验证维持现有 STA/远程连接，不自动连接 Mac 到 AP。

## 已运行的主机验证

```sh
python3 tests/test_softap_adapter.py --sanitize undefined
python3 tests/test_softap.py --sanitize undefined
```

各命令外层以 60 秒限制执行。使用 UBSan，不宣称 ASan 通过。覆盖：真实上游补丁版本/幂等/漂移拒绝；STA-only/AP-only/APSTA 三种 C 编译；模拟已有 STA 下 100 次 AP 开关无全局 stop/start；模式切换与配置读取失败；真实 NuttX 无线 ABI；仅 AP ioctl/地址写入；网段冲突；短命发起线程退出后停止；每一步失败回收；上游吞掉 stop 错误时检测及重试。

以上证明宿主控制逻辑和补丁转换通过，不能替代真机 APSTA 连续连接与射频验证。

## OTA 与 deepSleep

原 ESP-IDF 两者均有真实实现：

- `firmware/components/jsvm/src/mod_system.cpp#js_deep_sleep`：`ms > 0` 时设置定时唤醒，然后 `esp_deep_sleep_start()`。无参数/非正数不会设置定时唤醒。实体 USER 长按走 `system_keys.cpp#shutdown_sequence`，使用 GPIO18 ext1 唤醒。
- `firmware/components/bindings_net/src/mod_system_net.cpp#ota_task`：`esp_https_ota_begin/perform/finish`，完整性检查及切换启动分区，成功 1 秒后重启。当前 IDF S3 的 `partitions_speech.csv` 有两个 5 MiB OTA 槽，不能与 NuttX SimpleBoot 布局混用。

NuttX 当前 `src/prelude.js` 的 deepSleep/otaCheck/otaApply 仍是 unsupported/rejected。上游提供 `esp32s3_pmsleep(time_in_us)`、定时唤醒与 deep-sleep 实现，但当前工程 `CONFIG_PM` 未启用，也没有外围设备、VM、文件系统和看门狗的睡眠收尾接线。不得在没有已验证定时唤醒的情况下试睡真机。

NuttX 当前 SimpleBoot 固定从 offset 0 读取/执行单镜像；后 8 MiB `[0x800000, 0x1000000)` 是已有应用数据。即使两个当前镜像在尺寸上放得进前 8 MiB，也不代表第二份可启动：还缺 boot selector、槽位/镜像格式、重定位或加载规则、元数据、掉电恢复和回滚。可恢复的 A/B OTA 需要重新设计前 8 MiB 内的启动器和槽位，并单独验证迁移。当前运行中覆盖 offset 0 会破坏正在执行的映射与恢复入口，不能作为最小 OTA 实现；也禁止借用后 8 MiB 作为暂存区。
