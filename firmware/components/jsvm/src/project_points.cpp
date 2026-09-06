#include "jsvm_internal.hpp"

#include <cmath>
#include <climits>
#include <algorithm>

namespace {

bool option(JSContext *ctx, JSValueConst options, const char *key, double fallback, double &out)
{
    JSValue value = JS_GetPropertyStr(ctx, options, key);
    out = fallback;
    const bool ok = !JS_IsException(value) &&
        (JS_IsUndefined(value) || JS_ToFloat64(ctx, &out, value) == 0);
    JS_FreeValue(ctx, value);
    if (!ok) return false;
    if (!std::isfinite(out)) {
        JS_ThrowRangeError(ctx, "projection options must be finite");
        return false;
    }
    return true;
}

JSValue project_points(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv, int runs)
{
    if (argc < 3 || JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_FLOAT32 ||
        !JS_IsObject(argv[1]) || JS_GetTypedArrayType(argv[2]) != JS_TYPED_ARRAY_INT32)
        return JS_ThrowTypeError(ctx, "projectPoints needs Float32Array, options, Int32Array");

    double yaw, pitch, squash, lift, scale, cx, cy, distance, grid;
    // Getters can execute JS and detach buffers; obtain pointers only afterwards.
    if (!option(ctx, argv[1], "yaw", 0, yaw) || !option(ctx, argv[1], "pitch", 0, pitch) ||
        !option(ctx, argv[1], "squash", 1, squash) || !option(ctx, argv[1], "lift", 0, lift) ||
        !option(ctx, argv[1], "scale", 1, scale) || !option(ctx, argv[1], "cx", 0, cx) ||
        !option(ctx, argv[1], "cy", 0, cy) || !option(ctx, argv[1], "distance", 64, distance) ||
        !option(ctx, argv[1], "grid", 1, grid)) return JS_EXCEPTION;
    if (scale <= 0 || distance <= 0 || grid < 1)
        return JS_ThrowRangeError(ctx, "scale/distance must be positive; grid must be >= 1");

    size_t input_offset, input_bytes, output_offset, output_bytes, element_bytes;
    JSValue input_buffer = JS_GetTypedArrayBuffer(ctx, argv[0], &input_offset, &input_bytes, &element_bytes);
    if (JS_IsException(input_buffer)) return JS_EXCEPTION;
    JSValue output_buffer = JS_GetTypedArrayBuffer(ctx, argv[2], &output_offset, &output_bytes, &element_bytes);
    if (JS_IsException(output_buffer)) { JS_FreeValue(ctx, input_buffer); return JS_EXCEPTION; }
    size_t input_size = 0, output_size = 0;
    uint8_t *input_data = JS_GetArrayBuffer(ctx, &input_size, input_buffer);
    uint8_t *output_data = JS_GetArrayBuffer(ctx, &output_size, output_buffer);
    const bool invalid = input_bytes % (3 * sizeof(float)) || input_bytes > 8192 * 3 * sizeof(float) ||
        output_bytes / sizeof(int32_t) < input_bytes / sizeof(float) / 3 * (runs ? 3 : 2) ||
        input_offset > input_size || input_bytes > input_size - input_offset ||
        output_offset > output_size || output_bytes > output_size - output_offset;
    JSValue result = runs ? JS_NewInt32(ctx, 0) : JS_UNDEFINED;
    if (JS_HasException(ctx)) result = JS_EXCEPTION;
    else if (invalid || (input_bytes && (!input_data || !output_data || input_data == output_data)))
        result = JS_ThrowRangeError(ctx, "invalid projection lengths or aliased buffers (max 8192 points)");
    else if (input_bytes) {
        const auto *points = reinterpret_cast<const float *>(input_data + input_offset);
        auto *output = reinterpret_cast<int32_t *>(output_data + output_offset);
        const double ca = std::cos(yaw), sa = std::sin(yaw), cb = std::cos(pitch), sb = std::sin(pitch);
        int32_t min_x = INT32_MAX, min_y = INT32_MAX, max_x = INT32_MIN, max_y = INT32_MIN;
        for (size_t i = 0, j = 0; i < input_bytes / sizeof(float); i += 3, j += 2) {
            const double x = points[i] * ca + points[i + 2] * sa;
            const double z = -points[i] * sa + points[i + 2] * ca;
            const double y = points[i + 1] * squash * cb - z * sb;
            const double depth = points[i + 1] * sb + z * cb;
            const double perspective = distance / (distance - depth);
            const double gx = std::floor(std::floor(cx + x * scale * perspective + 0.5) / grid + 0.5);
            const double gy = std::floor(std::floor(cy + y * scale * perspective + lift + 0.5) / grid + 0.5);
            if (depth >= distance || !std::isfinite(gx) || !std::isfinite(gy) ||
                gx < INT32_MIN || gx > INT32_MAX || gy < INT32_MIN || gy > INT32_MAX) {
                result = JS_ThrowRangeError(ctx, "point is outside the projection range");
                break;
            }
            output[j] = static_cast<int32_t>(gx);
            output[j + 1] = static_cast<int32_t>(gy);
            min_x = std::min(min_x, output[j]); max_x = std::max(max_x, output[j]);
            min_y = std::min(min_y, output[j + 1]); max_y = std::max(max_y, output[j + 1]);
        }
        if (runs && !JS_IsException(result)) {
            const int64_t width = int64_t(max_x) - min_x + 1, height = int64_t(max_y) - min_y + 1;
            if (width > 65536 || height > 65536 || width * height > 65536) {
                result = JS_ThrowRangeError(ctx, "projected grid exceeds 65536 cells");
            } else {
                auto *mask = static_cast<uint8_t *>(js_mallocz(ctx, (width * height + 7) / 8));
                if (!mask) result = JS_EXCEPTION;
                else {
                    const size_t count = input_bytes / (3 * sizeof(float));
                    for (size_t i = 0; i < count; ++i) {
                        const size_t index = (int64_t(output[i * 2 + 1]) - min_y) * width + int64_t(output[i * 2]) - min_x;
                        mask[index / 8] |= uint8_t(1u << (index % 8));
                    }
                    int32_t emitted = 0;
                    for (int64_t y = 0; y < height; ++y) {
                        for (int64_t x = 0; x < width;) {
                            auto occupied = [&](int64_t col) {
                                const size_t index = y * width + col;
                                return col < width && (mask[index / 8] & (1u << (index % 8)));
                            };
                            if (!occupied(x)) { ++x; continue; }
                            const int64_t start = x;
                            while (occupied(x)) ++x;
                            output[emitted * 3] = int32_t(start + min_x);
                            output[emitted * 3 + 1] = int32_t(y + min_y);
                            output[emitted * 3 + 2] = int32_t(x - start);
                            ++emitted;
                        }
                    }
                    js_free(ctx, mask);
                    result = JS_NewInt32(ctx, emitted);
                }
            }
        }
    }
    JS_FreeValue(ctx, output_buffer);
    JS_FreeValue(ctx, input_buffer);
    return result;
}

} // namespace

namespace jsvm::internal {
void install_projection_util(JSContext *ctx, JSValue util)
{
    JS_SetPropertyStr(ctx, util, "projectPoints", JS_NewCFunctionMagic(ctx, project_points, "projectPoints", 3, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, util, "projectPointRuns", JS_NewCFunctionMagic(ctx, project_points, "projectPointRuns", 3, JS_CFUNC_generic_magic, 1));
}
}
