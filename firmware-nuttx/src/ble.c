/* 应用级BLE邮箱：有界队列、代次隔离、100ms同步读桥，后台不接触QuickJS。 */
#define _POSIX_C_SOURCE 200809L
#include "pixelbox_ble.h"
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __NuttX__
/* NuttX真实读桥采用单调deadline；宿主不可用后端保持POSIX条件变量时基。 */
#define BLE_WAIT_CLOCK CLOCK_MONOTONIC
#define ble_cond_wait(c,m,d) pthread_cond_clockwait(c,m,CLOCK_MONOTONIC,d)
#else
#define BLE_WAIT_CLOCK CLOCK_REALTIME
#define ble_cond_wait(c,m,d) pthread_cond_timedwait(c,m,d)
#endif

struct px_ble {
  uint32_t generation;
  unsigned head,count;
  size_t bytes;
  int fatal;
  struct px_ble_event events[PX_BLE_EVENT_COUNT];
};
static pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition=PTHREAD_COND_INITIALIZER;
static struct px_ble *current;
static uint32_t generation_counter,read_counter;
static struct {uint32_t generation,request;bool done,ok;size_t length;uint8_t data[PX_BLE_VALUE_BYTES];} reader;
static int hex(char ch){return ch>='0'&&ch<='9'?ch-'0':ch>='a'&&ch<='f'?ch-'a'+10:ch>='A'&&ch<='F'?ch-'A'+10:-1;}
bool px_ble_uuid(const char *input,char output[PX_BLE_UUID_BYTES])
{
  if(!input)return false;
  size_t length=strlen(input);static const char digits[]="0123456789abcdef";
  if(length!=4&&length!=8&&length!=36)return false;
  if(length!=36){memcpy(output,"00000000-0000-1000-8000-00805f9b34fb",37);for(size_t i=0;i<length;i++){int v=hex(input[i]);if(v<0)return false;output[8-length+i]=digits[v];}}
  else for(size_t i=0;i<=36;i++){if(i==8||i==13||i==18||i==23){if(input[i]!='-')return false;output[i]='-';}else if(i==36)output[i]=0;else{int v=hex(input[i]);if(v<0)return false;output[i]=digits[v];}}
  return true;
}
struct px_ble *px_ble_create(void)
{
  struct px_ble *ble=calloc(1,sizeof(*ble));if(!ble)return NULL;
  pthread_mutex_lock(&mutex);if(current){pthread_mutex_unlock(&mutex);free(ble);errno=EBUSY;return NULL;}
  if(!++generation_counter)++generation_counter;
  ble->generation=generation_counter;current=ble;pthread_mutex_unlock(&mutex);return ble;
}
bool px_ble_session_alive(uint32_t generation)
{pthread_mutex_lock(&mutex);bool alive=current&&current->generation==generation&&!current->fatal;pthread_mutex_unlock(&mutex);return alive;}
void px_ble_event_free(struct px_ble_event *event){if(event){free(event->data);memset(event,0,sizeof(*event));}}
void px_ble_destroy(struct px_ble *ble)
{
  if(!ble)return;
  pthread_mutex_lock(&mutex);if(current==ble)current=NULL;
  if(reader.generation==ble->generation){reader.done=true;reader.ok=false;pthread_cond_broadcast(&condition);}
  for(unsigned i=0;i<ble->count;i++)px_ble_event_free(&ble->events[(ble->head+i)%PX_BLE_EVENT_COUNT]);
  pthread_mutex_unlock(&mutex);px_ble_backend_stop(ble->generation,true);free(ble);
}
static int emit_locked(uint32_t generation,const struct px_ble_event *event)
{
  struct px_ble *ble=current;if(!ble||ble->generation!=generation)return -ECANCELED;
  if(ble->fatal)return ble->fatal;
  if((event->length&&!event->data)||event->length>sizeof(struct px_ble_services))return -EINVAL;
  /* 队列溢出不能默默丢弃完成事件，否则Promise永远悬挂；下一次poll使会话失败。 */
  if(ble->count==PX_BLE_EVENT_COUNT||ble->bytes+event->length>32768){ble->fatal=-ENOBUFS;return ble->fatal;}
  struct px_ble_event copy=*event;copy.data=NULL;
  if(event->length){copy.data=malloc(event->length);if(!copy.data){ble->fatal=-ENOMEM;return -ENOMEM;}memcpy(copy.data,event->data,event->length);}
  ble->events[(ble->head+ble->count++)%PX_BLE_EVENT_COUNT]=copy;ble->bytes+=event->length;return 0;
}
int px_ble_emit(uint32_t generation,const struct px_ble_event *event)
{pthread_mutex_lock(&mutex);int rc=emit_locked(generation,event);pthread_mutex_unlock(&mutex);return rc;}
int px_ble_poll(struct px_ble *ble,struct px_ble_event *event)
{
  if(!ble||!event)return -EINVAL;
  pthread_mutex_lock(&mutex);int rc=ble->fatal;
  if(!rc&&ble->count){*event=ble->events[ble->head];memset(&ble->events[ble->head],0,sizeof(*event));ble->head=(ble->head+1)%PX_BLE_EVENT_COUNT;ble->count--;ble->bytes-=event->length;rc=1;}
  pthread_mutex_unlock(&mutex);return rc;
}
bool px_ble_read_bridge(uint32_t generation,uint32_t tag,uint8_t *data,size_t *length)
{
  pthread_mutex_lock(&mutex);if(reader.request||!current||current->generation!=generation){pthread_mutex_unlock(&mutex);return false;}
  if(!++read_counter)++read_counter;
  reader.generation=generation;reader.request=read_counter;reader.done=reader.ok=false;
  struct px_ble_event event={.type=PX_BLE_PERIPHERAL_READ,.tag=tag,.request=reader.request};
  int rc=emit_locked(generation,&event);struct timespec deadline;clock_gettime(BLE_WAIT_CLOCK,&deadline);deadline.tv_nsec+=100000000;
  if(deadline.tv_nsec>=1000000000){deadline.tv_nsec-=1000000000;deadline.tv_sec++;}
  while(!rc&&!reader.done){rc=ble_cond_wait(&condition,&mutex,&deadline);}
  bool ok=!rc&&reader.done&&reader.ok;if(ok){memcpy(data,reader.data,reader.length);*length=reader.length;}
  memset(&reader,0,sizeof(reader));pthread_mutex_unlock(&mutex);return ok;
}
int px_ble_read_reply(struct px_ble *ble,uint32_t request,const uint8_t *data,size_t length,bool ok)
{
  if(!ble||length>PX_BLE_VALUE_BYTES||(length&&!data))return -EINVAL;
  pthread_mutex_lock(&mutex);int rc=0;
  if(reader.generation!=ble->generation||reader.request!=request||reader.done)rc=-ESTALE;
  else{reader.done=true;reader.ok=ok;reader.length=length;if(length)memcpy(reader.data,data,length);pthread_cond_broadcast(&condition);}
  pthread_mutex_unlock(&mutex);return rc;
}
bool px_ble_available(struct px_ble *ble){return ble&&px_ble_session_alive(ble->generation)&&px_ble_backend_available();}
static int ready(struct px_ble *ble){return !ble||!px_ble_session_alive(ble->generation)?-ECANCELED:px_ble_backend_ready();}
int px_ble_peripheral_start(struct px_ble *ble,const struct px_ble_definition *d)
{
  if(!d||!d->service_count||d->service_count>PX_BLE_SERVICES||d->characteristic_count>PX_BLE_CHARACTERISTICS||!memchr(d->name,0,sizeof(d->name)))return -EINVAL;
  char uuid[PX_BLE_UUID_BYTES],previous[PX_BLE_UUID_BYTES];for(unsigned i=0;i<d->service_count;i++){if(!memchr(d->services[i],0,PX_BLE_UUID_BYTES)||!px_ble_uuid(d->services[i],uuid))return -EINVAL;for(unsigned j=0;j<i;j++){px_ble_uuid(d->services[j],previous);if(!strcmp(uuid,previous))return -EEXIST;}}
  for(unsigned i=0;i<d->characteristic_count;i++){const struct px_ble_characteristic *c=&d->characteristics[i];
    if(c->service>=d->service_count||c->length>PX_BLE_VALUE_BYTES||!c->properties||(c->properties&~(PX_BLE_READ|PX_BLE_WRITE|PX_BLE_NOTIFY))||!memchr(c->uuid,0,PX_BLE_UUID_BYTES)||!px_ble_uuid(c->uuid,uuid))return -EINVAL;
    for(unsigned j=0;j<i;j++)if(c->service==d->characteristics[j].service){px_ble_uuid(d->characteristics[j].uuid,previous);if(!strcmp(uuid,previous))return -EEXIST;}}
  int rc=ready(ble);return rc?rc:px_ble_backend_peripheral(ble->generation,d);
}
int px_ble_peripheral_stop(struct px_ble *ble){return ble?px_ble_backend_stop(ble->generation,false):-EINVAL;}
int px_ble_notify(struct px_ble *ble,const char *service,const char *characteristic,const uint8_t *data,size_t length)
{char s[37],c[37];if(length>PX_BLE_VALUE_BYTES||(length&&!data)||!px_ble_uuid(service,s)||!px_ble_uuid(characteristic,c))return -EINVAL;int rc=ready(ble);return rc?rc:px_ble_backend_notify(ble->generation,s,c,data,length);}
int px_ble_scan(struct px_ble *ble,unsigned timeout_ms){if(!timeout_ms||timeout_ms>120000)return -EINVAL;int rc=ready(ble);return rc?rc:px_ble_backend_scan(ble->generation,timeout_ms);}
int px_ble_stop_scan(struct px_ble *ble){return ble?px_ble_backend_scan(ble->generation,0):-EINVAL;}
int px_ble_connect(struct px_ble *ble,const char *id,unsigned timeout_ms,uint32_t *connection)
{if(!id||strlen(id)!=17||!timeout_ms||timeout_ms>120000||!connection)return -EINVAL;for(unsigned i=0;i<17;i++)if(i%3==2?id[i]!=':':hex(id[i])<0)return -EINVAL;int rc=ready(ble);return rc?rc:px_ble_backend_connect(ble->generation,id,timeout_ms,connection);}
int px_ble_disconnect(struct px_ble *ble,uint32_t connection){return ble?px_ble_backend_disconnect(ble->generation,connection):-EINVAL;}
int px_ble_operate(struct px_ble *ble,uint32_t connection,uint32_t request,enum px_ble_operation op,const char *service,const char *characteristic,const uint8_t *data,size_t length,bool flag)
{char s[37]={0},c[37]={0};if(!request||length>PX_BLE_VALUE_BYTES||(length&&!data)||op<PX_BLE_DISCOVER||op>PX_BLE_SUBSCRIBE)return -EINVAL;if(op!=PX_BLE_DISCOVER&&(!px_ble_uuid(service,s)||!px_ble_uuid(characteristic,c)))return -EINVAL;int rc=ready(ble);return rc?rc:px_ble_backend_operate(ble->generation,connection,request,op,s,c,data,length,flag);}
