/* PixelBox NuttX NPL修复：侵入式事件队列，禁止在host自己的满mq上阻塞。
 * 每个事件最多入队一次；节点由NimBLE静态对象或8条命令桥拥有，不额外分配。
 */
#include "nimble/nimble_npl.h"
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __NuttX__
/* 重复唤醒沿用同一单调deadline，系统校时不能延长有限等待。 */
#define BLE_WAIT_CLOCK CLOCK_MONOTONIC
#define ble_cond_wait(c,m,d) pthread_cond_clockwait(c,m,CLOCK_MONOTONIC,d)
#else
#define BLE_WAIT_CLOCK CLOCK_REALTIME
#define ble_cond_wait(c,m,d) pthread_cond_timedwait(c,m,d)
#endif
static pthread_mutex_t queue_mutex=PTHREAD_MUTEX_INITIALIZER;
static struct ble_npl_eventq default_queue;
struct ble_npl_eventq *ble_npl_eventq_dflt_get(void){return &default_queue;}
void ble_npl_eventq_init(struct ble_npl_eventq *queue)
{
  pthread_mutex_lock(&queue_mutex);
  if(!queue->initialized){if(pthread_cond_init(&queue->condition,NULL))abort();queue->head=queue->tail=NULL;queue->initialized=true;}
  pthread_mutex_unlock(&queue_mutex);
}
bool ble_npl_eventq_is_empty(struct ble_npl_eventq *queue)
{pthread_mutex_lock(&queue_mutex);bool empty=queue->head==NULL;pthread_mutex_unlock(&queue_mutex);return empty;}
int ble_npl_eventq_inited(const struct ble_npl_eventq *queue)
{pthread_mutex_lock(&queue_mutex);int initialized=queue->initialized;pthread_mutex_unlock(&queue_mutex);return initialized;}
void ble_npl_eventq_put(struct ble_npl_eventq *queue,struct ble_npl_event *event)
{
  pthread_mutex_lock(&queue_mutex);if(!queue->initialized)abort();
  if(!event->ev_queued){event->ev_queued=1;event->ev_owner=queue;event->ev_next=NULL;if(queue->tail)queue->tail->ev_next=event;else queue->head=event;queue->tail=event;pthread_cond_signal(&queue->condition);}
  pthread_mutex_unlock(&queue_mutex);
}
struct ble_npl_event *ble_npl_eventq_get(struct ble_npl_eventq *queue,ble_npl_time_t timeout)
{
  pthread_mutex_lock(&queue_mutex);if(!queue->initialized)abort();
  struct timespec until={0};if(timeout!=BLE_NPL_TIME_FOREVER&&timeout){clock_gettime(BLE_WAIT_CLOCK,&until);until.tv_sec+=timeout/1000;until.tv_nsec+=(long)(timeout%1000)*1000000;if(until.tv_nsec>=1000000000){until.tv_nsec-=1000000000;until.tv_sec++;}}
  int rc=0;while(!queue->head&&timeout&&!rc)rc=timeout==BLE_NPL_TIME_FOREVER?pthread_cond_wait(&queue->condition,&queue_mutex):ble_cond_wait(&queue->condition,&queue_mutex,&until);
  struct ble_npl_event *event=queue->head;
  if(event){queue->head=event->ev_next;if(!queue->head)queue->tail=NULL;event->ev_queued=0;event->ev_next=NULL;event->ev_owner=NULL;}
  pthread_mutex_unlock(&queue_mutex);return event;
}
void ble_npl_eventq_run(struct ble_npl_eventq *queue)
{struct ble_npl_event *event=ble_npl_eventq_get(queue,BLE_NPL_TIME_FOREVER);if(event)ble_npl_event_run(event);}
void ble_npl_event_init(struct ble_npl_event *event,ble_npl_event_fn *callback,void *argument)
{memset(event,0,sizeof(*event));event->ev_cb=callback;event->ev_arg=argument;}
bool ble_npl_event_is_queued(struct ble_npl_event *event)
{pthread_mutex_lock(&queue_mutex);bool queued=event->ev_queued;pthread_mutex_unlock(&queue_mutex);return queued;}
void *ble_npl_event_get_arg(struct ble_npl_event *event){return event->ev_arg;}
void ble_npl_event_set_arg(struct ble_npl_event *event,void *argument){event->ev_arg=argument;}
void ble_npl_event_run(struct ble_npl_event *event){if(!event||!event->ev_cb)abort();event->ev_cb(event);}
void ble_npl_eventq_remove(struct ble_npl_eventq *queue,struct ble_npl_event *event)
{
  pthread_mutex_lock(&queue_mutex);
  if(event->ev_owner==queue){struct ble_npl_event *previous=NULL,*cursor=queue->head;while(cursor&&cursor!=event){previous=cursor;cursor=cursor->ev_next;}
    if(cursor){if(previous)previous->ev_next=cursor->ev_next;else queue->head=cursor->ev_next;if(queue->tail==cursor)queue->tail=previous;cursor->ev_queued=0;cursor->ev_next=NULL;cursor->ev_owner=NULL;}}
  pthread_mutex_unlock(&queue_mutex);
}
