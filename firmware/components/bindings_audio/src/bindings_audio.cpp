/**
 * PixelBox bindings_audio — px.audio JS 绑定(模块名 "audio")
 *
 * 与 sdk/types/pixelbox.d.ts 逐一对齐:
 *   px.audio.setVolume / getVolume
 *   px.audio.mic.start / stop / setGain / active
 *   px.audio.player.play / playPcm / openPcmStream / tone / stopAll / playing
 *   px.audio.record
 *
 * 线程规则:所有硬件事件(mic 帧 / 播放结束 / 解码完成)一律经 jsvm::post
 * 投递到 JS 线程后才触碰 JS_*。
 *
 * VM 热重启防护:px.audio 上挂一个带 finalizer 的隐藏 guard 对象;
 * VM 销毁时 guard 释放所有仍被 native 持有的 JSValue 并停掉 mic 订阅。
 */
#include <algorithm>
#include <atomic>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_audio/decode_stream.hpp"
#include "hal_audio/hal_audio.hpp"
#include "hal_audio/wav.hpp"
#include "js_util.hpp"
#include "jsvm/jsvm.hpp"
#include "path_resolve.hpp"
#include "quickjs.h"
#include "sdkconfig.h"

namespace {

const char* TAG = "px.audio";

#define ENSURE_READY(ctx)                                        \
    do {                                                         \
        if (!hal_audio::ready()) return jsvm::throw_enotsup(ctx); \
    } while (0)

// ============================================================
// 类 ID 与控制块
// ============================================================

JSClassID g_play_handle_cid;
JSClassID g_pcm_stream_cid;
JSClassID g_guard_cid;

/** onEnded 订阅表(仅 JS 线程访问) */
struct EndedCbs {
    std::vector<std::pair<int, JSValue>> cbs;
    int next_id = 1;
    bool fired = false;
};

/** PxPlayHandle 控制块;JS 对象 opaque = new shared_ptr<PlayCtx> */
struct PlayCtx {
    JSContext* ctx = nullptr;
    bool alive = true;  // finalizer 置 false;posted lambda 必查
    std::shared_ptr<hal_audio::Source> src;
    hal_audio::DecodeStream::Ptr stream;  // play() 时保活解码流
    EndedCbs ended;
};
using PlayCtxPtr = std::shared_ptr<PlayCtx>;

/** openPcmStream 控制块 */
struct StreamCtx {
    JSContext* ctx = nullptr;
    bool alive = true;
    std::shared_ptr<hal_audio::PcmRingSource> ring;
    EndedCbs ended;
    int64_t last_warn_tick = 0;
};
using StreamCtxPtr = std::shared_ptr<StreamCtx>;

/** play() 未决 Promise */
struct PendingPlay {
    JSContext* ctx = nullptr;
    JSValue resolve = JS_UNDEFINED;
    JSValue reject = JS_UNDEFINED;
    bool alive = true;
    hal_audio::DecodeStream::Ptr stream;
};
using PendingPlayPtr = std::shared_ptr<PendingPlay>;

/** record() 任务 */
struct RecordJob {
    JSContext* ctx = nullptr;
    JSValue resolve = JS_UNDEFINED;
    JSValue reject = JS_UNDEFINED;
    bool js_alive = true;
    std::string path;
    uint32_t rate = 16000;
    int16_t* pcm = nullptr;   // PSRAM 整段录音缓冲 (io_mtx 保护所有权)
    size_t cap = 0;           // 容量(样本)
    size_t len = 0;           // 已写样本
    hal_audio::LinearResampler rs;
    int sink_id = -1;
    std::atomic<bool> capture_done{false};
    /* io_mtx 串行化 [采集写入 pcm] 与 [guard_finalizer 回收 pcm]:
     * capture_task 在锁外快照派发 sink, unsubscribe 返回后仍可能有一次
     * 在途回调, 仅凭 capture_done 入口检查存在写后释放竞态。
     * writer_started = pcm 所有权已移交写盘任务, finalizer 不得再 free。 */
    std::mutex io_mtx;
    bool writer_started = false;
};
using RecordJobPtr = std::shared_ptr<RecordJob>;

/** PSRAM 麦克风帧 */
struct MicFrame {
    int16_t* data = nullptr;
    size_t samples = 0;
};

/** JS 侧 mic 单例状态 */
struct MicState {
    std::mutex mtx;
    bool alive = false;
    int sink_id = -1;
    JSContext* ctx = nullptr;
    JSValue cb = JS_UNDEFINED;
    uint32_t req_rate = 16000;
    size_t frame_samples = 512;
    hal_audio::LinearResampler rs;
    std::vector<int16_t> acc;
    std::deque<MicFrame> q;
    bool post_pending = false;
    uint32_t dropped = 0;
    int64_t last_warn_tick = 0;
};
MicState g_mic;

/** 组件级注册表(guard finalizer 统一收尾) */
struct Registry {
    std::mutex mtx;
    bool alive = false;
    JSContext* ctx = nullptr;
    std::vector<PendingPlayPtr> plays;
    std::vector<RecordJobPtr> records;
};
Registry g_reg;

void free_mic_queue_locked() {
    while (!g_mic.q.empty()) {
        hal_audio::big_free(g_mic.q.front().data);
        g_mic.q.pop_front();
    }
    g_mic.acc.clear();
}

// ============================================================
// PxPlayHandle
// ============================================================

PlayCtxPtr* handle_opaque(JSContext* ctx, JSValueConst v) {
    return static_cast<PlayCtxPtr*>(JS_GetOpaque2(ctx, v, g_play_handle_cid));
}

void fire_ended_cbs(JSContext* ctx, EndedCbs& ended) {
    ended.fired = true;
    // 先 dup 再调用,防止回调内 unsubscribe 造成悬垂
    std::vector<JSValue> fns;
    fns.reserve(ended.cbs.size());
    for (auto& kv : ended.cbs) fns.push_back(JS_DupValue(ctx, kv.second));
    for (auto& fn : fns) {
        pxjs::call_js(ctx, fn, 0, nullptr, TAG);
        JS_FreeValue(ctx, fn);
    }
}

/** 创建 PxPlayHandle,并把 Source 结束事件接到 JS 线程 */
JSValue make_play_handle(JSContext* ctx, const std::shared_ptr<hal_audio::Source>& src,
                         const hal_audio::DecodeStream::Ptr& stream) {
    JSValue obj = JS_NewObjectClass(ctx, static_cast<int>(g_play_handle_cid));
    if (JS_IsException(obj)) return obj;
    auto blk = std::make_shared<PlayCtx>();
    blk->ctx = ctx;
    blk->src = src;
    blk->stream = stream;
    JS_SetOpaque(obj, new PlayCtxPtr(blk));
    src->on_finished([blk] {
        jsvm::post([blk] {
            if (!blk->alive || blk->ended.fired) return;
            fire_ended_cbs(blk->ctx, blk->ended);
        });
    });
    return obj;
}

JSValue js_handle_stop(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = handle_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    (*p)->src->stop();
    if ((*p)->stream) (*p)->stream->abort();
    return JS_UNDEFINED;
}

JSValue js_handle_pause(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = handle_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    (*p)->src->pause();
    return JS_UNDEFINED;
}

JSValue js_handle_resume(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = handle_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    (*p)->src->resume();
    return JS_UNDEFINED;
}

JSValue js_handle_playing_get(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = handle_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    return JS_NewBool(ctx, (*p)->src->attached() && !(*p)->src->paused());
}

JSValue js_handle_unsub_ended(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                              JSValueConst* data) {
    auto* p = static_cast<PlayCtxPtr*>(JS_GetOpaque(data[0], g_play_handle_cid));
    int32_t id = 0;
    JS_ToInt32(ctx, &id, data[1]);
    if (p) {
        auto& cbs = (*p)->ended.cbs;
        for (auto it = cbs.begin(); it != cbs.end(); ++it) {
            if (it->first == id) {
                JS_FreeValue(ctx, it->second);
                cbs.erase(it);
                break;
            }
        }
    }
    return JS_UNDEFINED;
}

/** 通用 onEnded 注册:owner 为句柄/流对象,ended 为其订阅表 */
JSValue register_ended(JSContext* ctx, JSValueConst owner, EndedCbs& ended, JSValueConst cb,
                       JSCFunctionData* unsub_fn) {
    if (!JS_IsFunction(ctx, cb)) return pxjs::throw_error(ctx, "onEnded 需要函数参数");
    const int id = ended.next_id++;
    ended.cbs.emplace_back(id, JS_DupValue(ctx, cb));
    // JS_NewCFunctionData 内部会 dup data,这里只借用引用
    JSValue data[2] = {owner, JS_NewInt32(ctx, id)};
    return JS_NewCFunctionData(ctx, unsub_fn, 0, 0, 2, data);
}

JSValue js_handle_on_ended(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* p = handle_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    if (argc < 1) return pxjs::throw_error(ctx, "onEnded 需要函数参数");
    if ((*p)->ended.fired) {
        // 已结束:立即(异步)补一次回调
        JSValue fn = JS_DupValue(ctx, argv[0]);
        PlayCtxPtr blk = *p;
        const uint32_t gen = jsvm::vm_generation();
        jsvm::post([blk, fn, gen] {
            // VM 已热重启则整体放弃:fn 随旧 runtime 回收, 不可再 free (旧 ctx 已释放)
            if (gen != jsvm::vm_generation() || !jsvm::context()) return;
            if (blk->alive) pxjs::call_js(blk->ctx, fn, 0, nullptr, TAG);
            JS_FreeValue(blk->ctx, fn);
        });
    }
    return register_ended(ctx, this_val, (*p)->ended, argv[0], js_handle_unsub_ended);
}

void play_handle_finalizer(JSRuntime* rt, JSValueConst val) {
    auto* p = static_cast<PlayCtxPtr*>(JS_GetOpaque(val, g_play_handle_cid));
    if (!p) return;
    (*p)->alive = false;
    for (auto& kv : (*p)->ended.cbs) JS_FreeValueRT(rt, kv.second);
    (*p)->ended.cbs.clear();
    delete p;  // 播放本身继续(不随 GC 停止)
}

// ============================================================
// openPcmStream 对象
// ============================================================

StreamCtxPtr* stream_opaque(JSContext* ctx, JSValueConst v) {
    return static_cast<StreamCtxPtr*>(JS_GetOpaque2(ctx, v, g_pcm_stream_cid));
}

JSValue js_stream_feed(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* p = stream_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &data, &len)) {
        return JS_EXCEPTION;  // get_binary 已抛 TypeError
    }
    const size_t n = (*p)->ring->feed(data, len);
    if (n < len) {
        const int64_t now = xTaskGetTickCount();
        if (now - (*p)->last_warn_tick > pdMS_TO_TICKS(1000)) {
            (*p)->last_warn_tick = now;
            ESP_LOGW(TAG, "PCM 流缓冲已满,丢弃 %u 字节(建议用 buffered() 做节流)",
                     static_cast<unsigned>(len - n));
        }
    }
    return JS_UNDEFINED;
}

