#!/usr/bin/env python3
"""编译真实 I2S 修后函数，验证 DMA 引用、错误回收及超时取消。"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "scripts"))
import i2s_capture_patch as PATCH

DRIVER = PROJECT.parent / ".deps/nuttx/arch/xtensa/src/esp32s3"

PREFIX = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <inttypes.h>
#define OK 0
#define I2S_HAVE_TX 1
#define I2S_HAVE_RX 1
#define I2S_TX 1
#define I2S_RX 0
#define I2S_ROLE_MASTER 1
#define I2S_DMADESC_NUM 2
#define ESP32S3_DMA_BUFLEN_MAX 4092
#define ESP32S3_DMA_CTRL_OWN (1u<<31)
#define ESP32S3_DMA_CTRL_EOF (1u<<30)
#define ESP32S3_DMA_CTRL_DATALEN_S 0
#define ESP32S3_DMA_CTRL_DATALEN_V 4095
#define I2S_TX_START 1
#define I2S_TX_STOP_EN 2
#define I2S_TX_UPDATE 4
#define I2S_RX_START 8
#define I2S_RX_EOF_NUM_M 4095
#define I2S_TX_CONF_REG(p) 0
#define I2S_RX_CONF_REG(p) 1
#define I2S_RXEOF_NUM_REG(p) 2
#define FIELD_TO_VALUE(field,value) (value)
#define SET_GDMA_CH_REG(r,c,v) ((void)(c),(void)(v))
#define HPWORK 1
#define AUDIO_APB_FINAL 1
#define MIN(a,b) ((a)<(b)?(a):(b))
#define DEBUGASSERT assert
#define i2serr(...) ((void)0)
#define i2sinfo(...) ((void)0)
#define i2s_dump_buffer(...) ((void)0)
typedef int irqstate_t;
typedef uintptr_t wdparm_t;
typedef unsigned apb_samp_t;
typedef struct sq_entry_s {struct sq_entry_s *next;} sq_entry_t;
typedef struct {sq_entry_t *head,*tail;} sq_queue_t;
struct work_s {int unused;};
struct wdog_s {bool active;unsigned ticks;void(*fn)(wdparm_t);wdparm_t arg;};
struct esp32s3_dmadesc_s {uint32_t ctrl;struct esp32s3_dmadesc_s *next;};
struct i2s_dev_s {int unused;};
struct ap_buffer_s {unsigned nbytes,curbyte,nmaxbytes,flags,refs;uint8_t *samp;};
typedef void(*i2s_callback_t)(struct i2s_dev_s*,struct ap_buffer_s*,void*,int);
struct esp32s3_buffer_s {
 struct esp32s3_buffer_s *flink;
 struct esp32s3_dmadesc_s dma_link[I2S_DMADESC_NUM];
 i2s_callback_t callback;uint32_t timeout;void *arg;
 struct ap_buffer_s *apb;uint8_t *buf;uint32_t nbytes;int result;
};
struct transport {sq_queue_t pend,act,done;struct work_s work;struct wdog_s watchdog;struct{uint32_t value;size_t bytes;}carry;};
struct config {bool tx_en,rx_en;int role,port;};
struct esp32s3_i2s_s {
 struct i2s_dev_s dev;struct config *config;int dma_channel,slock,lock;
 unsigned data_width;bool capture,streaming;struct transport tx,rx;
 struct esp32s3_buffer_s containers[8];unsigned next;
};
static int lock_error,unlocks,alloc_fail,dma_fail,allocs,frees,releases,callbacks;
static int tx_stops,rx_stops,last_result,spin_depth;
static uint32_t registers[3];
static sq_entry_t *sq_peek(sq_queue_t*q){return q->head;}
static bool sq_empty(sq_queue_t*q){return !q->head;}
static void sq_addlast(sq_entry_t*e,sq_queue_t*q){e->next=NULL;if(q->tail)q->tail->next=e;else q->head=e;q->tail=e;}
static sq_entry_t *sq_remfirst(sq_queue_t*q){sq_entry_t*e=q->head;if(e){q->head=e->next;if(!q->head)q->tail=NULL;e->next=NULL;}return e;}
static irqstate_t spin_lock_irqsave(int*p){(void)p;assert(!spin_depth++);return 0;}
static void spin_unlock_irqrestore(int*p,int f){(void)p;(void)f;assert(--spin_depth==0);}
static int nxmutex_lock(int*p){(void)p;return lock_error;}
static void nxmutex_unlock(int*p){(void)p;++unlocks;}
static void apb_reference(struct ap_buffer_s*b){assert(b->refs);++b->refs;}
static void apb_free(struct ap_buffer_s*b){assert(b->refs>1);--b->refs;}
static void *pixelbox_dma_calloc(size_t n,size_t s){if(alloc_fail)return NULL;++allocs;return calloc(n,s);}
static void pixelbox_dma_free(void*p){if(p){++frees;free(p);}}
static struct esp32s3_buffer_s*i2s_buf_allocate(struct esp32s3_i2s_s*p){assert(p->next<8);return &p->containers[p->next++];}
static void i2s_buf_free(struct esp32s3_i2s_s*p,struct esp32s3_buffer_s*b){(void)p;(void)b;++releases;}
static void modifyreg32(unsigned r,uint32_t clear,uint32_t set){registers[r]=(registers[r]&~clear)|set;}
static unsigned esp32s3_dma_setup(struct esp32s3_dmadesc_s*d,int count,void*buffer,unsigned bytes,bool tx,int ch){(void)count;(void)buffer;(void)ch;if(dma_fail)return 0;d->ctrl=ESP32S3_DMA_CTRL_OWN|(tx?ESP32S3_DMA_CTRL_EOF:0)|bytes;d->next=NULL;return bytes;}
static void esp32s3_dma_load(struct esp32s3_dmadesc_s*d,int c,bool tx){(void)d;(void)c;(void)tx;}
static void esp32s3_dma_enable(int c,bool tx){(void)c;(void)tx;}
static void wd_start(struct wdog_s*w,unsigned ticks,void(*fn)(wdparm_t),wdparm_t arg){w->active=true;w->ticks=ticks;w->fn=fn;w->arg=arg;}
static void wd_cancel(struct wdog_s*w){w->active=false;}
static bool work_available(struct work_s*w){(void)w;return true;}
static int work_queue(int q,struct work_s*w,void(*fn)(void*),void*a,int delay){(void)q;(void)w;(void)fn;(void)a;(void)delay;return 0;}
static void i2s_tx_channel_stop(struct esp32s3_i2s_s*p){(void)p;++tx_stops;}
static void i2s_rx_channel_stop(struct esp32s3_i2s_s*p){(void)p;++rx_stops;}
static void i2s_tx_channel_start(struct esp32s3_i2s_s*p){(void)p;}
static void i2s_rx_channel_start(struct esp32s3_i2s_s*p){(void)p;}
static void i2s_tx_worker(void*);
static void i2s_rx_worker(void*);
static void pixelbox_tx_timeout(wdparm_t);
static void pixelbox_rx_timeout(wdparm_t);
static void callback(struct i2s_dev_s*d,struct ap_buffer_s*b,void*a,int e){(void)d;(void)a;assert(b->refs==2);++callbacks;last_result=e;}
'''

CHECKS = r'''
int main(int argc,char**argv){
 assert(argc==2);int which=atoi(argv[1]);
 struct config config={true,true,I2S_ROLE_MASTER,0};
 struct esp32s3_i2s_s p={.config=&config,.data_width=16,.streaming=true};
 uint8_t samples[64];memset(samples,0x5a,sizeof(samples));
 struct ap_buffer_s a={.nbytes=32,.nmaxbytes=32,.refs=1,.samp=samples};
 struct ap_buffer_s b={.nbytes=32,.nmaxbytes=32,.refs=1,.samp=samples+32};
 if(which==1){
  assert(i2s_send(&p.dev,&a,callback,NULL,123)==0);
  assert(a.refs==2&&p.tx.watchdog.active&&p.tx.watchdog.ticks==123);
  struct esp32s3_buffer_s*buffer=(void*)sq_peek(&p.tx.act);
  assert(!memcmp(buffer->buf,a.samp,32));
  i2s_tx_schedule(&p,buffer->dma_link);
  assert(!p.tx.watchdog.active&&callbacks==0&&a.refs==2);
  i2s_tx_worker(&p);assert(callbacks==1&&last_result==0&&a.refs==1);
 }else if(which==2){
  assert(i2s_receive(&p.dev,&a,callback,NULL,200)==0);
  struct esp32s3_buffer_s*buffer=(void*)sq_peek(&p.rx.act);
  memset(buffer->buf,0x27,32);buffer->dma_link->ctrl=ESP32S3_DMA_CTRL_EOF|32;
  i2s_rx_schedule(&p,buffer->dma_link);i2s_rx_worker(&p);
  assert(callbacks==1&&last_result==0&&a.refs==1&&a.nbytes==32);
  for(int i=0;i<32;i++)assert(a.samp[i]==0x27);
  assert(!p.rx.watchdog.active);
 }else if(which==3||which==4){
  if(which==3)alloc_fail=1;else dma_fail=1;
  int expected=which==3?-ENOMEM:-EIO;
  assert(i2s_send(&p.dev,&a,callback,NULL,10)==expected);
  assert(i2s_receive(&p.dev,&b,callback,NULL,10)==expected);
  assert(a.refs==1&&b.refs==1&&!callbacks&&releases==2);
 }else if(which==5){
  lock_error=-EINTR;
  assert(i2s_send(&p.dev,&a,callback,NULL,10)==-EINTR);
  assert(i2s_receive(&p.dev,&b,callback,NULL,10)==-EINTR);
  assert(a.refs==1&&b.refs==1&&!callbacks&&!unlocks&&releases==2);
 }else if(which==6||which==7){
  assert(i2s_receive(&p.dev,&a,callback,NULL,10)==0);
  assert(i2s_receive(&p.dev,&b,callback,NULL,10)==0);
  assert(!sq_empty(&p.rx.act)&&!sq_empty(&p.rx.pend));
  if(which==6)pixelbox_rx_abort(&p,-ECANCELED);else pixelbox_rx_timeout((wdparm_t)&p);
  assert(sq_empty(&p.rx.act)&&sq_empty(&p.rx.pend)&&!p.rx.watchdog.active);
  i2s_rx_worker(&p);assert(callbacks==2&&a.refs==1&&b.refs==1);
  assert(last_result==(which==6?-ECANCELED:-ETIMEDOUT)&&!a.nbytes&&!b.nbytes);
  pixelbox_rx_abort(&p,-ECANCELED);i2s_rx_worker(&p);assert(callbacks==2);
 }else if(which==8){
  p.capture=true;
  assert(i2s_send(&p.dev,&a,callback,NULL,10)==0);
  assert(i2s_send(&p.dev,&b,callback,NULL,10)==0);
  pixelbox_tx_timeout((wdparm_t)&p);i2s_tx_worker(&p);
  assert(callbacks==2&&last_result==-ETIMEDOUT&&a.refs==1&&b.refs==1);
  assert(sq_empty(&p.tx.act)&&sq_empty(&p.tx.pend)&&tx_stops==1);
  assert((registers[0]&I2S_TX_START)&&!(registers[0]&I2S_TX_STOP_EN));
 }else if(which==9){
  p.capture=true;pixelbox_capture_clock(&p);
  assert(registers[0]&I2S_TX_START);
  assert(i2s_send(&p.dev,&a,callback,NULL,0)==0);
  assert(!p.tx.watchdog.active);
  p.capture=false;pixelbox_capture_clock(&p);
  assert(registers[0]&I2S_TX_START);
  struct esp32s3_buffer_s*buffer=(void*)sq_peek(&p.tx.act);
  i2s_tx_schedule(&p,buffer->dma_link);i2s_tx_worker(&p);
  pixelbox_capture_clock(&p);assert(!(registers[0]&I2S_TX_START));
 }else if(which==10){
  assert(i2s_receive(&p.dev,&a,callback,NULL,10)==0);
  struct esp32s3_buffer_s*buffer=(void*)sq_peek(&p.rx.act);
  buffer->dma_link[0].ctrl=16;buffer->dma_link[0].next=&buffer->dma_link[1];
  buffer->dma_link[1].ctrl=ESP32S3_DMA_CTRL_EOF|16;
  memset(buffer->buf,0x33,32);
  i2s_rx_schedule(&p,&buffer->dma_link[1]);i2s_rx_worker(&p);
  assert(callbacks==1&&a.nbytes==32&&a.refs==1&&a.samp[31]==0x33);
 }else return 2;
 assert(allocs==frees&&spin_depth==0);return 0;
}
'''

class I2SCapturePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DRIVER.exists():
            raise unittest.SkipTest("pinned NuttX source is required")
        cls.source = (DRIVER / "esp32s3_i2s.c").read_text()
        cls.patched = PATCH.patch_text(cls.source)
        cls.temporary = tempfile.TemporaryDirectory(prefix="pixelbox-i2s-")
        root = Path(cls.temporary.name)
        signatures = {
            "i2s_txdma_start": "static int i2s_txdma_start(struct esp32s3_i2s_s *priv)",
            "i2s_rxdma_start": "static int i2s_rxdma_start(struct esp32s3_i2s_s *priv)",
            "i2s_txdma_setup": "static int i2s_txdma_setup(struct esp32s3_i2s_s *priv, struct esp32s3_buffer_s *bfcontainer)",
            "i2s_rxdma_setup": "static int i2s_rxdma_setup(struct esp32s3_i2s_s *priv, struct esp32s3_buffer_s *bfcontainer)",
            "i2s_tx_schedule": "static void i2s_tx_schedule(struct esp32s3_i2s_s *priv, struct esp32s3_dmadesc_s *outlink)",
            "i2s_rx_schedule": "static void i2s_rx_schedule(struct esp32s3_i2s_s *priv, struct esp32s3_dmadesc_s *inlink)",
            "i2s_tx_worker": "static void i2s_tx_worker(void *arg)",
            "i2s_rx_worker": "static void i2s_rx_worker(void *arg)",
            "i2s_send": "static int i2s_send(struct i2s_dev_s *dev, struct ap_buffer_s *apb, i2s_callback_t callback, void *arg, uint32_t timeout)",
            "i2s_receive": "static int i2s_receive(struct i2s_dev_s *dev, struct ap_buffer_s *apb, i2s_callback_t callback, void *arg, uint32_t timeout)",
        }
        bodies = []
        for name, signature in signatures.items():
            begin, end = PATCH.function_body(cls.patched, name)
            bodies.append(signature + "\n" + cls.patched[begin:end])
        (root / "test.c").write_text(PREFIX + "\n".join(bodies) + PATCH.CLOCK_AND_TIMEOUT + CHECKS)
        cls.binary = root / "test"
        result = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-variable", str(root / "test.c"), "-o", str(cls.binary)], text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_idempotent(self):
        self.assertEqual(PATCH.patch_text(self.patched), self.patched)
        header = PATCH.patch_header((DRIVER / "esp32s3_i2s.h").read_text())
        self.assertEqual(PATCH.patch_header(header), header)

    def test_source_drift_fails_closed(self):
        with self.assertRaises(ValueError):
            PATCH.patch_text(self.source.replace("  apb_free(bfcontainer->apb);", "  apb_free(NULL);", 1))
        with self.assertRaisesRegex(ValueError, 'restore pinned'):
            PATCH.patch_text(PATCH.OLD_MARKER + '\n' + self.source)

    def test_real_driver_behaviors(self):
        names = ["tx_ref", "rx_copy", "no_memory", "dma_failure", "mutex_failure", "rx_cancel", "rx_timeout", "tx_timeout", "clock_owner", "rx_descriptors"]
        for index, name in enumerate(names, 1):
            with self.subTest(path=name):
                result = subprocess.run([str(self.binary), str(index)], text=True, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
