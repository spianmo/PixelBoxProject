#include <cassert>
#include <cstdio>
#include <thread>
#include "jsvm/latest_value.hpp"
#include "js_helpers.hpp"
// Exercise the real loop and lifetime implementation with deterministic RTOS shims.
#include "../src/jsvm.cpp"

extern const char _binary_prelude_core_js_start[] = "";

static JSValue evaluate(const char *code) {
    JSValue result = JS_Eval(jsvm::context(), code, strlen(code), "<test>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        std::fprintf(stderr, "%s\n", jsvm::format_exception(jsvm::context()).c_str());
        std::abort();
    }
    return result;
}
static void run(const char *code) { JS_FreeValue(jsvm::context(), evaluate(code)); }
static int number(const char *code) {
    JSValue value = evaluate(code);
    int32_t result = 0;
    assert(JS_ToInt32(jsvm::context(), &result, value) == 0);
    JS_FreeValue(jsvm::context(), value);
    return result;
}
static jsvm::Callback callback(const char *code) {
    JSValue value = evaluate(code);
    jsvm::Callback cb(jsvm::context(), value);
    JS_FreeValue(jsvm::context(), value);
    return cb;
}
static void empty_queue() {
    while (uxQueueMessagesWaiting(jsvm::s_queue)) jsvm::run_loop_turn();
    jsvm::drain_callback_releases();
}
static JSValue slow(JSContext *, JSValueConst, int, JSValueConst *) {
    host::now_us += 3000;
    return JS_UNDEFINED;
}

static jsvm::LatestValue<int> samples;
static bool sources_active = false;
static int sensor_value = 0, frame_value = 0;
static int64_t sensor_deadline() { return sources_active && samples.pending() ? 0 : -1; }
static int64_t frame_deadline() { return sources_active ? 0 : -1; }
static void poll_sensor(JSContext *) { samples.take(sensor_value); }
static void draw_frame(JSContext *) { frame_value = sensor_value; }
static pxjs::JsFuncPtr teardown_func;
static pxjs::PromisePtr teardown_promise;
static pxjs::SelfRef teardown_self;
static void release_network_owners(JSContext *ctx) {
    teardown_func.reset();
    teardown_promise.reset();
    teardown_self.release(ctx);
}

