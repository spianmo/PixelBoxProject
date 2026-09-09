# JSVM Performance Review (2026-09-06)

## 2026-09-09 LVGL 9 与双 DMA 迁移（尚未烧录验收）

显示底层已使用 LVGL 9.2.2 的同步 RGB565 软件渲染入口；现有屏幕/画布 JS API、
立即读取像素、像素字体和几何规则保持兼容。主画布改为原生 RGB565，JPEG/PNG/GIF
统一该格式；发送时用 LVGL 交换行带字节序。详细设计见 `firmware/components/hal_display/README.md`。

QSPI 与 ST7789 后端共用双 DMA 管线：准备 B 时 A 在发送，先等 A 完成再提交 B。
480×480 板型固定使用两个 30 KiB 内部 DMA 缓冲，相对原实现增加 30 KiB 内部 RAM。
仍由 JS 线程同步 flush，成功返回前最后一笔 DMA 已完成；每次等待上限 250ms，
超时保留在途缓冲和脏区，重试先回收事务。此改动没有接入 TE 撕裂同步。

本地验证：

- LVGL 图形测试涵盖全部 65,536 个 RGB565 颜色、带行距裁剪、透明图片缩放和字体。
- 368×448 样张与迁移前 `1d14263` 的 RGB 输出逐字节一致，已固定 SHA256 回归检查。
- 模拟异步 DMA 验证交替、准备/发送重叠、连续超时保护、提交失败恢复和四向旋转字节序。
- ESP32-S3 CO5300 固件构建通过；ST7789、SH8601、无屏后端通过 S3 编译器编译检查。
  这不等于这些面板或 ESP32-C6 已完成真机验收。

此前 `pixel12` A 字宽断言写成 6，但字表实际步进为 8（proportional 字体），
现已修正测试数据。LVGL 没有改动字体文件或文字像素输出。
真机 20 FPS 及语音并发尚未验收，以下候选优化与新的 DMA 管线都不能替代实际测量。

## 2026-09-09 小猫 20 FPS 候选优化（尚未烧录验收）

目标覆盖 example06/07 的小猫普通与全屏页面。此次在 `pixelbox-5637bc`
（ESP32-S3 / 480×480 / 192.168.1.169）测得修改前 example06 为每秒 9.64 次 onFrame 回调，
平均回调间隔 103.6 ms，P95 111.0 ms；这不是面板实际帧率。另一次带方法包装的定位采样
约每秒 9.44 次回调，
`projectPointRuns` 平均 21.5 ms/帧、`fillRects` 11.0 ms/帧；带包装的结果不用作 FPS 基准。

候选补丁：

- 原生投影在有界坐标/相机范围内使用单精度运算，利用 S3 FPU。距离半像素舍入边界
  1/32 像素以内及范围外的点使用双精度计算，保留两次舍入和异常行为。
- 新增 `px.util.blendPoints`，把姿态过渡中数千次 TypedArray 坐标累加放到原生循环，
  保留每次写回 Float32 的舍入顺序。SDK、模拟器与 06/07 共用模型已同步。
- 彩边裁剪与绘制包围盒使用直接比较，减少 QuickJS 热路径的 Math 调用，像素输出不变。

验证命令：

```sh
cmake --build firmware/build/jsvm-host
ctest --test-dir firmware/build/jsvm-host --output-on-failure
node examples/scripts/test-cat-projection.mjs firmware/build/jsvm-host/qjs_bench
```

宿主机检查包含 32,000 个随机投影点、半像素边界、混合数组越界/别名，以及 720 个
小猫姿态/缩放/反复中断的过渡。模拟器和真实 QuickJS/C++ 均与原 JS 数学定义一致。
这些正确性测试及桌面耗时不构成真机达到 20 FPS 的证据。

真机验收工具 `node tools/check-cat-fps.mjs <设备IP> 12` 会临时切换应用，运行两个
真实渲染器的普通/全屏、待机/说话共 8 个场景，包含真实 IMU、自动姿态变化与模拟流式
字幕；报告绘制、同步 flush、实际完成帧数和 P95，任一场景低于 20 FPS 返回失败。
工具结束后恢复完整 example06。该检查不调用语音云服务，不代表真实 ASR/AI/TTS 并发验收。
仅有 onFrame 回调次数不足以验收：example06 的音频低缓冲保护会直接跳过绘制。

目前仅有修改前的真机数据；候选固件尚未烧录验收，不能声明已达到 20 FPS。

