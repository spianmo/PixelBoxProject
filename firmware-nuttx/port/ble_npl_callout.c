/* 修复单pending指针覆盖、一次性timer的active状态、剩余毫秒计算和NTP跳时。
 * SIGEV_THREAD只投递事件，不在系统工作队列中执行蓝牙host回调。
 */
#include "nimble/nimble_npl.h"
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static pthread_mutex_t timer_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t fallback_once=PTHREAD_ONCE_INIT;
static struct ble_npl_eventq fallback_queue;
static void *fallback_thread(void *argument)
{(void)argument;for(;;){struct ble_npl_event *event=ble_npl_eventq_get(&fallback_queue,BLE_NPL_TIME_FOREVER);if(event)ble_npl_event_run(event);}return NULL;}
static void initialize_fallback(void)
{
  ble_npl_eventq_init(&fallback_queue);pthread_attr_t attributes;int rc=pthread_attr_init(&attributes);if(rc)abort();
  rc=pthread_attr_setstacksize(&attributes,CONFIG_NIMBLE_CALLOUT_THREAD_STACKSIZE);if(!rc)rc=pthread_attr_setdetachstate(&attributes,PTHREAD_CREATE_DETACHED);
  pthread_t thread;if(!rc)rc=pthread_create(&thread,&attributes,fallback_thread,NULL);pthread_attr_destroy(&attributes);if(rc)abort();
}
static struct ble_npl_eventq *target_queue(struct ble_npl_callout *callout)
{return callout->c_evq?callout->c_evq:&fallback_queue;}
static void timer_expired(union sigval value)
{
  struct ble_npl_callout *callout=value.sival_ptr;pthread_mutex_lock(&timer_mutex);
  /* reset之后到达的旧SIGEV工作项不能让新timer提前触发。 */
  if(callout->c_active&&(int32_t)(ble_npl_time_get()-callout->c_ticks)>=0){callout->c_active=false;ble_npl_eventq_put(target_queue(callout),&callout->c_ev);}
  pthread_mutex_unlock(&timer_mutex);
}
void ble_npl_callout_init(struct ble_npl_callout *callout,struct ble_npl_eventq *queue,ble_npl_event_fn *callback,void *argument)
{
  if(!queue&&pthread_once(&fallback_once,initialize_fallback))abort();
  memset(callout,0,sizeof(*callout));ble_npl_event_init(&callout->c_ev,callback,argument);callout->c_evq=queue;
  struct sigevent event={0};event.sigev_notify=SIGEV_THREAD;event.sigev_value.sival_ptr=callout;event.sigev_notify_function=timer_expired;
  callout->c_inited=timer_create(CLOCK_MONOTONIC,&event,&callout->c_timer)==0;
}
bool ble_npl_callout_is_active(struct ble_npl_callout *callout)
{pthread_mutex_lock(&timer_mutex);bool active=callout->c_active;pthread_mutex_unlock(&timer_mutex);return active;}
int ble_npl_callout_inited(struct ble_npl_callout *callout){return callout->c_inited;}
ble_npl_error_t ble_npl_callout_reset(struct ble_npl_callout *callout,ble_npl_time_t ticks)
{
  if(!callout->c_inited)return BLE_NPL_ERROR;
  if(ticks>INT32_MAX)return BLE_NPL_EINVAL;
  if(!ticks)ticks=1;
  struct itimerspec interval={0};interval.it_value.tv_sec=ticks/1000;interval.it_value.tv_nsec=(long)(ticks%1000)*1000000;
  pthread_mutex_lock(&timer_mutex);ble_npl_eventq_remove(target_queue(callout),&callout->c_ev);callout->c_ticks=ble_npl_time_get()+ticks;
  int rc=timer_settime(callout->c_timer,0,&interval,NULL);callout->c_active=!rc;pthread_mutex_unlock(&timer_mutex);return rc?BLE_NPL_ERROR:BLE_NPL_OK;
}
int ble_npl_callout_queued(struct ble_npl_callout *callout){return ble_npl_callout_is_active(callout);}
void ble_npl_callout_stop(struct ble_npl_callout *callout)
{
  if(!callout->c_inited)return;
  struct itimerspec interval={0};pthread_mutex_lock(&timer_mutex);
  callout->c_active=false;(void)timer_settime(callout->c_timer,0,&interval,NULL);ble_npl_eventq_remove(target_queue(callout),&callout->c_ev);pthread_mutex_unlock(&timer_mutex);
}
ble_npl_time_t ble_npl_callout_get_ticks(struct ble_npl_callout *callout)
{pthread_mutex_lock(&timer_mutex);ble_npl_time_t ticks=callout->c_ticks;pthread_mutex_unlock(&timer_mutex);return ticks;}
void ble_npl_callout_set_arg(struct ble_npl_callout *callout,void *argument)
{pthread_mutex_lock(&timer_mutex);callout->c_ev.ev_arg=argument;pthread_mutex_unlock(&timer_mutex);}
uint32_t ble_npl_callout_remaining_ticks(struct ble_npl_callout *callout,ble_npl_time_t now)
{pthread_mutex_lock(&timer_mutex);int32_t remaining=(int32_t)(callout->c_ticks-now);uint32_t result=callout->c_active&&remaining>0?(uint32_t)remaining:0;pthread_mutex_unlock(&timer_mutex);return result;}
