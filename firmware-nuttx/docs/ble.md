# NuttX BLE 接线与验证

本模块对齐 `sdk/types/pixelbox.d.ts` 的 peripheral/central 契约。实际射频能力必须等 ESP32-S3 HCI 控制器注册并且 NimBLE host 同步后才报告可用；只打开配置或链接静态库不会令 `available()` 返回 true。

## 离线依赖和 configure hook

- NimBLE ref：`fb15c844542e812ceb49ab5ac8502dc93c167b90`，与当前 NuttX apps Kconfig 一致。
- 归档：`third_party/mynewt-nimble-fb15c844542e812ceb49ab5ac8502dc93c167b90.tar.gz`。
- SHA256：`7be7b5205d345372460838808199d39e73703dbe082336e752607dce2c48f8bd`。
- 控制器：继续使用已锁定 HAL IDF 5.1.4 的 `components/bt/controller/lib_esp32c3_family/esp32s3/libbtdm_app.a`，不要混入新 HAL 的控制器库。

在 `scripts/nuttx.py#prepare` 已复制私有 nuttx/apps 树之后、第一次 `make context` 之前调用：

```python
run([sys.executable, str(root / "tools/prepare_ble.py"),
     str(root), str(tree), str(app_tree)], root, env)
```

也可以导入 `prepare_ble.prepare(project, nuttx_root, apps_root)`。仅在配置选择 BLE 时调用。此 hook 不启用 Kconfig、不联网、不修改 `.deps`；它验证归档、解包到私有 apps、修复 socket transport/NPL/controller，并预置上游 Make context 所需的 tar。重复调用会检查 patch 指纹；源码或补丁版本变化时明确要求重建私有快照，不能复用结构不一致的对象文件。

私有 NuttX 树必须包含 `esp32s3_ble.c`、`esp32s3_ble_adapter.c`、本板 `esp32s3_bringup.c` 和 `net/bluetooth/bluetooth_sendmsg.c`。补丁分别修复 HCI 背压、失败回滚、真实网卡路由、控制器内部堆以及延迟初始化。`CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=y` 时，控制器 `_malloc_internal` 直接使用 `xtensa_imm_malloc`，OOM 不回退 PSRAM；对应 `_free` 根据 `xtensa_imm_heapmember` 选择内部堆或普通堆，避免混堆释放。

## 共享入口接线

当前共享构建入口已包含以下接线：

1. NuttX app Makefile 加入三个 C 源，并在 `Application.mk` 之前包含 NimBLE 构建片段：

   ```make
   CSRCS += src/ble.c src/ble_nimble.c src/ble_binding.c
   ifeq ($(CONFIG_NIMBLE),y)
   include $(APPDIR)/wireless/bluetooth/nimble/Makefile.nimble
   endif
   ```

   不能仅设置 `CONFIG_NIMBLE=y`。上游 GNU Make 包装在禁用 porting example 时只准备依赖，不独立编译 NimBLE 库。`Makefile.nimble` 会把固定版本实际使用的 87 个 NimBLE/NPL/Tinycrypt 源加入当前 app。

2. `src/runtime.c` 声明并在创建 native 对象时调用 `px_install_ble(ctx, native)`。宿主 CMake 也编译这三个模块；无 `CONFIG_NIMBLE` 的宿主后端会真实返回不可用。

3. `src/prelude.js` 用 `/* @include prelude_ble.js */` 替换旧的 `px.ble` 不支持对象。不要在后面再覆盖 `px.ble`。`px.system.info().capabilities.ble` 使用 `px.ble.available()`，不能固定 true。现有 `tools/prepare.py#embed` 会展开 include。

