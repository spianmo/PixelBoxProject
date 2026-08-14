/**
 * bindings_screen.cpp — px.screen JS 绑定 (JSVM_REGISTER_MODULE "screen", priority 10)
 *
 * 契约: sdk/types/pixelbox.d.ts 的 PxScreen / PxDrawTarget / PxCanvas。
 *   - px.screen 与 PxCanvas 共用一个 QuickJS class (共享全部绘图方法),
 *     以 opaque CanvasHandle 区分主屏/离屏画布;
 *   - 主屏绘图直接写 hal_display 的 PSRAM 逻辑帧缓冲并登记脏矩形;
 *   - onFrame: esp_timer 按 setFps 周期在定时器任务发起 tick, 经
 *     jsvm::post 投递到 JS 线程执行回调 (禁止跨线程直接调 JS_*),
 *     回调返回后自动 hal_display::flush();
 *   - createAnimation / loadGif 的公开包装在 prelude_screen.js (纯 JS),
 *     依赖本文件的内部助手 __decodeImage / __loadGifFrames / __isCanvas。
 *
 * 内存: 画布像素与解码缓冲一律优先 PSRAM (gfx::create_surface 内部处理)。
 */
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "quickjs.h"

#include "hal_common/px_alloc.h"
#include "hal_display/fonts.h"
#include "hal_display/gfx.hpp"
#include "hal_display/hal_display.hpp"
#include "hal_display/image_decode.hpp"
#include "jsvm/jsvm.hpp"

#include "js_util.hpp"
#include "path_resolve.hpp"

namespace {

constexpr const char *TAG = "px.screen";

using pxscr::throw_error;

/* ------------------------------------------------------------
 * 画布句柄 (px.screen 与 PxCanvas 共用 class)
 * ------------------------------------------------------------ */

struct CanvasHandle {
    gfx::Surface surf;  // 离屏画布拥有像素; 主屏时不使用 (动态取 hal 帧缓冲)
    bool is_screen = false;
    bool disposed = false;
};

JSClassID g_canvas_cid;  // 惰性分配, VM 重启保持

/** 从 this 解析绘图目标; 失败返回 nullptr (已抛异常) */
gfx::Surface *target_of(JSContext *ctx, JSValueConst this_val, CanvasHandle **out_handle)
{
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque2(ctx, this_val, g_canvas_cid));
    if (!h) return nullptr;  // JS_GetOpaque2 已抛 TypeError
    if (out_handle) *out_handle = h;
    if (h->is_screen) {
        if (!hal_display::ready()) {
            throw_error(ctx, "ENOTSUP");
            return nullptr;
        }
        return &hal_display::framebuffer();
    }
    if (h->disposed) {
        throw_error(ctx, "画布已释放 (dispose 后不可再绘制)");
        return nullptr;
    }
    return &h->surf;
}

/** 主屏绘图后登记脏矩形 */
inline void mark_if_screen(const CanvasHandle *h, int x, int y, int w, int h_)
{
    if (h->is_screen) hal_display::mark_dirty(x, y, w, h_);
}

/* ------------------------------------------------------------
 * onFrame 帧循环
 * ------------------------------------------------------------ */

struct FrameSub {
    uint32_t id;
    JSValue fn;  // 已 dup, 仅 JS 线程操作
};

std::vector<FrameSub> g_frame_subs;
uint32_t g_next_sub_id = 1;
esp_timer_handle_t g_frame_timer = nullptr;
std::atomic<bool> g_tick_pending{false};
int g_fps = 30;
int64_t g_last_tick_us = 0;
JSContext *g_ctx = nullptr;  // 当前 VM 的 ctx (init 时更新, teardown 清空)

void frame_tick_js();  // 前置声明

void frame_timer_cb(void *)
{
    // esp_timer 任务上下文: 只做投递; JS 忙时跳帧防事件队列堆积
    if (g_tick_pending.exchange(true)) return;
    jsvm::post([] { frame_tick_js(); });
}

void ensure_timer_started()
{
    if (!g_frame_timer) {
        const esp_timer_create_args_t args = {
            .callback = frame_timer_cb,
            .arg = nullptr,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "px_frame",
            .skip_unhandled_events = true,
        };
        if (esp_timer_create(&args, &g_frame_timer) != ESP_OK) {
            ESP_LOGE(TAG, "帧定时器创建失败");
            return;
        }
    }
    if (!esp_timer_is_active(g_frame_timer)) {
        g_last_tick_us = esp_timer_get_time();
        esp_timer_start_periodic(g_frame_timer, 1000000 / g_fps);
    }
}

void stop_timer_if_idle()
{
    if (g_frame_subs.empty() && g_frame_timer && esp_timer_is_active(g_frame_timer)) {
        esp_timer_stop(g_frame_timer);
    }
}

/** JS 线程: 执行一帧回调并自动 flush */
void frame_tick_js()
{
    g_tick_pending.store(false);
    JSContext *ctx = g_ctx;
    if (!ctx || g_frame_subs.empty()) return;

    const int64_t now = esp_timer_get_time();
    double dt = static_cast<double>(now - g_last_tick_us) / 1000.0;
    g_last_tick_us = now;
    if (dt <= 0 || dt > 10000) dt = 1000.0 / g_fps;

    // 拷贝一份列表并 dup: 回调内 unsubscribe (会 free 原引用) 不影响本轮遍历
    std::vector<JSValue> fns;
    fns.reserve(g_frame_subs.size());
    for (auto &sub : g_frame_subs) fns.push_back(JS_DupValue(ctx, sub.fn));
    for (JSValue fn : fns) {
        JSValue arg = JS_NewFloat64(ctx, dt);
        JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
        if (JS_IsException(ret)) jsvm::dump_error(ctx);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, arg);
        JS_FreeValue(ctx, fn);
    }
    // 回调返回后自动提交 (d.ts onFrame 约定)
    hal_display::flush();
}