JSValue js_stream_end(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = stream_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    (*p)->ring->end();
    return JS_UNDEFINED;
}

JSValue js_stream_stop(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = stream_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    (*p)->ring->stop();
    return JS_UNDEFINED;
}

JSValue js_stream_buffered(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
    auto* p = stream_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    return JS_NewInt32(ctx, static_cast<int32_t>((*p)->ring->buffered_ms()));
}

JSValue js_stream_unsub_ended(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                              JSValueConst* data) {
    auto* p = static_cast<StreamCtxPtr*>(JS_GetOpaque(data[0], g_pcm_stream_cid));
    int32_t id = 0;
    JS_ToInt32(ctx, &id, data[1]);
    if (p) {
        auto& cbs = (*p)->ended.cbs;
        for (auto it = cbs.begin(); it != cbs.end(); ++it) {
            if (it->first == id) {
                JS_FreeValue(ctx, it->second);
                cbs.erase(it);
                break;
            }
        }
    }
    return JS_UNDEFINED;
}

JSValue js_stream_on_ended(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* p = stream_opaque(ctx, this_val);
    if (!p) return JS_EXCEPTION;
    if (argc < 1) return pxjs::throw_error(ctx, "onEnded 需要函数参数");
    if ((*p)->ended.fired) {
        JSValue fn = JS_DupValue(ctx, argv[0]);
        StreamCtxPtr blk = *p;
        const uint32_t gen = jsvm::vm_generation();
        jsvm::post([blk, fn, gen] {
            // 同 js_handle_on_ended: VM 已热重启则整体放弃, 不可对旧 ctx free
            if (gen != jsvm::vm_generation() || !jsvm::context()) return;
            if (blk->alive) pxjs::call_js(blk->ctx, fn, 0, nullptr, TAG);
            JS_FreeValue(blk->ctx, fn);
        });
    }
    return register_ended(ctx, this_val, (*p)->ended, argv[0], js_stream_unsub_ended);
}

