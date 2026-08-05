/**
 * mod_ble.cpp — px.ble 绑定(NimBLE peripheral + central)
 *
 * 结构:
 *   §1 通用工具            §2 peripheral(动态 GATT / notify / 连接事件)
 *   §3 onRead 同步读桥      §4 central(scan / connect / 连接对象)
 *
 * 线程说明:
 *   - hal_periph::ble 的所有回调在 NimBLE host 任务触发,
 *     本文件一律经 jsvm::Callback / jsvm::post 投递回 JS 线程;
 *   - 唯一例外是 onRead 同步读桥(§3):NimBLE 任务阻塞等待 JS 线程
 *     执行 onRead(上限 100ms), 超时退回特征缓存值。
 */
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <vector>

#include "esp_log.h"

#include "hal_periph/ble_hal.hpp"
#include "hal_periph/px_uuid.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

[[maybe_unused]] static const char* TAG = "px.ble";

namespace {

namespace hb = hal_periph::ble;
using hal_periph::PxUuid;
using hal_periph::parse_uuid;
using hal_periph::uuid_to_string;

// ================================================================
// §1 通用工具
// ================================================================

bool guard(JSContext* ctx) {
    if (hb::available()) return true;
    jsvm::throw_enotsup(ctx);
    return false;
}

/** 解析 UUID 参数;失败已抛 TypeError */
bool arg_uuid(JSContext* ctx, JSValueConst v, PxUuid& out) {
    std::string s;
    if (!pxb::to_string(ctx, v, s)) return false;
    out = parse_uuid(s);
    if (!out.valid()) {
        JS_ThrowTypeError(ctx, "无效 UUID: %s", s.c_str());
        return false;
    }
    return true;
}

/** 读取数组长度 */
uint32_t array_length(JSContext* ctx, JSValueConst arr) {
    JSValue lv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, lv);
    JS_FreeValue(ctx, lv);
    return len;
}

// ================================================================
// §2 peripheral
// ================================================================

pxb::CallbackRegistry s_pconn_reg;   // peripheral onConnect
pxb::CallbackRegistry s_pdisc_reg;   // peripheral onDisconnect

/** 每个特征的 JS 回调(user_tag 为下标) */
struct CharJsCbs {
    jsvm::Callback on_write;           // 异步投递
    JSValue on_read_fn = JS_UNDEFINED; // 同步读桥用, 手动 dup/free
    bool has_on_read = false;
};
std::mutex s_char_mtx;
std::vector<CharJsCbs> s_char_cbs;
uint32_t s_char_gen = 0;  // 创建这批回调时的 VM 代数

/** JS 线程:释放当前 VM 内的 onRead 引用并清空表 */
void reset_char_cbs(JSContext* ctx) {
    std::lock_guard<std::mutex> lk(s_char_mtx);
    if (ctx != nullptr && s_char_gen == jsvm::vm_generation()) {
        for (auto& c : s_char_cbs) {
            if (c.has_on_read) JS_FreeValue(ctx, c.on_read_fn);
        }
    }
    // 跨 VM 残留:旧 runtime 已整体销毁, 引用随之回收, 直接丢弃
    s_char_cbs.clear();
}

// ---- §3 onRead 同步读桥 ----

struct ReadBridge {
    std::mutex m;
    std::condition_variable cv;
    bool done = false;
    bool ok = false;
    std::vector<uint8_t> data;
};