/** VM 拆除: 释放全部回调引用并停表 (JS 线程内, ctx 仍有效) */
void screen_teardown(JSContext *ctx)
{
    for (auto &sub : g_frame_subs) JS_FreeValue(ctx, sub.fn);
    g_frame_subs.clear();
    if (g_frame_timer && esp_timer_is_active(g_frame_timer)) esp_timer_stop(g_frame_timer);
    g_tick_pending.store(false);
    g_ctx = nullptr;
}

/* ------------------------------------------------------------
 * class 定义 (finalizer 释放画布像素)
 * ------------------------------------------------------------ */

void canvas_finalizer(JSRuntime *, JSValue val)
{
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque(val, g_canvas_cid));
    if (!h) return;
    if (!h->is_screen && !h->disposed) gfx::destroy_surface(&h->surf);
    delete h;
}

const JSClassDef kCanvasClassDef = {
    "PxCanvas",
    canvas_finalizer,
    nullptr,
    nullptr,
    nullptr,
};

/** 包一个离屏画布对象 (接管 surf 所有权); 失败释放 surf 并抛异常 */
JSValue wrap_canvas(JSContext *ctx, gfx::Surface surf)
{
    JSValue obj = JS_NewObjectClass(ctx, static_cast<int>(g_canvas_cid));
    if (JS_IsException(obj)) {
        gfx::destroy_surface(&surf);
        return obj;
    }
    auto *h = new (std::nothrow) CanvasHandle;
    if (!h) {
        gfx::destroy_surface(&surf);
        JS_FreeValue(ctx, obj);
        return throw_error(ctx, "内存不足");
    }
    h->surf = surf;
    JS_SetOpaque(obj, h);
    return obj;
}

/* ------------------------------------------------------------
 * 图片源解析: 路径 / 二进制 / 画布 → 解码结果
 * ------------------------------------------------------------ */

/** 读文件到 PSRAM 缓冲; 调用方 heap_caps_free */
uint8_t *read_file_psram(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return nullptr;
    fseek(f, 0, SEEK_END);
    const long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) {
        fclose(f);
        return nullptr;
    }
    /* 大文件缓冲: PSRAM 优先, 无 PSRAM 目标 (C6) 自动落内部堆 */
    auto *buf = static_cast<uint8_t *>(px_alloc_prefer_psram(static_cast<size_t>(n)));
    if (!buf) {
        fclose(f);
        return nullptr;
    }
    const size_t rd = fread(buf, 1, static_cast<size_t>(n), f);
    fclose(f);
    if (rd != static_cast<size_t>(n)) {
        heap_caps_free(buf);
        return nullptr;
    }
    *out_len = rd;
    return buf;
}

struct SrcImage {
    // 三选一: 解码产物 (decoded=true, 需释放) 或引用他人画布 (仅借用)
    img::Decoded dec{};
    const gfx::Surface *surf = nullptr;
    bool decoded = false;
    bool ok = false;
};

/** GIF 首帧 sink */
bool first_frame_sink(void *user, gfx::Surface frame, int)
{
    auto *si = static_cast<SrcImage *>(user);
    si->dec.surf = frame;
    si->decoded = true;
    si->ok = true;
    return false;  // 只要第一帧
}

/**
 * 解析 drawImage 的 src 参数。失败时已抛 JS 异常。
 * 注意: 返回中的指针在当次调用内有效 (二进制入参的底层 buffer 不被持有)。
 */
SrcImage resolve_src_image(JSContext *ctx, JSValueConst src)
{
    SrcImage out;
    // 1) 画布
    if (JS_GetOpaque(src, g_canvas_cid)) {
        auto *h = static_cast<CanvasHandle *>(JS_GetOpaque(src, g_canvas_cid));
        if (h->is_screen) {
            out.surf = hal_display::ready() ? &hal_display::framebuffer() : nullptr;
        } else if (!h->disposed) {
            out.surf = &h->surf;
        }
        if (!out.surf) {
            throw_error(ctx, "画布已释放或屏幕不可用");
            return out;
        }
        out.ok = true;
        return out;
    }

    const uint8_t *data = nullptr;
    size_t len = 0;
    uint8_t *file_buf = nullptr;

    // 2) 路径字符串
    if (JS_IsString(src)) {
        const char *vpath = JS_ToCString(ctx, src);
        if (!vpath) return out;
        char real[128];
        const bool resolved = pxscr::resolve_vpath(vpath, real, sizeof(real));
        JS_FreeCString(ctx, vpath);
        if (!resolved) {
            throw_error(ctx, "非法图片路径 (仅支持 /app、/data 下的文件)");
            return out;
        }
        file_buf = read_file_psram(real, &len);
        if (!file_buf) {
            throw_error(ctx, "图片文件读取失败");
            return out;
        }
        data = file_buf;
    } else {
        // 3) 二进制 (ArrayBuffer | Uint8Array)
        if (!jsvm::get_binary(ctx, src, &data, &len)) return out;  // 已抛 TypeError
    }

    bool ok;
    if (img::sniff(data, len) == img::Format::Gif) {
        // drawImage 收到 GIF: 取首帧
        ok = img::decode_gif(data, len, 1, first_frame_sink, &out) >= 1 && out.ok;
    } else {
        ok = img::decode(data, len, &out.dec);
        out.decoded = ok;
    }
    if (file_buf) heap_caps_free(file_buf);
    if (!ok) {
        out.ok = false;
        throw_error(ctx, "图片解码失败 (支持 PNG/JPEG/GIF)");
        return out;
    }
    out.surf = &out.dec.surf;
    out.ok = true;
    return out;
}

