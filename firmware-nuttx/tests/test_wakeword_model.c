#include "pixelbox_mn7_abi.h"
#include "pixelbox_mn7_memory.h"
#include "pixelbox_sha256.h"
#include <assert.h>
#include <errno.h>
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

static void put32(uint8_t *p,uint32_t n) { for (int i=0;i<4;++i) p[i]=(uint8_t)(n>>(8*i)); }
static int load(uint8_t *p,size_t n) { uint8_t hash[32]; px_sha256(p,n,hash); return px_mn7_model_load(p,n,hash); }
struct test_archive { uint8_t *bytes, *work; size_t size; };
static int exercise(void *argument)
{
  struct test_archive *input=argument;
  uint8_t *bytes=input->bytes,*work=input->work,hash[32]; size_t size=input->size;
  px_sha256(bytes,size,hash);
  assert(!px_mn7_model_load(bytes,size,hash)); srmodel_list_t *m=get_static_srmodels();
  assert(m && m->num==2 && !m->partition && !m->mmap_handle && !get_model_base_path());
  assert(!strcmp(m->model_name[0],"mn7_cn") && m->model_data[0]->num==4 && m->model_info[0]);
  assert(m->model_data[0]->data[0] >= (char *)bytes && m->model_data[0]->data[0] < (char *)bytes+size);
  memcpy(work,bytes,size); assert(px_mn7_model_load(work,size,hash)==-EBUSY);
  px_mn7_model_unload(); assert(!get_static_srmodels());
  bytes[size-1]^=1; assert(px_mn7_model_load(bytes,size,hash)==-EBADMSG); bytes[size-1]^=1;
  for (int kind=0;kind<8;++kind) {
    memcpy(work,bytes,size);
    if (kind==0) put32(work,UINT32_MAX);
    if (kind==1) memset(work+4,'x',32);
    if (kind==2) put32(work+36,UINT32_MAX);
    if (kind==3) put32(work+40+32,UINT32_MAX);
    if (kind==4) put32(work+40+36,UINT32_MAX);
    if (kind==5) put32(work+40+32,4);
    if (kind==6) memcpy(work+40,"missing",8);
    if (kind==7) memcpy(work+80,work+40,32);
    assert(load(work,size)==-EBADMSG && !get_static_srmodels());
  }
  assert(!load(bytes,size)); px_mn7_model_unload(); px_mn7_model_unload();
  void *p=heap_caps_aligned_alloc(32,73,1u<<10); assert(p && !((uintptr_t)p%32)); heap_caps_free(p);
  p=heap_caps_calloc(17,3,0); assert(p); for (int i=0;i<51;++i) assert(((uint8_t *)p)[i]==0); heap_caps_free(p);
  p=heap_caps_malloc(37,(1u<<12)|(1u<<20)); assert(p && !((uintptr_t)p%16)); heap_caps_free(p);
  void *queue=xQueueCreateMutex(1); assert(queue);
  assert(xQueueSemaphoreTake(queue,UINT32_MAX)); assert(!xQueueSemaphoreTake(queue,0));
  assert(!xQueueSemaphoreTake(queue,1)); assert(!xQueueGenericSend(queue,(void *)1,0,0));
  assert(xQueueGenericSend(queue,NULL,0,0)); assert(xQueueSemaphoreTake(queue,0));
  assert(xQueueGenericSend(queue,NULL,0,0)); vQueueDelete(queue);
  return 0;
}
int main(int argc,char **argv)
{
  assert(argc==2); FILE *f=fopen(argv[1],"rb"); assert(f); assert(!fseek(f,0,SEEK_END));
  long length=ftell(f); assert(length>0); rewind(f); size_t size=(size_t)length;
  uint8_t *bytes=malloc(size),*work=malloc(size); assert(bytes && work);
  assert(fread(bytes,1,size,f)==size); fclose(f);
  struct test_archive input={bytes,work,size}; struct px_mn7_memory_stats stats;
  assert(!px_mn7_memory_run(exercise,&input,&stats));
  assert(stats.live_blocks==0 && stats.reclaimed==0 && !get_static_srmodels());
  free(bytes); free(work); puts("PASS real MN7 archive SHA256, bounds, ABI directory and mutex/allocator contracts"); return 0;
}
