#!/usr/bin/env python3
"""运行真实BLE/NPL等待分支；模拟墙上时间跳变与虚假唤醒，不修改系统时钟。"""
from pathlib import Path
import tempfile

from test_ble_platform import function, run


COMMON = r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static struct timespec monotonic,deadline;
static int64_t wall;
static unsigned clock_reads,waits;
static void (*completion)(void);
static void reset_wait(time_t seconds,long nanos){
 monotonic=(struct timespec){42,950000000};deadline=(struct timespec){seconds,nanos};
 wall=1700000000;clock_reads=waits=0;completion=NULL;
}
int fake_clock(clockid_t clock,struct timespec *value){assert(clock==CLOCK_MONOTONIC);clock_reads++;*value=monotonic;return 0;}
int fake_clockwait(pthread_cond_t *condition,pthread_mutex_t *mutex,clockid_t clock,const struct timespec *until){
 assert(condition&&mutex&&clock==CLOCK_MONOTONIC);
 assert(until->tv_sec==deadline.tv_sec&&until->tv_nsec==deadline.tv_nsec);
 /* 两次虚假唤醒中分别向未来和过去校时；绝对单调期限不得重算。 */
 waits++;wall+=waits%2?315360000:-630720000;monotonic.tv_nsec+=1000000;
 if(waits<3)return 0;
 if(completion){assert(!pthread_mutex_unlock(mutex));completion();assert(!pthread_mutex_lock(mutex));return 0;}
 monotonic=deadline;return ETIMEDOUT;
}
int forbidden_realtime_wait(pthread_cond_t *condition,pthread_mutex_t *mutex,const struct timespec *until){
 (void)condition;(void)mutex;(void)until;assert(!"不能退回受墙上时间影响的条件等待");return EINVAL;
}
#define clock_gettime fake_clock
#define pthread_cond_clockwait fake_clockwait
#define pthread_cond_timedwait forbidden_realtime_wait
'''


def main():
    root = Path(__file__).resolve().parents[1]
    backend = (root / 'src/ble_nimble.c').read_text()
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-deadline-') as temporary:
        out = Path(temporary)
        (out / 'nuttx').mkdir()
        (out / 'nuttx/config.h').write_text('/* 宿主只编译不可用后端，无射频替代实现。 */\n')
        includes = ['-I' + str(root / 'include'), '-I' + str(out)]
        source = COMMON + '\n#define __NuttX__ 1\n' + (
            '#include "' + str(root / 'src/ble.c') + '"\n'
            '#include "' + str(root / 'src/ble_nimble.c') + '"\n') + r'''
static void reply(void){uint8_t data[]={7,8,9};assert(!px_ble_read_reply(current,reader.request,data,sizeof(data),true));}
int main(void){
 struct px_ble *ble=px_ble_create();assert(ble);uint8_t data[PX_BLE_VALUE_BYTES]={0};size_t length=17;
 reset_wait(43,50000000);assert(!px_ble_read_bridge(ble->generation,3,data,&length));
 assert(length==17&&clock_reads==1&&waits==3&&monotonic.tv_sec==43&&monotonic.tv_nsec==50000000);
 struct px_ble_event event;assert(px_ble_poll(ble,&event)==1);
 assert(px_ble_read_reply(ble,event.request,NULL,0,true)==-ESTALE);px_ble_event_free(&event);
 reset_wait(43,50000000);completion=reply;assert(px_ble_read_bridge(ble->generation,4,data,&length));
 assert(length==3&&data[0]==7&&data[2]==9&&clock_reads==1&&waits==3);px_ble_destroy(ble);
 puts("BLE真实NuttX读桥通过：100ms单调期限、前后校时与虚假唤醒不延长等待、成功回复、拒绝迟到回复");return 0;
}
'''
        run(out, 'reader', source, includes)

        # 只替换平台调用；deadline/ready/submit及命令引用释放全部使用产品真实函数。
        source = COMMON + r'''
