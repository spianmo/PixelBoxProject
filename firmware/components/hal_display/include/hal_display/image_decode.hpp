/**
 * hal_display/image_decode.hpp — 图片统一解码到 RGB565 表面
 *
 * - PNG:  vendored pngle (MIT, kikuchan/pngle) — 流式解码, 支持 alpha
 *   (alpha < 128 的像素记入 1bpp 透明掩码, blit 时跳过);
 * - JPEG: espressif/esp_new_jpeg (组件注册表) — 直接输出 RGB565 大端;
 *   宿主机单测环境无该组件, JPEG 仅在固件目标上可用;
 * - GIF:  vendored gifdec (public domain, lecram/gifdec, 内存化改造)
 *   — 逐帧解码为表面数组 + 每帧时长。
 *
 * 所有输出表面均由本模块分配 (PSRAM 优先), 调用方负责 free_image /
 * gfx::destroy_surface 释放。
 */
#pragma once

#include <cstdint>
#include <cstddef>

#include "hal_display/gfx.hpp"

namespace img {

/** 解码结果: 表面 + 可选 1bpp 透明掩码 (置位 = 不透明) */
struct Decoded {
    gfx::Surface surf;
    uint8_t *alpha = nullptr;  //!< 行字节 = ceil(w/8); 无透明像素时为 nullptr
};

enum class Format : uint8_t { Unknown = 0, Png, Jpeg, Gif };

/** 按魔数嗅探图片格式 */
Format sniff(const uint8_t *data, size_t len);

/**
 * 解码 PNG/JPEG 到新表面 (格式自动嗅探)。
 * 成功返回 true; 失败时不残留分配。
 */
bool decode(const uint8_t *data, size_t len, Decoded *out);

/** 释放 decode 的产物 */
void free_decoded(Decoded *d);

/** GIF 解码回调: 每帧一次; 返回 false 中止 (帧表面所有权移交回调方) */
using GifFrameSink = bool (*)(void *user, gfx::Surface frame, int delay_ms);

/**
 * 逐帧解码 GIF (合成后的完整帧, 已处理 disposal)。
 * max_frames 限制帧数上限 (内存保护), 返回实际解出的帧数, 失败返回 -1。
 */
int decode_gif(const uint8_t *data, size_t len, int max_frames,
               GifFrameSink sink, void *user);

}  // namespace img
