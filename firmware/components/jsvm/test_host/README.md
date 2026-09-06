# JSVM Host Checks

These checks compile the repository's QuickJS-ng and actual `jsvm.cpp`,
`js_std.cpp` and projection binding. Small RTOS shims provide a deterministic
clock and bounded event queue. They do not simulate ESP32 timing or DMA.

```sh
cmake -S firmware/components/jsvm/test_host -B firmware/build/jsvm-host -DCMAKE_BUILD_TYPE=Release
cmake --build firmware/build/jsvm-host
ctest --test-dir firmware/build/jsvm-host --output-on-failure
node examples/scripts/benchmark-obeing.mjs firmware/build/jsvm-host/qjs_bench
```

On Windows use MinGW GCC, put its `bin` directory on `PATH`, select Ninja, and
pass `.exe` for the benchmark executable. The suite covers:

- Queue saturation, nonblocking posts from the consumer and cross-task cleanup.
- Latest-value stream epochs and input-before-frame execution.
- Recursive microtasks, deadline-ordered timers, cancellation and reentry.
- Runaway JS interruption and continued execution after the exception.
- Callback self-unsubscription, builder errors and VM generation changes.
- Native point projection, subarrays, invalid buffers, range bounds and run merging.
- Network Promise/JsFunc/SelfRef destruction after the network teardown hook.

`benchmark-obeing.mjs` verifies 300 poses against the previous algorithm and the
simulator's batch implementation before producing its QuickJS benchmark bundle.

Device tools (SDK must be built first):

```sh
node tools/profile-device.mjs 192.168.31.100 12
node tools/check-device-runtime.mjs 192.168.31.100
node tools/check-device-switches.mjs 192.168.31.100
```

The first temporarily adds a frame observer to the running app. `--detail`
wraps native methods and substantially perturbs timing; use it only to locate
hotspots. The second replaces the current app with a test fixture using the
example6/example7 renderers and real IMU, then tests starvation, interruption
and restarts. Push the desired example again after it completes.

The third switches between the complete example6 and example7 applications
six times and checks that the device boot ID stays unchanged. It leaves
example6 running. Account credentials are neither entered nor printed.

The internal `__pxRuntimeStats()` diagnostic exposes queue depth/peak, rejected
posts, execution timeouts and maximum turn/source/job duration. Counters are
cumulative since firmware boot. A source includes rendering and synchronous
display flush. Maximum durations include startup and deliberate stress tests.