/** NimBLE host 任务:阻塞 ≤100ms 等 JS 线程执行 onRead */
bool on_read_sync(uint32_t tag, std::vector<uint8_t>& out) {
    {
        std::lock_guard<std::mutex> lk(s_char_mtx);
        if (tag >= s_char_cbs.size() || !s_char_cbs[tag].has_on_read) return false;
    }
    auto br = std::make_shared<ReadBridge>();
    jsvm::post([br, tag]() {
        // JS 线程
        JSContext* ctx = jsvm::context();
        JSValue fn = JS_UNDEFINED;
        {
            std::lock_guard<std::mutex> lk(s_char_mtx);
            if (ctx != nullptr && tag < s_char_cbs.size() && s_char_cbs[tag].has_on_read &&
                s_char_gen == jsvm::vm_generation()) {
                fn = JS_DupValue(ctx, s_char_cbs[tag].on_read_fn);
            }
        }
        if (!JS_IsUndefined(fn)) {
            JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, nullptr);
            if (JS_IsException(r)) {
                jsvm::dump_error(ctx);
            } else {
                const uint8_t* p = nullptr;
                size_t n = 0;
                if (jsvm::get_binary(ctx, r, &p, &n)) {
                    std::lock_guard<std::mutex> lk(br->m);
                    br->data.assign(p, p + n);
                    br->ok = true;
                } else {
                    JS_FreeValue(ctx, JS_GetException(ctx));  // 非二进制返回值 → 忽略
                }
            }
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, fn);
        }
        {
            std::lock_guard<std::mutex> lk(br->m);
            br->done = true;
        }
        br->cv.notify_all();
    });

    std::unique_lock<std::mutex> lk(br->m);
    br->cv.wait_for(lk, std::chrono::milliseconds(100), [&] { return br->done; });
    if (br->done && br->ok) {
        out = std::move(br->data);
        return true;
    }
    return false;  // 超时/失败 → hal 用缓存值
}

/** 解析 characteristics 数组中的一项;失败已抛异常 */
bool parse_char_def(JSContext* ctx, JSValueConst cv, uint32_t tag, hb::CharDef& out,
                    CharJsCbs& cbs) {
    JSValue uv = JS_GetPropertyStr(ctx, cv, "uuid");
    bool ok = arg_uuid(ctx, uv, out.uuid);
    JS_FreeValue(ctx, uv);
    if (!ok) return false;

    JSValue props = JS_GetPropertyStr(ctx, cv, "properties");
    if (JS_IsArray(props)) {
        uint32_t n = array_length(ctx, props);
        for (uint32_t i = 0; i < n; i++) {
            JSValue p = JS_GetPropertyUint32(ctx, props, i);
            std::string ps;
            pxb::to_string(ctx, p, ps);
            JS_FreeValue(ctx, p);
            if (ps == "read") out.readable = true;
            else if (ps == "write") out.writable = true;
            else if (ps == "notify") out.notifiable = true;
        }
    }
    JS_FreeValue(ctx, props);

    JSValue val = JS_GetPropertyStr(ctx, cv, "value");
    if (!JS_IsUndefined(val) && !JS_IsNull(val)) {
        if (!pxb::get_binary_copy(ctx, val, out.value)) {
            JS_FreeValue(ctx, val);
            return false;
        }
    }
    JS_FreeValue(ctx, val);

    cbs.on_write = pxb::opt_callback(ctx, cv, "onWrite");

    JSValue rd = JS_GetPropertyStr(ctx, cv, "onRead");
    if (JS_IsFunction(ctx, rd)) {
        cbs.on_read_fn = rd;  // 转移引用(不 Free)
        cbs.has_on_read = true;
        out.has_on_read = true;
    } else {
        JS_FreeValue(ctx, rd);
    }

    out.user_tag = tag;
    return true;
}