void release_src_image(SrcImage *si)
{
    if (si->decoded) img::free_decoded(&si->dec);
    si->surf = nullptr;
    si->decoded = false;
}

/* ------------------------------------------------------------
 * 文本样式解析
 * ------------------------------------------------------------ */

bool parse_text_style(JSContext *ctx, JSValueConst style, gfx::TextStyle *out)
{
    out->font = pxfonts_get(PXFONT_PIXEL8);
    out->c565 = gfx::to565(0xFFFFFF);
    out->scale = 1;
    out->align = gfx::Align::Left;
    if (JS_IsUndefined(style) || JS_IsNull(style)) return out->font != nullptr;
    if (!JS_IsObject(style)) {
        throw_error(ctx, "style 需为对象");
        return false;
    }
    JSValue v = JS_GetPropertyStr(ctx, style, "color");
    if (!JS_IsUndefined(v)) {
        uint32_t c = 0xFFFFFF;
        if (JS_ToUint32(ctx, &c, v) != 0) {
            JS_FreeValue(ctx, v);
            return false;
        }
        out->c565 = gfx::to565(c);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, style, "font");
    if (JS_IsString(v)) {
        const char *name = JS_ToCString(ctx, v);
        if (name) {
            const pxfont_t *f = pxfonts_by_name(name);
            if (f) out->font = f;  // 未知字体名回退 pixel8 (见 README)
            JS_FreeCString(ctx, name);
        }
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, style, "smooth");
    if (!JS_IsUndefined(v)) {
        out->smooth = JS_ToBool(ctx, v) > 0;
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, style, "scale");
    if (!JS_IsUndefined(v)) {
        int32_t sc = 1;
        if (JS_ToInt32(ctx, &sc, v) != 0) {
            JS_FreeValue(ctx, v);
            return false;
        }
        out->scale = sc < 1 ? 1 : (sc > 8 ? 8 : sc);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, style, "align");
    if (JS_IsString(v)) {
        const char *a = JS_ToCString(ctx, v);
        if (a) {
            if (strcmp(a, "center") == 0) out->align = gfx::Align::Center;
            else if (strcmp(a, "right") == 0) out->align = gfx::Align::Right;
            JS_FreeCString(ctx, a);
        }
    }
    JS_FreeValue(ctx, v);

    if (!out->font) {
        throw_error(ctx, "内置字体数据损坏");
        return false;
    }
    return true;
}

/* ------------------------------------------------------------
 * 共享绘图方法 (screen 与 canvas)
 * ------------------------------------------------------------ */

JSValue js_clear(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    uint32_t color = 0x000000;
    if (argc >= 1 && !JS_IsUndefined(argv[0]) && JS_ToUint32(ctx, &color, argv[0]) != 0)
        return JS_EXCEPTION;
    gfx::clear(*s, gfx::to565(color));
    mark_if_screen(h, 0, 0, s->w, s->h);
    return JS_UNDEFINED;
}

JSValue js_set_pixel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    int32_t x, y;
    uint32_t color;
    if (argc < 3 || !pxscr::get_i32(ctx, argv[0], &x) || !pxscr::get_i32(ctx, argv[1], &y) ||
        JS_ToUint32(ctx, &color, argv[2]) != 0)
        return JS_EXCEPTION;
    gfx::set_pixel(*s, x, y, gfx::to565(color));
    mark_if_screen(h, x, y, 1, 1);
    return JS_UNDEFINED;
}

JSValue js_get_pixel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    gfx::Surface *s = target_of(ctx, this_val, nullptr);
    if (!s) return JS_EXCEPTION;
    int32_t x, y;
    if (argc < 2 || !pxscr::get_i32(ctx, argv[0], &x) || !pxscr::get_i32(ctx, argv[1], &y))
        return JS_EXCEPTION;
    return JS_NewUint32(ctx, gfx::to888(gfx::get_pixel(*s, x, y)));
}

JSValue js_draw_line(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    int32_t x0, y0, x1, y1;
    uint32_t color;
    if (argc < 5 || !pxscr::get_i32(ctx, argv[0], &x0) || !pxscr::get_i32(ctx, argv[1], &y0) ||
        !pxscr::get_i32(ctx, argv[2], &x1) || !pxscr::get_i32(ctx, argv[3], &y1) ||
        JS_ToUint32(ctx, &color, argv[4]) != 0)
        return JS_EXCEPTION;
    gfx::draw_line(*s, x0, y0, x1, y1, gfx::to565(color));
    const int bx = x0 < x1 ? x0 : x1, by = y0 < y1 ? y0 : y1;
    mark_if_screen(h, bx, by, (x0 > x1 ? x0 : x1) - bx + 1, (y0 > y1 ? y0 : y1) - by + 1);
    return JS_UNDEFINED;
}

