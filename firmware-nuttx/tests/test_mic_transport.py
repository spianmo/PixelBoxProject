#!/usr/bin/env python3
"""真实 mic.c 与线程/I2S 替身：验证有序采集、重采样、取消和错误回收。"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

from audio_worker_fixture import HEADER as WORKER_HEADER, SOURCE as WORKER_SOURCE

PROJECT = Path(__file__).resolve().parents[1]
HEADER = r'''
#include <stdint.h>
#include <stddef.h>
struct ap_buffer_s {uint8_t*samp;unsigned nbytes,nmaxbytes,curbyte,flags;int refs;};
struct audio_buf_desc_s {unsigned numbytes;union {struct ap_buffer_s **pbuffer;}u;};
struct i2s_dev_s {int unused;};
typedef void(*i2s_callback_t)(struct i2s_dev_s*,struct ap_buffer_s*,void*,int);
int apb_alloc(struct audio_buf_desc_s*);
void apb_free(struct ap_buffer_s*);
int test_receive(struct i2s_dev_s*,struct ap_buffer_s*,i2s_callback_t,void*,unsigned);
#define I2S_RECEIVE test_receive
#define MSEC2TICK(n) (n)
'''
SOURCE = r'''
#define _POSIX_C_SOURCE 200809L
#include "pixelbox_mic.h"
#include "mic_test_platform.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#ifdef PX_AUDIO_WORKER_TEST
#include "audio_worker_test_platform.h"
#endif
static struct i2s_dev_s device;
static pthread_mutex_t driver_lock=PTHREAD_MUTEX_INITIALIZER;
static struct {struct ap_buffer_s*b;i2s_callback_t cb;void*arg;} pending[2];
static atomic_int allocations,released,acquired,cancelled,powered,prepared,gain_value;
static atomic_bool cancel_delayed,prepare_blocked;
static int alloc_error,prepare_error,submit_error,capture_error;
static bool available=true;
static void sleep_ms(unsigned n){struct timespec t={n/1000,(long)(n%1000)*1000000};nanosleep(&t,NULL);}
int apb_alloc(struct audio_buf_desc_s*d){
 if(alloc_error)return -ENOMEM;
 struct ap_buffer_s*b=calloc(1,sizeof(*b)+d->numbytes);assert(b);
 b->samp=(void*)(b+1);b->nmaxbytes=d->numbytes;b->refs=1;*d->u.pbuffer=b;
 ++allocations;return sizeof(*d);
}
void apb_free(struct ap_buffer_s*b){
 pthread_mutex_lock(&driver_lock);assert(b->refs>0);bool last=!--b->refs;
 pthread_mutex_unlock(&driver_lock);if(last){--allocations;free(b);}
}
int test_receive(struct i2s_dev_s*d,struct ap_buffer_s*b,i2s_callback_t cb,void*a,unsigned timeout){
 assert(d==&device&&timeout==100);if(submit_error)return submit_error;
 pthread_mutex_lock(&driver_lock);int slot=pending[0].b?1:0;assert(!pending[slot].b);
 ++b->refs;pending[slot].b=b;pending[slot].cb=cb;pending[slot].arg=a;
 pthread_mutex_unlock(&driver_lock);return 0;
}
bool pixelbox_board_mic_available(void){return available;}
int px_audio_capture_acquire(void){if(capture_error)return capture_error;++acquired;return 0;}
void px_audio_capture_release(void){++released;}
int pixelbox_board_mic_prepare(unsigned r,int gain,struct i2s_dev_s**out){
#ifdef PX_AUDIO_WORKER_TEST
 assert(test_worker_is_task()&&test_worker_snapshot().active==1);
#endif
 assert(r==16000);gain_value=gain;++prepared;
 while(prepare_blocked)sleep_ms(1);
 if(prepare_error)return prepare_error;*out=&device;return 0;
}
int pixelbox_board_mic_set_gain(int g){
#ifdef PX_AUDIO_WORKER_TEST
 assert(test_worker_is_task()&&test_worker_snapshot().active==1);
#endif
 gain_value=g;return 0;
}
static void deliver(int index,int count,int first,int error,bool malformed){
 pthread_mutex_lock(&driver_lock);
 struct ap_buffer_s*b=pending[index].b;assert(b);i2s_callback_t cb=pending[index].cb;void*arg=pending[index].arg;
 pending[index].b=NULL;pthread_mutex_unlock(&driver_lock);
 b->nbytes=malformed?3:(unsigned)count*4;
 for(int i=0;i<count;i++){
  int16_t sample=(int16_t)(first+i);
  b->samp[i*4]=(uint8_t)sample;b->samp[i*4+1]=(uint16_t)sample>>8;
  b->samp[i*4+2]=0x30;b->samp[i*4+3]=0x75;
 }
 cb(&device,b,arg,error);apb_free(b);
}
void pixelbox_board_mic_cancel(void){
 ++cancelled;
 if(cancel_delayed)return;
 for(int i=0;i<2;i++){
  pthread_mutex_lock(&driver_lock);bool exists=pending[i].b!=NULL;pthread_mutex_unlock(&driver_lock);
  if(exists)deliver(i,0,0,-ECANCELED,false);
 }
}
void pixelbox_board_mic_powerdown(void){
#ifdef PX_AUDIO_WORKER_TEST
 assert(test_worker_is_task()&&test_worker_snapshot().active==1);
#endif
 ++powered;pixelbox_board_mic_cancel();
}
static void wait_pending(int count){
 for(int i=0;i<100;i++){
  pthread_mutex_lock(&driver_lock);int n=(pending[0].b!=NULL)+(pending[1].b!=NULL);pthread_mutex_unlock(&driver_lock);
  if(n>=count)return;sleep_ms(1);
 }assert(!"DMA submission did not arrive");
}
static void wait_idle(void){for(int i=0;i<250&&px_mic_busy();i++)sleep_ms(1);assert(!px_mic_busy());assert(allocations==0&&released==acquired);}
static int poll(struct px_mic_frame*f){for(int i=0;i<150;i++){int r=px_mic_poll(f,1);if(r)return r;sleep_ms(1);}return 0;}
static int16_t sample_at(struct px_mic_frame*f,unsigned n){return (int16_t)(f->data[n*2]|(uint16_t)f->data[n*2+1]<<8);}
static void *short_vm(void *unused){
 (void)unused;assert(px_mic_start(16000,10)==0);wait_pending(2);px_mic_stop();return NULL;
}
int main(int argc,char**argv){
 assert(argc==2);int which=atoi(argv[1]);struct px_mic_frame frame;
 if(which==1){
  assert(px_mic_start(16000,10)==0&&px_mic_active());wait_pending(2);
  assert(px_mic_start(16000,10)==-EBUSY);deliver(0,160,-1000,0,false);
  assert(poll(&frame)==1&&frame.bytes==320&&frame.sample_rate==16000);
  for(unsigned i=0;i<160;i++)assert(sample_at(&frame,i)==(int)i-1000);
  free(frame.data);px_mic_stop();wait_idle();assert(!px_mic_active());
 }else if(which>=2&&which<=6){
  unsigned rates[]={8000,24000,32000,44100,48000};unsigned rate=rates[which-2];
  assert(px_mic_start(rate,10)==0);wait_pending(2);deliver(0,512,-12000,0,false);
  assert(poll(&frame)==1&&frame.bytes==rate/100*2&&frame.sample_rate==rate);
  for(unsigned i=0;i<frame.bytes/2;i++){
   int64_t phase=(int64_t)i*16000;int64_t base=phase/rate,fraction=phase%rate;
   int expected=(int)(((-12000+base)*(rate-fraction)+(-11999+base)*fraction)/(int64_t)rate);
   assert(sample_at(&frame,i)==expected);
  }
  free(frame.data);px_mic_stop();wait_idle();
 }else if(which==7){
  assert(px_mic_start(16000,10)==0);wait_pending(2);
  deliver(1,160,2000,0,false);sleep_ms(5);assert(px_mic_poll(&frame,1)==0);
  deliver(0,160,1000,0,false);
  assert(poll(&frame)==1&&sample_at(&frame,0)==1000);free(frame.data);
  assert(poll(&frame)==1&&sample_at(&frame,0)==2000);free(frame.data);
  px_mic_stop();wait_idle();
 }else if(which==8){
  assert(px_mic_start(16000,10)==0);wait_pending(2);deliver(0,0,0,0,true);
  assert(poll(&frame)==-EPROTO);wait_idle();
 }else if(which==9){
  assert(px_mic_start(16000,10)==0);wait_pending(2);
  assert(poll(&frame)==-ETIMEDOUT);wait_idle();assert(cancelled>=1);
 }else if(which==10){
  assert(px_mic_start(16000,10)==0);wait_pending(2);
  /* 超过有界的一秒队列仍须报告丢帧，不能静默覆盖。 */
  for(int i=0;i<32;i++){
   wait_pending(2);deliver(i%2,512,i*512,0,false);sleep_ms(2);
  }
  assert(poll(&frame)==-EOVERFLOW);wait_idle();
 }else if(which==11){
  alloc_error=1;assert(px_mic_start(16000,32)==0);
  assert(poll(&frame)==-ENOMEM);wait_idle();
 }else if(which==12){
  submit_error=-EIO;assert(px_mic_start(16000,32)==0);
  assert(poll(&frame)==-EIO);wait_idle();
 }else if(which==13){
  available=false;assert(px_mic_start(16000,32)==-ENODEV);available=true;
  assert(px_mic_start(123,32)==-EINVAL&&px_mic_start(16000,1)==-EINVAL);
  capture_error=-EBUSY;assert(px_mic_start(16000,32)==-EBUSY&&acquired==0);capture_error=0;
  prepare_error=-ENXIO;assert(px_mic_start(16000,32)==0);
  assert(poll(&frame)==-ENXIO);wait_idle();
 }else if(which==14){
  assert(px_mic_set_gain(500)==0);assert(px_mic_start(16000,32)==0);wait_pending(2);assert(gain_value==100);
  assert(px_mic_set_gain(-20)==0);
  for(int i=0;i<100&&gain_value!=0;i++)sleep_ms(1);assert(gain_value==0);
  px_mic_stop();wait_idle();assert(px_mic_start(16000,32)==0);wait_pending(2);
  px_mic_stop();wait_idle();assert(acquired==2&&released==2);
 }else if(which==15||which==16){
  cancel_delayed=true;
  if(which==16){
   pthread_t vm;assert(pthread_create(&vm,NULL,short_vm,NULL)==0);
   assert(pthread_join(vm,NULL)==0);
  }else{assert(px_mic_start(16000,10)==0);wait_pending(2);px_mic_stop();}
  assert(px_mic_quiesce(0)==-ETIMEDOUT&&px_mic_quiesce(30)==-ETIMEDOUT);
  assert(allocations==2&&acquired==1&&released==0&&cancelled>=1);
  assert(px_mic_start(16000,10)==-EBUSY);
  deliver(0,0,0,-ECANCELED,false);assert(px_mic_quiesce(10)==-ETIMEDOUT);
  assert(allocations==2&&released==0);
  deliver(1,0,0,-ECANCELED,false);assert(px_mic_quiesce(1000)==0);wait_idle();
  cancel_delayed=false;assert(px_mic_poll(&frame,1)==0);
  assert(px_mic_start(16000,10)==0);wait_pending(2);
  deliver(0,160,900,0,false);assert(poll(&frame)==1&&sample_at(&frame,0)==900);free(frame.data);
  px_mic_stop();assert(px_mic_quiesce(1000)==0);wait_idle();
 }else if(which==17){
  prepare_blocked=true;assert(px_mic_start(16000,10)==0);
  for(int i=0;i<100&&!prepared;i++)sleep_ms(1);assert(prepared==1);
  px_mic_stop();assert(px_mic_quiesce(25)==-ETIMEDOUT);
  assert(acquired==1&&released==0&&allocations==0&&powered==0);
  prepare_blocked=false;assert(px_mic_quiesce(1000)==0);wait_idle();
  assert(px_mic_start(16000,10)==0);wait_pending(2);px_mic_stop();wait_idle();
 }else if(which==20){
  /* 覆盖 JS poll 与 ensureCapture 之间的线程退出竞态。 */
  prepare_error=-ENXIO;assert(px_mic_start(16000,10)==0);wait_idle();
  prepare_error=0;assert(px_mic_start(16000,10)==-ENXIO);
  assert(prepared==1&&px_mic_poll(&frame,1)==-ENXIO&&px_mic_poll(&frame,1)==0);
  assert(px_mic_start(16000,10)==0);wait_pending(2);px_mic_stop();wait_idle();
 }else if(which==21){
  /* 真正编译 mic.c：VM 暂停消费 320ms 音频后，顺序与样本均须完整。 */
  assert(px_mic_start(16000,10)==0);
  for(int i=0;i<10;i++){
   wait_pending(2);deliver(i%2,512,i*512,0,false);sleep_ms(2);
  }
  wait_pending(2);assert(px_mic_active());
  for(int i=0;i<32;i++){
   assert(px_mic_poll(&frame,1)==1&&frame.bytes==320);
   for(unsigned j=0;j<160;j++)assert(sample_at(&frame,j)==i*160+(int)j);
   free(frame.data);
  }
  assert(px_mic_poll(&frame,1)==0);px_mic_stop();wait_idle();
 }else if(which==22){
  /* 连续四次320ms积压跨过一秒环形队列末端；批量只交付已就绪的完整帧。 */
  assert(px_mic_poll(NULL,10)==-EINVAL&&px_mic_poll(&frame,0)==-EINVAL);
  assert(px_mic_start(16000,10)==0);
  unsigned consumed=0;
  for(int turn=0;turn<4;turn++){
   for(int i=0;i<10;i++){
    wait_pending(2);deliver(i%2,512,turn*5120+i*512,0,false);sleep_ms(2);
   }
   wait_pending(2);
   for(int batch=0;batch<4;batch++){
    assert(px_mic_poll(&frame,10)==1);
    assert(frame.bytes==(batch==3?640:3200)&&frame.sample_rate==16000);
    for(unsigned j=0;j<frame.bytes/2;j++)assert(sample_at(&frame,j)==(int)consumed++);
    free(frame.data);
   }
   assert(px_mic_poll(&frame,10)==0);
  }
  assert(consumed==20480);px_mic_stop();wait_idle();
#ifdef PX_AUDIO_WORKER_TEST
 }else if(which==18){
  cancel_delayed=true;assert(px_mic_start(16000,10)==0);wait_pending(2);
  struct test_worker_status before=test_worker_snapshot();
  assert(before.registered==1&&before.active==1&&before.stack==8192&&before.beats==0);
  assert(px_mic_set_gain(50)==0);sleep_ms(25);
  struct test_worker_status after=test_worker_snapshot();
  assert(after.beats==before.beats&&after.progress_ms==before.progress_ms);
  px_mic_stop();assert(px_mic_quiesce(25)==-ETIMEDOUT);
  after=test_worker_snapshot();assert(after.active==1&&after.beats==before.beats);
  deliver(0,0,0,-ECANCELED,false);assert(px_mic_quiesce(10)==-ETIMEDOUT);
  after=test_worker_snapshot();assert(after.active==1&&after.beats==before.beats);
  deliver(1,0,0,-ECANCELED,false);assert(px_mic_quiesce(1000)==0);wait_idle();
  after=test_worker_snapshot();assert(after.active==0&&after.registered==0&&after.beats>before.beats);
 }else if(which==19){
  test_worker_create_error=-EAGAIN;
  assert(px_mic_start(16000,10)==-EAGAIN&&px_mic_quiesce(0)==0);
  assert(prepared==0&&acquired==released);test_worker_create_error=0;
  test_worker_register_error=-ENOSPC;assert(px_mic_start(16000,10)==0);
  assert(poll(&frame)==-ENOSPC);assert(px_mic_quiesce(1000)==0);wait_idle();
  assert(prepared==0&&test_worker_snapshot().registered==0);
  test_worker_register_error=0;assert(px_mic_start(16000,10)==0);wait_pending(2);
  px_mic_stop();wait_idle();
#endif
 }else return 2;
 return 0;
}
'''

class MicTransportTests(unittest.TestCase):
    worker_mode = False
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="pixelbox-mic-")
        root = Path(cls.temporary.name)
        (root / "mic_test_platform.h").write_text(HEADER)
        (root / "test.c").write_text(SOURCE)
        cls.binary = root / "test"
        command = [os.environ.get("CC", "cc"), "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-DPX_MIC_TEST", "-DPX_MIC_TIMEOUT_MS=100", "-Wall", "-Wextra", "-Werror", "-pthread", "-I", str(root), "-I", str(PROJECT / "include"), str(PROJECT / "src/mic.c"), str(root / "test.c"), "-o", str(cls.binary)]
        if cls.worker_mode:
            (root / "audio_worker_test_platform.h").write_text(WORKER_HEADER)
            (root / "worker.c").write_text(WORKER_SOURCE)
            command += ["-DPX_AUDIO_WORKER_TEST", str(root / "worker.c")]
        result = subprocess.run(command, text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_capture_paths(self):
        cases = list(range(1, 20 if self.worker_mode else 18)) + [20, 21, 22]
        for index in cases:
            with self.subTest(case=index):
                result = subprocess.run([str(self.binary), str(index)], text=True, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class IndependentMicTransportTests(MicTransportTests):
    worker_mode = True


if __name__ == "__main__":
    unittest.main()
