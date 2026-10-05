# mDNS 与 DNS-SD

`src/mdns.c` 实现 IPv4 `_name._tcp` / `_name._udp` 服务发现和广播。SDK 契约沿用原
ESP-IDF：`px.net.mdns.discover(service, {timeoutMs})` 返回 Promise，默认 3000 毫秒；
`advertise({name, service, port, txt})` 返回可重复调用的注销函数。返回服务含
`name/host/ip/port/txt`。实例名是单个最多 63 字节的 UTF-8 标签，可含空格或点；
hostname 仅接受单个 ASCII DNS 标签。

## 生命周期和配置

单个常驻 worker 拥有全部 UDP fd。NuttX 用 8KiB `kthread_create`，要求
`CONFIG_FDCLONE_STDIO=y` 或 `CONFIG_FDCLONE_DISABLE=y`；host 使用 detached pthread。
所有 VM owner 仅保存纯 C 查询/广播对象。VM 销毁不等待网络，不执行 JS；查询取消，
其广播排入 goodbye；owner=NULL 的 devd 广播不随 VM 清理而消失。

NuttX 必须开启 `CONFIG_NET_IGMP=y`，并保留 IPv4/UDP/socket/poll 支持。
`ipv4_setsockopt.c` 的加入组播、TTL 和接口选项由 IGMP 控制。网络状态提供有效 IPv4
以前，worker 返回 ENETDOWN 并每秒重试，不在尚未联网的接口上加入组播。

`igmp_waitmsg()` 会在 `net_sem_wait_uninterruptible()` 等待报告发送；加入/离开组播
和 socket close 均在 owner mutex 外执行。驱动停止推进时，查询仍可由 poll 在自己的
deadline 到期，owner destroy 不被拖住。全局 shutdown 最多等待 2 秒；返回 ETIMEDOUT
表示 worker 尚在内核调用中，不能声称 socket 已回收。保持 stopping 状态，不再创建
新的 owner/worker；旧调用收尾后重新 shutdown 才完成回收。没有强杀任务或跨任务关闭 fd。

## 已接入的共享入口

1. CMake/Make 已编译 `src/mdns.c` 和 `src/mdns_binding.c`。
2. `runtime.c#install` 在 net 后调用 `px_install_mdns`，与其他绑定处于同一个 VM
   线程，先于 prelude 执行。JS owner finalizer 兜底调用 destroy。
3. `src/prelude_mdns.js` 已嵌入总 prelude，在 `prelude_net.js` 后执行；它只覆盖
   `px.net.mdns`，不修改 TCP/UDP 方法。退出钩子关闭 native owner，拒绝未完成 Promise。
4. `px_devd_config.advertise` 显式控制设备广播，默认 false；NuttX 的 `main.c#serve_app`
   设为 true。宿主服务及现有 devd/service 测试不会主动对局域网广播。
5. `service.c#refresh_network` 每秒读取 IP/MAC，`px_devd_network` 只更新缓存和 dirty。
   `devd.c#refresh_mdns` 在 devd 自己的线程消费变化，生成 `pixelbox-<12位小写MAC>`
   hostname；MAC 尚不可用时使用本轮 boot 随机标识的前 12 位。空 IP 传 `0.0.0.0`。
   相同 IP/MAC、仅 heapFree 变化不触发更新；IP 变化清缓存、重建组播并重新探测。
6. devd 监听成功后以实际分配的端口调用
   `px_mdns_publish_devd(name, port, model, firmware, app_id)`。TXT 固定为 `model/fw/app`。
   `app` 来自已提交 `current/manifest.json` 的 ID，未安装应用为空；设置界面 VM 不更改
   已安装应用的 TXT。`refresh_app` 在提交后标记 dirty，下一次服务循环发布。
   configure/publish 失败每秒重试，错误变更才记录日志，不使 devd 启动失败。
7. `main.c#serve_app` 在监督器回收 VM、停止 devd 后执行 `px_mdns_shutdown()`。
   宿主单次脚本也会收尾；NuttX NSH 的单次 `--eval` 不关闭后台监督器的共享广播。
   `px_devd_stop` 本身不关闭全局 worker，嵌入使用者结束整个服务后须自行 shutdown。
   shutdown 失败返回非零并记录日志；`px_mdns_status()` 可查询 socket 初始化错误。

共享接线和宿主构建已验证；本次接线不在 P12 真机镜像中，真实组播与 SDK Bonjour
发现尚需新版镜像验收。独立模块测试不代替上板验证。

## 报文与资源边界

- IPv4 组播目标 `224.0.0.251:5353`，发送 TTL 255。响应只接受源端口 5353。
- 解析报文上限 4096 字节、32 个问题、64 条 RR；先完整校验报文再更新状态。
  压缩指针必须回指，最多 128 跳；名字展开上限 255 字节。拒绝截断、循环和非法 TXT。
- 全局最多 4 个查询、每查询 20 个结果、8 个广播、16 个 owner、32 条 A 缓存。
  TXT 总量最多 512 字节，单项最多 255 字节。完成但尚未 poll 的查询仍占用查询槽。