void pcm_stream_finalizer(JSRuntime* rt, JSValueConst val) {
    auto* p = static_cast<StreamCtxPtr*>(JS_GetOpaque(val, g_pcm_stream_cid));
    if (!p) return;
    (*p)->alive = false;
    for (auto& kv : (*p)->ended.cbs) JS_FreeValueRT(rt, kv.second);
    (*p)->ended.cbs.clear();
    // 对象被 GC 后无人能再 feed:声明 EOS 让缓冲播完自然收尾
    if ((*p)->ring && !(*p)->ring->ended() && !(*p)->ring->stopped()) (*p)->ring->end();
    delete p;
}

JSValue js_player_open_pcm_stream(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    JSValueConst opts = argc > 0 ? argv[0] : JS_UNDEFINED;
    const int32_t rate = pxjs::opt_int_prop(ctx, opts, "sampleRate", 16000);
    const int32_t ch = pxjs::opt_int_prop(ctx, opts, "channels", 1);
    if (ch != 1 && ch != 2) return pxjs::throw_error(ctx, "channels 仅支持 1 或 2");
    if (rate < 8000 || rate > 48000) return pxjs::throw_error(ctx, "sampleRate 超出范围");

    auto ring = hal_audio::PcmRingSource::create(
        static_cast<uint32_t>(rate), static_cast<uint8_t>(ch),
        static_cast<size_t>(CONFIG_PX_AUDIO_STREAM_RING_KB) * 1024);
    if (!ring) return pxjs::throw_error(ctx, "ENOMEM");

    JSValue obj = JS_NewObjectClass(ctx, static_cast<int>(g_pcm_stream_cid));
    if (JS_IsException(obj)) return obj;
    auto blk = std::make_shared<StreamCtx>();
    blk->ctx = ctx;
    blk->ring = ring;
    JS_SetOpaque(obj, new StreamCtxPtr(blk));
    ring->on_finished([blk] {
        jsvm::post([blk] {
            if (!blk->alive || blk->ended.fired) return;
            fire_ended_cbs(blk->ctx, blk->ended);
        });
    });
    hal_audio::player_add(ring);
    return obj;
}

// ============================================================
// player.play / playPcm / tone / stopAll / playing
// ============================================================

