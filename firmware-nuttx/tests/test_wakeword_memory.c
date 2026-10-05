/* 使用真实 NuttX allocator、真实 cJSON 和目录代码；Xtensa 推理仍须真机验证。 */
#include "pixelbox_mn7_memory.h"
#include "pixelbox_mn7_abi.h"
#include "pixelbox_sha256.h"
#include "wakeword_memory_backend.h"
#include "cJSON.h"
#include <nuttx/mm/mm.h>
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void *heap_caps_malloc(size_t,uint32_t);
void *heap_caps_calloc(size_t,size_t,uint32_t);
void *heap_caps_aligned_alloc(size_t,size_t,uint32_t);
void heap_caps_free(void *);
void *xQueueCreateMutex(unsigned char);
int xQueueSemaphoreTake(void *,uint32_t);
int xQueueGenericSend(void *,const void *,uint32_t,int);
void vQueueDelete(void *);
enum { SPIRAM=1<<10, INTERNAL=1<<11, DMA=1<<3 };
static int reached, mode;
static uint8_t *archive;
static size_t archive_bytes;
static uint8_t archive_hash[32];

static void assert_released(const struct px_mn7_memory_stats *stats)
{
  assert(!stats->live_blocks && !stats->psram_live && !stats->internal_live && !stats->overhead_live);
  assert(!stats->cleanup_error && !px_test_backing_live && !px_test_internal_live);
  assert(!get_static_srmodels());
  for (unsigned i=0;i<6;++i) assert(!px_test_library_state[i]);
}
static int empty(void *unused) { (void)unused; ++reached; return 0; }
static void test_real_heap(void)
{
  void *arena; assert(!posix_memalign(&arena,16,256*1024));
  struct mm_heap_s *heap=mm_initialize("real-test",arena,256*1024); assert(heap);
  struct mallinfo initial=mm_mallinfo(heap);
  void *blocks[120];
  for (unsigned i=0;i<120;++i) {
    size_t align=(size_t)16<<(i%5),size=47+i*3;
    blocks[i]=mm_memalign(heap,align,size); assert(blocks[i] && !((uintptr_t)blocks[i]%align));
    assert(mm_malloc_size(heap,blocks[i])>=size); memset(blocks[i],0x5a,size);
  }
  for (unsigned i=0;i<120;i+=2) mm_free(heap,blocks[i]);
  struct mallinfo fragmented=mm_mallinfo(heap); assert(fragmented.ordblks>1);
  for (unsigned i=1;i<120;i+=2) mm_free(heap,blocks[i]);
  struct mallinfo restored=mm_mallinfo(heap);
  assert(restored.uordblks==initial.uordblks && restored.mxordblk==initial.mxordblk);
  assert(restored.usmblks>initial.uordblks && !mm_malloc(heap,SIZE_MAX));
  mm_uninitialize(heap); free(arena);
}
static int basic(void *unused)
{
  (void)unused;
  for (unsigned i=0;i<1000;++i) {
    size_t alignment=(size_t)16<<(i%4);
    void *p=heap_caps_aligned_alloc(alignment,5+i%79,SPIRAM);
    assert(p && !((uintptr_t)p%alignment) && !px_mn7_test_internal_member(p)); px_mn7_free(p);
  }
  uint8_t *p=px_mn7_calloc(31,7); for (unsigned i=0;i<217;++i) assert(!p[i]);
  memset(p,0x71,217); p=px_mn7_realloc(p,401);
  for (unsigned i=0;i<217;++i) assert(p[i]==0x71);
  p=px_mn7_realloc(p,8); for (unsigned i=0;i<8;++i) assert(p[i]==0x71);
  assert(!px_mn7_realloc(p,0));
  char *s=px_mn7_strdup("ni hao"); assert(!strcmp(s,"ni hao")); px_mn7_free(s);
  p=heap_caps_malloc(123,INTERNAL|DMA); assert(px_mn7_test_internal_member(p));
  p=px_mn7_realloc(p,175); assert(px_mn7_test_internal_member(p)); heap_caps_free(p);
  /* 三种真实释放路由：子堆、调用者普通块、外部独立 IMEM 块。 */
  heap_caps_free(malloc(77)); heap_caps_free(px_mn7_test_internal_allocate(16,55));
  return 0;
}
static int invalid(void *unused)
{
  (void)unused;
  if (mode==0) heap_caps_calloc(SIZE_MAX,2,SPIRAM);
  if (mode==1) heap_caps_aligned_alloc(3,4,SPIRAM);
  if (mode==2) heap_caps_malloc(16,SPIRAM|INTERNAL);
  if (mode==3) heap_caps_malloc(16,1u<<31);
  if (mode==4) px_mn7_fopen("must-not-open","rb");
  if (mode==5) { void *p=px_mn7_malloc(17); px_mn7_free(p); px_mn7_free(p); }
  if (mode==6) heap_caps_aligned_alloc((SIZE_MAX>>1)+1,SIZE_MAX,0);
  if (mode==7) xQueueCreateMutex(2);
  reached=1; return 0;
}
static int exhausting(void *unused)
{
  (void)unused;
  for (;;) {
    /* 必须在首条未经检查的写入前退出，绝不让原库收到 NULL。 */
    uint8_t *p=heap_caps_malloc(65536,SPIRAM); p[0]=1; ++reached;
  }
}
static int held_lock_failure(void *unused)
{
  (void)unused;
  void *mutex=xQueueCreateMutex(1); assert(xQueueSemaphoreTake(mutex,UINT32_MAX));
  for (unsigned i=0;i<6;++i) px_test_library_state[i]=px_mn7_malloc(19+i);
  heap_caps_malloc(333,INTERNAL|DMA);
  uint8_t *p=px_mn7_malloc(PX_MN7_WORKSPACE_BYTES); *p=5; reached=1; return 0;
}
static int internal_failure(void *unused)
{
  (void)unused;
  px_mn7_malloc(11); uint8_t *p=heap_caps_malloc(99,INTERNAL); *p=5; reached=1; return 0;
}
static int parse_json(void *unused)
{
  (void)unused;
  cJSON *root=cJSON_Parse("{\"model\":\"mn7_cn\",\"tokens\":[1,2,3,{\"pinyin\":\"ni hao\"}]}");
  assert(root && cJSON_GetObjectItem(root,"tokens"));
  cJSON_Delete(root); ++reached; return 0;
}
static int load_directory(void *unused)
{
  (void)unused;
  int result=px_mn7_model_load(archive,archive_bytes,archive_hash); assert(!result && get_static_srmodels());
  px_mn7_model_unload(); ++reached; return 0;
}
static int check_phrase(model_iface_data_t *data,const char *s) { (void)data; return *s!=0; }
static esp_mn_error_t *set_commands(model_iface_data_t *data,esp_mn_node_t *node)
{
  (void)data; assert(node->next && node->next->next); static esp_mn_error_t ok; return &ok;
}
static int command_graph(void *unused)
{
  (void)unused;
  static int token;
  static const esp_mn_iface_t api={.check_speech_command=check_phrase,.set_speech_commands=set_commands};
  assert(!esp_mn_commands_alloc(&api,(model_iface_data_t *)&token));
  assert(!esp_mn_commands_add(1,"ni hao"));
  assert(!esp_mn_commands_phoneme_add(2,"zai jian","z ai j ian"));
  assert(!esp_mn_commands_update()); esp_mn_commands_free(); ++reached; return 0;
}
static void fail_each_allocation(int (*callback)(void *))
{
  struct px_mn7_memory_stats stats;
  px_test_allocation_calls=0; reached=0; assert(!px_mn7_memory_run(callback,NULL,&stats));
  int total=px_test_allocation_calls; assert(total>0 && reached==1); assert_released(&stats);
  for (int i=0;i<total;++i) {
    px_test_allocation_calls=0; px_test_fail_at=i; reached=0;
    assert(px_mn7_memory_run(callback,NULL,&stats)==-ENOMEM && !reached);
    assert_released(&stats);
    px_test_fail_at=-1; px_test_allocation_calls=0;
    assert(!px_mn7_memory_run(callback,NULL,&stats) && reached==1); assert_released(&stats);
  }
  printf("PASS %d allocation failure positions plus recovery\n",total);
}
static int nested(void *unused)
{
  (void)unused; struct px_mn7_memory_stats stats;
  assert(px_mn7_memory_run(empty,NULL,&stats)==-EBUSY); return 0;
}
static void *concurrent_run(void *unused)
{
  (void)unused; struct px_mn7_memory_stats stats;
  assert(px_mn7_memory_run(empty,NULL,&stats)==-EBUSY); return NULL;
}
static int concurrent(void *unused)
{
  (void)unused; pthread_t thread;
  assert(!pthread_create(&thread,NULL,concurrent_run,NULL)); assert(!pthread_join(thread,NULL)); return 0;
}
static int left_mutex(void *unused)
{
  (void)unused; assert(xQueueCreateMutex(1)); return 0;
}
int main(int argc,char **argv)
{
  if (argc==2 && !strcmp(argv[1],"quarantine")) {
    struct px_mn7_memory_stats stats;
    px_test_mutex_destroy_fail=true;
    assert(px_mn7_memory_run(left_mutex,NULL,&stats)==-EBUSY);
    assert(stats.cleanup_error==-EBUSY && stats.live_blocks==1 && px_test_backing_live==1);
    assert(px_mn7_memory_run(empty,NULL,&stats)==-EBUSY);
    puts("PASS unconfirmed mutex destruction retains backing and rejects restart"); return 0;
  }
  assert(argc==2); FILE *file=fopen(argv[1],"rb"); assert(file);
  assert(!fseek(file,0,SEEK_END)); archive_bytes=(size_t)ftell(file); rewind(file);
  archive=malloc(archive_bytes); assert(archive && fread(archive,1,archive_bytes,file)==archive_bytes); fclose(file);
  px_sha256(archive,archive_bytes,archive_hash);
  test_real_heap(); struct px_mn7_memory_stats stats;
  for (int i=1;i<=2;++i) {
    px_test_backing_mode=i; reached=0; int calls=px_test_backing_calls;
    assert(px_mn7_memory_run(empty,NULL,&stats)==(i==1 ? -ENOMEM : -EFAULT));
    assert(!reached && px_test_backing_calls==calls+1); assert_released(&stats);
  }
  px_test_backing_mode=0;
  assert(!px_mn7_memory_run(basic,NULL,&stats)); assert_released(&stats);
  assert(stats.psram_peak>=217 && stats.internal_peak>=123 && stats.overhead_peak>0 && stats.heap_peak>stats.heap_initial);
  for (mode=0;mode<8;++mode) {
    reached=0; int error=(mode==0 || mode==6) ? -EOVERFLOW : mode==4 ? -ENOTSUP : -EINVAL;
    assert(px_mn7_memory_run(invalid,NULL,&stats)==error && !reached); assert_released(&stats);
  }
  reached=0; assert(px_mn7_memory_run(exhausting,NULL,&stats)==-ENOMEM);
  assert(reached>10 && reached<64 && stats.reclaimed==(size_t)reached);
  assert(stats.failed_size==65536 && stats.failed_caps==SPIRAM && stats.heap_largest<65536);
  assert_released(&stats);
  for (unsigned i=0;i<3;++i) {
    reached=0; assert(px_mn7_memory_run(held_lock_failure,NULL,&stats)==-ENOMEM && !reached);
    assert(stats.reclaimed==7 && stats.internal_peak==333); assert_released(&stats);
    assert(!px_mn7_memory_run(basic,NULL,&stats)); assert_released(&stats);
  }
  px_test_internal_fail=true; reached=0;
  assert(px_mn7_memory_run(internal_failure,NULL,&stats)==-ENOMEM && !reached && stats.failed_caps==INTERNAL);
  assert_released(&stats); px_test_internal_fail=false;
  fail_each_allocation(parse_json); fail_each_allocation(load_directory); fail_each_allocation(command_graph);
  assert(!px_mn7_memory_run(nested,NULL,&stats)); assert_released(&stats);
  assert(!px_mn7_memory_run(concurrent,NULL,&stats)); assert_released(&stats);
  assert(!px_mn7_malloc(1) && errno==EPERM);
  free(archive);
  puts("PASS real NuttX heap fragmentation/alignment, bounded PSRAM, OOM guard, held mutex cleanup, allocator routing and restart");
  return 0;
}
