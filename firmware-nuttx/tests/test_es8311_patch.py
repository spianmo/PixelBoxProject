#!/usr/bin/env python3
"""验证补丁幂等/漂移检测，并编译真实修后函数检查音频错误与引用回收。"""
from pathlib import Path
import importlib.util
import os
import re
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("es8311_patch", PROJECT / "scripts/es8311_patch.py")
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)
DRIVER = PROJECT.parent / ".deps/nuttx/drivers/audio/es8311.c"

PREFIX = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <errno.h>
#define FAR
#define OK 0
#define DEBUGASSERT assert
#define audinfo(...) ((void)0)
#define auderr(...) ((void)0)
#define audwarn(...) ((void)0)
#define ES_MODULE_ADC 1
#define ES_MODULE_DAC 2
#define ES_MODULE_ADC_DAC 3
#define ES_WORD_LENGTH_16BITS 0
#define ES_WORD_LENGTH_24BITS 1
#define ES_WORD_LENGTH_32BITS 2
#define AUDIO_TYPE_FEATURE 1
#define AUDIO_TYPE_OUTPUT 2
#define AUDIO_TYPE_INPUT 3
#define AUDIO_TYPE_PROCESSING 4
#define AUDIO_FU_VOLUME 1
#define AUDIO_FU_MUTE 2
#define AUDIO_FU_INP_GAIN 3
#define AUDIO_CALLBACK_DEQUEUE 1
#define AUDIO_CALLBACK_IOERR 2
#define AUDIO_MSG_COMPLETE 8
#define CONFIG_ES8311_MSG_PRIO 1
#define CONFIG_ES8311_INFLIGHT 2
#define MSEC2TICK(ms) (ms)
typedef int irqstate_t;
typedef struct dq_entry_s {struct dq_entry_s *next;} dq_entry_t;
struct dq_queue_s {dq_entry_t *head,*tail;};
struct ap_buffer_s {dq_entry_t dq; uint16_t nbytes,curbyte,refs;};
struct i2s_dev_s {int unused;};
struct audio_lowerhalf_s {
  void *priv;
  void (*upper)(void*,uint16_t,struct ap_buffer_s*,uint16_t);
};
struct audio_msg_s {uint16_t msg_id; union {void *ptr; uint32_t data;} u;};
struct audio_caps_s {
  uint8_t ac_type,ac_channels;
  union {uint16_t hw; uint8_t b[2];} ac_format;
  union {uint16_t hw[2]; uint8_t b[4];} ac_controls;
};
struct es8311_dev_s {
  struct audio_lowerhalf_s dev;
  void *lower;
  struct i2s_dev_s *i2s;
  struct dq_queue_s pendq,doneq;
  int pendlock,mq;
  unsigned long threadid;
  uint32_t samprate,mclk;
  uint8_t bpsamp,inflight;
  bool running,paused,terminating,reserved;
  int result,audio_mode;
};
static const struct {
  int pre_div,pre_multi,adc_div,dac_div,fs_mode,adc_osr,dac_osr,lrck_h,lrck_l,bclk_div;
} es8311_coeff_div[]={{1,1,1,1,0,0,0,0,0,2}};
static int rate_error,width_error,volume_error,channel_error,send_error,lock_error;
static int rx_calls,tx_calls,io_errors,dequeues,sends,messages,joins,unlocks;
static uint32_t actual_mclk,checked_mclk;
static dq_entry_t *dq_peek(struct dq_queue_s*q){return q->head;}
static void dq_addlast(dq_entry_t*e,struct dq_queue_s*q){e->next=NULL;if(q->tail)q->tail->next=e;else q->head=e;q->tail=e;}
static dq_entry_t *dq_remfirst(struct dq_queue_s*q){dq_entry_t*e=q->head;if(e){q->head=e->next;if(!q->head)q->tail=NULL;e->next=NULL;}return e;}
static int nxmutex_lock(int*p){(void)p;return lock_error;}
static void nxmutex_unlock(int*p){(void)p;++unlocks;}
static irqstate_t enter_critical_section(void){return 0;}
static void leave_critical_section(irqstate_t flags){(void)flags;}
static void apb_free(struct ap_buffer_s*b){assert(b->refs>1);--b->refs;}
static int es8311_join_worker(struct es8311_dev_s*p,bool stop){(void)stop;if(p->threadid){++joins;p->threadid=0;}return 0;}
static int file_mq_send(int*q,const char*m,size_t n,unsigned p){(void)q;(void)m;(void)n;(void)p;++messages;return 0;}
static int test_rate(struct i2s_dev_s*d,uint32_t r,bool tx){(void)d;if(tx)++tx_calls;else ++rx_calls;if(rate_error)return rate_error;actual_mclk=r*256;return r*32;}
static int test_width(struct i2s_dev_s*d,uint8_t w,bool tx){(void)d;if(tx)++tx_calls;else ++rx_calls;return width_error?width_error:w;}
#define I2S_RXSAMPLERATE(d,r) test_rate(d,r,false)
#define I2S_TXSAMPLERATE(d,r) test_rate(d,r,true)
#define I2S_RXDATAWIDTH(d,w) test_width(d,w,false)
#define I2S_TXDATAWIDTH(d,w) test_width(d,w,true)
#define I2S_GETMCLKFREQUENCY(d) ((void)(d),actual_mclk)
#define I2S_RXCHANNELS(d,c) ((void)(d),(void)(c),channel_error)
#define I2S_TXCHANNELS(d,c) ((void)(d),(void)(c),channel_error)
static int es8311_getcoeff(struct es8311_dev_s*p,uint32_t rate){checked_mclk=p->mclk;return p->mclk==rate*256?0:-EINVAL;}
static int es8311_readreg(struct es8311_dev_s*p,int reg){(void)p;(void)reg;return 0;}
static int es8311_writereg(struct es8311_dev_s*p,int reg,int v){(void)p;(void)reg;(void)v;return 0;}
static int es8311_get_mclk_src(void){return 0;}
static int es8311_setvolume(struct es8311_dev_s*p,int mode,int v){(void)p;(void)mode;(void)v;return volume_error;}
static int es8311_setmute(struct es8311_dev_s*p,int mode,bool v){(void)p;(void)mode;(void)v;return 0;}
static int es8311_setmicgain(struct es8311_dev_s*p,int v){(void)p;(void)v;return 0;}
static void es8311_audio_output(struct es8311_dev_s*p){p->audio_mode=ES_MODULE_DAC;}
static void es8311_audio_input(struct es8311_dev_s*p){p->audio_mode=ES_MODULE_ADC;}
static void es8311_reset(struct es8311_dev_s*p){(void)p;}
static void es8311_processdone(struct i2s_dev_s*,struct ap_buffer_s*,void*,int);
static int test_send(struct i2s_dev_s*d,struct ap_buffer_s*b,void(*cb)(struct i2s_dev_s*,struct ap_buffer_s*,void*,int),void*p,uint32_t timeout){(void)d;(void)b;(void)cb;(void)p;(void)timeout;++sends;return send_error;}
#define I2S_SEND test_send
#define I2S_RECEIVE test_send
static void upper(void*p,uint16_t reason,struct ap_buffer_s*b,uint16_t status){(void)p;if(reason==AUDIO_CALLBACK_IOERR){assert(status==EIO);++io_errors;}else{assert(reason==AUDIO_CALLBACK_DEQUEUE&&b->refs==1);++dequeues;}}
"""

CHECKS = r"""
int main(void){
 struct i2s_dev_s i2s={0};
 struct es8311_dev_s dev={.lower=&i2s,.i2s=&i2s,.samprate=16000,.bpsamp=16,.audio_mode=ES_MODULE_DAC};
 dev.dev.upper=upper;
 actual_mclk=123;
 assert(es8311_setsamplerate(&dev)==0);
 assert(rx_calls==0&&tx_calls==1&&checked_mclk==16000*256);
 assert(es8311_setbitspersample(&dev)==0&&rx_calls==0&&tx_calls==2);
 struct audio_caps_s caps={.ac_type=AUDIO_TYPE_OUTPUT,.ac_channels=2};
 caps.ac_controls.hw[0]=48000;caps.ac_controls.b[2]=16;
 assert(es8311_configure(&dev.dev,&caps)==0&&dev.samprate==48000);
 rate_error=-EIO;assert(es8311_configure(&dev.dev,&caps)==-EIO);rate_error=0;
 width_error=-ENOTTY;assert(es8311_configure(&dev.dev,&caps)==-ENOTTY);width_error=0;
 channel_error=-EINVAL;assert(es8311_configure(&dev.dev,&caps)==-EINVAL);channel_error=0;
 caps.ac_type=AUDIO_TYPE_FEATURE;caps.ac_format.hw=AUDIO_FU_VOLUME;
 caps.ac_controls.hw[0]=700;volume_error=-EIO;
 assert(es8311_configure(&dev.dev,&caps)==-EIO);volume_error=0;
 caps.ac_type=AUDIO_TYPE_INPUT;caps.ac_controls.hw[0]=8000;caps.ac_controls.b[2]=16;
 assert(es8311_configure(&dev.dev,&caps)==0&&rx_calls==2);

 struct ap_buffer_s buffer={.nbytes=1024,.refs=2};
 dev.audio_mode=ES_MODULE_DAC;dev.running=true;
 dq_addlast(&buffer.dq,&dev.pendq);send_error=-EIO;
 assert(es8311_processbegin(&dev)==-EIO);
 assert(dev.inflight==0&&dev.terminating&&io_errors==1&&messages==1);
 assert(dev.pendq.head==NULL&&dev.doneq.head==&buffer.dq&&buffer.refs==2);
 dq_remfirst(&dev.doneq);
 struct ap_buffer_s queued={.nbytes=1024,.refs=2};
 dq_addlast(&queued.dq,&dev.pendq);int old_sends=sends;
 es8311_processbegin(&dev);assert(sends==old_sends);
 dev.reserved=true;dev.threadid=0;
 assert(es8311_release(&dev.dev)==0);
 assert(queued.refs==1&&dequeues==1&&!dev.reserved&&!dev.running&&!dev.pendq.head);
 dev.threadid=5;assert(es8311_release(&dev.dev)==0&&joins==1&&dev.threadid==0);
 int before_unlocks=unlocks;lock_error=-EINTR;
 assert(es8311_release(&dev.dev)==-EINTR&&unlocks==before_unlocks);
 return 0;
}
"""


LIFECYCLE_PREFIX = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <inttypes.h>
#define FAR
#define OK 0
#define DEBUGASSERT assert
#define audinfo(...) ((void)0)
#define auderr(...) ((void)0)
#define CONFIG_ES8311_MSG_PRIO 1
#define CONFIG_ES8311_WORKER_STACKSIZE 2048
#define ES_MODULE_ADC 1
#define ES_MODULE_DAC 2
#define ES_MODULE_ADC_DAC 3
#define ES_MODULE_LINE 4
#define AUDIO_CALLBACK_DEQUEUE 1
#define AUDIO_CALLBACK_COMPLETE 2
#define AUDIO_MSG_DATA_REQUEST 4
#define AUDIO_MSG_STOP 5
#define AUDIO_MSG_ENQUEUE 6
#define AUDIO_MSG_COMPLETE 7
#define AUDIO_APB_FINAL 1
#define O_RDWR 2
#define O_CREAT 4
#define SCHED_FIFO 1
typedef int irqstate_t;
typedef int pthread_attr_t;
typedef void *pthread_addr_t;
typedef struct dq_entry_s {struct dq_entry_s *next;} dq_entry_t;
struct dq_queue_s {dq_entry_t *head,*tail;};
struct ap_buffer_s {dq_entry_t dq; unsigned nbytes,curbyte,refs,flags;};
struct audio_lowerhalf_s {
  void *priv;
  void (*upper)(void*,uint16_t,struct ap_buffer_s*,uint16_t);
};
struct audio_msg_s {uint16_t msg_id;union {void *ptr;uint32_t data;} u;};
struct mq_attr {long mq_maxmsg,mq_msgsize,mq_curmsgs,mq_flags;};
struct sched_param {int sched_priority;};
struct file {void *f_inode;};
struct es8311_dev_s {
  struct audio_lowerhalf_s dev;
  struct dq_queue_s pendq,doneq;
  struct file mq;
  char mqname[64];
  unsigned long threadid;
  int pendlock;
  unsigned inflight;
  bool running,paused,terminating,reserved;
  int audio_mode;
};
static struct es8311_dev_s *device;
static void *(*entry)(void*);
static void *entry_arg;
static bool worker_ran,queue_full;
static int join_error,create_error,send_error,lock_error;
static int messages[32],head,tail;
static int opens,closes,unlinks,joins,sends,bounded_sends,invalid_sends;
static int blocked_sends,complete_callbacks,dequeues,process_calls,attr_destroy;
static int unsafe_reopens,sequence,joined_at,closed_at,opened_at,lock_depth;
static dq_entry_t *dq_peek(struct dq_queue_s*q){return q->head;}
static bool dq_empty(struct dq_queue_s*q){return !q->head;}
static void dq_addlast(dq_entry_t*e,struct dq_queue_s*q){e->next=NULL;if(q->tail)q->tail->next=e;else q->head=e;q->tail=e;}
static dq_entry_t *dq_remfirst(struct dq_queue_s*q){dq_entry_t*e=q->head;if(e){q->head=e->next;if(!q->head)q->tail=NULL;e->next=NULL;}return e;}
static int nxmutex_lock(int*p){(void)p;if(lock_error)return lock_error;++lock_depth;return 0;}
static void nxmutex_unlock(int*p){(void)p;assert(lock_depth>0);--lock_depth;}
static irqstate_t enter_critical_section(void){return 0;}
static void leave_critical_section(irqstate_t flags){(void)flags;}
static void apb_free(struct ap_buffer_s*b){assert(b->refs>1);--b->refs;}
static int es8311_readreg(struct es8311_dev_s*p,int reg){(void)p;(void)reg;return 0;}
static int es8311_writereg(struct es8311_dev_s*p,int reg,int value){(void)p;(void)reg;(void)value;return 0;}
static void es8311_reset(struct es8311_dev_s*p){(void)p;}
static void es8311_dump_registers(struct audio_lowerhalf_s*p,const char*label){(void)p;(void)label;}
static int es8311_processbegin(struct es8311_dev_s*p){(void)p;++process_calls;return 0;}
static int file_mq_open(struct file*q,const char*name,int flags,int mode,const struct mq_attr*a){
 (void)name;(void)flags;(void)mode;(void)a;
 if(q->f_inode||device->threadid)++unsafe_reopens;
 ++opens;opened_at=++sequence;q->f_inode=q;head=tail=0;return 0;
}
static int file_mq_close(struct file*q){assert(q->f_inode);q->f_inode=NULL;++closes;closed_at=++sequence;return 0;}
static int file_mq_unlink(const char*name){(void)name;++unlinks;return 0;}
static int file_mq_send(struct file*q,const char*data,size_t len,unsigned prio){
 (void)len;(void)prio;++sends;
 if(!q->f_inode){++invalid_sends;return -EBADF;}
 if(queue_full){++blocked_sends;return -EWOULDBLOCK;}
 if(send_error)return send_error;
 assert(tail<32);messages[tail++]=((const struct audio_msg_s*)data)->msg_id;return 0;
}
static int file_mq_ticksend(struct file*q,const char*data,size_t len,unsigned prio,int ticks){
 assert(ticks==1);++bounded_sends;
 if(queue_full){assert(q->f_inode);return -ETIMEDOUT;}
 return file_mq_send(q,data,len,prio);
}
static int file_mq_receive(struct file*q,char*data,size_t len,unsigned*prio){
 (void)len;(void)prio;assert(q->f_inode);
 /* 替身只模拟 OS 消息队列；没有唤醒时真实代码会永久等待。 */
 assert(head<tail);
 ((struct audio_msg_s*)data)->msg_id=messages[head++];
 return sizeof(struct audio_msg_s);
}
static int pthread_attr_init(pthread_attr_t*a){*a=1;return 0;}
static int pthread_attr_setschedparam(pthread_attr_t*a,const struct sched_param*p){(void)a;(void)p;return 0;}
static int pthread_attr_setstacksize(pthread_attr_t*a,size_t n){(void)a;(void)n;return 0;}
static int pthread_attr_destroy(pthread_attr_t*a){(void)a;++attr_destroy;return 0;}
static int sched_get_priority_max(int p){(void)p;return 255;}
static int pthread_create(unsigned long*t,const pthread_attr_t*a,void*(*fn)(void*),void*arg){
 (void)a;if(create_error)return create_error;
 entry=fn;entry_arg=arg;*t=41;worker_ran=false;return 0;
}
static int pthread_setname_np(unsigned long t,const char*name){(void)t;(void)name;return 0;}
static void run_worker(void){assert(entry&&!worker_ran);entry(entry_arg);worker_ran=true;}
static int pthread_join(unsigned long t,void**value){
 (void)value;++joins;assert(t!=0);assert(lock_depth==0);
 if(join_error)return join_error;
 if(!worker_ran)run_worker();
 joined_at=++sequence;return 0;
}
static void upper(void*p,uint16_t reason,struct ap_buffer_s*b,uint16_t status){
 (void)p;assert(status==0);
 if(reason==AUDIO_CALLBACK_COMPLETE){assert(!b);++complete_callbacks;}
 else{assert(reason==AUDIO_CALLBACK_DEQUEUE&&b->refs==1);++dequeues;}
}
static void *es8311_workerthread(pthread_addr_t arg);
"""