- PTR/SRV/TXT/A 可跨报文乱序合并；返回必须有未过期 PTR、SRV 与 IPv4 A。
  TTL=0 撤销对应记录。A 缓存保存最多 1 小时；只返回本次查询实际发现的服务。
- 广播前三次探测间隔 250ms，首次延迟 0..250ms；成功后广播两次，后续 60s 刷新。
  实例/主机冲突会改名并重新探测，最多 99 次。独立 unique RR 的冲突比较和退让已实现，
  并非完整 RFC 的多 RR 集合同时探测裁决器。
- 支持 QU 单播、legacy 单播事务 ID/问题回显/TTL≤10、PTR 已知答案抑制、回应限速和
  注销后两次 TTL=0 goodbye。异常关闭或断网无法保证对端收到 goodbye，缓存按 TTL 过期。
- 当前不实现 IPv6、服务 subtype、`_services._dns-sd._udp` 枚举、NSEC 或完整多播缓存代理。
  mDNS 是局域网发现协议，结果不构成设备身份认证；本实现没有声称验证接收 IP TTL。

## 验证

```sh
python3 firmware-nuttx/tests/test_mdns.py --sanitize undefined
python3 firmware-nuttx/tests/test_mdns_binding.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
node firmware-nuttx/tests/test_mdns_prelude.mjs
python3 firmware-nuttx/tests/test_mdns_runtime.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
python3 firmware-nuttx/tests/test_devd_mdns.py firmware-nuttx/build/libpixelbox_quickjs.a --sanitize undefined
cmake --build firmware-nuttx/build -j4
ctest --test-dir firmware-nuttx/build --output-on-failure --timeout 60
```

core 测试使用临时 UDP 端口和真实回环 socket，分别跑普通 pthread 与 kthread 替身，
验证压缩报文、乱序合并、截断/指针环、20,000 组有界模糊输入、20 条结果上限、源端口、
3 次探测、QU/legacy 回复、已知答案抑制、冲突改名、goodbye、devd 跨 owner 存活、
短命发起线程退出、任务创建错误、网络调用阻塞、查询取消、shutdown 超时和 fd 回收。
替身没有声称模拟 NuttX 任务组文件表或真实 IGMP 驱动。

binding 测试使用真实 QuickJS，覆盖参数长度/整数边界、TXT 原型安全、getter/ToString
重入关闭、固定 owner 闭包、GC 和三代 VM。prelude 测试覆盖 Promise、注销幂等、timer
不足、退出取消、迟到事件和错误分派。

runtime 测试将真实 core/binding/prelude 放入 QuickJS，另一 Python 线程独立编码/解码
DNS 报文，验证 JS discover、advertise、Unicode TXT、SRV、goodbye、devd TXT、退出取消。
`test_devd_mdns` 使用真实 devd 线程、临时 TCP 监听和应用存储提交配合 mDNS 记录桩，
覆盖默认不广播、实际端口、MAC hostname、IP/断网、重复状态、失败重试、提交 TXT。
完整运行时回归另覆盖真实绑定参数校验、离线 discover 和提前退出的 owner 回收。
全部测试子进程上限 60 秒，只访问回环地址；未更改系统时间、串口或真机。
NuttX 交叉编译、真实组播与 SDK Bonjour 发现须在后续固件阶段验证，不能以这些 host
结果替代。

### 8KiB worker 栈预算

2026-10-02 将 NuttX worker 从 16KiB 调整为 8KiB，每个常驻实例释放 8192 字节内部
内存；host pthread 保持平台默认栈，kthread 替身严格断言传入的目标栈为 8192 字节。
接收缓冲在 heap 上，DNS 压缩指针迭代最多 128 跳，解析没有递归。

同一 Xtensa GCC / `-Os` 的 `-fstack-usage` 结果：worker_task 144、handle_packet 992、
send_service 2064、write_record 48、write_bytes 32 字节；最长已识别自有调用链合计
3280 字节。实际固件原 16KiB worker 的普通运行峰值为 3088 字节。底层网络驱动和
libc 的完整动态调用链没有仅凭这些入口帧证明 worst case。

独立 guarded 宿主测试把线程栈上下页设为 PROT_NONE，并在 join 后测填充高水位。
26 个 worker 的全部真实 UDP/生命周期测试通过，最高使用 5136 字节；额外压力线程
覆盖 20000 组最长 4095 字节模糊包、压缩截断、64/65 记录边界、最大 TXT、最长实例名、
legacy 输出溢出和 sendto 失败，最高使用 2464 字节。该 Mac 的页大小与最小线程栈均为
16KiB，因此这份 guard 证据不能表述为已经宿主实测 8KiB 栈。
命令、静态帧和压力脚本保存在 `tmp/mdns-stack-20261002/`；新 8KiB 镜像的真机
`ps` 栈水位仍待下一轮烧录后确认。

协议依据：RFC 6762（Multicast DNS）、RFC 6763（DNS-Based Service Discovery），以及
本仓库 `firmware/components/bindings_net/src/mod_net.cpp` 和 `devd/src/devd.cpp` 的 SDK
及 TXT 行为；本地 NuttX 的 `net/inet/ipv4_setsockopt.c`、`net/igmp/igmp_msg.c` 是接口
与阻塞边界的实际依据。
