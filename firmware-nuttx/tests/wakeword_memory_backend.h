#ifndef WAKEWORD_MEMORY_BACKEND_H
#define WAKEWORD_MEMORY_BACKEND_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* 仅模拟物理地址/内部堆，实际子堆算法直接来自当前 NuttX。 */
extern int px_test_backing_mode, px_test_fail_at, px_test_allocation_calls;
extern int px_test_backing_calls, px_test_backing_live, px_test_internal_live, px_test_resets;
extern bool px_test_internal_fail;
extern bool px_test_mutex_destroy_fail;
extern void *px_test_library_state[6];
uintptr_t px_mn7_test_psram_address(const void *);
void *px_mn7_test_backing_allocate(size_t);
void px_mn7_test_backing_free(void *);
void *px_mn7_test_internal_allocate(size_t, size_t);
void px_mn7_test_internal_free(void *);
bool px_mn7_test_internal_member(void *);
bool px_mn7_test_allocation_fail(void);
#endif
