# NuttX MultiNet7 中文唤醒适配

本适配调用仓库现有 ESP-SR 2.5.3 的真实 `esp_sr_multinet7_quantized`，不产生预设识别结果。主机测试中的模型替身仅用于并发、资源回收和错误边界测试，不能代替真机语音验收。

## 接线

默认 `esp32s3` profile 和宿主 CMake 均关闭本地唤醒。独立目标继承 `configs/esp32s3.config`，再应用 `configs/esp32s3-multinet7.config`；构建和产物位于单独的 `build/esp32s3-multinet7`，不更改普通目标配置：

```sh
python3 firmware-nuttx/scripts/nuttx.py build --target esp32s3-multinet7 \
  --nuttx-path .deps/nuttx --apps-path .deps/apps
```

此命令只构建，不烧录。`CMakeLists.txt` 是宿主测试入口，显式 `-DPX_ENABLE_MULTINET7=ON` 会拒绝配置并提示上述 Xtensa 构建入口，不能把宿主模型替身当作真实 MN7 功能。

1. runner 在 staging 前调用 `tools/prepare_wakeword.py`，使用与 NuttX 相同的独立 Xtensa 工具链。独立核验命令为：

   ```sh
   python3 firmware-nuttx/tools/prepare_wakeword.py --output /tmp/px-mn7-isolated-generated
   ```

2. `Makefile` 仅在 `CONFIG_INTERPRETERS_PIXELBOX_MULTINET7=y` 时添加：

   ```make
   CFLAGS += -DPX_MULTINET7
   CSRCS += src/wakeword.c src/wakeword_binding.c src/wakeword_model.c
   CSRCS += src/wakeword_commands.c src/wakeword_port.c
   CSRCS += generated/wakeword/cJSON.c
   ASRCS += generated/wakeword/model.S
   EXTOBJS += generated/wakeword/multinet7.o
   ```

   `-I$(CURDIR)/generated` 覆盖模型摘要头，额外的 `generated/wakeword` include 提供 cJSON。`wakeword_selector.c` 已合入 `multinet7.o`，不能再次加入 `CSRCS`。runner 只额外登记这一个已审计 `.o`，以及模型 `.S`、`.bin` 和清单，不复制其它旧目标文件。

3. 板级启动配置必须包含 `CONFIG_XTENSA_CP_INITSET=0x0009` 和 `CONFIG_ARCH_SETJMP_H=y`。前者启用 CP0、CP3；后者让 NuttX 生成自身的 `include/setjmp.h` 并构建 `libs/libc/machine/xtensa/arch_setjmp.S`。不能借用工具链 Newlib 的 `jmp_buf`。runner 在首次和增量构建都检查最终配置中的精确 CP 掩码、ESP32-S3、PSRAM、独立内部堆和 setjmp；olddefconfig 静默关闭请求也会失败。直接 Make 时适配源码仍有编译期 ABI 门禁。

4. `runtime.c` 在 `PX_MULTINET7` 下安装 `px_install_wakeword(JSContext *ctx, JSValue native)`；该符号由 `wakeword_binding.c` 提供。JS 接口使用 `prelude_speech.js` 的 `px.speech.wakeword`。普通构建通过公开 API 明确拒绝为 `ENOTSUP`。

5. VM 清理路径先调用 `px_wakeword_stop(0)`，再调用 `px_wakeword_quiesce(2000)`，并把未完成清理记为 VM 失败。超时返回 `-ETIMEDOUT` 时仍由独立 worker 持有模型；不得清除 busy、启动第二个模型或把回收描述为成功。

6. 最终整机映像必须检查前 8 MiB 容量边界。模型嵌入 `.rodata`，准备脚本不打开串口、不擦除 Flash，也不使用后 8 MiB 用户数据区。

## 真实依赖与 ABI