/** JS 线程:完成 play() 的 Promise */
void finish_pending_play(const PendingPlayPtr& p, esp_err_t err) {
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        auto& v = g_reg.plays;
        v.erase(std::remove(v.begin(), v.end(), p), v.end());
        if (!p->alive) return;  // guard 已释放其 JSValue
        p->alive = false;
    }
    JSContext* ctx = p->ctx;
    if (err == ESP_OK && p->stream && p->stream->source()) {
        JSValue handle = make_play_handle(ctx, p->stream->source(), p->stream);
        hal_audio::player_add(p->stream->source());
        JSValue r = JS_Call(ctx, p->resolve, JS_UNDEFINED, 1, &handle);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, handle);
    } else {
        const char* msg = "EAUDIO_DECODE";
        if (err == ESP_ERR_NOT_FOUND) msg = "ENOENT";
        else if (err == ESP_ERR_NOT_SUPPORTED) msg = "EFORMAT";
        else if (err == ESP_ERR_NO_MEM) msg = "ENOMEM";
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        JSValue r = JS_Call(ctx, p->reject, JS_UNDEFINED, 1, &e);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, p->resolve);
    JS_FreeValue(ctx, p->reject);
    p->resolve = p->reject = JS_UNDEFINED;
}

JSValue js_player_play(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    if (argc < 1) return pxjs::throw_error(ctx, "play 需要路径或 URL");
    const char* src = JS_ToCString(ctx, argv[0]);
    if (!src) return JS_EXCEPTION;
    std::string path;
    if (strncmp(src, "http://", 7) == 0 || strncmp(src, "https://", 8) == 0) {
        path = src;
    } else {
        char buf[160];
        if (!pxjs::resolve_vpath(src, buf, sizeof(buf))) {
            JS_FreeCString(ctx, src);
            return pxjs::throw_error(ctx, "路径需为 /app、/data 或 http(s) URL");
        }
        path = buf;
    }
    JS_FreeCString(ctx, src);

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) return promise;

    auto pending = std::make_shared<PendingPlay>();
    pending->ctx = ctx;
    pending->resolve = funcs[0];
    pending->reject = funcs[1];
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        g_reg.plays.push_back(pending);
    }
    auto stream = hal_audio::DecodeStream::open(path, [pending](esp_err_t err) {
        // 解码任务上下文 → 投递 JS 线程
        jsvm::post([pending, err] { finish_pending_play(pending, err); });
    });
    if (!stream) {
        finish_pending_play(pending, ESP_ERR_NO_MEM);
    } else {
        pending->stream = stream;
    }
    return promise;
}

JSValue js_player_play_pcm(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &data, &len)) {
        return JS_EXCEPTION;  // get_binary 已抛 TypeError
    }
    JSValueConst opts = argc > 1 ? argv[1] : JS_UNDEFINED;
    const int32_t rate = pxjs::opt_int_prop(ctx, opts, "sampleRate", 16000);
    const int32_t ch = pxjs::opt_int_prop(ctx, opts, "channels", 1);
    if (ch != 1 && ch != 2) return pxjs::throw_error(ctx, "channels 仅支持 1 或 2");

    auto src = hal_audio::PcmBufferSource::create(data, len, static_cast<uint32_t>(rate),
                                                  static_cast<uint8_t>(ch));
    if (!src) return pxjs::throw_error(ctx, "ENOMEM");
    JSValue handle = make_play_handle(ctx, src, nullptr);
    if (JS_IsException(handle)) return handle;
    hal_audio::player_add(src);
    return handle;
}

JSValue js_player_tone(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    double freq = 440, dur = 200;
    int32_t vol = 80;
    if (argc > 0) JS_ToFloat64(ctx, &freq, argv[0]);
    if (argc > 1) JS_ToFloat64(ctx, &dur, argv[1]);
    if (argc > 2 && !JS_IsUndefined(argv[2])) JS_ToInt32(ctx, &vol, argv[2]);
    if (dur <= 0 || dur > 60000) return pxjs::throw_error(ctx, "durationMs 超出范围");
    auto src = hal_audio::ToneSource::create(hal_audio::device_rate(), static_cast<float>(freq),
                                             static_cast<uint32_t>(dur), vol);
    if (src) hal_audio::player_add(src);
    return JS_UNDEFINED;
}

JSValue js_player_stop_all(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    ENSURE_READY(ctx);
    hal_audio::player_stop_all();
    return JS_UNDEFINED;
}

JSValue js_player_playing_get(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_audio::ready() && hal_audio::player_active());
}

// ============================================================
// mic
// ============================================================