LIFECYCLE_CHECKS = r"""
static void start_device(struct es8311_dev_s*d){
 assert(es8311_start(&d->dev)==0);assert(d->threadid!=0&&d->mq.f_inode);
}
static void finish_naturally(struct es8311_dev_s*d){
 struct ap_buffer_s final={.refs=2,.flags=AUDIO_APB_FINAL};
 dq_addlast(&final.dq,&d->doneq);
 messages[tail++]=AUDIO_MSG_COMPLETE;
 run_worker();assert(final.refs==1&&complete_callbacks==1);
}
int main(int argc,char**argv){
 assert(argc==2);
 struct es8311_dev_s d={.audio_mode=ES_MODULE_DAC,.reserved=true};
 d.dev.upper=upper;device=&d;
 if(!strcmp(argv[1],"repeat_stop")){
   assert(es8311_stop(&d.dev)==0&&es8311_stop(&d.dev)==0);
   assert(sends==0&&bounded_sends==0&&joins==0&&closes==0);
 }else if(!strcmp(argv[1],"create_failure")){
   create_error=EAGAIN;
   assert(es8311_start(&d.dev)==-EAGAIN);
   assert(!d.running&&!d.threadid&&!d.mq.f_inode);
   assert(closes==1&&unlinks==1&&attr_destroy==1);
 }else if(!strcmp(argv[1],"natural_stop")){
   start_device(&d);finish_naturally(&d);
   assert(es8311_stop(&d.dev)==0);
   assert(invalid_sends==0&&sends==0&&bounded_sends==0);
   assert(!d.threadid&&!d.mq.f_inode&&joins==1&&closes==1&&unlinks==1);
   assert(closed_at>joined_at);
   assert(es8311_stop(&d.dev)==0&&joins==1&&closes==1);
 }else if(!strcmp(argv[1],"active_stop")){
   start_device(&d);assert(es8311_stop(&d.dev)==0);
   assert(!d.running&&!d.threadid&&!d.mq.f_inode&&complete_callbacks==1);
   assert(bounded_sends==1&&blocked_sends==0&&closed_at>joined_at);
 }else if(!strcmp(argv[1],"full_queue_stop")){
   start_device(&d);queue_full=true;
   /* STOP 在 worker 入口之前发生，不能由入口清除 terminating。 */
   assert(es8311_stop(&d.dev)==0);
   assert(!d.running&&!d.threadid&&!d.mq.f_inode&&complete_callbacks==1);
   assert(bounded_sends==1&&blocked_sends==0&&process_calls==0);
 }else if(!strcmp(argv[1],"stop_join_error")){
   start_device(&d);finish_naturally(&d);join_error=EDEADLK;
   assert(es8311_stop(&d.dev)==-EDEADLK);
   assert(d.threadid==41&&d.mq.f_inode&&closes==0);
   join_error=0;assert(es8311_stop(&d.dev)==0&&closes==1&&joins==2);
 }else if(!strcmp(argv[1],"release_join_error")){
   start_device(&d);finish_naturally(&d);join_error=EINVAL;
   struct ap_buffer_s queued={.refs=2};dq_addlast(&queued.dq,&d.pendq);
   assert(es8311_release(&d.dev)==-EINVAL);
   assert(d.threadid==41&&d.mq.f_inode&&closes==0&&d.reserved&&queued.refs==2);
   join_error=0;assert(es8311_release(&d.dev)==0);
   assert(!d.reserved&&queued.refs==1&&closes==1&&dequeues==2);
 }else if(!strcmp(argv[1],"start_join_error")){
   start_device(&d);finish_naturally(&d);join_error=EDEADLK;
   assert(es8311_start(&d.dev)==-EDEADLK);
   assert(d.threadid==41&&d.mq.f_inode&&opens==1&&closes==0&&unsafe_reopens==0);
 }else if(!strcmp(argv[1],"restart")){
   start_device(&d);finish_naturally(&d);
   assert(es8311_start(&d.dev)==0);
   assert(joins==1&&closes==1&&opens==2&&unsafe_reopens==0);
   assert(opened_at>closed_at&&closed_at>joined_at&&d.running&&!d.terminating);
   assert(es8311_stop(&d.dev)==0&&closes==2);
 }else if(!strcmp(argv[1],"active_start")){
   start_device(&d);assert(es8311_start(&d.dev)==-EBUSY);
   assert(opens==1&&joins==0&&closes==0&&d.running);
 }else if(!strcmp(argv[1],"wake_error")){
   start_device(&d);send_error=-ENOMEM;
   assert(es8311_stop(&d.dev)==-ENOMEM);
   assert(d.threadid==41&&d.mq.f_inode&&joins==0&&closes==0);
   send_error=0;assert(es8311_stop(&d.dev)==0&&closes==1);
 }else if(!strcmp(argv[1],"release_active")){
   start_device(&d);assert(es8311_release(&d.dev)==0);
   assert(!d.reserved&&!d.threadid&&!d.mq.f_inode&&complete_callbacks==1&&closes==1);
 }else if(!strcmp(argv[1],"release_create_failure")){
   struct ap_buffer_s queued={.refs=2};dq_addlast(&queued.dq,&d.pendq);
   create_error=EAGAIN;assert(es8311_start(&d.dev)==-EAGAIN);
   assert(es8311_release(&d.dev)==0&&queued.refs==1&&dequeues==1&&!d.reserved);
   assert(joins==0&&closes==1&&unlinks==1);
 }else{
   assert(!"unknown scenario");
 }
 return 0;
}
"""


