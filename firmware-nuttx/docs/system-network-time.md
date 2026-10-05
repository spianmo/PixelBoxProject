# NuttX 系统时间与芯片温度模块

本模块补齐 `px.system.ntpSync(server?: string): Promise<void>` 与
`px.system.temperature(): number`。独立文件与测试已经落地；主入口、prelude 拼接、
Makefile、Kconfig 和真机验证由固件集成流程负责。

## 集成

应用源列表加入：

```text
src/system_net.c
src/system_net_binding.c
src/system_temperature.c
```

在其它 native binding 注册位置声明并调用：

```c
void px_install_system_net(JSContext *ctx, JSValue native);
px_install_system_net(ctx, native);
```

把 `src/prelude_system_net.js` 放入既有 prelude 的同一个 IIFE 作用域，位于
`px.system` 创建之后。它使用已有 `native`、`px`、`exitHandlers`，覆盖两个占位接口，
不会覆盖其它 `px.system` 方法。准备/生成脚本需要将这份文件纳入输入依赖。

NTP 使用已有 IPv4 UDP、DNS、poll、`/dev/urandom` 与
`CLOCK_MONOTONIC` / `CLOCK_REALTIME`。当前板级配置已启用
`CONFIG_ESP32S3_RNG`、`CONFIG_DEV_URANDOM_ARCH`。不需要引入第三方 NTP 库。
NuttX worker 由 `kthread_create("pixelbox-ntp", 100, 8192, ...)` 创建，
host 使用 detached pthread。板端必须启用 `CONFIG_FDCLONE_STDIO` 或
`CONFIG_FDCLONE_DISABLE`，缺失时编译报错：当前 NuttX 内核线程共享文件表，
跨任务组完整复制应用 fd 会覆盖已有内核 socket/watchdog 的同编号 fd。

温度使用已经在 `libarch.a` 内的 HAL/eFuse/REGI2C 符号，不增加 HAL 源文件。
除现有 HAL include 路径外，还需要以下三个目录，全部相对于构建快照中的
`arch/xtensa/src/chip/esp-hal-3rdparty`：

```text
components/efuse/include
components/efuse/esp32s3/include
components/hal/platform_port/include
```

非 ESP32-S3 宿主构建的温度接口明确返回 `-ENOTSUP`。

## NTP 行为与边界

- 与原 SDK 一致，未传入参数、`undefined` 或 `null` 使用 `pool.ntp.org`；其余值
  按旧绑定进行字符串转换。拒绝空串、内嵌 NUL、超长串、URL、端口和非 ASCII 主机名。
- 每次调用独立请求，默认总截止时间 15 秒，包括 DNS、UDP 和主线程消费结果的等待。
  C/native 私有接口接受 1..120000 毫秒，公开 JS 签名没有新增超时参数。
- 当前支持 IPv4、UDP 123、48 字节 NTP v3/v4 server 响应；不支持 extension、MAC 或 NTS。
  使用 `/dev/urandom` 的 64 位 challenge 作为请求 transmit 字段，严格匹配响应 originate。
- 同时校验来源 IP/端口、长度、version、mode、LI、stratum、receive/transmit 非零及顺序，
  并要求服务器处理时间不超过实测 RTT 加一个 `CLOCK_MONOTONIC` 分辨率刻度；
  这个容差只修正同一时钟刻度内的量化误差，明显倒退仍被拒绝。普通错包忽略至总超时；匹配 challenge 的
  stratum 0（KoD）返回 `EACCES`。
- 接受的服务器时间窗口是 2024-01-01（含）至 2100-01-01（不含），窗口小于一个 NTP era，
  因而无需已校准 RTC 就能处理 2036 年回绕。设备当前 `time_t` 为无符号 32 位，
  该范围可表示；提交时仍进行回转检查。
- 使用服务器 transmit 时间加扣除服务器处理后的半程 RTT 估算接收时刻；
  主线程提交前再补偿从接收至 poll 的单调时间差。
- DNS 返回多个 IPv4 地址时，各地址共享总截止时间；在还有后续地址时每个地址最多使用
  3 秒预算，避免第一个失联节点耗尽默认 15 秒，后续地址仍可尝试。
- 这些是报文与生命周期校验，**普通 NTP 没有服务器身份认证**，不能把它描述为 NTS
  或经过密码学认证的时间来源。TLS 仍保持 CA、主机名、证书日期验证，不因同步失败降级。

## 取消、退出与资源上限

