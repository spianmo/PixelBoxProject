/**
 * mod_util.cpp — px.util native 部分: crc32 / sha256 / randomBytes
 *
 * 纯 JS 部分 (b64/hex/uuid) 在 prelude_core.js 中挂到同一 px.util 对象。
 */
#include "jsvm_internal.hpp"

#include "esp_random.h"
#include "esp_rom_crc.h"
#include "mbedtls/sha256.h"

namespace {

using jsvm::get_binary;

/** crc32(data: BinaryLike): number — zlib 兼容 CRC32 (esp_rom 实现) */
JSValue js_crc32(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "crc32 需要 1 个参数");
    }
    const uint8_t *data = nullptr;
    size_t len = 0;
    if (!get_binary(ctx, argv[0], &data, &len)) {
        return JS_EXCEPTION;
    }
    uint32_t crc = esp_rom_crc32_le(0, data, len);
    return JS_NewFloat64(ctx, (double)crc);
}

/** sha256(data: BinaryLike | string): ArrayBuffer */
JSValue js_sha256(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "sha256 需要 1 个参数");
    }
    uint8_t digest[32];
    if (JS_IsString(argv[0])) {
        size_t len = 0;
        const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
        if (!s) {
            return JS_EXCEPTION;
        }
        int rc = mbedtls_sha256((const unsigned char *)s, len, digest, 0);
        JS_FreeCString(ctx, s);
        if (rc != 0) {
            return JS_ThrowInternalError(ctx, "sha256 计算失败");
        }
    } else {
        const uint8_t *data = nullptr;
        size_t len = 0;
        if (!get_binary(ctx, argv[0], &data, &len)) {
            return JS_EXCEPTION;
        }
        if (mbedtls_sha256(data, len, digest, 0) != 0) {
            return JS_ThrowInternalError(ctx, "sha256 计算失败");
        }
    }
    return JS_NewArrayBufferCopy(ctx, digest, sizeof(digest));
}

/** randomBytes(len: number): ArrayBuffer */
JSValue js_random_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    int32_t len = 0;
    if (argc < 1 || JS_ToInt32(ctx, &len, argv[0])) {
        return JS_ThrowTypeError(ctx, "randomBytes 需要长度参数");
    }
    if (len < 0 || len > 65536) {
        return JS_ThrowRangeError(ctx, "randomBytes 长度需在 0-65536 之间");
    }
    uint8_t *tmp = (uint8_t *)js_malloc(ctx, len > 0 ? (size_t)len : 1);
    if (!tmp) {
        return JS_EXCEPTION;
    }
    esp_fill_random(tmp, (size_t)len);
    JSValue out = JS_NewArrayBufferCopy(ctx, tmp, (size_t)len);
    js_free(ctx, tmp);
    return out;
}

void util_init(JSContext *ctx, JSValue px)
{
    JSValue util = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, util, "crc32", JS_NewCFunction(ctx, js_crc32, "crc32", 1));
    JS_SetPropertyStr(ctx, util, "sha256", JS_NewCFunction(ctx, js_sha256, "sha256", 1));
    JS_SetPropertyStr(ctx, util, "randomBytes",
                      JS_NewCFunction(ctx, js_random_bytes, "randomBytes", 1));
    JS_SetPropertyStr(ctx, px, "util", util);
}

} // namespace

JSVM_REGISTER_MODULE((jsvm::Module{
    .name = "util",
    .priority = 0,
    .init = util_init,
    .prelude = nullptr,
}));