template <void (*Fn)(gfx::Surface &, int, int, int, int, uint16_t)>
JSValue js_rect_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    int32_t x, y, w, hh;
    uint32_t color;
    if (argc < 5 || !pxscr::get_i32(ctx, argv[0], &x) || !pxscr::get_i32(ctx, argv[1], &y) ||
        !pxscr::get_i32(ctx, argv[2], &w) || !pxscr::get_i32(ctx, argv[3], &hh) ||
        JS_ToUint32(ctx, &color, argv[4]) != 0)
        return JS_EXCEPTION;
    Fn(*s, x, y, w, hh, gfx::to565(color));
    mark_if_screen(h, x, y, w, hh);
    return JS_UNDEFINED;
}

template <void (*Fn)(gfx::Surface &, int, int, int, uint16_t)>
JSValue js_circle_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    int32_t x, y, r;
    uint32_t color;
    if (argc < 4 || !pxscr::get_i32(ctx, argv[0], &x) || !pxscr::get_i32(ctx, argv[1], &y) ||
        !pxscr::get_i32(ctx, argv[2], &r) || JS_ToUint32(ctx, &color, argv[3]) != 0)
        return JS_EXCEPTION;
    Fn(*s, x, y, r, gfx::to565(color));
    mark_if_screen(h, x - r, y - r, 2 * r + 1, 2 * r + 1);
    return JS_UNDEFINED;
}

JSValue js_draw_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    if (argc < 3) return throw_error(ctx, "drawText(text, x, y, style?) 参数不足");
    int32_t x, y;
    if (!pxscr::get_i32(ctx, argv[1], &x) || !pxscr::get_i32(ctx, argv[2], &y))
        return JS_EXCEPTION;
    gfx::TextStyle st;
    if (!parse_text_style(ctx, argc >= 4 ? argv[3] : JS_UNDEFINED, &st)) return JS_EXCEPTION;
    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    gfx::draw_text(*s, text, x, y, st);
    if (h->is_screen) {
        int tw = 0, th = 0;
        gfx::measure_text(text, st, &tw, &th);
        int bx = x;
        if (st.align == gfx::Align::Center) bx = x - tw / 2;
        else if (st.align == gfx::Align::Right) bx = x - tw;
        hal_display::mark_dirty(bx, y, tw, th);
    }
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

JSValue js_measure_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    gfx::Surface *s = target_of(ctx, this_val, nullptr);
    if (!s) return JS_EXCEPTION;
    if (argc < 1) return throw_error(ctx, "measureText(text, style?) 参数不足");
    gfx::TextStyle st;
    if (!parse_text_style(ctx, argc >= 2 ? argv[1] : JS_UNDEFINED, &st)) return JS_EXCEPTION;
    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    int w = 0, hh = 0;
    gfx::measure_text(text, st, &w, &hh);
    JS_FreeCString(ctx, text);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "width", JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, obj, "height", JS_NewInt32(ctx, hh));
    return obj;
}

JSValue js_draw_image(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    CanvasHandle *h = nullptr;
    gfx::Surface *s = target_of(ctx, this_val, &h);
    if (!s) return JS_EXCEPTION;
    if (argc < 3) return throw_error(ctx, "drawImage(src, x, y, opts?) 参数不足");
    int32_t x, y;
    if (!pxscr::get_i32(ctx, argv[1], &x) || !pxscr::get_i32(ctx, argv[2], &y))
        return JS_EXCEPTION;

    gfx::BlitOpts bo;
    int32_t color_key = -1;
    if (argc >= 4 && JS_IsObject(argv[3])) {
        JSValueConst o = argv[3];
        // xtensa GCC14 上 int32_t 为 long, 与 BlitOpts 的 int 字段指针不兼容,
        // 先读入 int32_t 临时量再赋值 (值域一致, 仅类型别名差异)
        int32_t dw = bo.dw, dh = bo.dh, sx = bo.sx, sy = bo.sy, sw = bo.sw, sh = bo.sh;
        if (!pxscr::opt_prop_i32(ctx, o, "w", &dw) ||
            !pxscr::opt_prop_i32(ctx, o, "h", &dh) ||
            !pxscr::opt_prop_i32(ctx, o, "sx", &sx) ||
            !pxscr::opt_prop_i32(ctx, o, "sy", &sy) ||
            !pxscr::opt_prop_i32(ctx, o, "sw", &sw) ||
            !pxscr::opt_prop_i32(ctx, o, "sh", &sh))
            return JS_EXCEPTION;
        bo.dw = static_cast<int>(dw);
        bo.dh = static_cast<int>(dh);
        bo.sx = static_cast<int>(sx);
        bo.sy = static_cast<int>(sy);
        bo.sw = static_cast<int>(sw);
        bo.sh = static_cast<int>(sh);
        JSValue kv = JS_GetPropertyStr(ctx, o, "colorKey");
        if (!JS_IsUndefined(kv) && !JS_IsNull(kv)) {
            uint32_t key888 = 0;
            if (JS_ToUint32(ctx, &key888, kv) != 0) {
                JS_FreeValue(ctx, kv);
                return JS_EXCEPTION;
            }
            color_key = gfx::to565(key888);
        }
        JS_FreeValue(ctx, kv);
    }
    bo.color_key = color_key;

    SrcImage si = resolve_src_image(ctx, argv[0]);
    if (!si.ok) return JS_EXCEPTION;
    // 自绘自身保护: 源即目标时行为未定义, 拒绝
    if (si.surf == s) {
        release_src_image(&si);
        return throw_error(ctx, "drawImage 的源与目标不能是同一表面");
    }
    if (si.decoded && si.dec.alpha) bo.alpha = si.dec.alpha;
    gfx::blit(*s, *si.surf, x, y, bo);

    if (h->is_screen) {
        // 计算实际目标尺寸登记脏区 (与 blit 内部默认规则一致)
        int sw = bo.sw < 0 ? si.surf->w : bo.sw;
        int sh = bo.sh < 0 ? si.surf->h : bo.sh;
        const int dw = bo.dw < 0 ? sw : bo.dw;
        const int dh = bo.dh < 0 ? sh : bo.dh;
        hal_display::mark_dirty(x, y, dw, dh);
    }
    release_src_image(&si);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------
 * width/height getter (screen 动态取旋转后尺寸; canvas 取表面尺寸)
 * ------------------------------------------------------------ */

JSValue js_width_get(JSContext *ctx, JSValueConst this_val, int, JSValueConst *)
{
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque2(ctx, this_val, g_canvas_cid));
    if (!h) return JS_EXCEPTION;
    return JS_NewInt32(ctx, h->is_screen ? hal_display::width() : h->surf.w);
}

