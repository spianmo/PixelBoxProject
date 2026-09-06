# JSVM Performance Review (2026-09-06)

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