4. 使用下列配置，保留原有 Wi-Fi/BLE coexist 默认配置：

   ```text
   CONFIG_WIRELESS=y
   CONFIG_ALLOW_BSD_COMPONENTS=y
   CONFIG_ESPRESSIF_BLE=y
   CONFIG_DRIVERS_BLUETOOTH=y
   CONFIG_WIRELESS_BLUETOOTH=y
   CONFIG_NET_BLUETOOTH=y
   CONFIG_NETDEV_IFINDEX=y
   CONFIG_NETDEV_IOCTL=y
   # CONFIG_WIRELESS_BLUETOOTH_HOST is not set
   # CONFIG_UART_BTH4 is not set
   CONFIG_NIMBLE=y
   CONFIG_NIMBLE_REF="fb15c844542e812ceb49ab5ac8502dc93c167b90"
   CONFIG_NIMBLE_ROLE_BROADCASTER=y
   CONFIG_NIMBLE_ROLE_CENTRAL=y
   CONFIG_NIMBLE_ROLE_OBSERVER=y
   CONFIG_NIMBLE_ROLE_PERIPHERAL=y
   # CONFIG_NIMBLE_PORTING_EXAMPLE is not set
   CONFIG_NIMBLE_TINYCRYPT=y
   CONFIG_NIMBLE_BLE_MAX_CONN=3
   CONFIG_NIMBLE_BLE_ATT_PREFFERED_MTU=256
   CONFIG_NIMBLE_CALLOUT_THREAD_STACKSIZE=4096
   CONFIG_PTHREAD_MUTEX_TYPES=y
   CONFIG_SIG_EVTHREAD=y
   # CONFIG_DISABLE_POSIX_TIMERS is not set
   ```

   上游板级 `esp32s3_bringup()` 的 `esp32s3_ble_initialize()` 由私有补丁移到 `ble_nimble.c#host_task`。任务先注册并开始 watchdog 票据，再初始化真实控制器，通过控制器注册的网卡取得 HCI 索引。底层 Make.defs 会链接 `-lbtbb -lbtdm_app`。

   必须检查 `olddefconfig` 后的真实 `.config`，不能仅验证输入 profile。缺少顶层 `WIRELESS=y` 会同时移除 `WIRELESS_BLUETOOTH` 与 `NET_BLUETOOTH`，即使控制器和 NimBLE 仍编译进固件，`bt_driver_register_internal` 也只会返回 `-ENOSYS`。`ble_nimble.c` 现对这些依赖、网卡索引/启停支持以及 RAW HCI 独占路由执行编译期检查。启动失败日志携带 `stage` 与负 `error`，可区分 controller、hci-interface、hci-socket、hci-bind 和 hci-thread。

NuttX 的 `hci_dev` 是全局网卡 `d_ifindex - 1`，不是独立蓝牙序号：`net/bluetooth/bluetooth_sendmsg.c#bluetooth_sendto:285` 用 `netdev_findbyindex(conn->bc_ldev + 1)` 找发送网卡。Wi-Fi 先注册时固定 `hci_dev=0` 会选中 WLAN。`esp32s3_ble_hci_device()` 从本控制器已注册的 `bt_net` 获取网卡，验证类型和索引，执行 `netdev_ifup()`，再把真实索引传给 NimBLE transport 的全部 bind/send 地址。日志会记录 `netdev`、`ifindex` 和 `hci_dev`。私有网络补丁在解引用 radio 前拒绝空接口或非蓝牙接口。

## 运行边界

| 项目 | 当前边界与真实行为 |
| --- | --- |
| 所有权 | 设备级 `pixelbox-ble` 使用独立 `task_create` 常驻，优先级 110、栈 8192；HCI pthread 栈 8192，由该 task 创建并共享其 fd 表；应用 VM 退出只停止对应 generation 的资源 |
| host 启动 | 每次调用最多同步等待 2000ms；永久任务先开启 watchdog 监督，再初始化控制器，启用其网卡并用真实 socket/bind 检查 HCI；未注册或未同步都不能假报 available |
| 启动监督 | 一张 busy 票据覆盖控制器初始化至首次 host 同步；正常失败时 end/unregister，健康超时不报告 available；全局故障已锁存时不能靠回收票据恢复喂狗 |
| host 命令 | 最多 8 条、同步等待 2000ms；超时撤销未执行命令，迟到的已执行 start/connect 会清理该 generation 的资源 |
| HCI 背压 | 控制器忙返回 `-EAGAIN`；socket 在 `sendto` 之外每 1ms 重试，最长 1000ms，使网络锁可释放 |
| HCI TX 调度 | RAW HCI 的单次网络信号量等待为 1000ms；超时后在网络锁下撤销回调并释放状态；L2CAP 保持上游行为。此期限不包括网络锁本身的阻塞时间 |
| peripheral read | 纯 C 条件变量桥最长 100ms；JS 主循环没及时回复则返回已有缓存值；后台不持有 JSValue |
| JS 队列 | 每连接最多 16 个串行 GATT 操作；每操作 30s 超时并发起断开；disconnect 最多 5s |
| 资源 | 每定义 8 个服务、32 个特征、总连接 3 个、64 个扫描设备、值最长 512 字节 |
| 邮箱 | 32 条事件、总负载 32KiB；溢出令会话失败，不能静默丢失 Promise 完成事件 |
| UUID | 16/32/128 位输入统一成小写标准 128 位；别名重复会被拒绝；central 属性名保持旧 SDK 的 `writeNoRsp` |
| NPL | 侵入式事件队列去重且无需分配节点，不会在满 mq 上自锁；独立 callout 事件不会被单个全局指针覆盖；有限 mutex 等待采用 trylock/1ms 让出，保留递归锁语义 |
| 有限等待时基 | NuttX 启动/命令、100ms 读桥、NPL 事件与信号量均用 CLOCK_MONOTONIC；虚假唤醒/EINTR 不重算 deadline；无限等待仍遵循原 NPL 契约 |