JSValue js_height_get(JSContext *ctx, JSValueConst this_val, int, JSValueConst *)
{
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque2(ctx, this_val, g_canvas_cid));
    if (!h) return JS_EXCEPTION;
    return JS_NewInt32(ctx, h->is_screen ? hal_display::height() : h->surf.h);
}

/* ------------------------------------------------------------
 * canvas 专属: dispose / __isCanvas
 * ------------------------------------------------------------ */

JSValue js_canvas_dispose(JSContext *ctx, JSValueConst this_val, int, JSValueConst *)
{
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque2(ctx, this_val, g_canvas_cid));
    if (!h) return JS_EXCEPTION;
    if (h->is_screen) return throw_error(ctx, "主屏不可 dispose");
    if (!h->disposed) {
        gfx::destroy_surface(&h->surf);
        h->disposed = true;
    }
    return JS_UNDEFINED;
}

JSValue js_is_canvas(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_FALSE;
    auto *h = static_cast<CanvasHandle *>(JS_GetOpaque(argv[0], g_canvas_cid));
    (void)ctx;
    return h && !h->is_screen ? JS_TRUE : JS_FALSE;
}

/* ------------------------------------------------------------
 * screen 专属方法
 * ------------------------------------------------------------ */

JSValue js_set_brightness(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    int32_t p = 0;
    if (argc < 1 || !pxscr::get_i32(ctx, argv[0], &p)) return JS_EXCEPTION;
    hal_display::set_brightness(p);
    return JS_UNDEFINED;
}

JSValue js_get_brightness(JSContext *ctx, JSValueConst, int, JSValueConst *)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    return JS_NewInt32(ctx, hal_display::get_brightness());
}

JSValue js_set_power(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    if (argc < 1) return throw_error(ctx, "setPower(on) 参数不足");
    hal_display::set_power(JS_ToBool(ctx, argv[0]) != 0);
    return JS_UNDEFINED;
}

JSValue js_set_rotation(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    int32_t deg = 0;
    if (argc < 1 || !pxscr::get_i32(ctx, argv[0], &deg)) return JS_EXCEPTION;
    if (hal_display::set_rotation(deg) != ESP_OK)
        return throw_error(ctx, "setRotation 仅接受 0/90/180/270");
    return JS_UNDEFINED;
}

JSValue js_flush(JSContext *ctx, JSValueConst, int, JSValueConst *)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    hal_display::flush();
    return JS_UNDEFINED;
}

JSValue js_set_fps(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    int32_t fps = 30;
    if (argc < 1 || !pxscr::get_i32(ctx, argv[0], &fps)) return JS_EXCEPTION;
    g_fps = fps < 1 ? 1 : (fps > 60 ? 60 : fps);
    if (g_frame_timer && esp_timer_is_active(g_frame_timer)) {
        esp_timer_stop(g_frame_timer);
        esp_timer_start_periodic(g_frame_timer, 1000000 / g_fps);
    }
    return JS_UNDEFINED;
}

/** onFrame 的退订闭包 (func_data[0] = 订阅 id) */
JSValue js_frame_unsub(JSContext *ctx, JSValueConst, int, JSValueConst *, int, JSValue *func_data)
{
    uint32_t id = 0;
    JS_ToUint32(ctx, &id, func_data[0]);
    for (size_t i = 0; i < g_frame_subs.size(); ++i) {
        if (g_frame_subs[i].id == id) {
            JS_FreeValue(ctx, g_frame_subs[i].fn);
            g_frame_subs.erase(g_frame_subs.begin() + static_cast<long>(i));
            break;
        }
    }
    stop_timer_if_idle();
    return JS_UNDEFINED;
}

JSValue js_on_frame(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (!hal_display::ready()) return throw_error(ctx, "ENOTSUP");
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return throw_error(ctx, "onFrame(cb) 需要函数参数");
    const uint32_t id = g_next_sub_id++;
    g_frame_subs.push_back({id, JS_DupValue(ctx, argv[0])});
    ensure_timer_started();
    JSValue data = JS_NewUint32(ctx, id);
    JSValue unsub = JS_NewCFunctionData(ctx, js_frame_unsub, 0, 0, 1, &data);
    JS_FreeValue(ctx, data);
    return unsub;
}

