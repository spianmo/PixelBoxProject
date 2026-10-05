#!/usr/bin/env python3
"""真实NPL队列/定时器适配源，POSIX timer系统调用替身；验证队列并发与计时边界。"""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile

def main():
    root=Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-npl-') as temporary:
        out=Path(temporary);(out/'nimble').mkdir();(out/'nimble/nimble_npl.h').write_text(r'''
#ifndef PX_NPL_TEST_H
#define PX_NPL_TEST_H
#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <signal.h>
#include <time.h>
#ifdef __APPLE__
typedef struct test_timer *timer_t;
struct itimerspec {struct timespec it_interval,it_value;};
#endif
#define timer_create px_timer_create
#define timer_settime px_timer_settime
int px_timer_create(clockid_t,struct sigevent *,timer_t *);
int px_timer_settime(timer_t,int,const struct itimerspec *,struct itimerspec *);
#define BLE_NPL_TIME_FOREVER UINT32_MAX
#define BLE_NPL_OK 0
#define BLE_NPL_EINVAL 2
#define BLE_NPL_ERROR 12
#define CONFIG_NIMBLE_CALLOUT_THREAD_STACKSIZE 65536
typedef uint32_t ble_npl_time_t;
typedef int ble_npl_error_t;
struct ble_npl_event;struct ble_npl_eventq;
typedef void ble_npl_event_fn(struct ble_npl_event *);
struct ble_npl_event {uint8_t ev_queued;ble_npl_event_fn *ev_cb;void *ev_arg;struct ble_npl_event *ev_next;struct ble_npl_eventq *ev_owner;};
struct ble_npl_eventq {pthread_cond_t condition;struct ble_npl_event *head,*tail;bool initialized;};
struct ble_npl_callout {struct ble_npl_event c_ev;struct ble_npl_eventq *c_evq;uint32_t c_ticks;timer_t c_timer;bool c_active,c_inited;};
void ble_npl_eventq_init(struct ble_npl_eventq *);
bool ble_npl_eventq_is_empty(struct ble_npl_eventq *);
int ble_npl_eventq_inited(const struct ble_npl_eventq *);
void ble_npl_eventq_put(struct ble_npl_eventq *,struct ble_npl_event *);
struct ble_npl_event *ble_npl_eventq_get(struct ble_npl_eventq *,ble_npl_time_t);
void ble_npl_eventq_remove(struct ble_npl_eventq *,struct ble_npl_event *);
void ble_npl_event_init(struct ble_npl_event *,ble_npl_event_fn *,void *);
bool ble_npl_event_is_queued(struct ble_npl_event *);
void ble_npl_event_run(struct ble_npl_event *);
void *ble_npl_event_get_arg(struct ble_npl_event *);
void ble_npl_event_set_arg(struct ble_npl_event *,void *);
void ble_npl_callout_init(struct ble_npl_callout *,struct ble_npl_eventq *,ble_npl_event_fn *,void *);
bool ble_npl_callout_is_active(struct ble_npl_callout *);
int ble_npl_callout_inited(struct ble_npl_callout *);
ble_npl_error_t ble_npl_callout_reset(struct ble_npl_callout *,ble_npl_time_t);
void ble_npl_callout_stop(struct ble_npl_callout *);
ble_npl_time_t ble_npl_callout_get_ticks(struct ble_npl_callout *);
uint32_t ble_npl_callout_remaining_ticks(struct ble_npl_callout *,ble_npl_time_t);
ble_npl_time_t ble_npl_time_get(void);
#endif
''')
        source=out/'test.c';source.write_text(r'''
#include "nimble/nimble_npl.h"
#include <assert.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
struct test_timer {struct sigevent event;struct itimerspec interval;};
static struct test_timer timers[16];static unsigned timer_count;static bool fail_create,fail_reset;static uint32_t ticks;static atomic_int callbacks;
int px_timer_create(clockid_t clock,struct sigevent *event,timer_t *id){assert(clock==CLOCK_MONOTONIC);if(fail_create){errno=ENOMEM;return -1;}assert(timer_count<16);timers[timer_count].event=*event;*id=(timer_t)(uintptr_t)&timers[timer_count++];return 0;}
int px_timer_settime(timer_t id,int flags,const struct itimerspec *value,struct itimerspec *old){(void)flags;(void)old;if(fail_reset){errno=EIO;return -1;}((struct test_timer *)(uintptr_t)id)->interval=*value;return 0;}
ble_npl_time_t ble_npl_time_get(void){return ticks;}
static void fire(struct ble_npl_callout *callout){struct test_timer *timer=(void *)(uintptr_t)callout->c_timer;timer->event.sigev_notify_function(timer->event.sigev_value);}
static void callback(struct ble_npl_event *event){(void)event;atomic_fetch_add(&callbacks,1);}
static struct ble_npl_eventq queue;static struct ble_npl_event events[1000];
static void *producer(void *argument){(void)argument;for(unsigned repeat=0;repeat<3;repeat++)for(unsigned i=0;i<1000;i++)ble_npl_eventq_put(&queue,&events[i]);return NULL;}
int main(void){
 ble_npl_eventq_init(&queue);assert(ble_npl_eventq_inited(&queue)&&ble_npl_eventq_is_empty(&queue));
 for(unsigned i=0;i<1000;i++)ble_npl_event_init(&events[i],callback,(void *)(uintptr_t)i);
 pthread_t producers[4];for(unsigned i=0;i<4;i++)assert(!pthread_create(&producers[i],NULL,producer,NULL));for(unsigned i=0;i<4;i++)pthread_join(producers[i],NULL);
 bool seen[1000]={0};for(unsigned i=0;i<1000;i++){struct ble_npl_event *e=ble_npl_eventq_get(&queue,0);assert(e&&!ble_npl_event_is_queued(e));unsigned value=(unsigned)(uintptr_t)ble_npl_event_get_arg(e);assert(!seen[value]);seen[value]=true;}assert(!ble_npl_eventq_get(&queue,0));
 for(unsigned i=0;i<4;i++)ble_npl_eventq_put(&queue,&events[i]);ble_npl_eventq_remove(&queue,&events[1]);ble_npl_eventq_remove(&queue,&events[3]);ble_npl_eventq_remove(&queue,&events[0]);assert(ble_npl_eventq_get(&queue,0)==&events[2]&&ble_npl_eventq_is_empty(&queue));
 struct timespec start,end;clock_gettime(CLOCK_MONOTONIC,&start);assert(!ble_npl_eventq_get(&queue,50));clock_gettime(CLOCK_MONOTONIC,&end);double elapsed=end.tv_sec-start.tv_sec+(end.tv_nsec-start.tv_nsec)/1e9;assert(elapsed>=0.04&&elapsed<0.5);
 struct ble_npl_callout a,b;ble_npl_callout_init(&a,&queue,callback,NULL);ble_npl_callout_init(&b,&queue,callback,NULL);assert(ble_npl_callout_inited(&a));ticks=1000;assert(!ble_npl_callout_reset(&a,20)&&!ble_npl_callout_reset(&b,20));assert(ble_npl_callout_remaining_ticks(&a,1005)==15);ticks=1020;fire(&a);fire(&b);assert(!ble_npl_callout_is_active(&a));assert(ble_npl_eventq_get(&queue,0)==&a.c_ev);assert(ble_npl_eventq_get(&queue,0)==&b.c_ev);
 ticks=2000;ble_npl_callout_reset(&a,10);ticks=2010;fire(&a);assert(ble_npl_event_is_queued(&a.c_ev));ble_npl_callout_stop(&a);assert(!ble_npl_event_is_queued(&a.c_ev)&&ble_npl_eventq_is_empty(&queue));
 ble_npl_callout_reset(&a,20);fire(&a);assert(ble_npl_callout_is_active(&a)&&ble_npl_eventq_is_empty(&queue));ticks=2030;fire(&a);ble_npl_callout_reset(&a,30);assert(ble_npl_eventq_is_empty(&queue));ticks=2059;fire(&a);assert(ble_npl_eventq_is_empty(&queue));ticks=2060;fire(&a);assert(ble_npl_eventq_get(&queue,0)==&a.c_ev);
 ticks=UINT32_MAX-5;ble_npl_callout_reset(&a,20);assert(ble_npl_callout_remaining_ticks(&a,UINT32_MAX)==15);ticks=14;fire(&a);assert(ble_npl_eventq_get(&queue,0)==&a.c_ev);
 fail_reset=true;assert(ble_npl_callout_reset(&a,1)==BLE_NPL_ERROR&&!ble_npl_callout_is_active(&a));fail_reset=false;assert(ble_npl_callout_reset(&a,UINT32_MAX)==BLE_NPL_EINVAL);
 fail_create=true;struct ble_npl_callout unavailable;ble_npl_callout_init(&unavailable,&queue,callback,NULL);assert(!ble_npl_callout_inited(&unavailable)&&ble_npl_callout_reset(&unavailable,1)==BLE_NPL_ERROR);fail_create=false;
 struct ble_npl_callout fallback;ble_npl_callout_init(&fallback,NULL,callback,NULL);ticks=0;ble_npl_callout_reset(&fallback,1);ticks=1;fire(&fallback);for(unsigned i=0;i<100&&!atomic_load(&callbacks);i++){struct timespec pause={0,1000000};nanosleep(&pause,NULL);}assert(atomic_load(&callbacks)==1);
 puts("BLE NPL通过：1000事件/4并发生产者去重、不阻塞host、实际50ms等待、删除、同时到期、stop/reset迟到工作、32位计时回绕、timer故障");return 0;
}
''')
        binary=out/'test';subprocess.run([*shlex.split(os.environ.get('CC','cc')),'-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(out),str(root/'port/ble_npl_eventq.c'),str(root/'port/ble_npl_callout.c'),str(source),'-lpthread','-o',str(binary)],check=True,timeout=60)
        subprocess.run([str(binary)],check=True,timeout=60)
if __name__=='__main__':main()