int main() {
    using namespace jsvm;
    s_queue = xQueueCreate(CONFIG_JSVM_QUEUE_DEPTH, sizeof(void *));
    s_task = xTaskGetCurrentTaskHandle();
    assert(boot_vm());

    JSValue projection_global = JS_GetGlobalObject(s_ctx);
    internal::install_projection_util(s_ctx, projection_global);
    JS_FreeValue(s_ctx, projection_global);
    run("globalThis.projected = new Int32Array(8); projectPoints(new Float32Array([1,2,0, -1,-2,0]), {scale:2,cx:10,cy:20,grid:2}, projected.subarray(2,6))");
    assert(number("projected.join(',') === '0,0,6,12,4,8,0,0'") == 1);
    run("projectPoints(new Float32Array(0), {}, new Int32Array(0))");
    run("globalThis.invalidCases = 0; for (const args of [[[],{},new Int32Array(2)], [new Float32Array(2),{},new Int32Array(2)], [new Float32Array(3),{},new Int32Array(1)], [new Float32Array(3),{yaw:Infinity},new Int32Array(2)], [new Float32Array([0,0,64]),{},new Int32Array(2)], [new Float32Array([NaN,0,0]),{},new Int32Array(2)]]) { try { projectPoints(...args); } catch(e) { invalidCases++; } }");
    assert(number("invalidCases") == 6);
    run("let alias = new ArrayBuffer(12); try { projectPoints(new Float32Array(alias),{},new Int32Array(alias)); } catch(e) { invalidCases++; }");
    assert(number("invalidCases") == 7);
    run("globalThis.runs = new Int32Array(15); globalThis.runCount = projectPointRuns(new Float32Array([0,0,0, 1,0,0, 1,0,0, 3,0,0, 0,1,0]), {}, runs)");
    assert(number("runCount === 3 && runs.slice(0,9).join(',') === '0,0,2,3,0,1,0,1,1'") == 1);
    assert(number("projectPointRuns(new Float32Array(0), {}, new Int32Array(0))") == 0);
    run("try { projectPointRuns(new Float32Array([0,0,0, 1000,1000,0]),{},new Int32Array(6)); } catch(e) { invalidCases++; }");
    assert(number("invalidCases") == 8);
    run(R"JS(
        for (let k=0;k<100;k++) {
            const points=new Float32Array(90);
            for(let i=0;i<points.length;i++)points[i]=Math.sin(i*13+k)*10;
            const out=new Int32Array(60), yaw=k/67, pitch=k/123;
            projectPoints(points,{yaw,pitch,squash:.84,scale:7.8,cx:240,cy:170,lift:1.7,grid:8},out);
            for(let i=0,j=0;i<points.length;i+=3,j+=2){
                const x=points[i]*Math.cos(yaw)+points[i+2]*Math.sin(yaw);
                const z=-points[i]*Math.sin(yaw)+points[i+2]*Math.cos(yaw);
                const y=points[i+1]*.84*Math.cos(pitch)-z*Math.sin(pitch);
                const d=points[i+1]*Math.sin(pitch)+z*Math.cos(pitch), p=64/(64-d);
                const gx=Math.round(Math.round(240+x*7.8*p)/8), gy=Math.round(Math.round(170+y*7.8*p+1.7)/8);
                if(gx!==out[j]||gy!==out[j+1])throw Error('projection mismatch');
            }
        }
    )JS");
    std::puts("[OK] native projection validates types, subarrays, ranges and buffer ownership");

    const auto epoch = samples.reset();
    assert(samples.publish(epoch, 1));
    for (int i = 2; i <= 10000; ++i) assert(!samples.publish(epoch, i));
    int sample = 0;
    assert(samples.take(sample) && sample == 10000 && !samples.take(sample));
    const auto next = samples.reset();
    assert(!samples.publish(epoch, -1));
    assert(samples.publish(next, 10001));
    std::puts("[OK] latest sample coalescing and stopped-stream epoch rejection");

    auto cb = callback("() => 42");
    const size_t controls = s_live_ctrls.size();
    for (int i = 0; i < CONFIG_JSVM_QUEUE_DEPTH; ++i) assert(post([] {}, 0));
    assert(!post([] {}));
    assert(host::blocking_sends == 0);
    std::thread release([owned = std::move(cb)]() mutable { owned.reset(); });
    release.join();
    drain_callback_releases();
    assert(s_live_ctrls.size() == controls - 1);
    assert(uxQueueMessagesWaiting(s_queue) == CONFIG_JSVM_QUEUE_DEPTH);
    std::puts("[OK] queue saturation cannot block the consumer or lose callback cleanup");

    add_loop_source({100, frame_deadline, draw_frame});
    add_loop_source({0, sensor_deadline, poll_sensor});
    add_loop_source({0, sensor_deadline, poll_sensor});
    assert(s_loop_sources.size() == 2);
    sources_active = true;
    run_loop_turn();
    assert(frame_value == 10001);
    assert(uxQueueMessagesWaiting(s_queue) > 0);
    sources_active = false;
    empty_queue();
    std::puts("[OK] fresh input precedes frames even with a saturated event queue");

    run("globalThis.jobs = 0; queueMicrotask(function again() { jobs++; if (jobs < 10000) queueMicrotask(again); }); globalThis.timerRan = 0; setTimeout(() => timerRan++, 0)");
    pump_jobs();
    assert(number("jobs") == 32);
    run_loop_turn();
    assert(number("timerRan") == 1 && number("jobs") < 10000);
    while (JS_IsJobPending(s_rt)) pump_jobs();
    std::puts("[OK] recursive microtasks yield to timers and native event sources");

    JSValue global = JS_GetGlobalObject(s_ctx);
    JS_SetPropertyStr(s_ctx, global, "slow", JS_NewCFunction(s_ctx, slow, "slow", 0));
    JS_FreeValue(s_ctx, global);
    run("globalThis.order = []; for (let i = 0; i < 12; i++) { let id = setInterval(() => { order.push(i); clearInterval(id); slow(); }, 0); }");
    host::now_us += 1000;
    internal::run_due_timers(s_ctx);
    assert(number("order.length") == 1);
    for (int i = 0; i < 11; ++i) internal::run_due_timers(s_ctx);
    assert(number("order.length") == 12);
    assert(number("order.every((value, i) => value === i)") == 1);
    run("globalThis.argsOK = 0; setTimeout((a, b) => { argsOK = a + b; setTimeout(() => argsOK++, 0); }, 0, 20, 21)");
    internal::run_due_timers(s_ctx);
    internal::run_due_timers(s_ctx);
    assert(number("argsOK") == 42);
    run("let never = setTimeout(() => { throw Error('cancelled timer ran'); }, Infinity); clearTimeout(never)");
    assert(internal::next_timer_deadline_us() == -1);
    std::puts("[OK] bounded deadline-ordered timers, cancellation, reentry and arguments");

    run("globalThis.calls = 0");
    auto builder_failure = callback("() => calls++");
    builder_failure.invoke_now([](JSContext *ctx, JSValue *args) {
        args[0] = JS_NewString(ctx, "must be freed");
        JS_ThrowTypeError(ctx, "builder failure");
        return 1;
    });
    assert(number("calls") == 0 && !JS_HasException(s_ctx));
    builder_failure.reset();
    auto self = callback("() => calls++");
    self.invoke_now([&self](JSContext *, JSValue *) { self.reset(); return 0; });
    assert(number("calls") == 1);
    std::puts("[OK] builder exceptions and callback self-unsubscription retain correct ownership");

    auto runaway = callback("() => { while (true) {} }");
    host::clock_step_us = 1000;
    runaway.invoke_now(nullptr);
    host::clock_step_us = 0;
    assert(!JS_HasException(s_ctx));
    run("calls++");
    assert(number("calls") == 2);
    runaway.reset();
    std::puts("[OK] runaway JS callback is interrupted and subsequent JS remains executable");

    JSValue resolved;
    auto network_resolve = pxjs::Promise::create(s_ctx, &resolved);
    JSValue network_global = JS_GetGlobalObject(s_ctx);
    JS_SetPropertyStr(s_ctx, network_global, "networkPromise", resolved);
    JS_FreeValue(s_ctx, network_global);
    run("globalThis.networkAnswer = 0; networkPromise.then(v => networkAnswer = v)");
    network_resolve->resolve_now(JS_NewInt32(s_ctx, 42));
    network_resolve->resolve_now(JS_NewString(s_ctx, "ignored duplicate"));
    pump_jobs();
    assert(number("networkAnswer") == 42);
    network_resolve.reset();
    JSValue rejected;
    auto network_reject = pxjs::Promise::create(s_ctx, &rejected);
    network_global = JS_GetGlobalObject(s_ctx);
    JS_SetPropertyStr(s_ctx, network_global, "networkRejected", rejected);
    JS_FreeValue(s_ctx, network_global);
    run("globalThis.networkError = ''; networkRejected.catch(e => networkError = e.message)");
    std::thread reject_worker([network_reject] { network_reject->reject_msg("test failure"); });
    reject_worker.join();
    empty_queue();
    assert(number("networkError === 'test failure'") == 1);
    network_reject.reset();
    std::puts("[OK] network Promise resolve, duplicate settlement and cross-task rejection");

    auto stale = callback("() => { throw Error('stale callback'); }");
    pxjs::set_ctx(s_ctx);
    JSValue network_fn = evaluate("() => 42");
    teardown_func = std::make_shared<pxjs::JsFunc>(s_ctx, network_fn);
    JS_FreeValue(s_ctx, network_fn);
    JSValue network_promise;
    teardown_promise = pxjs::Promise::create(s_ctx, &network_promise);
    JS_FreeValue(s_ctx, network_promise);
    JSValue network_object = JS_NewObject(s_ctx);
    teardown_self.hold(s_ctx, network_object);
    JS_FreeValue(s_ctx, network_object);
    // Reproduce release after the networking teardown hook and generation bump.
    add_teardown_hook(release_network_owners);
    stale.invoke();
    const auto generation = vm_generation();
    teardown_vm(false);
    assert(vm_generation() != generation);
    bool built = false;
    stale.invoke_now([&built](JSContext *, JSValue *) { built = true; return 0; });
    assert(!built);
    assert(boot_vm());
    empty_queue();
    stale.invoke_now([&built](JSContext *, JSValue *) { built = true; return 0; });
    stale.reset();
    assert(!built && !JS_HasException(s_ctx));
    teardown_vm(false);
    drain_callback_releases();
    assert(s_live_ctrls.empty() && s_pending_releases == nullptr && js_heap_used() == 0);
    std::puts("[OK] queued callbacks cannot cross VM generations; all JS allocations released");
    std::puts("[OK] network Promise/JsFunc/SelfRef released in a later teardown hook cannot leak");
    vQueueDelete(s_queue);
    s_queue = nullptr;
    std::puts("JSVM host regression tests passed");
}