class ES8311PatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DRIVER.exists():
            raise unittest.SkipTest("prepare pinned NuttX checkout to validate real driver")
        cls.original = DRIVER.read_text()
        cls.previous = PATCH.patch_v1(cls.original)
        cls.patched = PATCH.patch_text(cls.original)

    def test_idempotent(self):
        self.assertEqual(PATCH.patch_text(self.patched), self.patched)

    def test_v1_upgrade_matches_clean_patch(self):
        self.assertEqual(PATCH.patch_text(self.previous), self.patched)

    def test_source_drift_fails_closed(self):
        changed = self.original.replace("ret = es8311_setsamplerate(priv) == -ENOTTY ? OK : ret;", "ret = 17;", 1)
        self.assertNotEqual(changed, self.original)
        with self.assertRaises(ValueError):
            PATCH.patch_text(changed)
        for source in (self.previous, self.patched):
            changed = source.replace("  attr.mq_maxmsg  = 16;", "  attr.mq_maxmsg  = 17;", 1)
            self.assertNotEqual(changed, source)
            with self.assertRaises(ValueError):
                PATCH.patch_text(changed)

    def test_thread_creation_failure_closes_queue(self):
        a, b = PATCH.function_body(self.patched, "es8311_start")
        body = self.patched[a:b]
        error = body[body.index("if (ret != OK)"):body.index("else", body.index("if (ret != OK)"))]
        self.assertIn("file_mq_close(&priv->mq)", error)
        self.assertIn("file_mq_unlink(priv->mqname)", error)
        self.assertIn("return -ret;", error)
        self.assertIn("pthread_attr_destroy(&tattr)", body)

    def test_real_patched_functions(self):
        signatures = {
            "es8311_setbitspersample": "static int es8311_setbitspersample(struct es8311_dev_s *priv)",
            "es8311_setsamplerate": "static int es8311_setsamplerate(struct es8311_dev_s *priv)",
            "es8311_configure": "static int es8311_configure(struct audio_lowerhalf_s *dev, const struct audio_caps_s *caps)",
            "es8311_processdone": "static void es8311_processdone(struct i2s_dev_s *i2s, struct ap_buffer_s *apb, void *arg, int result)",
            "es8311_processbegin": "static int es8311_processbegin(struct es8311_dev_s *priv)",
            "es8311_release": "static int es8311_release(struct audio_lowerhalf_s *dev)",
        }
        bodies = []
        for name, signature in signatures.items():
            a, b = PATCH.function_body(self.patched, name)
            bodies.append(signature + "\n" + self.patched[a:b])
        functions = "\n".join(bodies)
        registers = sorted(set(re.findall(r"\bES8311_[A-Z0-9_]+\b", functions)))
        definitions = "\n".join(f"#define {name} {i+1}" for i, name in enumerate(registers))
        source = PREFIX + "\n" + definitions + "\n" + functions + "\n" + CHECKS
        with tempfile.TemporaryDirectory(prefix="es8311-patch-test-") as temporary:
            path = Path(temporary)
            (path / "test.c").write_text(source)
            compiled = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-Wno-tautological-constant-out-of-range-compare", str(path / "test.c"), "-o", str(path / "test")], text=True, capture_output=True, timeout=15)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            ran = subprocess.run([str(path / "test")], text=True, capture_output=True, timeout=5)
            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)

    def test_real_lifecycle_before_and_after(self):
        signatures = {
            "es8311_join_worker": "static int es8311_join_worker(struct es8311_dev_s *priv, bool stop)",
            "es8311_start": "static int es8311_start(struct audio_lowerhalf_s *dev)",
            "es8311_stop": "static int es8311_stop(struct audio_lowerhalf_s *dev)",
            "es8311_release": "static int es8311_release(struct audio_lowerhalf_s *dev)",
            "es8311_returnbuffers": "static void es8311_returnbuffers(struct es8311_dev_s *priv)",
            "es8311_workerthread": "static void *es8311_workerthread(pthread_addr_t pvarg)",
        }
        scenarios = (
            "repeat_stop", "create_failure", "natural_stop", "active_stop",
            "full_queue_stop", "stop_join_error", "release_join_error",
            "start_join_error", "restart", "active_start", "wake_error",
            "release_active", "release_create_failure",
        )
        # 将真实 v1/v2 函数分别编译，证明同一回归在修前失败、修后通过。
        old_failures = {
            "repeat_stop", "natural_stop", "active_stop", "full_queue_stop",
            "stop_join_error", "release_join_error", "start_join_error",
            "restart", "active_start", "wake_error", "release_active",
        }
        with tempfile.TemporaryDirectory(prefix="es8311-lifecycle-") as temporary:
            path = Path(temporary)
            for version, driver in (("v1", self.previous), ("v2", self.patched)):
                bodies = []
                for name, signature in signatures.items():
                    if version == "v1" and name == "es8311_join_worker":
                        continue
                    a, b = PATCH.function_body(driver, name)
                    bodies.append(signature + "\n" + driver[a:b])
                functions = "\n".join(bodies)
                registers = sorted(set(re.findall(r"\bES8311_[A-Z0-9_]+\b", functions)))
                definitions = "\n".join(f"#define {name} {i+1}" for i, name in enumerate(registers))
                code = LIFECYCLE_PREFIX + definitions + "\n" + functions + LIFECYCLE_CHECKS
                source = path / f"{version}.c"
                binary = path / version
                source.write_text(code)
                compiled = subprocess.run([
                    os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra",
                    "-Werror", "-Wno-unused-parameter", "-Wno-unused-function",
                    "-Wno-sign-compare", str(source), "-o", str(binary),
                ], text=True, capture_output=True, timeout=15)
                self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
                for scenario in scenarios:
                    with self.subTest(version=version, scenario=scenario):
                        ran = subprocess.run([str(binary), scenario], text=True,
                                             capture_output=True, timeout=5)
                        if version == "v1" and scenario in old_failures:
                            self.assertNotEqual(ran.returncode, 0, f"修前未触发 {scenario}")
                        else:
                            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)


if __name__ == "__main__":
    unittest.main()