- ESP-SR 来源：`firmware/managed_components/espressif__esp-sr`，2.5.3，提交 `efa8d907c6d457cd0f99dae6c6b493412d3078d4`。
- 收敛入口：`esp_sr_multinet7_quantized`。使用 `ld -r --gc-sections` 合并 `multinet`、`dl_lib`、`fst`、`hufzip`、`c_speech_features`、原 ESP-DL 和 dl_fft 归档。
- `esp_mn_handle_from_name` 仅选择 `mn7_cn`，避免通用选择器额外拉入 MN5/MN6。生成器使用 `-mlongcalls`，允许选择器从 IROM 调用不同段中的 NuttX libc；遗漏此选项会在整机链接 `strcmp` 时触发 `call8: call target out of range`。
- `srmodel_list_t` 保留 ESP_PLATFORM 构建时的 `partition` 槽；32 位下 `num` 偏移为 16、`model_data` 为 20。vtable、phrase、result 尺寸有编译期断言。
- cJSON 从原组件源码重新编译到 NuttX libc，不使用预编译 Newlib 的 `_ctype_` 表。
- 生成器校验七个原始归档 SHA256，仅把推理闭包的 `malloc/calloc/realloc/strdup/free/fopen` 重定向到端口。六个可变 BSS 字必须与清单完全一致；四张数学表、唯一不分配内存的 C++ `dl::base::dotprod` 符号也有门禁。修改依赖必须重新审计，不能静默接受未知状态或 C++ 析构路径。
- cJSON 的 malloc/free/realloc 宏仅注入本模块生成的独立源码，原组件不修改。其 hooks 和错误位置指针随会话复位。
- IDF 允许 `free(heap_caps_malloc(...))`。本端口按分配登记和 `xtensa_imm_heapmember` 分流子堆、独立内部堆及普通块。
- `Cache_Start_DCache_Preload`、`Cache_DCache_Preload_Done` 由现有 ESP32-S3 ROM linker script 提供，分别为 `0x40001770`、`0x4000177c`。

`nm -u` 会显示已经没有重定位引用的废弃符号，不能据此添加替身。2026-10-01 对合并对象的有效 relocation 与当前 NuttX ELF、staging 归档、工具链 libm/libgcc 对照后，仅上述两个已有 ROM PROVIDE 符号不在已用符号表中。

## CP3 约束

MN7 的 S3 SIMD 使用 CP3。`arch/xtensa/include/esp32s3/tie.h` 定义其 208 字节、16 字节对齐的上下文；`xtensa_coproc.S` 已包含真实保存与恢复。

当前 `xtensa_context.S` 的实际路径没有逐任务保存 CPENABLE。`xtensa_coproc.S` 根据当前硬件 CPENABLE 决定保存/恢复哪些协处理器，因此不能用 worker 内临时 enable/disable 来隔离 CP3。`xtensa_initialize.c` 和 SMP 的 `esp32s3_cpustart.c` 均从 `CONFIG_XTENSA_CP_INITSET` 初始化，统一配置 `0x0009` 保留 CP0 并启用 CP3。

## 模型与运行行为

模型来源为 `firmware/build/srmodels/srmodels.bin`，长度 2,681,351 字节，SHA256：

```text
87c77c650bbafbfb63f7cca4979f70302ef34078429635d01f716f5ae01b8e5b
```

每次初始化先验证完整摘要，再检查目录、名称终止、偏移和长度、必须的四个 MN7 文件以及重复项。有效目录只保留指向只读 Flash 的指针，不为归档再占 2.56 MiB PSRAM。

独立 `px-wakeword` kernel task 使用优先级 100、16 KiB 栈，与默认 VM 同级轮转，低于优先级 120 的健康看门狗，独占模型和命令表；JS 只发送 16 kHz PCM16LE、轮询事件。PCM/前导缓冲区均 16 字节对齐。READY 之后 `wakeword.start()` 才完成并订阅共享 micHub。模型 duration 6000 ms、command ID 1；仅接受真实结果首候选 ID 1、有限且不低于门限的概率。

环形队列最多 8192 样本，推理前最多保留 160 ms 旧音频；丢帧即 clean，避免拼接跨缺口话音。500 ms 静音后开启新窗口时回放约 200 ms 前导。3 秒无输入报错，JS 初始化总上限 360 秒，以覆盖 ESP32-S3 上 MultiNet7 `create()` 的实际加载时间。stop 异步且不触发用户 onError；显式取消、旧 job 与新 job 隔离。完成与最后一帧 PCM 交错时保留待交付的真实 wake/error 事件。

看门狗仅在真实模型加载、推理、回收有进展后更新，等待音频不伪造进展。同步 `create()` 阶段暂时退出健康监督槽，返回后立即恢复监督，避免最长约 259 秒的模型初始化被普通阶段的 45 秒期限误判。硬件看门狗的 60 秒期限可覆盖监督线程无法继续喂狗的失控；若 `create()` 持续运行但仍可被抢占，硬件看门狗不会单独终止它，JS 超时及 stop 也只能请求异步取消。每次停止或识别完成都会销毁模型，当前未缓存实例。

## 固定 PSRAM 工作区与 OOM 边界