JSValue js_create_canvas(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    int32_t w = 0, h = 0;
    if (argc < 2 || !pxscr::get_i32(ctx, argv[0], &w) || !pxscr::get_i32(ctx, argv[1], &h))
        return JS_EXCEPTION;
    if (w <= 0 || h <= 0 || w > 2048 || h > 2048)
        return throw_error(ctx, "createCanvas 尺寸需在 1..2048");
    gfx::Surface surf;
    if (!gfx::create_surface(&surf, w, h)) return throw_error(ctx, "画布内存分配失败 (PSRAM)");
    return wrap_canvas(ctx, surf);
}

/** __decodeImage(src): 路径/二进制/画布 → 新 PxCanvas (画布入参会被拷贝) */
JSValue js_decode_image(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (argc < 1) return throw_error(ctx, "__decodeImage(src) 参数不足");
    SrcImage si = resolve_src_image(ctx, argv[0]);
    if (!si.ok) return JS_EXCEPTION;

    // 画布入参 → 拷贝一份 (动画帧需要独立所有权)
    if (!si.decoded) {
        gfx::Surface copy;
        if (!gfx::create_surface(&copy, si.surf->w, si.surf->h)) {
            release_src_image(&si);
            return throw_error(ctx, "画布内存分配失败 (PSRAM)");
        }
        gfx::blit(copy, *si.surf, 0, 0, {});
        release_src_image(&si);
        return wrap_canvas(ctx, copy);
    }
    // 解码产物 → 直接移交表面所有权 (alpha 掩码烧不进画布, 丢弃; 见 README)
    gfx::Surface surf = si.dec.surf;
    si.dec.surf = gfx::Surface{};
    release_src_image(&si);
    return wrap_canvas(ctx, surf);
}

/* GIF 帧收集 (限制总内存 4MB, 防呆) */
struct GifFrames {
    std::vector<gfx::Surface> frames;
    std::vector<int> delays;
    size_t bytes = 0;
    bool remove_background = false;
    int background_threshold = 44;
    bool background_failed = false;
};

/** 完整比较两张 RGB565 帧，识别 GIF 编码器附加的重复末帧。 */
bool gif_frames_equal(const gfx::Surface &a, const gfx::Surface &b)
{
    if (!a.px || !b.px || a.w != b.w || a.h != b.h) return false;
    const size_t row_bytes = static_cast<size_t>(a.w) * sizeof(uint16_t);
    for (int y = 0; y < a.h; ++y) {
        if (memcmp(a.row(y), b.row(y), row_bytes) != 0) return false;
    }
    return true;
}

/** 仅把与帧边界四连通的近背景色像素改为黑色。 */
bool remove_gif_exterior_background(gfx::Surface &frame, int threshold)
{
    if (!frame.px || frame.w <= 0 || frame.h <= 0) return false;
    const size_t count = static_cast<size_t>(frame.w) * frame.h;
    auto *outside = static_cast<uint8_t *>(px_alloc_prefer_psram(count));
    auto *queue = static_cast<int32_t *>(px_alloc_prefer_psram(count * sizeof(int32_t)));
    if (!outside || !queue) {
        if (outside) heap_caps_free(outside);
        if (queue) heap_caps_free(queue);
        return false;
    }
    memset(outside, 0, count);

    const uint32_t corners[4] = {
        gfx::to888(frame.row(0)[0]),
        gfx::to888(frame.row(0)[frame.w - 1]),
        gfx::to888(frame.row(frame.h - 1)[0]),
        gfx::to888(frame.row(frame.h - 1)[frame.w - 1]),
    };
    int background[3] = {0, 0, 0};
    for (const uint32_t color : corners) {
        background[0] += static_cast<int>((color >> 16) & 0xFF);
        background[1] += static_cast<int>((color >> 8) & 0xFF);
        background[2] += static_cast<int>(color & 0xFF);
    }
    for (int &channel : background) channel /= 4;
    const int threshold_sq = threshold * threshold;
    size_t head = 0, tail = 0;

    auto enqueue = [&](int pixel_index) {
        if (outside[pixel_index]) return;
        const int x = pixel_index % frame.w;
        const int y = pixel_index / frame.w;
        const uint32_t color = gfx::to888(frame.row(y)[x]);
        const int dr = static_cast<int>((color >> 16) & 0xFF) - background[0];
        const int dg = static_cast<int>((color >> 8) & 0xFF) - background[1];
        const int db = static_cast<int>(color & 0xFF) - background[2];
        if (dr * dr + dg * dg + db * db > threshold_sq) return;
        outside[pixel_index] = 1;
        queue[tail++] = pixel_index;
    };

    for (int x = 0; x < frame.w; ++x) {
        enqueue(x);
        enqueue((frame.h - 1) * frame.w + x);
    }
    for (int y = 1; y + 1 < frame.h; ++y) {
        enqueue(y * frame.w);
        enqueue(y * frame.w + frame.w - 1);
    }
    while (head < tail) {
        const int pixel_index = queue[head++];
        const int x = pixel_index % frame.w;
        const int y = pixel_index / frame.w;
        if (x > 0) enqueue(pixel_index - 1);
        if (x + 1 < frame.w) enqueue(pixel_index + 1);
        if (y > 0) enqueue(pixel_index - frame.w);
        if (y + 1 < frame.h) enqueue(pixel_index + frame.w);
    }

    const uint16_t black = gfx::to565(0x000000);
    for (size_t i = 0; i < count; ++i) {
        if (outside[i]) frame.px[i] = black;
    }
    heap_caps_free(queue);
    heap_caps_free(outside);
    return true;
}