每个 VM 拥有独立 C context，最多 4 个请求；系统全局同时最多 4 个后台 worker，
包括 DNS 迟迟没有返回的 worker。`getaddrinfo()` 没有可移植的安全强制取消机制，
所以主线程在总截止时间到达后返回 `ETIMEDOUT`，不等待 DNS。迟到 worker 只释放自己的
C 引用和 fd，不再发送 UDP，也不会接触 JS 或设置时钟。

NuttX 应用退出会强制取消同组 pthread，因此 NTP 不从 VM 派生 pthread。
独立内核 worker 在 VM 退出后仍持有自己的 job 引用，DNS 返回后执行正常回收，
释放全局 worker 计数。worker 内部创建和关闭全部 UDP/urandom fd，不向 VM 传递
文件描述符。启动失败按 kthread API 的负 errno 直接回退 slot、引用和计数。
worker 没有套用 VM 的 5 秒 progress watchdog，正常 15 秒 DNS/NTP 等待不会被误判。
阻塞 DNS 最多占用四个 worker；本模块不宣称可以安全强杀任意 libc DNS 调用。

worker 只交还 C 时间样本。只有 `px_system_net_poll()` 在确认请求未取消、未过期后
调用 `clock_settime(CLOCK_REALTIME, ...)`。若 `clock_settime()` 失败，Promise 必须 reject；
已收到样本但尚未消费时发生取消/退出，同样禁止设置时钟。

prelude 仅在有 pending 请求时创建 25 毫秒轮询 timer。没有请求时清理 timer；
退出时关闭 native owner、取消所有任务并拒绝尚未完成的 Promise。native 方法闭包
固定 owner，`call` / `apply` 不能混淆上下文；可能执行用户 JS 的参数转换之后再次
检查关闭状态，防止转换中的重入 shutdown 导致使用已释放的 C context。

## 芯片温度

读取的是 ESP32-S3 内部芯片温度，不是环境温度。使用原 SDK 指定的 -10..80℃量程，
DAC 15 / offset 0 / clock divider 6。公式为：

```text
摄氏温度 = 0.4386 × raw - 20.52 - eFuse温度修正值 / 10
```

无受支持的 eFuse 校准值时按 ESP-IDF 行为使用零修正；其它初始化错误返回 `EIO`。
量程外返回 `ERANGE`，不会用无效数字冒充成功读取。首次启用保留一次全局
SARADC/REGI2C 引用，后续读取复用传感器；不 reset 或关闭与 Wi-Fi/ADC 共享的外设域。
该固定量程实现不包含较新 ESP-IDF 温度驱动的自动量程切换。

HAL 自带的 `temperature_sensor_ll_get_raw_value()` 含无界 busy-loop，本实现不调用它：
最多 1000 次、每次延时 10 微秒等待 ready，超过约 10 毫秒返回 `ETIMEDOUT`，
并清除 dump 请求以便后续重试。首次启用另有 ESP-IDF 推荐的 300 微秒稳定等待。

## 已执行的验证

```sh
python3 firmware-nuttx/tests/test_system_net.py --sanitize undefined
python3 firmware-nuttx/tests/test_system_temperature.py --sanitize undefined
python3 firmware-nuttx/tests/test_system_net_binding.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
node firmware-nuttx/tests/test_system_net_prelude.mjs
```

NTP 测试使用真实 UDP 回环覆盖 18 种响应、2036 回绕、DNS 总超时、全局 worker 上限、
请求取消、VM 退出、clock_settime 失败和 fd 回收。测试替换 `clock_settime`，
从未设置 Mac 系统时间。温度测试使用寄存器/ROM 替身覆盖正负校准、无校准、
初始化失败重试、10 毫秒上限与量程；绑定测试使用真实 QuickJS 库验证参数与 GC。
NTP 同一组测试同时运行普通 pthread 和内核任务启动替身分支，后者验证 argv 复制、
连续八次创建失败的负 errno/资源回退，以及发起 VM 线程销毁 owner 并退出后，
迟到 DNS worker 仍完成回收。替身不模拟真实 NuttX 调度器或任务组 fd 隔离。
测试每条 subprocess 限时 60 秒，编译输出只写独立临时目录。

上述三个 C 源已使用当前 ESP32-S3 NuttX 快照和 Xtensa 交叉工具链编译为目标对象。
该检查不等同于完整固件链接或真机运行。真机 NTP、温度实测与板载资源并发验证尚未执行。
