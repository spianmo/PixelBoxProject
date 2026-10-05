#define _POSIX_C_SOURCE 200809L
#include "pixelbox_ble.h"
#include "quickjs.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
void px_install_ble(JSContext *,JSValue);
/* 此适配器模拟无线对端，验证真实C邮箱/QuickJS协议；不把它作为射频验证。 */
static uint32_t generation,token=100,connected;
static bool available=true,hold;
static unsigned operations,subscriptions,ready_calls;
static int fail_ready;
static uint8_t cached[512];static size_t cached_length;
static char service_uuid[37],characteristic_uuid[37];
bool px_ble_backend_available(void){return available;}
int px_ble_backend_ready(void){ready_calls++;if(fail_ready){available=false;return fail_ready;}return available?0:-ENOTSUP;}
int px_ble_backend_stop(uint32_t g,bool all){(void)g;if(all)connected=0;return 0;}
int px_ble_backend_peripheral(uint32_t g,const struct px_ble_definition *d)
{generation=g;assert(d->service_count==1&&d->characteristic_count==1);assert(!strcmp(d->services[0],service_uuid));cached_length=d->characteristics[0].length;memcpy(cached,d->characteristics[0].value,cached_length);return 0;}
int px_ble_backend_notify(uint32_t g,const char *s,const char *c,const uint8_t *d,size_t n)
{assert(!strcmp(s,service_uuid)&&!strcmp(c,characteristic_uuid));struct px_ble_event e={.type=PX_BLE_PERIPHERAL_WRITE,.tag=0,.data=(uint8_t *)d,.length=n};return px_ble_emit(g,&e);}
int px_ble_backend_scan(uint32_t g,unsigned timeout)
{
  generation=g;if(timeout){uint8_t m[]={1,2};struct px_ble_event e={.type=PX_BLE_SCAN,.rssi=-60,.has_manufacturer=true,.data=m,.length=2};memcpy(e.id,"01:02:03:04:05:06",18);px_ble_emit(g,&e);
    e.has_name=true;memcpy(e.name,"first",6);e.rssi=-40;px_ble_emit(g,&e);memcpy(e.id,"01:02:03:04:05:07",18);memcpy(e.name,"second",7);px_ble_emit(g,&e);}
  struct px_ble_event done={.type=PX_BLE_SCAN_DONE};return px_ble_emit(g,&done);
}
int px_ble_backend_connect(uint32_t g,const char *id,unsigned timeout,uint32_t *out)
{(void)id;(void)timeout;generation=g;connected=++token;*out=connected;struct px_ble_event e={.type=PX_BLE_CONNECTED,.connection=connected};return px_ble_emit(g,&e);}
int px_ble_backend_disconnect(uint32_t g,uint32_t c)
{connected=0;struct px_ble_event e={.type=PX_BLE_DISCONNECTED,.connection=c};return px_ble_emit(g,&e);}
int px_ble_backend_operate(uint32_t g,uint32_t c,uint32_t r,enum px_ble_operation op,const char *s,const char *h,const uint8_t *d,size_t n,bool f)
{
  assert(c==connected);operations++;if(hold)return 0;struct px_ble_event e={.type=PX_BLE_RESULT,.connection=c,.request=r,.tag=op};struct px_ble_services services={0};
  if(op==PX_BLE_DISCOVER){services.service_count=1;services.characteristic_count=1;memcpy(services.services[0].uuid,service_uuid,37);services.services[0].count=1;memcpy(services.characteristics[0].uuid,characteristic_uuid,37);services.characteristics[0].properties=PX_BLE_READ|PX_BLE_WRITE|PX_BLE_NOTIFY;e.data=(uint8_t *)&services;e.length=sizeof(services);}
  else {assert(!strcmp(s,service_uuid)&&!strcmp(h,characteristic_uuid));if(op==PX_BLE_READ_VALUE){e.data=cached;e.length=cached_length;}else if(op==PX_BLE_WRITE_VALUE){cached_length=n;memcpy(cached,d,n);}else if(op==PX_BLE_SUBSCRIBE){subscriptions+=f?1:(unsigned)-1;}}
  return px_ble_emit(g,&e);
}
struct bridge {uint32_t generation;bool ok;uint8_t data[512];size_t length;};
static void *read_bridge(void *argument){struct bridge *bridge=argument;bridge->ok=px_ble_read_bridge(bridge->generation,0,bridge->data,&bridge->length);return NULL;}
static struct px_ble_event await_event(struct px_ble *ble)
{struct px_ble_event event;for(unsigned i=0;i<1000;i++){if(px_ble_poll(ble,&event)==1)return event;struct timespec wait={0,1000000};nanosleep(&wait,NULL);}assert(0);return event;}
static void core_test(void)
{
  char uuid[37];assert(px_ble_uuid("180D",uuid)&&!strcmp(uuid,"0000180d-0000-1000-8000-00805f9b34fb"));assert(!px_ble_uuid("not-a-uuid",uuid));
  struct px_ble *ble=px_ble_create();assert(ble);assert(!px_ble_create()&&errno==EBUSY);
  /* 查询不得启动后端；只有有效操作调用ready，失败状态必须体现在后续查询中。 */
  assert(!px_ble_available(NULL)&&px_ble_available(ble)&&px_ble_available(ble)&&!ready_calls);
  fail_ready=-EIO;assert(px_ble_scan(ble,10)==-EIO&&ready_calls==1&&!px_ble_available(ble));
  fail_ready=0;available=true;assert(px_ble_scan(ble,10)==0&&ready_calls==2);
  struct px_ble_event event;while(px_ble_poll(ble,&event)>0)px_ble_event_free(&event);
  struct px_ble_definition *definition=calloc(1,sizeof(*definition));assert(definition);definition->service_count=2;strcpy(definition->services[0],"180D");strcpy(definition->services[1],service_uuid);assert(px_ble_peripheral_start(ble,definition)==-EEXIST);
  definition->service_count=1;definition->characteristic_count=2;definition->characteristics[0].properties=definition->characteristics[1].properties=PX_BLE_READ;strcpy(definition->characteristics[0].uuid,"2A37");strcpy(definition->characteristics[1].uuid,characteristic_uuid);assert(px_ble_peripheral_start(ble,definition)==-EEXIST);free(definition);
  struct bridge bridge={.generation=generation};pthread_t thread;assert(!pthread_create(&thread,NULL,read_bridge,&bridge));event=await_event(ble);assert(event.type==PX_BLE_PERIPHERAL_READ);uint8_t data[]={4,5,6};assert(!px_ble_read_reply(ble,event.request,data,3,true));pthread_join(thread,NULL);assert(bridge.ok&&bridge.length==3&&!memcmp(bridge.data,data,3));assert(px_ble_read_reply(ble,event.request,data,3,true)==-ESTALE);px_ble_event_free(&event);
  bridge=(struct bridge){.generation=generation};assert(!pthread_create(&thread,NULL,read_bridge,&bridge));event=await_event(ble);pthread_join(thread,NULL);assert(!bridge.ok);assert(px_ble_read_reply(ble,event.request,data,3,true)==-ESTALE);px_ble_event_free(&event);
  bridge=(struct bridge){.generation=generation};assert(!pthread_create(&thread,NULL,read_bridge,&bridge));event=await_event(ble);uint32_t old=generation;px_ble_destroy(ble);pthread_join(thread,NULL);assert(!bridge.ok);px_ble_event_free(&event);
  ble=px_ble_create();assert(ble);struct px_ble_event empty={.type=PX_BLE_SCAN_DONE};assert(px_ble_emit(old,&empty)==-ECANCELED);px_ble_scan(ble,10);while(px_ble_poll(ble,&event)>0)px_ble_event_free(&event);
  for(unsigned i=0;i<PX_BLE_EVENT_COUNT;i++)assert(!px_ble_emit(generation,&empty));assert(px_ble_emit(generation,&empty)==-ENOBUFS);assert(px_ble_poll(ble,&event)==-ENOBUFS);assert(!px_ble_available(ble));px_ble_destroy(ble);
  puts("BLE C核心通过：查询无启动副作用、命令按需启动、启动失败不可用、UUID、100ms读桥/超时/退出、代次隔离、32条有界邮箱");
}
static pthread_t javascript_reader;static struct bridge javascript_bridge;static bool reader_running;
static JSValue control(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;int command=0;if(!argc||JS_ToInt32(ctx,&command,argv[0]))return JS_EXCEPTION;
  if(command==1){struct px_ble_event e={.type=PX_BLE_NOTIFICATION,.connection=connected,.data=cached,.length=cached_length};memcpy(e.service,service_uuid,37);memcpy(e.characteristic,characteristic_uuid,37);assert(!px_ble_emit(generation,&e));}
  if(command==2){javascript_bridge=(struct bridge){.generation=generation};reader_running=true;assert(!pthread_create(&javascript_reader,NULL,read_bridge,&javascript_bridge));}
  if(command==3){assert(reader_running);pthread_join(javascript_reader,NULL);reader_running=false;return JS_NewArrayBufferCopy(ctx,javascript_bridge.data,javascript_bridge.ok?javascript_bridge.length:0);}
  if(command==4){hold=true;return JS_UNDEFINED;}
  if(command==5){hold=false;return JS_UNDEFINED;}
  if(command==6){struct px_ble_event e={.type=PX_BLE_PERIPHERAL_CONNECT};memcpy(e.id,"01:02:03:04:05:06",18);px_ble_emit(generation,&e);e.type=PX_BLE_PERIPHERAL_DISCONNECT;px_ble_emit(generation,&e);}
  if(command==7){available=false;return JS_UNDEFINED;}
  if(command==8){available=true;return JS_UNDEFINED;}
  if(command==10)return JS_NewUint32(ctx,ready_calls);
  return JS_NewUint32(ctx,command==9?subscriptions:operations);
}
static int exception(JSContext *ctx,JSValue value)
{if(!JS_IsException(value)){JS_FreeValue(ctx,value);return 0;}JSValue error=JS_GetException(ctx),stack=JS_GetPropertyStr(ctx,error,"stack");const char *message=JS_ToCString(ctx,error),*trace=JS_ToCString(ctx,stack);fprintf(stderr,"%s\n%s\n",message?message:"JS error",trace?trace:"");JS_FreeCString(ctx,message);JS_FreeCString(ctx,trace);JS_FreeValue(ctx,stack);JS_FreeValue(ctx,error);return 1;}
int main(int argc,char **argv)
{
  assert(argc==2);px_ble_uuid("180d",service_uuid);px_ble_uuid("2a37",characteristic_uuid);core_test();ready_calls=0;
  FILE *file=fopen(argv[1],"rb");assert(file);assert(!fseek(file,0,SEEK_END));long size=ftell(file);assert(size>=0&&!fseek(file,0,SEEK_SET));char *source=malloc((size_t)size+1);assert(source&&fread(source,1,(size_t)size,file)==(size_t)size);fclose(file);source[size]=0;
  JSRuntime *runtime=JS_NewRuntime();JS_SetMaxStackSize(runtime,1024*1024);JS_SetMemoryLimit(runtime,16*1024*1024);JSContext *ctx=JS_NewContext(runtime);JSValue global=JS_GetGlobalObject(ctx),native=JS_NewObject(ctx);px_install_ble(ctx,native);JS_SetPropertyStr(ctx,native,"testControl",JS_NewCFunction(ctx,control,"testControl",1));JS_SetPropertyStr(ctx,global,"native",native);
  int failed=exception(ctx,JS_Eval(ctx,source,(size_t)size,argv[1],JS_EVAL_TYPE_GLOBAL));free(source);
  for(unsigned i=0;!failed&&i<15000;i++){JSContext *job;while(JS_IsJobPending(runtime))if(JS_ExecutePendingJob(runtime,&job)<0){failed=exception(job,JS_EXCEPTION);break;}if(failed)break;JSValue complete=JS_GetPropertyStr(ctx,global,"testComplete");int done=JS_ToBool(ctx,complete);JS_FreeValue(ctx,complete);if(done)break;failed=exception(ctx,JS_Eval(ctx,"testTick()",10,"tick",JS_EVAL_TYPE_GLOBAL));struct timespec delay={0,1000000};nanosleep(&delay,NULL);}
  JSValue complete=JS_GetPropertyStr(ctx,global,"testComplete"),error=JS_GetPropertyStr(ctx,global,"testError");if(!JS_ToBool(ctx,complete)||!JS_IsUndefined(error)){const char *message=JS_ToCString(ctx,error);fprintf(stderr,"BLE test failed: %s\n",message?message:"timeout");JS_FreeCString(ctx,message);failed=1;}JS_FreeValue(ctx,complete);JS_FreeValue(ctx,error);JS_FreeValue(ctx,global);JS_FreeContext(ctx);JS_FreeRuntime(runtime);
  if(reader_running)pthread_join(javascript_reader,NULL);if(!failed)puts("BLE真实QuickJS协议通过：peripheral读写/通知、扫描合并、central发现/队列/订阅/断开、退出清理；无线对端为测试替身");return failed;
}
