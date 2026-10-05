#include "wakeword_memory_backend.h"
#include "pixelbox_mn7_memory.h"
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int px_test_backing_mode, px_test_fail_at = -1, px_test_allocation_calls;
int px_test_backing_calls, px_test_backing_live, px_test_internal_live, px_test_resets;
bool px_test_internal_fail;
bool px_test_mutex_destroy_fail;
void *px_test_library_state[6];
static void *backing;
struct internal { void *pointer; size_t size; struct internal *next; };
static struct internal *internals;

void *px_mn7_test_backing_allocate(size_t size)
{
  assert(size == PX_MN7_WORKSPACE_BYTES && !backing);
  ++px_test_backing_calls;
  if (px_test_backing_mode == 1) return NULL;
  assert(!posix_memalign(&backing, 16, size)); ++px_test_backing_live; return backing;
}
uintptr_t px_mn7_test_psram_address(const void *p)
{
  assert(p == backing);
  /* mode=2 表示首地址合法、末地址越界；必须校验整个 backing 区间。 */
  return px_test_backing_mode == 2 ? 0x3dffffffu : 0x3c000000u;
}
void px_mn7_test_backing_free(void *p)
{
  assert(p == backing && px_test_backing_live == 1); free(p); backing = NULL; --px_test_backing_live;
}
void *px_mn7_test_internal_allocate(size_t alignment, size_t size)
{
  if (px_test_internal_fail) return NULL;
  struct internal *entry = malloc(sizeof(*entry)); assert(entry);
  assert(!posix_memalign(&entry->pointer, alignment, size)); entry->size = size;
  entry->next = internals; internals = entry; ++px_test_internal_live; return entry->pointer;
}
bool px_mn7_test_internal_member(void *p)
{
  for (struct internal *entry = internals; entry; entry = entry->next)
    if ((uintptr_t)p >= (uintptr_t)entry->pointer && (uintptr_t)p - (uintptr_t)entry->pointer < entry->size) return true;
  return false;
}
void px_mn7_test_internal_free(void *p)
{
  struct internal **link = &internals;
  while (*link && (*link)->pointer != p) link = &(*link)->next;
  assert(*link); struct internal *entry = *link; *link = entry->next;
  free(entry->pointer); free(entry); --px_test_internal_live;
}
bool px_mn7_test_allocation_fail(void)
{
  return px_test_allocation_calls++ == px_test_fail_at;
}
void px_mn7_cjson_state_reset(void);
void px_mn7_library_state_reset(void)
{
  ++px_test_resets; memset(px_test_library_state, 0, sizeof(px_test_library_state));
  px_mn7_cjson_state_reset();
}