## 2026-09-08 渲染与调度优化（待真机验收）

以下旧版约 5 FPS 数据不代表本次补丁的帧率。本次改动覆盖固件和 example06/07：

- `examples/06-obeing-pixel/src/render.ts` 的 `beginScene`、`companionBody` 保留静态背景与字幕，
  IMU 帧只恢复旧小猫区域和相交网格，字幕变化独立刷新；07 使用同一缓存。
- `drawCat` 增加 IMU 直接位移，彩边跳过最终白色主体覆盖的像素。99 个姿态与原五层
  算法逐像素一致，彩边及主体累计填色从 8,535,765 降到 2,540,035 像素，减少 70.2%；
  该指标不含背景/字幕，也不是整体帧率提高比例。`wrapText` 缓存字体 advance。
- 两个示例请求 30 FPS，IMU 保持 50 Hz 最新值投递；不能以 `setFps(30)` 作为实测证据。
- `jsvm.cpp#run_loop_turn` 在输入、帧或定时器到期时将事件批次预算缩到 8 ms，
  最多仍合批 32 条便宜事件。单条回调不能抢占，8 ms 是批次边界而非硬实时保证。
- `gfx.cpp#clear` 对黑白使用 memset，其他颜色从缓存首行复制；整行矩形复用同一路径。
  `gather_rotated_rect` 让 90/270 度旋转连续读取 PSRAM，跨行写内部 DMA 缓冲。
- AMOLED DMA 描述符按实际 32 行缓冲大小预留；窄脏区在同一缓冲中装更多行，减少传输次数。

本地验证：06 的 33 项测试通过，包含 216 个连续帧和页面切换的整屏重画对照；
另外独立执行 1,080 帧跨尺寸/姿态/IMU 的逐像素检查通过。
Playwright 使用真实字体检查 06 的 69 个场景、07 的 54 个场景，无越界/文字重叠。
JSVM 宿主机 CTest 通过，模拟 3 ms 的事件时，到期帧在 9 ms 执行、12 ms 后到期的帧在
12 ms 执行，剩余事件完整送达。绘图专项 38,961/38,961 断言通过；完整绘图测试仅有
既有 `pixel12` 字体 A advance==6 断言失败，独立重建 HEAD 原版也复现该失败。

真机验收需更新固件和对应示例，运行 `node tools/profile-device.mjs <设备IP> 12` 记录 FPS，
再在 ASR/AI/TTS 并行工作时检查 IMU 跟随与字幕。未烧录前不宣称真实 FPS、物理输入到
屏幕响应时延或音频网络并发稳定性已通过。

## Findings and Changes

1. IMU samples were queued individually. A slow frame accumulated stale input,
   and a full queue could block the producer for 200 ms. Samples now use a
   single latest-value mailbox with stream epochs. The VM reads it before the
   frame source. Stopping/restarting rejects samples from the previous stream.
2. Frame timer delivery could fail with its pending flag still set, permanently
   stopping frames; queued ticks also lacked a VM generation guard. Frame
   deadlines now live entirely in the JS thread. Missed frames are skipped.
3. Callback destruction posted an allocating cleanup job to the same queue.
   Saturation could leak the control block and retained JS function, or make
   the consumer wait for its own queue. Cleanup now uses an intrusive retire
   list and task notification. Only the JS thread touches live JS values.
   Full application switching also reproduced a `JS_FreeRuntime` assertion:
   networking's independent lifetime registry could lose references released
   after its teardown hook. Network Promise, JsFunc and SelfRef now use the
   same `jsvm::Value` registry as callbacks, so native owner destruction cannot
   leave an untracked JS reference queued past runtime shutdown.
4. Promise pumping allowed over 1024 jobs per checkpoint, and every due timer
   ran in one pass. Work is now bounded by count and elapsed time; timers are
   ordered by deadline. Intervals skip missed periods. ID wrap and non-finite
   timer delays are handled explicitly.
5. Endless JS callbacks could prevent normal progress until an external stop.
   The interrupt handler now enforces `CONFIG_JSVM_EXECUTION_TIMEOUT_MS`
   (default 1000 ms; entry scripts receive ten times the budget). A busy loop
   also yields to FreeRTOS so the idle task can service its watchdog.
6. AMOLED DMA completion waited forever and discarded dirty regions on failure.
   Completion now has a 250 ms bound. A timed-out transfer retains ownership of
   its buffer until completion; dirty regions survive failure for retry.