bool gif_collect_sink(void *user, gfx::Surface frame, int delay_ms)
{
    auto *c = static_cast<GifFrames *>(user);
    if (c->remove_background &&
        !remove_gif_exterior_background(frame, c->background_threshold)) {
        gfx::destroy_surface(&frame);
        c->background_failed = true;
        return false;
    }
    c->frames.push_back(frame);
    c->delays.push_back(delay_ms);
    c->bytes += static_cast<size_t>(frame.w) * frame.h * 2;
    return c->bytes < 4 * 1024 * 1024;
}

/** __loadGifFrames(src): → { frames: PxCanvas[], delays: number[] } */
JSValue js_load_gif_frames(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (argc < 1) return throw_error(ctx, "__loadGifFrames(src) 参数不足");

    bool remove_background = false;
    int32_t background_threshold = 44;
    if (argc >= 2 && JS_IsObject(argv[1]) && !JS_IsNull(argv[1])) {
        JSValue remove_value = JS_GetPropertyStr(ctx, argv[1], "removeBackground");
        if (!JS_IsUndefined(remove_value)) remove_background = JS_ToBool(ctx, remove_value) > 0;
        JS_FreeValue(ctx, remove_value);

        JSValue threshold_value = JS_GetPropertyStr(ctx, argv[1], "backgroundThreshold");
        if (!JS_IsUndefined(threshold_value) &&
            JS_ToInt32(ctx, &background_threshold, threshold_value) != 0) {
            JS_FreeValue(ctx, threshold_value);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, threshold_value);
        if (background_threshold < 0 || background_threshold > 255) {
            return JS_ThrowRangeError(ctx, "backgroundThreshold 须为 0-255");
        }
    }

    const uint8_t *data = nullptr;
    size_t len = 0;
    uint8_t *file_buf = nullptr;
    if (JS_IsString(argv[0])) {
        const char *vpath = JS_ToCString(ctx, argv[0]);
        if (!vpath) return JS_EXCEPTION;
        char real[128];
        const bool resolved = pxscr::resolve_vpath(vpath, real, sizeof(real));
        JS_FreeCString(ctx, vpath);
        if (!resolved) return throw_error(ctx, "非法 GIF 路径");
        file_buf = read_file_psram(real, &len);
        if (!file_buf) return throw_error(ctx, "GIF 文件读取失败");
        data = file_buf;
    } else if (!jsvm::get_binary(ctx, argv[0], &data, &len)) {
        return JS_EXCEPTION;
    }

    GifFrames gc;
    gc.remove_background = remove_background;
    gc.background_threshold = background_threshold;
    const int n = img::decode_gif(data, len, 256, gif_collect_sink, &gc);
    if (file_buf) heap_caps_free(file_buf);
    if (n <= 0 || gc.background_failed || gc.frames.empty()) {
        for (auto &f : gc.frames) gfx::destroy_surface(&f);
        return throw_error(ctx, gc.background_failed ? "GIF 去背景内存不足" : "GIF 解码失败");
    }

    // 无限循环 GIF 常把首帧复制到末尾；保留一份即可避免边界停顿。
    if (gc.frames.size() > 1 && gif_frames_equal(gc.frames.front(), gc.frames.back())) {
        gfx::destroy_surface(&gc.frames.back());
        gc.frames.pop_back();
        gc.delays.pop_back();
    }

    JSValue frames = JS_NewArray(ctx);
    JSValue delays = JS_NewArray(ctx);
    for (size_t i = 0; i < gc.frames.size(); ++i) {
        JSValue c = wrap_canvas(ctx, gc.frames[i]);  // 所有权移交 (失败内部已释放)
        if (JS_IsException(c)) {
            for (size_t j = i + 1; j < gc.frames.size(); ++j) gfx::destroy_surface(&gc.frames[j]);
            JS_FreeValue(ctx, frames);
            JS_FreeValue(ctx, delays);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, frames, static_cast<uint32_t>(i), c);
        JS_SetPropertyUint32(ctx, delays, static_cast<uint32_t>(i),
                             JS_NewInt32(ctx, gc.delays[i]));
    }
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "frames", frames);
    JS_SetPropertyStr(ctx, obj, "delays", delays);
    return obj;
}

/* ------------------------------------------------------------
 * 模块初始化
 * ------------------------------------------------------------ */