一次 API 的启动等待和命令等待可合计约 4 秒，但这不构成整轮 JS 的健康保证：同一轮连续 native 调用、清理和调度也会累积时间。应用 stall watchdog 默认 5000ms，硬件超时 15000ms；JS `--turn-timeout-ms` 默认 1000ms，QuickJS 中断不能抢占正在执行的 C 等待，返回 JS 后才有机会检查预算。启动票据在首次同步后释放，永久 host 的后续射频活性不属于此票据的持续监督范围。

首次启动失败不会反复创建控制器或永久任务；该次开机的 BLE 后端保持不可用。首次调用等候 2000ms 超时而后台仍在初始化时，后续调用仍可等候同一次初始化完成。永久 host 意外退出会清除 `host_ready/synchronized` 并记录错误，不能继续报告可用。

独立 task 组是失败回收的必要条件。`sched/group/group_create.c#group_initialize:130` 把 kernel task 放进共享 `g_kthread_group`；`sched/task/exit.c#_exit:70` 只对非 kernel task 执行 `group_kill_children()`。当前 host 改用 `task_create`，先关闭控制器再退出，组内 HCI/callout pthread 随组强制取消；最后成员离开时 `sched/group/group_leave.c#group_release:105` 释放 fd 表，各线程 TCB 回收通过 `sched/sched/sched_releasetcb.c:121` 调用 `timer_deleteall(pid)`。这是源码机制验证；真机启动故障注入后的全部资源回收尚未验收。

初始化阶段 `init/enable/vhci-callback/driver-register` 失败保留原始负 errno，并按已完成阶段先 `disable`、再 `deinit`。host 的网卡启用/socket/bind/HCI 线程或首次同步失败也进入同一关闭路径。关闭首先原子清除 `io_ready` 并将网卡置为 down，之后新 RX/TX 返回 `-ENODEV`。`disable/deinit` 返回错误时保留对应初始化状态，不能假装已经释放；host 保留 busy 看门狗票据，让未恢复的控制器故障进入硬件恢复。

控制器关闭函数本身仍有无界等待：`esp32s3_ble_adapter.c:3328` 在 `btdm_power_state_active()` 为 false 时持续 `nxsig_usleep(1000)`。启动和清理 busy 票据用于覆盖这个阶段，不能把它描述为控制器函数自带超时。`net_lock()`/`net_restorelock()` 本身也不是绝对有界；硬件 watchdog 对底层完全失去调度或中断能力的恢复效果仍需真机验证。

这不是支持反复启动的完整卸载：已注册的 RAW netdev 和其回调上下文保留至重启。当前上游 `bt_deinitialize()` 在 `WIRELESS_BLUETOOTH_HOST=n` 下不清理在途 HCI work；直接注销并释放 netdev 会给延迟回调留下悬空指针。失败后本次开机不重试，因此只停止控制器和其射频/内部内存，保留不可再收发的网络上下文。正常 host 继续永久运行。

## 早期共存与内存边界

本次只延迟 BLE 控制器，保留上游 `esp32s3_bringup()` 中 `esp_wifi_bt_coexist_init()` → `board_wlan_init()` 的顺序。`esp32s3_wifi_adapter.c#esp_wifi_bt_coexist_init` 调用 `esp_coex_adapter_register`、`coex_pre_init`，但忽略其返回值并返回 0；这段仍在应用 watchdog 启动前。

已对当前固定 `libcoexist.a`（SHA256 `687141768f79b19d18069306255ff14fdb785a03c5effa37a6d801adcf5ae580`）执行真实 Xtensa 反汇编。`coex_core_pre_init` 创建初值 1 的信号量，设置共存调度 timer 回调，然后调用 `coex_core_lock`。该锁经适配表的 `_semphr_take` 传入 `0xffffffff`，落到 `esp32s3_wifi_adapter.c#esp_semphr_take` 的 `nxsem_wait`，没有有限超时。首次正常初始化的新信号量可立即获取，未发现必然卡住的正常路径；但不能把这条路径宣称为有界，也不能把它直接挪到已运行 Wi-Fi 之后。若要对全部早期无线初始化提供恢复能力，应把 watchdog 启动边界前移，或整体延迟无线初始化并保留共存先行顺序。

内部堆容量必须在 Wi-Fi 工作后和 BLE 首次初始化后实测。固定 `libbtdm_app.a#btdm_controller_init` 最早三次 `_malloc_internal` 可由反汇编确认是 280、976、2528 字节；后续还有按活动数量计算的分配和 ROM 模块初始化，这 3784 字节不是总需求。当前控制器 `ble_max_act=6`，NimBLE 最大连接数为 3。不能只凭剩余总堆或最大连续块判定 BLE 峰值满足要求；初始化/扫描/连接之后均需记录 IMEM 的 free/maxfree，并保留 Wi-Fi 共存余量。