`wakeword_port.c#px_mn7_memory_run` 使用 linker 的 `.ext_ram.bss` 固定放置一个 4 MiB、16 字节对齐的 backing，并校验完整区间位于 `_ext_ram_bss_start/_ext_ram_bss_end`；主机故障注入测试才使用 `posix_memalign` 替身。backing 不进入通用用户堆，也不会作为两个堆的空闲区域；随后调用 NuttX 公共 `mm_initialize/mm_memalign/mm_free/mm_uninitialize` 建立和释放专用子堆。失败直接上报，不递增申请尺寸、不占满内部堆、不重试其它预算，也不修改全局 `USER_HEAP` 配置。

4 MiB 来自原 ESP-IDF `speech_engine.cpp` 的 `kMinModelPsram` 门槛。2026-10-01 核对 Espressif 官方 ESP-SR ESP32-S3 Benchmark，MultiNet 7 一行列出 18 KB Internal RAM、2920 KB PSRAM；这支持把 4 MiB 作为首个有界候选，但该表并未给出本仓库 `mn7_cn` 在 NuttX 中的创建临时峰值、登记开销和当前命令图。因此它仍是候选预算，并非实测最大峰值。连续 backing 不足时，即使普通堆总空闲超过 4 MiB 也会返回 `-ENOMEM`。模型权重 2,681,351 字节仍在只读 Flash 中，不再复制一份至 PSRAM。

官方参考：`https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html`，MultiNet Resource Consumption 表（访问于 2026-10-01）。

普通、DEFAULT 和 SPIRAM 的小块全部走专用子堆，消除 COMMON_HEAP 从内部残余区返回小块的问题。只有明确 INTERNAL/DMA 请求走 `xtensa_imm_memalign`。每块登记原始地址、用户地址、大小和链表，正常 free 直接释放；OOM 后统一回收登记，不依赖半初始化模型图完整。frame/history、命令表、目录和 cJSON 也使用相同分配出口。JS 投递队列及 worker 栈仍由原调用方拥有，在 guard 外按原生命周期清理；静态 `.ext_ram.bss` backing 在镜像生命周期内保持有效，不调用 `free`。

真实归档的 `fst_state_alloc`、`rnnt_path_alloc`、`model_create` 含申请后未经 NULL 检查即写入的路径。仅返回 NULL 会在库内崩溃。因此 `setjmp` 边界只覆盖同一个 worker 的同步 C 模型创建、命令配置、推理和销毁；分配失败由 `failure` 直接 `longjmp`，不返回 NULL 给这些库路径。控制队列的 mutex 和看门狗登记在此边界外，调用模型时不持有它们的锁。唯一 C++ dotprod 不分配、不含 RAII，也没有可触发跳出的回调；不能把此方案推广到未经审计的 C++ 库。

正常返回仍先 destroy，再清命令和目录。异常跳出不会调用半成品 destroy：先清六个原库 BSS、cJSON 状态和本地根；再由同一 worker 解锁并销毁登记互斥、释放内部块与子堆块，最后 `mm_uninitialize`，静态 backing 随镜像保留。`fopen` 分支明确返回 `-ENOTSUP`，避免未登记的文件句柄进入跳出路径；模型只支持当前 Flash 归档加载方式。

如果 mutex 解锁或销毁失败，返回真实 `cleanup_error`，保留 backing 和登记资源，并保持会话门关闭，使后续创建返回 `-EBUSY`。这时尚未完成清理，须复位后继续排查；不能把保留的资源描述成已经释放。

每会话输出一条 `[pixelbox] mn7 memory` 日志：

- `budget`：backing 固定预算；`initial`：初始化子堆后的 NuttX 占用。
- `heap_peak`：NuttX `mm_mallinfo.usmblks` 原始峰值，含分配器计账及对齐临时开销；不是纯模型负载大小。
- `psram_peak/internal_peak`：此会话两类用户负载的最大同时存活字节。
- `overhead_peak`：分配登记、对齐和 PSRAM 可用块余量的最大同时开销；内部堆自身块头没有包含在这个值中。
- `free/largest`：回收模型锁后、批量回收残留块前的子堆空闲与最大块。
- `failed_size/failed_caps`：触发退出的申请；首次 backing 失败记录 4 MiB 和 SPIRAM 能力。
- `reclaimed`：正常图清理未释放、最终批量回收的块数；`cleanup` 非零表示资源被隔离保留，不能声明成功。

`manifest.json` 的 `memory.measured_device_peak` 保持 `null`，直到真机真实创建、持续推理、取消重启和并发音频验收得到峰值。