/** 共享绘图方法注册到任意对象 (screen 对象与 canvas 原型) */
void register_draw_methods(JSContext *ctx, JSValue obj)
{
    JS_SetPropertyStr(ctx, obj, "clear", JS_NewCFunction(ctx, js_clear, "clear", 1));
    JS_SetPropertyStr(ctx, obj, "setPixel", JS_NewCFunction(ctx, js_set_pixel, "setPixel", 3));
    JS_SetPropertyStr(ctx, obj, "getPixel", JS_NewCFunction(ctx, js_get_pixel, "getPixel", 2));
    JS_SetPropertyStr(ctx, obj, "drawLine", JS_NewCFunction(ctx, js_draw_line, "drawLine", 5));
    JS_SetPropertyStr(ctx, obj, "drawRect",
                      JS_NewCFunction(ctx, js_rect_op<gfx::draw_rect>, "drawRect", 5));
    JS_SetPropertyStr(ctx, obj, "fillRect",
                      JS_NewCFunction(ctx, js_rect_op<gfx::fill_rect>, "fillRect", 5));
    JS_SetPropertyStr(ctx, obj, "drawCircle",
                      JS_NewCFunction(ctx, js_circle_op<gfx::draw_circle>, "drawCircle", 4));
    JS_SetPropertyStr(ctx, obj, "fillCircle",
                      JS_NewCFunction(ctx, js_circle_op<gfx::fill_circle>, "fillCircle", 4));
    JS_SetPropertyStr(ctx, obj, "drawText", JS_NewCFunction(ctx, js_draw_text, "drawText", 4));
    JS_SetPropertyStr(ctx, obj, "measureText",
                      JS_NewCFunction(ctx, js_measure_text, "measureText", 2));
    JS_SetPropertyStr(ctx, obj, "drawImage", JS_NewCFunction(ctx, js_draw_image, "drawImage", 4));
    pxscr::define_getter(ctx, obj, "width", js_width_get);
    pxscr::define_getter(ctx, obj, "height", js_height_get);
}

void screen_native_init(JSContext *ctx, JSValue px)
{
    g_ctx = ctx;

    // 显示硬件初始化 (幂等; 首次 VM 启动时点亮)
    if (!hal_display::ready()) {
        const esp_err_t err = hal_display::init();
        if (err == ESP_ERR_NOT_SUPPORTED) {
            // 无屏板型 (BOARD_HEADLESS): 契约行为, 绘图调用抛 ENOTSUP, 不算错误
            ESP_LOGW(TAG, "本板无屏幕, px.screen 调用将抛 ENOTSUP");
        } else if (err != ESP_OK) {
            ESP_LOGE(TAG, "显示初始化失败: %s", esp_err_to_name(err));
        }
    }

    // class 注册 (class id 跨 VM 重启复用, class 定义每个 runtime 一次)
    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_NewClassID(rt, &g_canvas_cid);
    if (!JS_IsRegisteredClass(rt, g_canvas_cid)) {
        JS_NewClass(rt, g_canvas_cid, &kCanvasClassDef);
    }

    // canvas 原型: 共享绘图方法 + dispose
    JSValue proto = JS_NewObject(ctx);
    register_draw_methods(ctx, proto);
    JS_SetPropertyStr(ctx, proto, "dispose",
                      JS_NewCFunction(ctx, js_canvas_dispose, "dispose", 0));
    JS_SetClassProto(ctx, g_canvas_cid, proto);

    // px.screen: 同 class 实例 (is_screen 标记), 原型上已有共享方法
    JSValue screen = JS_NewObjectClass(ctx, static_cast<int>(g_canvas_cid));
    auto *sh = new CanvasHandle;
    sh->is_screen = true;
    JS_SetOpaque(screen, sh);

    // screen 专属方法
    JS_SetPropertyStr(ctx, screen, "setBrightness",
                      JS_NewCFunction(ctx, js_set_brightness, "setBrightness", 1));
    JS_SetPropertyStr(ctx, screen, "getBrightness",
                      JS_NewCFunction(ctx, js_get_brightness, "getBrightness", 0));
    JS_SetPropertyStr(ctx, screen, "setPower", JS_NewCFunction(ctx, js_set_power, "setPower", 1));
    JS_SetPropertyStr(ctx, screen, "setRotation",
                      JS_NewCFunction(ctx, js_set_rotation, "setRotation", 1));
    JS_SetPropertyStr(ctx, screen, "flush", JS_NewCFunction(ctx, js_flush, "flush", 0));
    JS_SetPropertyStr(ctx, screen, "onFrame", JS_NewCFunction(ctx, js_on_frame, "onFrame", 1));
    JS_SetPropertyStr(ctx, screen, "setFps", JS_NewCFunction(ctx, js_set_fps, "setFps", 1));
    JS_SetPropertyStr(ctx, screen, "createCanvas",
                      JS_NewCFunction(ctx, js_create_canvas, "createCanvas", 2));
    // prelude 依赖的内部助手 (不可枚举防误用)
    JS_DefinePropertyValueStr(ctx, screen, "__decodeImage",
                              JS_NewCFunction(ctx, js_decode_image, "__decodeImage", 1), 0);
    JS_DefinePropertyValueStr(ctx, screen, "__loadGifFrames",
                              JS_NewCFunction(ctx, js_load_gif_frames, "__loadGifFrames", 2), 0);
    JS_DefinePropertyValueStr(ctx, screen, "__isCanvas",
                              JS_NewCFunction(ctx, js_is_canvas, "__isCanvas", 1), 0);

    JS_SetPropertyStr(ctx, px, "screen", screen);

    // VM 拆除钩子 (进程内只注册一次, 每次热重启触发)
    static bool s_hook_added = false;
    if (!s_hook_added) {
        jsvm::add_teardown_hook(screen_teardown);
        s_hook_added = true;
    }
}

/* prelude_screen.js 经 EMBED_TXTFILES 编入 (NUL 结尾) */
extern "C" const char _binary_prelude_screen_js_start[];

const jsvm::Module s_screen_module = {
    "screen",                        // 模块名
    10,                              // hal 域优先级
    screen_native_init,              // native 初始化
    _binary_prelude_screen_js_start, // prelude: Animation 包装 + createAnimation/loadGif
};

}  // namespace

JSVM_REGISTER_MODULE(s_screen_module);