#include "pixelbox_ble.h"
struct ble_npl_event {void (*callback)(struct ble_npl_event *);void *argument;};
struct ble_npl_eventq {int unused;};
''' + function(backend, 'enum command_type {') + ';\n' + function(backend, 'struct command {') + r''';
static pthread_mutex_t boot_lock=PTHREAD_MUTEX_INITIALIZER,command_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t boot_condition=PTHREAD_COND_INITIALIZER;
static bool initialized,host_ready,synchronized;
static int boot_error;
static unsigned pending_commands,created;
static struct command *queued;
static struct ble_npl_eventq queue;
static void execute_command(struct ble_npl_event *event){(void)event;assert(!"事件执行在本等待测试中必须显式触发");}
static int host_task(int argc,char **argv){(void)argc;(void)argv;assert(!"不会创建实际后台任务");return 0;}
int task_create(const char *name,int priority,int stack,int (*entry)(int,char **),char *const argv[]){
 assert(!strcmp(name,"pixelbox-ble")&&priority==110&&stack==8192&&entry==host_task&&!argv);created++;return 101;
}
void ble_npl_event_init(struct ble_npl_event *event,void (*callback)(struct ble_npl_event *),void *argument){event->callback=callback;event->argument=argument;}
struct ble_npl_eventq *nimble_port_get_dflt_eventq(void){return &queue;}
void ble_npl_eventq_put(struct ble_npl_eventq *target,struct ble_npl_event *event){assert(target==&queue);queued=event->argument;}
''' + '\n'.join(function(backend, signature) for signature in [
            'static void deadline_ms(', 'static void release_command(',
            'static int submit(', 'int px_ble_backend_ready(void)\n{']) + r'''
static void sync_ready(void){synchronized=true;}
static void command_ready(void){assert(!pthread_mutex_lock(&queued->mutex));queued->done=true;queued->connection=1234;assert(!pthread_mutex_unlock(&queued->mutex));}
static void release_queued(void){assert(queued&&pending_commands==1);release_command(queued);queued=NULL;pending_commands--;}
int main(void){
 reset_wait(44,950000000);assert(px_ble_backend_ready()==-ETIMEDOUT);assert(created==1&&clock_reads==1&&waits==3);
 reset_wait(44,950000000);completion=sync_ready;assert(!px_ble_backend_ready());assert(created==1&&clock_reads==1&&waits==3);
 host_ready=true;reset_wait(44,950000000);assert(submit(calloc(1,sizeof(struct command)),NULL)==-ETIMEDOUT);
 assert(queued->cancelled&&queued->references==1&&clock_reads==1&&waits==3);release_queued();
 reset_wait(44,950000000);completion=command_ready;uint32_t connection=0;assert(!submit(calloc(1,sizeof(struct command)),&connection));
 assert(connection==1234&&!queued->cancelled&&queued->references==1&&clock_reads==1&&waits==3);release_queued();
 puts("BLE真实启动/命令等待通过：2000ms单调期限、前后校时/虚假唤醒不重置期限、超时撤销、成功结果/引用回收");return 0;
}
'''
        run(out, 'backend_wait', source, includes)

        (out / 'nimble').mkdir()
        (out / 'nimble/nimble_npl.h').write_text(r'''
#include <stdbool.h>
#include <stdint.h>
#include <pthread.h>
#define BLE_NPL_TIME_FOREVER UINT32_MAX
typedef uint32_t ble_npl_time_t;
struct ble_npl_event;struct ble_npl_eventq;
typedef void ble_npl_event_fn(struct ble_npl_event *);
struct ble_npl_event {uint8_t ev_queued;ble_npl_event_fn *ev_cb;void *ev_arg;struct ble_npl_event *ev_next;struct ble_npl_eventq *ev_owner;};
struct ble_npl_eventq {pthread_cond_t condition;struct ble_npl_event *head,*tail;bool initialized;};
void ble_npl_event_run(struct ble_npl_event *event);
''')
        source = COMMON + '\n#define __NuttX__ 1\n#include "' + str(root / 'port/ble_npl_eventq.c') + '"\n' + r'''
static struct ble_npl_eventq queue;
static struct ble_npl_event event;
static void enqueue(void){ble_npl_eventq_put(&queue,&event);}
int main(void){
 ble_npl_eventq_init(&queue);ble_npl_event_init(&event,NULL,NULL);
 reset_wait(43,450000000);assert(!ble_npl_eventq_get(&queue,500));assert(clock_reads==1&&waits==3);
 reset_wait(43,450000000);completion=enqueue;assert(ble_npl_eventq_get(&queue,500)==&event);
 assert(clock_reads==1&&waits==3&&!ble_npl_event_is_queued(&event));
 reset_wait(0,0);assert(!ble_npl_eventq_get(&queue,0)&&!clock_reads&&!waits);
 enqueue();assert(ble_npl_eventq_get(&queue,BLE_NPL_TIME_FOREVER)==&event&&!clock_reads&&!waits);
 puts("BLE真实NuttX事件队列通过：单调期限、前后校时/虚假唤醒不延长、唤醒取事件、非阻塞/已就绪无限等待");return 0;
}
'''
        run(out, 'queue_wait', source, includes)


if __name__ == '__main__':
    main()
