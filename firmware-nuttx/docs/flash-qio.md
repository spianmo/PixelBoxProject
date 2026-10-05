# SimpleBoot 的 Flash QIO 取指

适用于 ESP32-S3-Touch-AMOLED-2.16、NuttX 12.9.0 与当前固定版本的 `esp-hal-3rdparty`。这里的 QIO 是程序 Flash 取指模式，屏幕的 SPI2/QSPI 配置另见 [Framebuffer](../README.md#framebuffer)。

当前采用 **ROM 按 DIO 镜像头载入 RAM，再由 RAM 中的官方启动代码确认 QE 并切换 QIO**。native20 已完成构建、烧录、独立校验及软件复位启动，启动日志确认实际 QIO；三种动态场景各 120 秒长测显示错误均为 0。帧率及验收范围见文末和[完整性能记录](../../docs/performance/example07-nuttx-fps-20261003.md)。

## 启动与配置

[esp32s3.config](../configs/esp32s3.config) 同时配置芯片侧和 Espressif 通用侧的 Kconfig：

```text
CONFIG_ESPRESSIF_SIMPLE_BOOT=y
CONFIG_ESP32S3_FLASH_MODE_DIO=n
CONFIG_ESP32S3_FLASH_MODE_QIO=y
CONFIG_ESPRESSIF_FLASH_MODE_DIO=n
CONFIG_ESPRESSIF_FLASH_MODE_QIO=y
```

只改这些选项不够：当前 HAL 的 `sdkconfig.h` 原先固定使用 DIO 宏，SimpleBoot 的源文件列表也未编入 QE/wrap 实现。[simpleboot_qio_patch.py#patch](../scripts/simpleboot_qio_patch.py) 补齐以下接线：

|位置（隔离 NuttX 树内）|作用|
|---|---|
|HAL `nuttx/esp32s3/include/sdkconfig.h`|仅当 SimpleBoot 与芯片 QIO 同时启用时，映射 HAL 的 QIO 宏与旧别名，取消对应 DIO 宏|
|`arch/xtensa/src/esp32s3/hal.mk`|仅在上述组合编译同版 `flash_qio_mode.c` 与 `spi_flash_wrap.c`|
|`tools/esp32s3/Config.mk`|上述组合的 ROM 镜像头保持 `FLASH_MODE := dio`；HAL 的模式字符串也保留 `"dio"`|
|`boards/xtensa/esp32s3/common/scripts/esp32s3_sections.ld`|将两个新增对象的 text/literal 放入 IRAM，rodata 放入 DRAM|
|HAL `flash_qio_mode.c`|改用 `ESP_EARLY_LOG*`，避免早期启动依赖运行时日志锁|

`esp32s3_start.c#__start` 在映射 Flash 段前调用 `bootloader_init()`。随后 `bootloader_init_spi_flash()` 调用官方 `bootloader_enable_qio_mode()`：按 JEDEC ID 选择状态寄存器操作，读取 QE；仅在未置位时执行读改写并读回验证，成功后调用 `esp_rom_spiflash_config_readmode()` 和 QIO 引脚配置。QE 读回失败会跳过切换；外层入口返回 `void`，所以启动继续不等于 QIO 成功。

QE 流程还调用 wrap 探测与禁用函数，因此仅添加 `flash_qio_mode.c` 会缺失依赖。映射 Flash 前执行的函数、字面量、函数指针表及字符串都须位于内部 RAM 或 ROM；只把入口函数标成 IRAM 不足以保证这条路径可执行。

## 本板 Flash 的证据

本板实际使用 ESP32-S3R8 裸芯片与 XM25QH128DHIQT 外置 Flash；`ESP32S3WROOM1N16R8` 是所用配置名称。已有 esptool 探测记录的 JEDEC 为 `0x204018`（manufacturer `0x20`、device `0x4018`），命中官方表的默认 **SR2 bit 1** 分支，不命中 `XM25QU64A / 0x203817` 的专用分支。

[《XM25QH128D》Rev1.2](https://www.xmcwh.com/uploads/934/XM25QH128D-Ver1.2.pdf)（2024-11-15）的依据：

|手册页码|确认内容|
|---|---|
|16|QE 为 S9，即 SR2 bit 1；置位后启用 IO2/IO3。LB1/2/3 是另外的 OTP 锁定位|
|22|RDSR2=`0x35`、WRSR2=`0x31`、Write Enable=`0x06`|
|29|`0x06` 后写状态寄存器可写入非易失状态；`0x50` 是另一种易失写使能|
|70|SFDP 的 QE 要求再次明确为 SR2 bit 1|

本地手册证据为仓库 `tmp/qio-hardware-readonly/XM25QH128D-Ver1.2.pdf`。`tmp/fps-native20-preflash-status.log` 的烧录前状态为 `0x0200`，即 QE 已置位。官方 QE 函数若读到同样状态，会跳过该函数内的状态写入；这一读数不证明 CPU 控制器已切到 QIO，也不证明之前由谁设置了 QE。若将来 QE 为 0，官方分支会以原状态 OR QE 的方式写回并验证，保留其它状态位。该操作涉及外部 Flash 状态寄存器；此路径不烧写 ESP32 eFuse，QIO 引脚信息来自 eFuse 读取接口。

## 复现与核验

[nuttx.py#apply_nuttx_compat_patches](../scripts/nuttx.py) 自动把补丁应用到 `build/esp32s3/nuttx/` 隔离快照；不修改用户提供的原始 SDK。helper 本身接收路径参数，手动使用时也必须指向隔离副本。它先读入并核验全部五个目标文件及 wrap 源码是否存在，再写入；重复运行不产生变化，上游上下文漂移会报错。这是版本检查机制，不是跨文件写入事务。

从仓库根目录执行，工具链和 SDK 路径按 [NuttX 集成](../README.md#nuttx-集成) 准备：

```sh
python3 firmware-nuttx/tests/test_simpleboot_qio_patch.py
python3 firmware-nuttx/scripts/nuttx.py configure --target esp32s3
python3 firmware-nuttx/scripts/nuttx.py build --target esp32s3
```

补丁测试覆盖幂等、漂移拒绝、缺少 wrap 拒绝，以及真实 C 预处理器/GNU Make 的 SimpleBoot × DIO/DOUT/QIO/QOUT 八组合；外部子进程超时为 60 秒。构建继续执行原有 digest 与内部堆边界检查，内部堆尾区下限为 4096B。

native20 完整链接的冻结审计记录位于 `tmp/qio-simpleboot-audit/native20-final-audit.json` 与同目录 `README.md`：

- ELF SHA256：`580d4f21a1be049f1f498cd3228d6205b85905e203b4c6a47a1a60cb1283b451`；bin SHA256：`876ffe4754826dbb6b335e5f845fb8d78bfcfc3ac49ca62811fec14c195b4064`。
- ROM 头 mode=2（DIO），80MHz/16MiB；QE/wrap 调用、字面量及分发表未发现 Flash/XIP 依赖。
- `_iram_end=0x40388100`、`_sheap=0x3fcba544`、内部堆尾区 18672B。重新构建后须核对新的 ELF、镜像哈希和堆报告，不能沿用这组数值。

烧录使用外层 `build/esp32s3/nuttx.bin` 及配套校验资料，流程见 [无人值守恢复](unattended-recovery.md)。完成独立 Flash 校验、软件复位及 NSH 启动后，读取 [main.c#initialize_platform](../src/main.c) 输出：

```text
[pixelbox] flash read mode=<实际解码模式> ctrl=<实际寄存器值>
```

该诊断只读 `SPI_MEM_CTRL_REG(0)`（`0x60003008`），按 QIO bit24、DIO bit23、QOUT bit20、DOUT bit14 解码，记录原始值；它不写控制器、不新增 JS API。只有实际日志报告 QIO 才能确认此时的取指模式，随后还需运行应用、复位与同口径帧率测试。模式日志也不能单独证明所有故障都可经 USB 恢复。

native20 的真机证据在 `tmp/fps-native-flash-20261003-20-qio/`：`verify.log` 为 `verify OK (digest matched)`，`state.json` 为 `phase=booted`，镜像哈希与上面的冻结审计一致。`boot.log:19` 实际输出 `flash read mode=QIO ctrl=0x012c2008`，随后 watchdog 启动返回 0 并出现 NSH；屏幕 CO5300 总线仍为 40MHz。

三场各 120 秒、关闭分项插桩的结果如下，原始数据为 `tmp/example07-fps-native20-qio-120s/results.json`，对照及完整说明见[性能记录](../../docs/performance/example07-nuttx-fps-20261003.md)。

|场景|绘制回调 FPS|有效提交 FPS|显示错误|
|---|---:|---:|---:|
|全屏说话与模拟倾斜|29.951|29.951|0|
|全屏待机|29.641|29.641|0|
|普通说话与模拟倾斜|30.002|27.712|0|

普通模式会跳过量化后未变化的画面，不能把绘制回调数当成有效提交数。这些结果验证软件绘制与成功提交帧率，不代表物理面板扫描率；benchmark 的倾斜和音量使用模拟输入，未据此验收真实 IMU 或音频链路。