## 验证与尚未验证项

```sh
python3 firmware-nuttx/tests/test_prepare_wakeword.py -v
python3 firmware-nuttx/tests/test_wakeword.py --sanitize undefined
node firmware-nuttx/tests/test_speech_contract.mjs
```

已通过：真实归档 SHA256/目录边界与 8 类损坏输入、生成器未知状态/C++ 门禁与幂等输出、20 组原生 worker 生命周期、5 组 JS 唤醒契约、8 组原 Azure 语音回归。原生生命周期中的模型检测结果为显式替身。

内存测试直接编译当前 `.deps/nuttx/mm/mm_heap` 的 10 个真实源文件，包括初始化、malloc、memalign、free、合并与统计；只用薄 shim 替代 OS/IRQ/物理地址边界。验证碎片回收、对齐、单次有界 backing 失败和末地址越界、真实子堆耗尽、三类释放路由、持锁 OOM 清理、无法销毁锁时隔离资源、重入拒绝，并对 cJSON 16 处、模型目录 12 处、命令图 7 处共 35 个申请位置逐个注入失败后立即再启动。worker 的创建/推理阶段分别连续 3 次模拟 OOM，再正常创建并停止。全部经 UBSan，不能等同于 Xtensa 真机异常恢复验收。

五个适配 C、生成 cJSON、模型汇编及真实 NuttX `arch_setjmp.S` 已用当前构建参数和隔离配置覆盖 `CP_INITSET=0x0009`、`ARCH_SETJMP_H=y`，经 `-Wall -Wextra -Werror` 交叉编译并局部链接。六个原库状态字、setjmp/longjmp 均已解析。

2026-10-02 首次用默认关闭接线和独立 profile 完成整机编译，初次产物为 6,239,944 字节，SHA256 `420fac39897c9f53d3d1e3c1f56ff7ad1aeec194587633740cb62f1fef541bfc`。Simple Boot ROM 摘要验证通过，按 4 KiB 擦除扇区计算末址 `0x5f4000`，小于固定应用数据区起址 `0x800000`，余量 2,146,304 字节。最终 ELF 包含真实 MN7 vtable、模型归档、native 安装/启动/停止/静默等待入口，以及 NuttX 的 setjmp/longjmp。生成对象缺少 `-mlongcalls` 导致的跨段短调用问题已由此次整机链接发现并修复。

同轮通过 runner 的 63 项配置/隔离/容量测试、默认宿主 4 项 CTest、生成器 2 项真实归档/状态审计，以及 UBSan 的原生内存和 20 组 worker 生命周期测试。宿主显式打开 `PX_ENABLE_MULTINET7` 的拒绝路径也已验证。该构建只写入独立目录，没有改主 profile、共享 build 或访问真机；它不证明真实语音识别或运行内存峰值。

2026-10-02 随后同步最新网络连接/热推送和原生图形修复，再次完成隔离整机链接。归档快照为 `tmp/mn7-latest-20261002.bin`，6,237,192 字节，SHA256 `bce30f16e8479b43bed6fbaf2abe9ec6a1ecbbba43a845f3a3d0460597d29e67`；ROM 摘要 `97372f147999f1d92c9d9f74db268b3e4f20c39d2d7e92f2b4fb0061a8df7c14` 校验通过。擦除末址 `0x5f3000`，距 `0x800000` 数据区剩 2,150,400 字节；CP 掩码、setjmp、MN7开关再次校验，portal/sleep保持关闭。ELF确认原生Canvas、投影、统一VM预算检查和真实MN7入口均存在。`tmp/mn7-latest-validation-20261002.json`、`tmp/mn7-latest-source-snapshot-20261002.json` 保存产物及源码摘要，构建后比较当前源码未发现漂移。同期宿主5项CTest（runtime30项、OTA6项及默认关闭门禁）与图形UBSan通过；此镜像仍**未烧录/未验真实模型运行峰值**。隔离构建目录中的普通`nuttx.bin`已是这一新版，不能再按初次摘要解释。

AddressSanitizer 在当前 Mac 中没有获得有效结果：实际模型测试 60 秒超时，随后最小 `puts` 程序同样在 `libc interceptors initialized` 后 15 秒启动超时。UBSan 已通过，不能把 ASan 写成通过。

主代理仍需验证最终固件容量、模型创建时的真实堆峰值和碎片、持续推理/看门狗/实时性、语音误触发与真实命中、识别后重新启用耗时、micHub 与录音/Azure 的并发。尚未进行真机语音推理验收。
