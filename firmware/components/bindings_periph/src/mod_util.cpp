/**
 * mod_util.cpp — px.util 的 native 部分:crc32 / sha256 / randomBytes
 *
 * 挂载约定(与 fw-core prelude 对齐, 见 architecture.md §4.1):
 *   1. native init 直接把三个方法挂到 px.util 上(px.util 不存在则创建);
 *   2. 同时导出全局 __native_util = { crc32, sha256, randomBytes },
 *      供 fw-core 的纯 JS prelude(b64/hex/uuid 等)引用同一套实现;
 *   3. fw-core 的 prelude 只需在既有 px.util 上补 b64encode/b64decode/
 *      hexEncode/hexDecode/uuid, 无需重复实现本文件的三个方法。
 *
 * 幂等策略:fw-core (jsvm/src/mod_util.cpp, priority 0) 也内置了同名三方法,
 * 先于本模块执行。本模块只在 px.util 上"缺哪个补哪个", 不覆盖已有实现,
 * 保证两个组件谁先谁后/谁被裁剪都不影响契约;__native_util 别名始终由本模块导出。
 */
#include <vector>

#include "esp_random.h"
#include "esp_rom_crc.h"
#include "mbedtls/sha256.h"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

/** crc32(data: BinaryLike): number — 标准 IEEE CRC-32(与 zlib 一致) */
JSValue js_crc32(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "crc32 需要 1 个参数");
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, argv[0], &data, &len)) return JS_EXCEPTION;
    // esp_rom_crc32_le(0, ...) 即标准反射多项式 CRC-32
    uint32_t crc = esp_rom_crc32_le(0, data, static_cast<uint32_t>(len));
    return JS_NewUint32(ctx, crc);
}

/** sha256(data: BinaryLike | string): ArrayBuffer(32 字节) */
JSValue js_sha256(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "sha256 需要 1 个参数");
    uint8_t hash[32];

    if (JS_IsString(argv[0])) {
        size_t len = 0;
        const char* s = JS_ToCStringLen(ctx, &len, argv[0]);
        if (s == nullptr) return JS_EXCEPTION;
        int rc = mbedtls_sha256(reinterpret_cast<const unsigned char*>(s), len, hash, 0);
        JS_FreeCString(ctx, s);
        if (rc != 0) return JS_ThrowInternalError(ctx, "sha256 计算失败");
    } else {
        const uint8_t* data = nullptr;
        size_t len = 0;
        if (!jsvm::get_binary(ctx, argv[0], &data, &len)) return JS_EXCEPTION;
        if (mbedtls_sha256(data, len, hash, 0) != 0) {
            return JS_ThrowInternalError(ctx, "sha256 计算失败");
        }
    }
    return JS_NewArrayBufferCopy(ctx, hash, sizeof(hash));
}

/** randomBytes(len: number): ArrayBuffer — 硬件真随机 */
JSValue js_random_bytes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    int64_t len = 0;
    if (argc < 1 || JS_ToInt64(ctx, &len, argv[0]) != 0) {
        return JS_ThrowTypeError(ctx, "randomBytes 需要长度参数");
    }
    if (len < 0 || len > 65536) {
        return JS_ThrowRangeError(ctx, "randomBytes 长度须在 0~65536");
    }
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    if (!buf.empty()) esp_fill_random(buf.data(), buf.size());
    return JS_NewArrayBufferCopy(ctx, buf.data(), buf.size());
}

void util_init(JSContext* ctx, JSValue px) {
    // px.util:不存在则创建(fw-core prelude 之后在其上补纯 JS 方法)
    JSValue util = JS_GetPropertyStr(ctx, px, "util");
    if (!JS_IsObject(util)) {
        JS_FreeValue(ctx, util);
        util = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, px, "util", JS_DupValue(ctx, util));
    }

    // 缺哪个补哪个(fw-core 已挂载时不覆盖)
    struct FnDef {
        const char* name;
        JSCFunction* fn;
    };
    static constexpr FnDef kFns[] = {
        {"crc32", js_crc32},
        {"sha256", js_sha256},
        {"randomBytes", js_random_bytes},
    };
    for (const auto& f : kFns) {
        JSValue existing = JS_GetPropertyStr(ctx, util, f.name);
        bool present = JS_IsFunction(ctx, existing);
        JS_FreeValue(ctx, existing);
        if (!present) pxb::def_fn(ctx, util, f.name, f.fn, 1);
    }

    // 全局 __native_util:与 px.util 同一套函数, 供 fw-core prelude 使用
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue nu = JS_NewObject(ctx);
    for (const char* name : {"crc32", "sha256", "randomBytes"}) {
        JSValue fn = JS_GetPropertyStr(ctx, util, name);
        JS_SetPropertyStr(ctx, nu, name, fn);  // 转移引用
    }
    JS_SetPropertyStr(ctx, global, "__native_util", nu);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, util);
}

const jsvm::Module s_module = {
    .name = "util_native",
    .priority = 10,  // hal 域
    .init = util_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
