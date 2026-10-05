# PMU 文件对象与跨任务访问

`src/power.c` 在 NuttX 使用 `struct file` 持有 I2C 设备，通过
`file_open()`、`file_ioctl()`、`file_close()` 操作。对象不占用 task group 的 fd
槽位，因此 boot 初始化后，独立应用任务和常驻按键服务都能访问同一个 PMU。
初始化、监测使能、电池读取、PKEY 消费及 shutdown 全部持有 `g_power_lock`，
不会在另一线程仍传输时关闭对象。

内核 file API 直接返回负 errno；实现不会读取调用线程上一次系统调用遗留的 errno。
probe 失败立即关闭对象，后续初始化可以重试；成功 probe 严格要求 AXP2101 ID 0x4a。
只允许开启电池检测、ADC 和 PKEY IRQ，以及确认已消费的 PKEY 位，不改变供电轨、
充电参数或执行关机。纯 host 分支继续返回 ENOTSUP；原 `PX_POWER_TEST` 使用 POSIX fd
替身，额外 `PX_POWER_TEST_FILE` 验证内核文件对象分支。

```sh
python3 firmware-nuttx/tests/test_power.py --ubsan
```

两套平台分支各验证 11 组场景。新增生命周期场景由一个线程初始化后退出，
三个新线程各连续执行 100 轮电池与按键读取，最后由另一线程关闭，确认总共只开关一次。
文件对象替身还让返回 errno 与线程 errno 刻意不同，验证负错误码传播正确。
这些测试验证 C 分支、对象持有和互斥访问，真实 NuttX task group 与板载 I2C 并发
由固件集成流程验证，不以宿主测试替代真机证据。