JSValue js_periph_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "start(opts) 需要 { name, services }");
    }
    std::string name = "PixelBox";
    pxb::opt_string(ctx, argv[0], "name", name);

    JSValue services = JS_GetPropertyStr(ctx, argv[0], "services");
    if (!JS_IsArray(services)) {
        JS_FreeValue(ctx, services);
        return JS_ThrowTypeError(ctx, "opts.services 须为数组");
    }

    // 重建特征回调表(先释放旧引用)
    reset_char_cbs(ctx);
    std::vector<hb::SvcDef> svc_defs;
    std::vector<CharJsCbs> char_cbs;
    uint32_t tag = 0;

    uint32_t svc_n = array_length(ctx, services);
    for (uint32_t i = 0; i < svc_n; i++) {
        JSValue sv = JS_GetPropertyUint32(ctx, services, i);
        hb::SvcDef sd;

        JSValue uv = JS_GetPropertyStr(ctx, sv, "uuid");
        bool ok = arg_uuid(ctx, uv, sd.uuid);
        JS_FreeValue(ctx, uv);

        JSValue chars = ok ? JS_GetPropertyStr(ctx, sv, "characteristics") : JS_UNDEFINED;
        if (ok && JS_IsArray(chars)) {
            uint32_t cn = array_length(ctx, chars);
            for (uint32_t j = 0; j < cn && ok; j++) {
                JSValue cv2 = JS_GetPropertyUint32(ctx, chars, j);
                hb::CharDef cd;
                CharJsCbs cbs;
                ok = parse_char_def(ctx, cv2, tag, cd, cbs);
                JS_FreeValue(ctx, cv2);
                if (ok) {
                    sd.chars.push_back(std::move(cd));
                    char_cbs.push_back(std::move(cbs));
                    tag++;
                }
            }
        }
        if (!JS_IsUndefined(chars)) JS_FreeValue(ctx, chars);
        JS_FreeValue(ctx, sv);

        if (!ok) {
            JS_FreeValue(ctx, services);
            // 解析失败:释放已收集的 onRead 引用
            for (auto& c : char_cbs) {
                if (c.has_on_read) JS_FreeValue(ctx, c.on_read_fn);
            }
            return JS_EXCEPTION;
        }
        svc_defs.push_back(std::move(sd));
    }
    JS_FreeValue(ctx, services);

    {
        std::lock_guard<std::mutex> lk(s_char_mtx);
        s_char_cbs = std::move(char_cbs);
        s_char_gen = jsvm::vm_generation();
    }

    hb::PeripheralCallbacks cbs;
    cbs.on_connect = [](const std::string& id) {
        if (!s_pconn_reg.active()) return;
        std::string cid = id;
        s_pconn_reg.invoke_all([cid](JSContext* c, JSValue* a) -> int {
            a[0] = JS_NewString(c, cid.c_str());
            return 1;
        });
    };
    cbs.on_disconnect = [](const std::string& id) {
        if (!s_pdisc_reg.active()) return;
        std::string cid = id;
        s_pdisc_reg.invoke_all([cid](JSContext* c, JSValue* a) -> int {
            a[0] = JS_NewString(c, cid.c_str());
            return 1;
        });
    };
    cbs.on_write = [](uint32_t t, std::vector<uint8_t> data) {
        jsvm::Callback cb;
        {
            std::lock_guard<std::mutex> lk(s_char_mtx);
            if (t < s_char_cbs.size()) cb = s_char_cbs[t].on_write;
        }
        if (!cb) return;
        cb.invoke_with([data = std::move(data)](JSContext* c, JSValue* a) -> int {
            a[0] = JS_NewArrayBufferCopy(c, data.data(), data.size());
            return 1;
        });
    };
    cbs.on_read_sync = on_read_sync;

    esp_err_t err = hb::peripheral_start(name, std::move(svc_defs), std::move(cbs));
    if (err != ESP_OK) {
        return JS_ThrowPlainError(ctx, "BLE peripheral 启动失败: %s", esp_err_to_name(err));
    }
    return JS_UNDEFINED;
}

JSValue js_periph_notify(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    PxUuid svc, chr;
    if (argc < 3 || !arg_uuid(ctx, argv[0], svc) || !arg_uuid(ctx, argv[1], chr)) {
        return JS_EXCEPTION;
    }
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, argv[2], &data, &len)) return JS_EXCEPTION;

    esp_err_t err = hb::peripheral_notify(svc, chr, data, len);
    if (err == ESP_ERR_INVALID_STATE) return JS_ThrowPlainError(ctx, "peripheral 未启动");
    if (err == ESP_ERR_NOT_FOUND) return JS_ThrowPlainError(ctx, "特征不存在");
    if (err != ESP_OK) return JS_ThrowPlainError(ctx, "notify 失败: %s", esp_err_to_name(err));
    return JS_UNDEFINED;
}

JSValue js_periph_stop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hb::peripheral_stop();
    return JS_UNDEFINED;
}

JSValue js_periph_on_connect(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return JS_ThrowTypeError(ctx, "需要回调函数");
    uint64_t id = s_pconn_reg.add(ctx, argv[0]);
    return pxb::make_unsubscribe(ctx, &s_pconn_reg, id);
}

JSValue js_periph_on_disconnect(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return JS_ThrowTypeError(ctx, "需要回调函数");
    uint64_t id = s_pdisc_reg.add(ctx, argv[0]);
    return pxb::make_unsubscribe(ctx, &s_pdisc_reg, id);
}

// ================================================================
// §4 central
// ================================================================