/** 采集任务上下文:重采样→切帧→入队→投递 */
void mic_on_capture(const int16_t* samples, size_t count) {
    std::lock_guard<std::mutex> lk(g_mic.mtx);
    if (!g_mic.alive) return;
    size_t off = 0;
    auto pull = [&](int16_t* b, size_t m) {
        const size_t c = std::min(m, count - off);
        memcpy(b, samples + off, c * 2);
        off += c;
        return c;
    };
    int16_t tmp[256];
    for (;;) {
        const size_t got = g_mic.rs.produce(tmp, 256, pull);
        if (got == 0) break;
        g_mic.acc.insert(g_mic.acc.end(), tmp, tmp + got);
        while (g_mic.acc.size() >= g_mic.frame_samples) {
            MicFrame f;
            f.samples = g_mic.frame_samples;
            f.data = static_cast<int16_t*>(hal_audio::big_alloc(f.samples * 2));
            if (f.data) {
                memcpy(f.data, g_mic.acc.data(), f.samples * 2);
            }
            g_mic.acc.erase(g_mic.acc.begin(),
                            g_mic.acc.begin() + static_cast<long>(g_mic.frame_samples));
            if (!f.data) continue;
            if (g_mic.q.size() >= CONFIG_PX_AUDIO_MIC_QUEUE_FRAMES) {
                // 背压:JS 未消费完,丢最旧帧
                hal_audio::big_free(g_mic.q.front().data);
                g_mic.q.pop_front();
                g_mic.dropped++;
                const int64_t now = xTaskGetTickCount();
                if (now - g_mic.last_warn_tick > pdMS_TO_TICKS(1000)) {
                    g_mic.last_warn_tick = now;
                    ESP_LOGW(TAG, "JS 未及时消费麦克风帧,已丢弃最旧帧(累计 %u)",
                             static_cast<unsigned>(g_mic.dropped));
                }
            }
            g_mic.q.push_back(f);
            if (!g_mic.post_pending) {
                g_mic.post_pending = true;
                jsvm::post([] {
                    // JS 线程:批量派发积压帧
                    std::vector<MicFrame> frames;
                    JSContext* ctx = nullptr;
                    JSValue cb = JS_UNDEFINED;
                    {
                        std::lock_guard<std::mutex> lk2(g_mic.mtx);
                        g_mic.post_pending = false;
                        if (!g_mic.alive) {
                            free_mic_queue_locked();
                            return;
                        }
                        while (!g_mic.q.empty()) {
                            frames.push_back(g_mic.q.front());
                            g_mic.q.pop_front();
                        }
                        ctx = g_mic.ctx;
                        cb = JS_DupValue(ctx, g_mic.cb);
                    }
                    for (auto& fr : frames) {
                        JSValue ab = JS_NewArrayBufferCopy(
                            ctx, reinterpret_cast<uint8_t*>(fr.data), fr.samples * 2);
                        pxjs::call_js(ctx, cb, 1, &ab, TAG);
                        JS_FreeValue(ctx, ab);
                        hal_audio::big_free(fr.data);
                    }
                    JS_FreeValue(ctx, cb);
                });
            }
        }
    }
}

/**
 * 停止 mic 订阅 (须持 g_mic.mtx 调用), 返回待摘除的 sink id (-1 = 无)。
 * mic_unsubscribe 必须由调用方在锁外执行: 它在摘除最后一个 sink 时阻塞等
 * 采集任务退出, 而采集任务的 mic_on_capture 正卡在 g_mic.mtx 上 —— 持锁
 * 调用 = 互等到 hal 侧 1s 超时才解, 每次 mic 存活期间的 VM 热重启都白卡。
 */
int mic_stop_locked(JSContext* ctx) {
    const int detached = g_mic.sink_id;
    g_mic.sink_id = -1;
    if (g_mic.alive) {
        g_mic.alive = false;
        if (ctx) JS_FreeValue(ctx, g_mic.cb);
        g_mic.cb = JS_UNDEFINED;
        g_mic.ctx = nullptr;
    }
    free_mic_queue_locked();
    return detached;
}

JSValue js_mic_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    if (argc < 1 || !JS_IsObject(argv[0])) return pxjs::throw_error(ctx, "mic.start 需要选项对象");
    JSValue on_data = JS_GetPropertyStr(ctx, argv[0], "onData");
    if (!JS_IsFunction(ctx, on_data)) {
        JS_FreeValue(ctx, on_data);
        return pxjs::throw_error(ctx, "onData 必须为函数");
    }
    const int32_t rate = pxjs::opt_int_prop(ctx, argv[0], "sampleRate", 16000);
    int32_t frame_ms = pxjs::opt_int_prop(ctx, argv[0], "frameMs", 32);
    static const int32_t kRates[] = {8000, 16000, 24000, 32000, 44100, 48000};
    bool rate_ok = false;
    for (int32_t r : kRates) rate_ok = rate_ok || (r == rate);
    if (!rate_ok) {
        JS_FreeValue(ctx, on_data);
        return pxjs::throw_error(ctx, "sampleRate 仅支持 8000/16000/24000/32000/44100/48000");
    }
    if (frame_ms < 10) frame_ms = 10;
    if (frame_ms > 500) frame_ms = 500;

    int old_sink = -1;
    {
        std::lock_guard<std::mutex> lk(g_mic.mtx);
        old_sink = mic_stop_locked(ctx);  // 重复 start 视为重启
    }
    if (old_sink >= 0) hal_audio::mic_unsubscribe(old_sink);  // 锁外, 见 mic_stop_locked 注释

    std::lock_guard<std::mutex> lk(g_mic.mtx);
    g_mic.ctx = ctx;
    g_mic.cb = on_data;  // 转移引用
    g_mic.req_rate = static_cast<uint32_t>(rate);
    g_mic.frame_samples = static_cast<size_t>(rate) * static_cast<size_t>(frame_ms) / 1000;
    if (g_mic.frame_samples == 0) g_mic.frame_samples = 160;
    g_mic.rs.reset(hal_audio::device_rate(), g_mic.req_rate);
    g_mic.acc.clear();
    g_mic.acc.reserve(g_mic.frame_samples * 2);
    g_mic.dropped = 0;
    g_mic.alive = true;
    // subscribe 只注册 + 拉起采集任务, 不会阻塞等待, 持锁调用安全
    g_mic.sink_id = hal_audio::mic_subscribe(mic_on_capture);
    if (g_mic.sink_id < 0) {
        mic_stop_locked(ctx);  // sink 未注册成功, 返回值必为 -1, 无需锁外摘除
        return pxjs::throw_error(ctx, "麦克风启动失败");
    }
    return JS_UNDEFINED;
}