7. The examples projected, sorted and allocated objects/string keys for a
   single-material shell every frame. Reused arrays and native
   `px.util.projectPoints` / `projectPointRuns` remove this work from QuickJS.
   Both have simulator implementations; examples feature-detect them and keep
   the optimized JS fallback. Rotation and drawing geometry remain equivalent.
8. IMU polling added I2C time to every period and rounded a requested 30 Hz
   stream toward 25 Hz with 50 Hz detection. Polling now uses absolute task
   deadlines and carries stream phase. Detection remains at 50 Hz; failed
   register configuration is reported. Example smoothing is 65 ms instead of
   160 ms and uses actual elapsed time, with 50 Hz requested samples.

## Device Measurements

ESP32-S3 revision 0.2, Waveshare AMOLED 2.16, 480x480, 8 MB PSRAM, 16 MB
Flash, 240 MHz CPU, 80 MHz PSRAM, 40 MHz QSPI display. Existing performance
compiler settings were retained. Device: `pixelbox-906ee8`, USB `COM3`.

| Workload | FPS | Mean Frame Interval |
| --- | ---: | ---: |
| Original firmware and installed example6 | 0.84 | 1196 ms |
| Final firmware and full updated example6 | 5.09 | 197 ms |
| Updated example6 assistant renderer with live IMU test fixture | 5.03 | about 199 ms |
| Updated example7 assistant renderer with live IMU test fixture | 5.62 | about 178 ms |
| Full updated example7, login page | 8.78 | 114 ms |

The full example6 comparison is approximately 6.1x faster. The example7
assistant measurement uses its real renderer and live sensor stream in a
local fixture, without signing into an account or calling speech services.
It is not a measurement of authenticated streaming speech or network traffic.
There was no original example7 baseline measurement.

Normal measured scenes had no rejected queue jobs or execution timeouts.
Two deliberate infinite-loop tests increased the cumulative timeout count;
both returned control and allowed subsequent JS evaluation. With recursively
scheduled microtasks, a timer fired after 32 jobs, before the chain completed.
Six consecutive VM restarts left internal free heap between 41359 and 41407
bytes (48 bytes more free at the end). Captured teardown logs reported zero
JS allocator residue.

After the networking lifetime fix, six additional switches between the full
example6 and example7 applications completed with the same device boot ID
throughout. Each teardown reported zero JS allocator residue, with no queue
drops or callback timeouts. This directly retests the previously reproduced
`JS_FreeRuntime` assertion, including example7's NTP and subscription cleanup.

The requested 24 FPS is still not achieved for these full-screen scenes.
On this board, a standalone full clear measured about 21 ms and a full flush
about 45 ms, before application computation. Frame-rate improvement is not
a measured physical motion-to-photon latency. Sensor callback cadence falls
with render throughput, while the delivered sample is the latest available.
Long-duration audio/network soak testing remains outstanding.

## Validation and Reproduction

- ESP-IDF 5.5 ESP32-S3 firmware build, flashed and verified by esptool.
- Seven examples passed TypeScript checking and bundling; 48 example6/7 tests passed.
- Simulator node/web TypeScript checks passed.
- 72 Playwright scenes at 320/368/480 widths passed bounds/overlap and animation checks.
- 300 pose/layout combinations matched previous drawing runs, including simulator acceleration.
- Real QuickJS host tests cover scheduling, queue saturation, callback lifetime,
  interruption, restart, projection bounds and subarray ownership.
- Native projection was compared against JS arithmetic for 3000 points.

See [host test instructions](../firmware/components/jsvm/test_host/README.md).
`node tools/profile-device.mjs 192.168.31.100 12` measures the current app;
the script removes its frame observer after sampling. `--detail` adds expensive
method wrappers and must not be used for headline FPS measurements.

`node tools/check-device-runtime.mjs 192.168.31.100` installs a temporary test
app and runs both renderers, microtask stress, a deliberate runaway callback,
and six restarts. `--stability-only` skips the rendering measurement phase.
Restore the desired app with the SDK after using this tool.
`node tools/check-device-switches.mjs 192.168.31.100` alternates the full
applications six times, asserts that the boot ID stays unchanged and restores
example6 on success.

The original complete Flash was backed up locally to
`firmware/build/device-flash-before-jsvm.bin` before flashing. Only `ota_0`
and the OTA selection data were written; NVS, app storage, model, bootloader
and partition table were retained. The binary backup is generated output and
is not part of the source changes.