/** 断开事件分发表(连接对象 onDisconnect / disconnect() 的 promise) */
struct DiscEntry {
    uint64_t id;
    uint32_t token;
    jsvm::Callback cb;
};
std::mutex s_disc_mtx;
std::vector<DiscEntry> s_disc_entries;
uint64_t s_disc_next_id = 1;

/** 活跃连接 token(VM 重启时用于批量断开) */
std::mutex s_tokens_mtx;
std::vector<uint32_t> s_active_tokens;

void track_token(uint32_t token, bool add) {
    std::lock_guard<std::mutex> lk(s_tokens_mtx);
    if (add) {
        s_active_tokens.push_back(token);
    } else {
        for (auto it = s_active_tokens.begin(); it != s_active_tokens.end(); ++it) {
            if (*it == token) {
                s_active_tokens.erase(it);
                break;
            }
        }
    }
}

uint64_t add_disc_entry(uint32_t token, jsvm::Callback cb) {
    std::lock_guard<std::mutex> lk(s_disc_mtx);
    uint64_t id = s_disc_next_id++;
    s_disc_entries.push_back({id, token, std::move(cb)});
    return id;
}

void remove_disc_entry(uint64_t id) {
    std::lock_guard<std::mutex> lk(s_disc_mtx);
    for (auto it = s_disc_entries.begin(); it != s_disc_entries.end(); ++it) {
        if (it->id == id) {
            s_disc_entries.erase(it);
            break;
        }
    }
}

/** NimBLE 任务:连接断开 → 依次触发该 token 的全部回调并移除 */
void fire_disconnect(uint32_t token) {
    track_token(token, false);
    std::vector<jsvm::Callback> cbs;
    {
        std::lock_guard<std::mutex> lk(s_disc_mtx);
        for (auto it = s_disc_entries.begin(); it != s_disc_entries.end();) {
            if (it->token == token) {
                cbs.push_back(std::move(it->cb));
                it = s_disc_entries.erase(it);
            } else {
                ++it;
            }
        }
    }
    for (auto& cb : cbs) cb.invoke();
}

/** onDisconnect 的 Unsubscribe:func_data[0]=entry id */
JSValue disc_unsub_impl(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                        JSValueConst* func_data) {
    int64_t id = 0;
    JS_ToInt64(ctx, &id, func_data[0]);
    remove_disc_entry(static_cast<uint64_t>(id));
    return JS_UNDEFINED;
}

/** subscribe 返回的 Unsubscribe:func_data = [token, svcUuid, chrUuid] */
JSValue sub_unsub_impl(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                       JSValueConst* func_data) {
    int64_t token = 0;
    JS_ToInt64(ctx, &token, func_data[0]);
    std::string svc_s, chr_s;
    pxb::to_string(ctx, func_data[1], svc_s);
    pxb::to_string(ctx, func_data[2], chr_s);
    PxUuid svc = parse_uuid(svc_s), chr = parse_uuid(chr_s);
    hb::gatt_subscribe(static_cast<uint32_t>(token), svc, chr, false, nullptr,
                       [](const char*) {});
    return JS_UNDEFINED;
}

/** 连接对象方法共用:func_data[0] = token */
uint32_t conn_token(JSContext* ctx, JSValueConst* func_data) {
    int64_t t = 0;
    JS_ToInt64(ctx, &t, func_data[0]);
    return static_cast<uint32_t>(t);
}

