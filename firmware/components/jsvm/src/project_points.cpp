#include "jsvm_internal.hpp"

#include <cmath>
#include <climits>
#include <algorithm>
#include <array>

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

struct FastProjection {
    bool enabled;
    float ca, sa, cb, sb, squash, lift, scale, cx, cy, distance;
    int grid;

    bool project(const float *p, int32_t &gx, int32_t &gy) const
    {
        // S3 只有单精度 FPU。限制坐标/相机范围后，远离半像素边界的点
        // 使用硬件 float；边界及范围外的点交回 double，保持原 API 的取整结果。
        if (!enabled || !(std::fabs(p[0]) <= 32 && std::fabs(p[1]) <= 32 && std::fabs(p[2]) <= 32)) return false;
        const float x = p[0] * ca + p[2] * sa;
        const float z = -p[0] * sa + p[2] * ca;
        const float y = p[1] * squash * cb - z * sb;
        const float depth = p[1] * sb + z * cb;
        if (std::fabs(depth) > 32) return false;
        const float perspective = distance / (distance - depth);
        const float sx = cx + x * scale * perspective, sy = cy + y * scale * perspective + lift;
        const float px = std::floor(sx + 0.5f), py = std::floor(sy + 0.5f);
        // 1/32 像素保护带覆盖上述有界运算的累计浮点误差。
        if (std::fabs(sx - px) > 0.46875f || std::fabs(sy - py) > 0.46875f) return false;
        // 二次网格舍入只涉及整数，避免再次进入软件 double 除法。
        auto snap = [this](int pixel) {
            const int numerator = pixel * 2 + grid, denominator = grid * 2;
            return numerator / denominator - (numerator < 0 && numerator % denominator != 0);
        };
        gx = snap(static_cast<int>(px)); gy = snap(static_cast<int>(py));
        return true;
    }
};

struct FloatBuffer {
    JSContext *ctx;
    JSValue owner = JS_UNDEFINED;
    uint8_t *base = nullptr;
    float *data = nullptr;
    size_t count = 0;

    explicit FloatBuffer(JSContext *context = nullptr) : ctx(context) {}
    ~FloatBuffer() { if (ctx) JS_FreeValue(ctx, owner); }
    bool read(JSContext *context, JSValueConst value)
    {
        ctx = context;
        if (JS_GetTypedArrayType(value) != JS_TYPED_ARRAY_FLOAT32) return false;
        size_t offset, bytes, element_bytes, capacity;
        owner = JS_GetTypedArrayBuffer(ctx, value, &offset, &bytes, &element_bytes);
        if (JS_IsException(owner)) return false;
        base = JS_GetArrayBuffer(ctx, &capacity, owner);
        if (JS_HasException(ctx) || offset > capacity || bytes > capacity - offset || (bytes && !base)) return false;
        count = bytes / sizeof(float);
        data = base ? reinterpret_cast<float *>(base + offset) : nullptr;
        return true;
    }
};

JSValue blend_points(JSContext *ctx, JSValueConst, int argc, JSValueConst *argv)
{
    if (argc < 3 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx, "blendPoints needs an array of Float32Array, weights and output");
    JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
    uint32_t length = 0;
    const int length_error = JS_ToUint32(ctx, &length, length_value);
    JS_FreeValue(ctx, length_value);
    if (length_error) return JS_EXCEPTION;
    if (length < 1 || length > 32) return JS_ThrowRangeError(ctx, "blendPoints accepts 1 to 32 point sets");

    // 数组 getter 能执行 JS；先取齐并保留所有对象，再获得底层指针。
    struct Sources {
        JSContext *ctx;
        std::array<JSValue, 32> values;
        explicit Sources(JSContext *c) : ctx(c) { values.fill(JS_UNDEFINED); }
        ~Sources() { for (JSValue value : values) JS_FreeValue(ctx, value); }
    } sources(ctx);
    for (uint32_t i = 0; i < length; ++i) {
        sources.values[i] = JS_GetPropertyUint32(ctx, argv[0], i);
        if (JS_IsException(sources.values[i])) return JS_EXCEPTION;
    }
    FloatBuffer weights, output;
    std::array<FloatBuffer, 32> inputs;
    if (!weights.read(ctx, argv[1]) || !output.read(ctx, argv[2]))
        return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowTypeError(ctx, "blendPoints needs Float32Array buffers");
    if (weights.count != length || output.count % 3 || output.count > 8192 * 3 ||
        (output.count && output.base == weights.base))
        return JS_ThrowRangeError(ctx, "invalid blend lengths or aliased output");
    for (uint32_t i = 0; i < length; ++i) {
        if (!inputs[i].read(ctx, sources.values[i]))
            return JS_HasException(ctx) ? JS_EXCEPTION : JS_ThrowTypeError(ctx, "point sets must be Float32Array");
        if (inputs[i].count != output.count || (output.count && inputs[i].base == output.base) ||
            !std::isfinite(weights.data[i]))
            return JS_ThrowRangeError(ctx, "point sets must match output, weights must be finite, output cannot alias inputs");
    }
    // 保留每次 TypedArray 写入的 Float32 舍入顺序；将成千上万次 JS
    // 取下标/装箱/算术移入原生循环，状态过渡无需阻塞整帧。
    for (size_t j = 0; j < output.count; ++j) {
        float value = 0;
        for (uint32_t i = 0; i < length; ++i) {
            if (weights.data[i] != 0)
                value = static_cast<float>(double(value) + double(inputs[i].data[j]) * double(weights.data[i]));
        }
        output.data[j] = value;
    }
    return JS_UNDEFINED;
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
        const bool fast_enabled = std::fabs(squash) <= 2 && std::fabs(lift) <= 512 && scale <= 32 &&
            std::fabs(cx) <= 2048 && std::fabs(cy) <= 2048 && distance >= 64 && distance <= 1024 &&
            grid <= 1024 && std::floor(grid) == grid;
        const FastProjection fast = fast_enabled ? FastProjection{true, float(ca), float(sa), float(cb), float(sb),
            float(squash), float(lift), float(scale), float(cx), float(cy), float(distance),
            static_cast<int>(grid)} : FastProjection{};
        int32_t min_x = INT32_MAX, min_y = INT32_MAX, max_x = INT32_MIN, max_y = INT32_MIN;
        for (size_t i = 0, j = 0; i < input_bytes / sizeof(float); i += 3, j += 2) {
            if (fast.project(points + i, output[j], output[j + 1])) {
                min_x = std::min(min_x, output[j]); max_x = std::max(max_x, output[j]);
                min_y = std::min(min_y, output[j + 1]); max_y = std::max(max_y, output[j + 1]);
                continue;
            }
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
    JS_SetPropertyStr(ctx, util, "blendPoints", JS_NewCFunction(ctx, blend_points, "blendPoints", 3));
    JS_SetPropertyStr(ctx, util, "projectPoints", JS_NewCFunctionMagic(ctx, project_points, "projectPoints", 3, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, util, "projectPointRuns", JS_NewCFunctionMagic(ctx, project_points, "projectPointRuns", 3, JS_CFUNC_generic_magic, 1));
}
}