## 已执行的验证和验收入口

```sh
python3 firmware-nuttx/tests/test_ble.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
python3 firmware-nuttx/tests/test_ble_npl.py
python3 firmware-nuttx/tests/test_ble_platform.py --nuttx .deps/nuttx
python3 firmware-nuttx/tests/test_ble_hci_route.py --nuttx .deps/nuttx
python3 firmware-nuttx/tests/test_ble_deadline.py
python3 firmware-nuttx/tests/test_prepare_ble.py /path/to/unmodified/mynewt-nimble --nuttx .deps/nuttx
python3 firmware-nuttx/tests/test_ble_nimble_compile.py firmware-nuttx/build/esp32s3/nuttx /path/to/unmodified/mynewt-nimble --full
```

- 真实 QuickJS 与 C 核心：peripheral 读写/notify、扫描合并、central 服务发现/串行队列/引用计数订阅/断开、VM 退出、generation 隔离、邮箱溢出、100ms 读桥，UBSan 通过。无线对端使用明确的测试替身。
- 真实 NPL 源：1000 事件、4 并发生产者去重、50ms 实际等待、删除、timer 同时到期/stop/reset/迟到工作、32 位时钟回绕与故障，UBSan 通过。宿主 POSIX timer 系统调用使用替身。
- 控制器真实分配/释放函数：普通堆返回 PSRAM 时仍从独立 SRAM 堆分配，独立堆 OOM 不回退，双堆/NULL 释放；分别编译开启与关闭独立堆的分支，UBSan 通过。
- 启动真实函数：watchdog register/begin 在控制器初始化之前，至同步前保持 busy；注册、begin、控制器、网卡/socket/bind/HCI、地址及 watchdog end 失败均注入；验证真实 `hci_dev=4` 传给 socket 与 NimBLE；同步失败退出事件循环并停控制器；shutdown 失败保留 busy 票据，UBSan 通过。硬件及 watchdog 系统调用是显式替身。
- 控制器真实生命周期：init/enable/VHCI/driver 注册失败、disable/deinit 回滚错误、二次幂等关闭、保留原始 errno、disable 成功前不 deinit，以及网卡索引、ifup/ifdown、错误类型/零索引，UBSan 通过。RAW 驱动注册真实分支复现缺 `NET_BLUETOOTH` 的 `-ENOSYS`，并验证 RAW/UART 路由优先级。
- 真实 `bluetooth_sendto()`：替身网卡使用 Wi-Fi index 1、蓝牙 index 5；HCI 0 拒绝 WLAN，HCI 4 命中蓝牙；空接口返回 ENODEV；TX 等待参数准确为 1000ms，超时后回调、信号量、内存和网络锁均回收，UBSan 通过。
- NuttX 真实等待分支：2000ms 启动/命令、100ms 读桥及 NPL 队列，在墙上时间前后跳变和两次虚假唤醒后保持同一单调截止；超时撤销、成功回复、迟到回复及命令引用回收，UBSan 通过。没有修改宿主系统时钟。
- 固定源码补丁：真实函数 OOM、释放后访问、HCI busy/1s 上限、单调 sem EINTR/纳秒进位、mutex 实际 1ms 让出/1500ms 上限/零等待/独立 deadline、锚点漂移时零写入、hook 幂等/路径/归档校验，通过。
- 真实 Xtensa 工具链：Makefile 的完整 87 个依赖源及 3 个 BLE 模块对象编译通过。应用三个模块使用 `-Wall -Wextra -Werror`，仅豁免上游头部 initializer 和 unused parameter。
- 修补后的完整 `esp32s3_ble_adapter.c` 与本板 `esp32s3_bringup.c` 使用 P14 真实 `compile_commands.json` 的 NuttX/HAL 头文件和参数，在临时目录输出对象，编译通过。板初始化保留上游 I2S 局部变量未使用的两个 warning。
- 加入生命周期回滚及网卡路由后的完整 `esp32s3_ble.c`、完整 `bluetooth_sendmsg.c` 使用同一真实编译参数交叉编译通过。配置守卫真实拒绝缺 WIRELESS、缺 NET_BLUETOOTH、启用原生 HOST、启用 UART_BTH4、缺 NETDEV_IFINDEX、缺 NETDEV_IOCTL 六种错误组合。

这些宿主与对象证据不等于真机 BLE 验收。完整固件链接与上板结果由系统验收记录补充；需要观察真实 HCI 索引与 host 同步，再用真实 BLE 对端验证扫描、连接、读写、订阅、广播、Wi-Fi 共存和 VM 重启后的资源回收。没有获得对端授权或真实对端时，不把 GATT 用例标为通过。