JSValue conn_services(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                      JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t token = conn_token(ctx, func_data);

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hb::discover(
        token, [pp](const std::vector<hb::GattSvcInfo>* svcs, const char* e) {
            if (e != nullptr || svcs == nullptr) {
                pp.reject_error(e ? e : "服务发现失败");
                return;
            }
            std::vector<hb::GattSvcInfo> copy = *svcs;  // 指针仅回调期间有效 → 拷贝
            pp.resolve_with([copy = std::move(copy)](JSContext* c, JSValue* a) -> int {
                JSValue arr = JS_NewArray(c);
                uint32_t i = 0;
                for (const auto& s : copy) {
                    JSValue so = JS_NewObject(c);
                    JS_SetPropertyStr(c, so, "uuid",
                                      JS_NewString(c, uuid_to_string(s.uuid).c_str()));
                    JSValue carr = JS_NewArray(c);
                    uint32_t j = 0;
                    for (const auto& ch : s.chars) {
                        JSValue co = JS_NewObject(c);
                        JS_SetPropertyStr(c, co, "uuid",
                                          JS_NewString(c, uuid_to_string(ch.uuid).c_str()));
                        JSValue parr = JS_NewArray(c);
                        uint32_t k = 0;
                        if (ch.properties & 0x01)
                            JS_SetPropertyUint32(c, parr, k++, JS_NewString(c, "read"));
                        if (ch.properties & 0x02)
                            JS_SetPropertyUint32(c, parr, k++, JS_NewString(c, "write"));
                        if (ch.properties & 0x04)
                            JS_SetPropertyUint32(c, parr, k++, JS_NewString(c, "writeNoRsp"));
                        if (ch.properties & 0x08)
                            JS_SetPropertyUint32(c, parr, k++, JS_NewString(c, "notify"));
                        if (ch.properties & 0x10)
                            JS_SetPropertyUint32(c, parr, k++, JS_NewString(c, "indicate"));
                        JS_SetPropertyStr(c, co, "properties", parr);
                        JS_SetPropertyUint32(c, carr, j++, co);
                    }
                    JS_SetPropertyStr(c, so, "characteristics", carr);
                    JS_SetPropertyUint32(c, arr, i++, so);
                }
                a[0] = arr;
                return 1;
            });
        });
    if (err != ESP_OK) pp.reject_error("连接已断开");
    return promise;
}

JSValue conn_read(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv, int,
                  JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t token = conn_token(ctx, func_data);
    PxUuid svc, chr;
    if (argc < 2 || !arg_uuid(ctx, argv[0], svc) || !arg_uuid(ctx, argv[1], chr)) {
        return JS_EXCEPTION;
    }
    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hb::gatt_read(token, svc, chr,
                                  [pp](std::vector<uint8_t>* data, const char* e) {
        if (e != nullptr || data == nullptr) {
            pp.reject_error(e ? e : "读取失败");
            return;
        }
        std::vector<uint8_t> copy = std::move(*data);
        pp.resolve_with([copy = std::move(copy)](JSContext* c, JSValue* a) -> int {
            a[0] = JS_NewArrayBufferCopy(c, copy.data(), copy.size());
            return 1;
        });
    });
    if (err != ESP_OK) pp.reject_error("连接已断开");
    return promise;
}

JSValue conn_write(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv, int,
                   JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t token = conn_token(ctx, func_data);
    PxUuid svc, chr;
    if (argc < 3 || !arg_uuid(ctx, argv[0], svc) || !arg_uuid(ctx, argv[1], chr)) {
        return JS_EXCEPTION;
    }
    std::vector<uint8_t> data;
    if (!pxb::get_binary_copy(ctx, argv[2], data)) return JS_EXCEPTION;
    bool with_rsp = true;  // 默认带响应写(可靠)
    if (argc >= 4 && JS_IsObject(argv[3])) {
        with_rsp = pxb::opt_bool(ctx, argv[3], "withResponse", true);
    }

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hb::gatt_write(token, svc, chr, std::move(data), with_rsp,
                                   [pp](const char* e) {
        if (e != nullptr) {
            pp.reject_error(e);
        } else {
            pp.resolve_undefined();
        }
    });
    if (err != ESP_OK) pp.reject_error("连接已断开");
    return promise;
}

JSValue conn_subscribe(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv, int,
                       JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t token = conn_token(ctx, func_data);
    PxUuid svc, chr;
    if (argc < 3 || !arg_uuid(ctx, argv[0], svc) || !arg_uuid(ctx, argv[1], chr)) {
        return JS_EXCEPTION;
    }
    if (!JS_IsFunction(ctx, argv[2])) return JS_ThrowTypeError(ctx, "subscribe 需要回调函数");
    jsvm::Callback on_notify(ctx, argv[2]);

    std::string svc_s = uuid_to_string(svc), chr_s = uuid_to_string(chr);

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hb::gatt_subscribe(
        token, svc, chr, true,
        [on_notify](std::vector<uint8_t> data) {
            on_notify.invoke_with([data = std::move(data)](JSContext* c, JSValue* a) -> int {
                a[0] = JS_NewArrayBufferCopy(c, data.data(), data.size());
                return 1;
            });
        },
        [pp, token, svc_s, chr_s](const char* e) {
            if (e != nullptr) {
                pp.reject_error(e);
                return;
            }
            // 成功 → resolve 一个 Unsubscribe 闭包(在 JS 线程构造)
            pp.resolve_with([token, svc_s, chr_s](JSContext* c, JSValue* a) -> int {
                JSValue data[3] = {
                    JS_NewInt64(c, token),
                    JS_NewString(c, svc_s.c_str()),
                    JS_NewString(c, chr_s.c_str()),
                };
                a[0] = JS_NewCFunctionData(c, sub_unsub_impl, 0, 0, 3, data);
                for (auto& d : data) JS_FreeValue(c, d);
                return 1;
            });
        });
    if (err != ESP_OK) pp.reject_error("连接已断开");
    return promise;
}