JSValue js_mic_stop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    int old_sink = -1;
    {
        std::lock_guard<std::mutex> lk(g_mic.mtx);
        old_sink = mic_stop_locked(ctx);
    }
    if (old_sink >= 0) hal_audio::mic_unsubscribe(old_sink);  // 锁外, 见 mic_stop_locked 注释
    return JS_UNDEFINED;
}

JSValue js_mic_active_get(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    std::lock_guard<std::mutex> lk(g_mic.mtx);
    return JS_NewBool(ctx, g_mic.alive);
}

JSValue js_mic_set_gain(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    int32_t v = 0;
    if (argc < 1 || JS_ToInt32(ctx, &v, argv[0]) != 0) return JS_EXCEPTION;
    hal_audio::set_mic_gain(v);
    return JS_UNDEFINED;
}

// ============================================================
// record
// ============================================================

void record_writer_task(void* arg) {
    auto* holder = static_cast<RecordJobPtr*>(arg);
    RecordJobPtr job = *holder;
    delete holder;

    hal_audio::WavWriter w;
    bool ok = w.open(job->path.c_str(), job->rate, 1);
    if (ok) {
        size_t off = 0;
        while (ok && off < job->len) {
            const size_t n = std::min<size_t>(4096, job->len - off);
            ok = w.write(job->pcm + off, n);
            off += n;
        }
        ok = w.finalize() && ok;
    }
    const uint32_t dur =
        static_cast<uint32_t>(static_cast<uint64_t>(job->len) * 1000 / job->rate);
    hal_audio::big_free(job->pcm);
    job->pcm = nullptr;

    jsvm::post([job, ok, dur] {
        {
            std::lock_guard<std::mutex> lk(g_reg.mtx);
            auto& v = g_reg.records;
            v.erase(std::remove(v.begin(), v.end(), job), v.end());
            if (!job->js_alive) return;
            job->js_alive = false;
        }
        JSContext* ctx = job->ctx;
        if (ok) {
            JSValue d = JS_NewInt32(ctx, static_cast<int32_t>(dur));
            JSValue r = JS_Call(ctx, job->resolve, JS_UNDEFINED, 1, &d);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, d);
        } else {
            JSValue e = JS_NewError(ctx);
            JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, "EIO"),
                                      JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
            JSValue r = JS_Call(ctx, job->reject, JS_UNDEFINED, 1, &e);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, e);
        }
        JS_FreeValue(ctx, job->resolve);
        JS_FreeValue(ctx, job->reject);
        job->resolve = job->reject = JS_UNDEFINED;
    });
    vTaskDelete(nullptr);
}

/** 采集任务上下文:录音写入 PSRAM 缓冲,满时长后转写盘任务 */
void record_on_capture(const RecordJobPtr& job, const int16_t* samples, size_t count) {
    bool full = false;
    {
        std::lock_guard<std::mutex> lk(job->io_mtx);
        if (job->capture_done.load() || !job->pcm) return;
        size_t off = 0;
        auto pull = [&](int16_t* b, size_t m) {
            const size_t c = std::min(m, count - off);
            memcpy(b, samples + off, c * 2);
            off += c;
            return c;
        };
        for (;;) {
            const size_t space = job->cap - job->len;
            if (space == 0) break;
            const size_t got =
                job->rs.produce(job->pcm + job->len, std::min<size_t>(space, 512), pull);
            if (got == 0) break;
            job->len += got;
        }
        /* exchange 保证与 guard_finalizer 只有一方执行 unsubscribe */
        if (job->len >= job->cap) full = !job->capture_done.exchange(true);
    }
    if (full) {
        hal_audio::mic_unsubscribe(job->sink_id);
        std::lock_guard<std::mutex> lk(job->io_mtx);
        if (!job->pcm) return;  // finalizer 已抢先回收 (VM 恰在此刻热重启)
        auto* holder = new RecordJobPtr(job);
        if (xTaskCreatePinnedToCore(record_writer_task, "px_rec_wr", 4096, holder, 5, nullptr,
                                    CONFIG_PX_AUDIO_TASK_CORE) == pdPASS) {
            job->writer_started = true;  // pcm 所有权移交写盘任务
        } else {
            delete holder;
            ESP_LOGE(TAG, "录音写盘任务创建失败");
            hal_audio::big_free(job->pcm);
            job->pcm = nullptr;
        }
    }
}

