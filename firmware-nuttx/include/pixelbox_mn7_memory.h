#ifndef PIXELBOX_MN7_MEMORY_H
#define PIXELBOX_MN7_MEMORY_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* 固定候选预算来自原 ESP-IDF 引擎的最低门槛；真机峰值另行验收。 */
#define PX_MN7_WORKSPACE_BYTES (4u * 1024u * 1024u)
struct px_mn7_memory_stats {
  size_t budget, heap_initial, heap_peak, heap_free, heap_largest;
  size_t psram_live, psram_peak, internal_live, internal_peak;
  size_t overhead_live, overhead_peak;
  size_t failed_size, allocations, reclaimed, live_blocks;
  uint32_t failed_caps;
  int error, cleanup_error;
};

/* callback 独占原库全部状态，只能在本线程调用；不得跨此边界持有外部资源。 */
int px_mn7_memory_run(int (*callback)(void *), void *argument,
                      struct px_mn7_memory_stats *stats);
void *px_mn7_malloc(size_t size);
void *px_mn7_calloc(size_t count, size_t size);
void *px_mn7_realloc(void *pointer, size_t size);
char *px_mn7_strdup(const char *text);
void px_mn7_free(void *pointer);
FILE *px_mn7_fopen(const char *path, const char *mode);
void px_mn7_commands_forget(void);
void px_mn7_model_forget(void);

#endif