JSValue conn_disconnect(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                        JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t token = conn_token(ctx, func_data);

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    // 断开事件触发时 resolve;若 token 已失效(早已断开)直接 resolve
    add_disc_entry(token, pp.resolve);
    hb::disconnect(token);

    bool still_active;
    {
        std::lock_guard<std::mutex> lk(s_tokens_mtx);
        still_active = false;
        for (uint32_t t : s_active_tokens) {
            if (t == token) {
                still_active = true;
                break;
            }
        }
    }
    if (!still_active) pp.resolve_undefined();  // 幂等:重复 resolve 无害
    return promise;
}

JSValue conn_on_disconnect(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv, int,
                           JSValueConst* func_data) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return JS_ThrowTypeError(ctx, "需要回调函数");
    uint32_t token = conn_token(ctx, func_data);
    uint64_t id = add_disc_entry(token, jsvm::Callback(ctx, argv[0]));

    JSValue data[1] = {JS_NewInt64(ctx, static_cast<int64_t>(id))};
    JSValue fn = JS_NewCFunctionData(ctx, disc_unsub_impl, 0, 0, 1, data);
    JS_FreeValue(ctx, data[0]);
    return fn;
}

/** 构造 PxBleConnection 对象(JS 线程) */
JSValue make_conn_obj(JSContext* ctx, uint32_t token) {
    JSValue obj = JS_NewObject(ctx);
    JSValue data[1] = {JS_NewInt64(ctx, token)};
    struct MethodDef {
        const char* name;
        JSCFunctionData* fn;
        int nargs;
    };
    static constexpr MethodDef kMethods[] = {
        {"services", conn_services, 0},
        {"read", conn_read, 2},
        {"write", conn_write, 4},
        {"subscribe", conn_subscribe, 3},
        {"disconnect", conn_disconnect, 0},
        {"onDisconnect", conn_on_disconnect, 1},
    };
    for (const auto& m : kMethods) {
        JS_SetPropertyStr(ctx, obj, m.name,
                          JS_NewCFunctionData(ctx, m.fn, m.nargs, 0, 1, data));
    }
    JS_FreeValue(ctx, data[0]);
    return obj;
}

/** ScanResult → PxBleScanResult 对象 */
JSValue make_scan_obj(JSContext* ctx, const hb::ScanResult& r) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "id", JS_NewString(ctx, r.id.c_str()));
    JS_SetPropertyStr(ctx, o, "name",
                      r.has_name ? JS_NewString(ctx, r.name.c_str()) : JS_NULL);
    JS_SetPropertyStr(ctx, o, "rssi", JS_NewInt32(ctx, r.rssi));
    JS_SetPropertyStr(ctx, o, "manufacturerData",
                      r.has_mfg ? JS_NewArrayBufferCopy(ctx, r.mfg.data(), r.mfg.size())
                                : JS_NULL);
    return o;
}

