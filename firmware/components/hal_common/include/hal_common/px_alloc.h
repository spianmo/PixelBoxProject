/**
 * hal_common/px_alloc.h — PSRAM 优先分配辅助 (多目标统一入口)
 *
 * 背景: S3 板载 8MB PSRAM, 大缓冲 (JS 堆/帧缓冲/网络缓冲) 优先落 PSRAM;
 * C6 等无 PSRAM 目标必须落内部堆。此前"先试 SPIRAM 再回退 8BIT"的双写
 * 模式散落在各组件, 统一收敛到本头文件:
 *
 *   - CONFIG_SPIRAM 开启: 先试 MALLOC_CAP_SPIRAM, 失败回退内部堆;
 *   - CONFIG_SPIRAM 关闭 (C6 / 用户禁用): 直接走内部堆, 不做无谓尝试。
 *
 * 全部为 static inline, hal_common 保持纯头文件组件。
 * 仅固件目标可用 (依赖 esp_heap_caps); 宿主机单测请勿包含本头文件。
 */
#pragma once

#include <stddef.h>

#include "esp_heap_caps.h"
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

/** malloc: PSRAM 优先, 无 PSRAM (或 PSRAM 耗尽) 落内部堆 */
static inline void *px_alloc_prefer_psram(size_t size)
{
#if CONFIG_SPIRAM
    void *p = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p) return p;
#endif
    return heap_caps_malloc(size, MALLOC_CAP_8BIT);
}

/** calloc: PSRAM 优先 (语义同 px_alloc_prefer_psram) */
static inline void *px_calloc_prefer_psram(size_t count, size_t size)
{
#if CONFIG_SPIRAM
    void *p = heap_caps_calloc(count, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p) return p;
#endif
    return heap_caps_calloc(count, size, MALLOC_CAP_8BIT);
}

/** realloc: PSRAM 优先 (原块位置不限, heap_caps_realloc 自行搬移) */
static inline void *px_realloc_prefer_psram(void *ptr, size_t size)
{
#if CONFIG_SPIRAM
    void *p = heap_caps_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p) return p;
#endif
    return heap_caps_realloc(ptr, size, MALLOC_CAP_8BIT);
}

/** 对齐分配: PSRAM 优先 (DMA/缓存行对齐的大缓冲用) */
static inline void *px_aligned_alloc_prefer_psram(size_t alignment, size_t size)
{
#if CONFIG_SPIRAM
    void *p = heap_caps_aligned_alloc(alignment, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p) return p;
#endif
    return heap_caps_aligned_alloc(alignment, size, MALLOC_CAP_8BIT);
}

#ifdef __cplusplus
}
#endif
