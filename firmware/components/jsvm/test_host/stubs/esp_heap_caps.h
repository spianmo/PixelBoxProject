#pragma once
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <limits>

#define MALLOC_CAP_8BIT 1
#define MALLOC_CAP_INTERNAL 2
#define MALLOC_CAP_SPIRAM 4
struct alignas(std::max_align_t) HostAllocation { size_t size; };
inline void *heap_caps_malloc(size_t size, unsigned) {
    if (size > SIZE_MAX - sizeof(HostAllocation)) return nullptr;
    auto *p = static_cast<HostAllocation *>(std::malloc(sizeof(HostAllocation) + size));
    if (!p) return nullptr;
    p->size = size;
    return p + 1;
}
inline void heap_caps_free(void *p) { if (p) std::free(static_cast<HostAllocation *>(p) - 1); }
inline size_t heap_caps_get_allocated_size(void *p) {
    return p ? (static_cast<HostAllocation *>(p) - 1)->size : 0;
}
inline void *heap_caps_calloc(size_t count, size_t size, unsigned caps) {
    if (size && count > SIZE_MAX / size) return nullptr;
    void *p = heap_caps_malloc(count * size, caps);
    if (p) std::memset(p, 0, count * size);
    return p;
}
inline void *heap_caps_realloc(void *p, size_t size, unsigned caps) {
    if (!size) { heap_caps_free(p); return nullptr; }
    void *next = heap_caps_malloc(size, caps);
    if (next && p) {
        std::memcpy(next, p, size < heap_caps_get_allocated_size(p) ? size : heap_caps_get_allocated_size(p));
        heap_caps_free(p);
    }
    return next;
}
inline void *heap_caps_aligned_alloc(size_t, size_t size, unsigned caps) { return heap_caps_malloc(size, caps); }
inline size_t heap_caps_get_free_size(unsigned) { return 8 * 1024 * 1024; }