JSValue js_audio_record(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    if (argc < 1) return pxjs::throw_error(ctx, "record 需要文件路径");
    const char* vp = JS_ToCString(ctx, argv[0]);
    if (!vp) return JS_EXCEPTION;
    char buf[160];
    const bool ok_path = pxjs::resolve_vpath(vp, buf, sizeof(buf));
    JS_FreeCString(ctx, vp);
    if (!ok_path) return pxjs::throw_error(ctx, "路径需位于 /data 下");

    JSValueConst opts = argc > 1 ? argv[1] : JS_UNDEFINED;
    int32_t max_ms = pxjs::opt_int_prop(ctx, opts, "maxMs", 10000);
    int32_t rate = pxjs::opt_int_prop(ctx, opts, "sampleRate", 16000);
    if (max_ms < 100) max_ms = 100;
    if (max_ms > 60000) max_ms = 60000;
    if (rate < 8000 || rate > 48000) return pxjs::throw_error(ctx, "sampleRate 超出范围");

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) return promise;

    auto job = std::make_shared<RecordJob>();
    job->ctx = ctx;
    job->resolve = funcs[0];
    job->reject = funcs[1];
    job->path = buf;
    job->rate = static_cast<uint32_t>(rate);
    job->cap = static_cast<size_t>(rate) * static_cast<size_t>(max_ms) / 1000;
    job->pcm = static_cast<int16_t*>(hal_audio::big_alloc(job->cap * 2));
    job->rs.reset(hal_audio::device_rate(), job->rate);

    auto reject_now = [&](const char* msg) {
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        JSValue r = JS_Call(ctx, job->reject, JS_UNDEFINED, 1, &e);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, e);
        JS_FreeValue(ctx, job->resolve);
        JS_FreeValue(ctx, job->reject);
        return promise;
    };
    if (!job->pcm) return reject_now("ENOMEM");

    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        g_reg.records.push_back(job);
    }
    job->sink_id = hal_audio::mic_subscribe(
        [job](const int16_t* s, size_t n) { record_on_capture(job, s, n); });
    if (job->sink_id < 0) {
        {
            std::lock_guard<std::mutex> lk(g_reg.mtx);
            auto& v = g_reg.records;
            v.erase(std::remove(v.begin(), v.end(), job), v.end());
        }
        hal_audio::big_free(job->pcm);
        job->pcm = nullptr;
        return reject_now("麦克风启动失败");
    }
    return promise;
}

// ============================================================
// 音量
// ============================================================

JSValue js_audio_set_volume(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_READY(ctx);
    int32_t v = 0;
    if (argc < 1 || JS_ToInt32(ctx, &v, argv[0]) != 0) return JS_EXCEPTION;
    hal_audio::set_volume(v);
    return JS_UNDEFINED;
}

JSValue js_audio_get_volume(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewInt32(ctx, hal_audio::get_volume());
}

// ============================================================
// guard(VM 热重启收尾)
// ============================================================

void guard_finalizer(JSRuntime* rt, JSValueConst) {
    int mic_sink = -1;
    {
        std::lock_guard<std::mutex> lk(g_mic.mtx);
        mic_sink = g_mic.sink_id;
        g_mic.sink_id = -1;
        if (g_mic.alive) {
            g_mic.alive = false;
            JS_FreeValueRT(rt, g_mic.cb);
            g_mic.cb = JS_UNDEFINED;
            g_mic.ctx = nullptr;
        }
        free_mic_queue_locked();
    }
    // 锁外摘除, 见 mic_stop_locked 注释 (持锁调用会与采集任务互等 1s)
    if (mic_sink >= 0) hal_audio::mic_unsubscribe(mic_sink);

    std::lock_guard<std::mutex> lk(g_reg.mtx);
    g_reg.alive = false;
    g_reg.ctx = nullptr;
    for (auto& p : g_reg.plays) {
        if (p->alive) {
            p->alive = false;
            JS_FreeValueRT(rt, p->resolve);
            JS_FreeValueRT(rt, p->reject);
        }
        if (p->stream) p->stream->abort();
    }
    g_reg.plays.clear();
    for (auto& j : g_reg.records) {
        if (j->js_alive) {
            j->js_alive = false;
            JS_FreeValueRT(rt, j->resolve);
            JS_FreeValueRT(rt, j->reject);
        }
        /* exchange 保证与采集侧只有一方 unsubscribe */
        if (!j->capture_done.exchange(true)) {
            hal_audio::mic_unsubscribe(j->sink_id);
        }
        /* pcm 回收须在 io_mtx 内: unsubscribe 返回后 capture 快照仍可能有
         * 一次在飞写入; 写盘任务已接管 (writer_started) 则所有权归它 */
        {
            std::lock_guard<std::mutex> io(j->io_mtx);
            if (!j->writer_started && j->pcm) {
                hal_audio::big_free(j->pcm);
                j->pcm = nullptr;
            }
        }
    }
    g_reg.records.clear();
    // VM 销毁不打断正在播放的音频(由 appmgr 决定是否 stopAll)
}

// ============================================================
// 类注册与模块初始化
// ============================================================