JSValue js_scan(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t timeout = 5000;
    jsvm::Callback on_device;
    if (argc >= 1 && JS_IsObject(argv[0])) {
        timeout = static_cast<uint32_t>(pxb::opt_number(ctx, argv[0], "timeoutMs", 5000));
        on_device = pxb::opt_callback(ctx, argv[0], "onDevice");
    }

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hb::scan_start(
        timeout,
        [on_device](const hb::ScanResult& r) {
            if (!on_device) return;
            hb::ScanResult copy = r;
            on_device.invoke_with([copy = std::move(copy)](JSContext* c, JSValue* a) -> int {
                a[0] = make_scan_obj(c, copy);
                return 1;
            });
        },
        [pp](std::vector<hb::ScanResult> all) {
            pp.resolve_with([all = std::move(all)](JSContext* c, JSValue* a) -> int {
                JSValue arr = JS_NewArray(c);
                uint32_t i = 0;
                for (const auto& r : all) JS_SetPropertyUint32(c, arr, i++, make_scan_obj(c, r));
                a[0] = arr;
                return 1;
            });
        });
    if (err != ESP_OK) pp.reject_error("扫描启动失败");
    return promise;
}

JSValue js_stop_scan(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hb::scan_stop();
    return JS_UNDEFINED;
}

JSValue js_connect(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    std::string device_id;
    if (argc < 1 || !pxb::to_string(ctx, argv[0], device_id)) {
        return JS_ThrowTypeError(ctx, "connect(deviceId) 需要设备地址");
    }
    uint32_t timeout = 10000;
    if (argc >= 2 && JS_IsObject(argv[1])) {
        timeout = static_cast<uint32_t>(pxb::opt_number(ctx, argv[1], "timeoutMs", 10000));
    }

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    // token 在连接成功后才有值;断开回调经 holder 取回
    auto token_holder = std::make_shared<std::atomic<uint32_t>>(hb::INVALID_CONN);

    esp_err_t err = hb::connect(
        device_id, timeout,
        [pp, token_holder](hb::ConnToken tok, const char* e) {
            if (e != nullptr || tok == hb::INVALID_CONN) {
                pp.reject_error(e ? e : "连接失败");
                return;
            }
            token_holder->store(tok);
            track_token(tok, true);
            pp.resolve_with([tok](JSContext* c, JSValue* a) -> int {
                a[0] = make_conn_obj(c, tok);
                return 1;
            });
        },
        [token_holder]() {
            uint32_t tok = token_holder->load();
            if (tok != hb::INVALID_CONN) fire_disconnect(tok);
        });
    if (err != ESP_OK) pp.reject_error("发起连接失败");
    return promise;
}

// ================================================================
// 模块注册
// ================================================================

JSValue js_available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hb::available());
}

void ble_init(JSContext* ctx, JSValue px) {
    // VM 重启:停广播/扫描, 断开全部 central 连接, 清回调表
    s_pconn_reg.clear();
    s_pdisc_reg.clear();
    if (hb::available()) {
        hb::peripheral_stop();
        hb::scan_stop();
        std::vector<uint32_t> tokens;
        {
            std::lock_guard<std::mutex> lk(s_tokens_mtx);
            tokens = s_active_tokens;
        }
        for (uint32_t t : tokens) hb::disconnect(t);
    }
    {
        std::lock_guard<std::mutex> lk(s_disc_mtx);
        s_disc_entries.clear();
    }
    reset_char_cbs(nullptr);  // 跨 VM:旧引用随 runtime 销毁, 直接丢弃

    JSValue ble = JS_NewObject(ctx);
    pxb::def_fn(ctx, ble, "available", js_available, 0);

    JSValue periph = JS_NewObject(ctx);
    pxb::def_fn(ctx, periph, "start", js_periph_start, 1);
    pxb::def_fn(ctx, periph, "notify", js_periph_notify, 3);
    pxb::def_fn(ctx, periph, "stop", js_periph_stop, 0);
    pxb::def_fn(ctx, periph, "onConnect", js_periph_on_connect, 1);
    pxb::def_fn(ctx, periph, "onDisconnect", js_periph_on_disconnect, 1);
    JS_SetPropertyStr(ctx, ble, "peripheral", periph);

    JSValue central = JS_NewObject(ctx);
    pxb::def_fn(ctx, central, "scan", js_scan, 1);
    pxb::def_fn(ctx, central, "stopScan", js_stop_scan, 0);
    pxb::def_fn(ctx, central, "connect", js_connect, 2);
    JS_SetPropertyStr(ctx, ble, "central", central);

    JS_SetPropertyStr(ctx, px, "ble", ble);
    ESP_LOGD(TAG, "px.ble 就绪 (available=%d)", hb::available());
}

const jsvm::Module s_module = {
    .name = "ble",
    .priority = 10,
    .init = ble_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
