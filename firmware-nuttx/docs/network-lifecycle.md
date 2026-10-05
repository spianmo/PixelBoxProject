# 网络任务与连接移交

NuttX 中应用 VM 是独立 task。DNS、TCP 连接和 TLS 握手使用 `kthread_create()`
创建后台任务；应用退出后不强杀该任务，迟到的 DNS 仍能释放地址、endpoint 引用
和全局并发名额。每个固件最多同时保留 4 个解析任务。主机分支使用 detached pthread。

所有 NuttX kthread 共用内核任务组的文件表。profile 设置
`CONFIG_FDCLONE_STDIO=y`，避免从 VM 创建任务时把 VM 的非标准 fd 复制到内核组，
覆盖看门狗、音频或网络已打开的设备。`net.c` 和 `system_net.c` 在缺少此限制时
拒绝编译；`CONFIG_FDCLONE_DISABLE` 也是受支持的更严格选项。

连接完成后不能直接把 worker 的 fd 整数交给 VM。`net.c#publish_transport`
先通过 `fs_getfilep()` / `file_dup2()` 保存独立的 `struct file` 引用，再关闭
worker 中的 fd；`endpoint_event()` 在 VM 所属线程用 `file_dup()` 导入其自己的
文件表。成功、取消、超时和移交失败路径均释放中转对象。`fs_getfilep()` 的临时
引用总是配对 `fs_putfilep()`。

TLS 上下文在握手后随连接串行移交，VM 导入新 fd 后调用 `px_tls_rebind_fd()`。
此函数只接受已完成握手、没有待重试写入、仍开放且无错误的上下文，并检查新 fd
非阻塞；它不关闭或复制 fd，也不跳过任何证书检查。调用者保证新旧 fd 属于同一
连接，网络模块的中转文件对象提供这一保证。

应用的连接截止时间不等待无法取消的 libc DNS；超时后先向 JS 报错，后台引用
随后独立回收。DNS 的系统重试时间可以长于 JS 截止时间，因此不把整个 DNS 等待
当成 5 秒 VM 无进展。VM 的正常事件循环仍受执行健康看门狗监督。

验证入口：

```sh
python3 firmware-nuttx/tests/test_net.py --sanitize undefined
python3 firmware-nuttx/tests/test_tls.py --sanitize undefined
python3 firmware-nuttx/tests/test_net_tls.py --sanitize undefined
```

主机 fd 表替身故意让不同任务使用相同数字的不同描述符，验证跨组传递整数会失败，
并覆盖移交失败、取消、启动失败和发起线程退出。真实 TCP/TLS 回环验证数据与握手。
这些测试不替代真实 NuttX 固件上的任务退出与反复连接验证。