void register_classes(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    if (g_play_handle_cid == 0) JS_NewClassID(rt, &g_play_handle_cid);
    if (g_pcm_stream_cid == 0) JS_NewClassID(rt, &g_pcm_stream_cid);
    if (g_guard_cid == 0) JS_NewClassID(rt, &g_guard_cid);

    static const JSClassDef play_def = {"PxPlayHandle", play_handle_finalizer, nullptr, nullptr,
                                        nullptr};
    static const JSClassDef stream_def = {"PxPcmStream", pcm_stream_finalizer, nullptr, nullptr,
                                          nullptr};
    static const JSClassDef guard_def = {"PxAudioGuard", guard_finalizer, nullptr, nullptr,
                                         nullptr};
    if (!JS_IsRegisteredClass(rt, g_play_handle_cid)) JS_NewClass(rt, g_play_handle_cid, &play_def);
    if (!JS_IsRegisteredClass(rt, g_pcm_stream_cid)) JS_NewClass(rt, g_pcm_stream_cid, &stream_def);
    if (!JS_IsRegisteredClass(rt, g_guard_cid)) JS_NewClass(rt, g_guard_cid, &guard_def);

    // PxPlayHandle 原型
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, proto, "stop", JS_NewCFunction(ctx, js_handle_stop, "stop", 0));
    JS_SetPropertyStr(ctx, proto, "pause", JS_NewCFunction(ctx, js_handle_pause, "pause", 0));
    JS_SetPropertyStr(ctx, proto, "resume", JS_NewCFunction(ctx, js_handle_resume, "resume", 0));
    JS_SetPropertyStr(ctx, proto, "onEnded",
                      JS_NewCFunction(ctx, js_handle_on_ended, "onEnded", 1));
    pxjs::define_getter(ctx, proto, "playing", js_handle_playing_get);
    JS_SetClassProto(ctx, g_play_handle_cid, proto);

    // PxPcmStream 原型
    JSValue sproto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, sproto, "feed", JS_NewCFunction(ctx, js_stream_feed, "feed", 1));
    JS_SetPropertyStr(ctx, sproto, "end", JS_NewCFunction(ctx, js_stream_end, "end", 0));
    JS_SetPropertyStr(ctx, sproto, "stop", JS_NewCFunction(ctx, js_stream_stop, "stop", 0));
    JS_SetPropertyStr(ctx, sproto, "buffered",
                      JS_NewCFunction(ctx, js_stream_buffered, "buffered", 0));
    JS_SetPropertyStr(ctx, sproto, "onEnded",
                      JS_NewCFunction(ctx, js_stream_on_ended, "onEnded", 1));
    JS_SetClassProto(ctx, g_pcm_stream_cid, sproto);
}

void audio_native_init(JSContext* ctx, JSValue px) {
    // 懒初始化:main/boards 若尚未初始化音频 HAL,这里按板级配置兜底一次
    if (!hal_audio::ready()) {
        const esp_err_t err = hal_audio::init_from_board();
        if (err != ESP_OK && err != ESP_ERR_NOT_SUPPORTED) {
            ESP_LOGW(TAG, "音频 HAL 初始化失败: %s(px.audio 将抛 ENOTSUP)",
                     esp_err_to_name(err));
        }
    }
    register_classes(ctx);
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        g_reg.alive = true;
        g_reg.ctx = ctx;
    }

    JSValue audio = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, audio, "setVolume",
                      JS_NewCFunction(ctx, js_audio_set_volume, "setVolume", 1));
    JS_SetPropertyStr(ctx, audio, "getVolume",
                      JS_NewCFunction(ctx, js_audio_get_volume, "getVolume", 0));
    JS_SetPropertyStr(ctx, audio, "record", JS_NewCFunction(ctx, js_audio_record, "record", 2));

    JSValue mic = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, mic, "start", JS_NewCFunction(ctx, js_mic_start, "start", 1));
    JS_SetPropertyStr(ctx, mic, "stop", JS_NewCFunction(ctx, js_mic_stop, "stop", 0));
    JS_SetPropertyStr(ctx, mic, "setGain", JS_NewCFunction(ctx, js_mic_set_gain, "setGain", 1));
    pxjs::define_getter(ctx, mic, "active", js_mic_active_get);
    JS_SetPropertyStr(ctx, audio, "mic", mic);

    JSValue player = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, player, "play", JS_NewCFunction(ctx, js_player_play, "play", 1));
    JS_SetPropertyStr(ctx, player, "playPcm",
                      JS_NewCFunction(ctx, js_player_play_pcm, "playPcm", 2));
    JS_SetPropertyStr(ctx, player, "openPcmStream",
                      JS_NewCFunction(ctx, js_player_open_pcm_stream, "openPcmStream", 1));
    JS_SetPropertyStr(ctx, player, "tone", JS_NewCFunction(ctx, js_player_tone, "tone", 3));
    JS_SetPropertyStr(ctx, player, "stopAll",
                      JS_NewCFunction(ctx, js_player_stop_all, "stopAll", 0));
    pxjs::define_getter(ctx, player, "playing", js_player_playing_get);
    JS_SetPropertyStr(ctx, audio, "player", player);

    // VM 热重启收尾 guard(不可枚举)
    JSValue guard = JS_NewObjectClass(ctx, static_cast<int>(g_guard_cid));
    JS_DefinePropertyValueStr(ctx, audio, "__pxAudioGuard", guard, 0);

    JS_SetPropertyStr(ctx, px, "audio", audio);
}

const jsvm::Module s_audio_module = {
    "audio",             // 模块名
    10,                  // hal 域优先级
    audio_native_init,   // native 初始化
    nullptr,             // 无 prelude(全部 native 实现)
};

}  // namespace

JSVM_REGISTER_MODULE(s_audio_module);
