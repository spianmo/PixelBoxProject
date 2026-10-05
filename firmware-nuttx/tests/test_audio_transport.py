#!/usr/bin/env python3
"""编译真实 audio.c，用 NuttX 音频/MQ 替身验证协议，整组预算 60 秒。

不操作串口，不把主机替身结果当作真机出声验证。
"""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import unittest

from audio_worker_fixture import HEADER as WORKER_HEADER, SOURCE as WORKER_SOURCE


PROJECT = Path(__file__).resolve().parents[1]

PLATFORM = r"""
#ifndef AUDIO_TEST_PLATFORM_H
#define AUDIO_TEST_PLATFORM_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <time.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
typedef int mqd_t;
struct mq_attr { long mq_flags, mq_maxmsg, mq_msgsize, mq_curmsgs; };
struct ap_buffer_s {
  uint16_t nmaxbytes, nbytes, curbyte, nsamples, flags, crefs;
  uint8_t *samp;
};
struct audio_caps_s {
  uint8_t ac_len, ac_type, ac_subtype, ac_channels;
  union { uint16_t hw; uint8_t b[2]; } ac_format;
  union { uint16_t hw[2]; uint8_t b[4]; uint32_t w; } ac_controls;
};
struct audio_caps_desc_s { struct audio_caps_s caps; };
struct audio_buf_desc_s {
  uint16_t numbytes;
  union { struct ap_buffer_s *buffer; struct ap_buffer_s **pbuffer; } u;
};
struct audio_msg_s { uint16_t msg_id; union { void *ptr; uint32_t data; } u; };
enum { AUDIOIOC_RESERVE=1, AUDIOIOC_RELEASE, AUDIOIOC_CONFIGURE,
       AUDIOIOC_START, AUDIOIOC_STOP, AUDIOIOC_PAUSE, AUDIOIOC_RESUME,
       AUDIOIOC_ALLOCBUFFER, AUDIOIOC_FREEBUFFER, AUDIOIOC_ENQUEUEBUFFER,
       AUDIOIOC_REGISTERMQ, AUDIOIOC_UNREGISTERMQ };
#define AUDIO_TYPE_FEATURE 16
#define AUDIO_TYPE_OUTPUT 2
#define AUDIO_FU_VOLUME 2
#define AUDIO_APB_FINAL 8
#define AUDIO_MSG_DEQUEUE 1
#define AUDIO_MSG_COMPLETE 8
#define AUDIO_MSG_IOERR 13
int px_test_open(const char *, int, ...);
int px_test_close(int);
int px_test_ioctl(int, unsigned long, ...);
mqd_t mq_open(const char *, int, ...);
int mq_close(mqd_t);
int mq_unlink(const char *);
ssize_t mq_timedreceive(mqd_t, char *, size_t, unsigned *, const struct timespec *);
#define open px_test_open
#define close px_test_close
#define ioctl px_test_ioctl
#endif
"""

HARNESS = r"""
#include "audio_test_platform.h"
#include "pixelbox_audio.h"
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef PX_AUDIO_WORKER_TEST
#include "audio_worker_test_platform.h"
#endif

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static struct ap_buffer_s *pending[8];
static int pending_count, allocated, opened, reserved, registered, queues;
static int starts, stops, pauses, resumes, completes, enqueue_count, final_count;
static bool started, paused, have_header, complete_pending;
static bool progress = true, allow_complete = true, stop_blocked;
static int fail_command, fail_errno = EIO, fail_alloc_at;
static int hardware_volume, configured_rate, header_channels;
static uint8_t captured[1000000];
static size_t captured_size;
static unsigned dequeue_delay;

static uint64_t milliseconds(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void sleep_ms(unsigned ms) {
  struct timespec ts = {.tv_sec=ms/1000, .tv_nsec=(ms%1000)*1000000L};
  nanosleep(&ts, NULL);
}
static uint32_t le32(const uint8_t *p) {
  return p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static int failure(int e) { errno=e; return -1; }
int px_test_open(const char *path, int flags, ...) {
#ifdef PX_AUDIO_WORKER_TEST
  assert(test_worker_is_task() && test_worker_snapshot().active==1);
#endif
  assert(!strcmp(path, "/dev/audio/pcm0")); assert(flags==O_RDWR);
  pthread_mutex_lock(&lock);
  if (fail_command == -1) { pthread_mutex_unlock(&lock); return failure(ENODEV); }
  ++opened; pthread_mutex_unlock(&lock); return 7;
}
int px_test_close(int fd) {
  assert(fd==7); pthread_mutex_lock(&lock); --opened;
  have_header=false; pthread_mutex_unlock(&lock); return 0;
}
int px_test_ioctl(int fd, unsigned long command, ...) {
#ifdef PX_AUDIO_WORKER_TEST
  assert(test_worker_is_task() && test_worker_snapshot().active==1);
#endif
  assert(fd==7); va_list args; va_start(args, command);
  unsigned long arg=va_arg(args, unsigned long); va_end(args);
  pthread_mutex_lock(&lock);
  if ((int)command==fail_command) {
    pthread_mutex_unlock(&lock); return failure(fail_errno);
  }
  int result=0;
  switch (command) {
  case AUDIOIOC_RESERVE: assert(!reserved); reserved=1; break;
  case AUDIOIOC_RELEASE: assert(reserved); reserved=0; pending_count=0; break;
  case AUDIOIOC_REGISTERMQ: assert(arg==11 && queues); registered=1; break;
  case AUDIOIOC_UNREGISTERMQ: assert(registered); registered=0; break;
  case AUDIOIOC_ALLOCBUFFER: {
    struct audio_buf_desc_s *d=(void*)arg;
    if (fail_alloc_at && allocated+1==fail_alloc_at) {
      pthread_mutex_unlock(&lock); return failure(ENOMEM);
    }
    struct ap_buffer_s *b=calloc(1,sizeof(*b)); assert(b);
    b->samp=calloc(1,d->numbytes); assert(b->samp);
    b->nmaxbytes=d->numbytes; *d->u.pbuffer=b; ++allocated;
    result=sizeof(*d); break;
  }
  case AUDIOIOC_FREEBUFFER: {
    struct ap_buffer_s *b=((struct audio_buf_desc_s*)arg)->u.buffer;
    for(int i=0;i<pending_count;++i) assert(pending[i]!=b);
    free(b->samp); free(b); --allocated; break;
  }
  case AUDIOIOC_CONFIGURE: {
    struct audio_caps_s *c=&((struct audio_caps_desc_s*)arg)->caps;
    assert(c->ac_type==AUDIO_TYPE_FEATURE && c->ac_format.hw==AUDIO_FU_VOLUME);
    hardware_volume=c->ac_controls.hw[0];
    assert(hardware_volume>=0 && hardware_volume<=1000); break;
  }
  case AUDIOIOC_ENQUEUEBUFFER: {
    struct ap_buffer_s *b=((struct audio_buf_desc_s*)arg)->u.buffer;
    assert(b->curbyte==0); assert(pending_count<8); ++enqueue_count;
    if (!have_header) {
      assert(b->nbytes>=48 && !memcmp(b->samp,"RIFF",4));
      assert(!memcmp(b->samp+8,"WAVEfmt ",8));
      assert(le32(b->samp+16)==16 && b->samp[20]==1 && b->samp[34]==16);
      configured_rate=le32(b->samp+24); header_channels=b->samp[22];
      assert(header_channels==2 && le32(b->samp+28)==configured_rate*4u);
      assert(!memcmp(b->samp+36,"data",4));
      b->curbyte=44; have_header=true;
    }
    assert((b->nbytes-b->curbyte)%4==0);
    assert(captured_size+b->nbytes-b->curbyte<sizeof(captured));
    memcpy(captured+captured_size,b->samp+b->curbyte,b->nbytes-b->curbyte);
    captured_size+=b->nbytes-b->curbyte;
    if(b->flags&AUDIO_APB_FINAL) ++final_count;
    pending[pending_count++]=b; break;
  }
  case AUDIOIOC_START: assert(have_header && hardware_volume>=0); started=true; ++starts; break;
  case AUDIOIOC_STOP:
    while(stop_blocked) pthread_cond_wait(&wake,&lock);
    started=false; pending_count=0; complete_pending=false; ++stops; break;
  case AUDIOIOC_PAUSE: paused=true; ++pauses; break;
  case AUDIOIOC_RESUME: paused=false; ++resumes; break;
  default: assert(!"unknown ioctl");
  }
  pthread_cond_broadcast(&wake); pthread_mutex_unlock(&lock); return result;
}
mqd_t mq_open(const char *name, int flags, ...) {
#ifdef PX_AUDIO_WORKER_TEST
  assert(test_worker_is_task() && test_worker_snapshot().active==1);
#endif
  assert(!strncmp(name,"/pxaudio-",9)); assert(flags&O_EXCL);
  va_list args; va_start(args,flags); (void)va_arg(args,int);
  const struct mq_attr *attr=va_arg(args,const struct mq_attr*); va_end(args);
  assert(attr->mq_msgsize==sizeof(struct audio_msg_s)); assert(attr->mq_maxmsg>=4);
  pthread_mutex_lock(&lock); ++queues; pthread_mutex_unlock(&lock); return 11;
}
int mq_close(mqd_t q) {
  assert(q==11); pthread_mutex_lock(&lock); --queues;
  pthread_mutex_unlock(&lock); return 0;
}
int mq_unlink(const char *name) { assert(!strncmp(name,"/pxaudio-",9)); return 0; }
ssize_t mq_timedreceive(mqd_t q,char *data,size_t size,unsigned *priority,
                       const struct timespec *until) {
  assert(q==11 && size==sizeof(struct audio_msg_s)); (void)priority;
  pthread_mutex_lock(&lock);
  for(;;) {
    struct audio_msg_s msg={0};
    if(started && progress && !paused && pending_count) {
      struct ap_buffer_s *b=pending[0];
      memmove(pending,pending+1,(--pending_count)*sizeof(*pending));
      msg.msg_id=AUDIO_MSG_DEQUEUE; msg.u.ptr=b;
      if(b->flags&AUDIO_APB_FINAL) { assert(!pending_count); complete_pending=true; }
    } else if(complete_pending && allow_complete) {
      complete_pending=false; msg.msg_id=AUDIO_MSG_COMPLETE; ++completes;
    }
    if(msg.msg_id) {
      memcpy(data,&msg,sizeof(msg));
      unsigned delay=msg.msg_id==AUDIO_MSG_DEQUEUE?dequeue_delay:0;
      pthread_mutex_unlock(&lock);
      if(delay) sleep_ms(delay);
      return sizeof(msg);
    }
    int result=pthread_cond_timedwait(&wake,&lock,until);
    if(result==ETIMEDOUT) { pthread_mutex_unlock(&lock); return failure(ETIMEDOUT); }
    assert(!result);
  }
}
static void verify_clean(void) {
  uint64_t limit=milliseconds()+1500;
  for(;;) {
    pthread_mutex_lock(&lock);
    bool clean=!allocated&&!opened&&!reserved&&!registered&&!queues;
    pthread_mutex_unlock(&lock);
    if(clean) { assert(px_audio_quiesce(1500)==0); return; }
    assert(milliseconds()<limit); sleep_ms(5);
  }
}
static struct px_audio_result wait_result(void) {
  struct px_audio_result result;
  uint64_t limit=milliseconds()+2000;
  while(!px_audio_poll(&result)) { assert(milliseconds()<limit); sleep_ms(5); }
  return result;
}
static void wait_enqueued(int n) {
  uint64_t limit=milliseconds()+1000;
  for(;;) {
    pthread_mutex_lock(&lock); bool enough=enqueue_count>=n; pthread_mutex_unlock(&lock);
    if(enough) return;
    assert(milliseconds()<limit); sleep_ms(5);
  }
}
static void reset(void) {
  verify_clean(); pthread_mutex_lock(&lock);
  starts=stops=pauses=resumes=completes=enqueue_count=final_count=0;
  captured_size=0; configured_rate=header_channels=hardware_volume=0;
  progress=allow_complete=true; stop_blocked=started=paused=have_header=false;
  complete_pending=false; fail_command=fail_alloc_at=0;
  dequeue_delay=0;
  pthread_mutex_unlock(&lock);
  assert(px_audio_init()==0); assert(px_audio_set_volume(70)==0);
}
static void tone_test(void) {
  reset(); uint32_t id; assert(px_audio_tone(1000,100,80,&id)==0);
  struct px_audio_result result=wait_result(); verify_clean();
  assert(result.job_id==id && result.error==0);
  assert(starts==1&&stops==1&&completes==1&&final_count==1);
  assert(configured_rate==16000&&header_channels==2&&captured_size==6400);
  assert(hardware_volume==700);
  int positives=0,negatives=0,crossings=0,previous=0;
  for(size_t i=0;i<captured_size;i+=4) {
    int sample=(int16_t)(captured[i]|captured[i+1]<<8);
    assert(captured[i]==captured[i+2]&&captured[i+1]==captured[i+3]);
    assert(abs(sample)<=21000); positives+=sample>0; negatives+=sample<0;
    if(previous<0&&sample>=0) ++crossings;
    previous=sample;
  }
  assert(positives>500&&negatives>500&&crossings>=98&&crossings<=100);
  assert(!px_audio_playing(0)); assert(px_audio_poll(&result)==0);
}
static void pcm_test(void) {
  reset(); uint32_t id;
  uint8_t pcm[]={0x34,0x12,0xcd,0xab,0xff,0x7f,0x00,0x80};
  assert(px_audio_play_pcm(pcm,sizeof(pcm),16000,1,&id)==0);
  memset(pcm,0,sizeof(pcm));
  assert(wait_result().error==0); verify_clean();
  const uint8_t expected[]={0x34,0x12,0x34,0x12,0xcd,0xab,0xcd,0xab,
                            0xff,0x7f,0xff,0x7f,0x00,0x80,0x00,0x80};
  assert(captured_size==sizeof(expected)&&!memcmp(captured,expected,sizeof(expected)));
  assert(enqueue_count==1&&final_count==1);
  reset(); uint8_t stereo[]={1,2,3,4,5,6,7,8};
  assert(px_audio_play_pcm(stereo,sizeof(stereo),48000,2,&id)==0);
  assert(wait_result().error==0); verify_clean();
  assert(configured_rate==48000&&captured_size==8&&!memcmp(captured,stereo,8));
}
static void put32(uint8_t *p,uint32_t value) {
  p[0]=value; p[1]=value>>8; p[2]=value>>16; p[3]=value>>24;
}
static uint8_t *encoded_wav(size_t samples,size_t *bytes) {
  *bytes=44+samples*2; uint8_t *data=calloc(1,*bytes); assert(data);
  memcpy(data,"RIFF",4); put32(data+4,(uint32_t)*bytes-8);
  memcpy(data+8,"WAVEfmt ",8); put32(data+16,16); data[20]=1; data[22]=1;
  put32(data+24,16000); put32(data+28,32000); data[32]=2; data[34]=16;
  memcpy(data+36,"data",4); put32(data+40,(uint32_t)samples*2);
  for(size_t i=0;i<samples*2;++i)data[44+i]=(uint8_t)i;
  return data;
}
static void encoded_test(void) {
  reset(); uint32_t id,other; size_t bytes; uint8_t *source=encoded_wav(16000,&bytes);
  pthread_mutex_lock(&lock); dequeue_delay=25; pthread_mutex_unlock(&lock);
  uint64_t began=milliseconds();
  assert(px_audio_play_encoded(source,bytes,&id)==0); memset(source,0,bytes); free(source);
  struct px_audio_result event=wait_result();
  assert(event.started&&event.error==0&&event.job_id==id);
  assert(px_audio_tone(440,100,50,&other)==-EBUSY);
  event=wait_result(); assert(!event.started&&event.error==0&&event.job_id==id);
  verify_clean(); assert(milliseconds()-began>250);
  assert(captured_size==64000&&final_count==1&&starts==1&&completes==1);
  for(size_t i=0;i<captured_size;i+=4) {
    assert(captured[i]==(uint8_t)(i/2)&&captured[i+1]==(uint8_t)(i/2+1));
    assert(captured[i]==captured[i+2]&&captured[i+1]==captured[i+3]);
  }
  assert(px_audio_poll(&event)==0);
  reset(); source=encoded_wav(1,&bytes);
  assert(px_audio_play_encoded(source,bytes,&id)==0); free(source);
  sleep_ms(50); verify_clean();
  assert(px_audio_tone(440,100,50,&other)==-EBUSY);
  assert(wait_result().started); assert(px_audio_tone(440,100,50,&other)==-EBUSY);
  event=wait_result(); assert(!event.started&&event.error==0);
}
static void encoded_failure_test(void) {
  reset(); uint32_t id; const char invalid[]="bad audio source";
  assert(px_audio_play_encoded(invalid,sizeof(invalid),&id)==0);
  struct px_audio_result event=wait_result();
  assert(!event.started&&event.error==-EBADMSG&&event.job_id==id);
  verify_clean(); assert(!starts&&!opened&&!captured_size);
  reset(); size_t bytes; uint8_t *source=encoded_wav(10,&bytes);
  pthread_mutex_lock(&lock); fail_command=AUDIOIOC_START; pthread_mutex_unlock(&lock);
  assert(px_audio_play_encoded(source,bytes,&id)==0); free(source);
  event=wait_result(); assert(!event.started&&event.error==-EIO);
  verify_clean(); assert(px_audio_poll(&event)==0);
}
static void completion_test(void) {
  reset(); uint32_t id; pthread_mutex_lock(&lock); allow_complete=false;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,10,50,&id)==0); wait_enqueued(1); sleep_ms(60);
  struct px_audio_result result; assert(px_audio_poll(&result)==0);
  assert(px_audio_playing(id));
  pthread_mutex_lock(&lock); allow_complete=true; pthread_cond_broadcast(&wake);
  pthread_mutex_unlock(&lock); assert(wait_result().error==0); verify_clean();
}
static void stream_test(void) {
  reset(); uint32_t id; assert(px_audio_stream_open(16000,1,&id)==0);
  assert(px_audio_pause(id,true)==0);
  uint8_t *pcm=malloc(65536); assert(pcm);
  for(size_t i=0;i<65536;++i) pcm[i]=(uint8_t)i;
  assert(px_audio_stream_feed(id,pcm,65536)==0);
  assert(px_audio_stream_feed(id,pcm,2)==-EAGAIN);
  assert(px_audio_stream_feed(id,pcm,1)==-EINVAL);
  assert(px_audio_buffered_ms(id)==2048);
  assert(px_audio_stream_end(id)==0);
  assert(px_audio_stream_feed(id,pcm,2)==-EINVAL);
  assert(px_audio_pause(id,false)==0); free(pcm);
  assert(wait_result().error==0); verify_clean();
  assert(captured_size==131072&&final_count==1);
  for(size_t i=0;i<captured_size;i+=4) {
    assert(captured[i]==(uint8_t)(i/2)&&captured[i+1]==(uint8_t)(i/2+1));
    assert(captured[i]==captured[i+2]&&captured[i+1]==captured[i+3]);
  }
}
static void stream_late_end_test(void) {
  reset(); uint32_t id; uint8_t pcm[]={1,2,3,4};
  assert(px_audio_stream_open(16000,2,&id)==0);
  assert(px_audio_stream_feed(id,pcm,4)==0); wait_enqueued(1); sleep_ms(30);
  struct px_audio_result result; assert(px_audio_poll(&result)==0);
  assert(px_audio_stream_end(id)==0);
  assert(wait_result().error==0); verify_clean();
  assert(captured_size==8 && !memcmp(captured,pcm,4));
  assert(!memcmp(captured+4,"\0\0\0\0",4)&&final_count==1);
  reset(); assert(px_audio_stream_open(8000,1,&id)==0);
  assert(px_audio_stream_end(id)==0); assert(wait_result().error==0);
  verify_clean(); assert(starts==0&&captured_size==0);
}
static void cancellation_test(void) {
  reset(); uint32_t id,other;
  pthread_mutex_lock(&lock); progress=false; stop_blocked=true;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,500,40,&id)==0); wait_enqueued(2);
  assert(px_audio_tone(440,10,40,&other)==-EBUSY);
  assert(px_audio_stop(id)==0);
  uint64_t began=milliseconds();
  struct px_audio_result result=wait_result();
  assert(result.error==-ECANCELED&&result.job_id==id&&milliseconds()-began<150);
  assert(!px_audio_playing(id)); assert(px_audio_tone(440,10,40,&other)==-EBUSY);
  pthread_mutex_lock(&lock); assert(allocated==2); stop_blocked=false;
  pthread_cond_broadcast(&wake); pthread_mutex_unlock(&lock);
  verify_clean(); sleep_ms(5); assert(px_audio_poll(&result)==0);
  assert(px_audio_tone(440,10,40,&other)==0);
  pthread_mutex_lock(&lock); progress=true; pthread_cond_broadcast(&wake);
  pthread_mutex_unlock(&lock);
  assert(wait_result().error==0); verify_clean();
}
static void timeout_test(void) {
  reset(); uint32_t id;
  pthread_mutex_lock(&lock); progress=false; stop_blocked=true;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,10,40,&id)==0); wait_enqueued(1);
  struct px_audio_result result=wait_result();
  assert(result.error==-ETIMEDOUT&&result.job_id==id);
  pthread_mutex_lock(&lock); assert(allocated==2); stop_blocked=false;
  pthread_cond_broadcast(&wake); pthread_mutex_unlock(&lock);
  verify_clean();
  reset(); assert(px_audio_stream_open(16000,1,&id)==0);
  assert(wait_result().error==-ETIMEDOUT); verify_clean(); assert(starts==0);
}
static void pause_volume_test(void) {
  reset(); uint32_t id;
  pthread_mutex_lock(&lock); progress=false; pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,100,40,&id)==0); wait_enqueued(2);
  assert(px_audio_pause(id,true)==0); sleep_ms(80);
  assert(!px_audio_playing(id)); assert(px_audio_set_volume(200)==0);
  assert(px_audio_get_volume()==100); sleep_ms(80);
  pthread_mutex_lock(&lock); assert(pauses==1&&hardware_volume==1000);
  pthread_mutex_unlock(&lock); assert(px_audio_pause(id,false)==0);
  pthread_mutex_lock(&lock); progress=true; pthread_cond_broadcast(&wake);
  pthread_mutex_unlock(&lock);
  assert(wait_result().error==0); verify_clean(); assert(resumes==1);
}
static void failure_test(void) {
  const int commands[]={-1,AUDIOIOC_RESERVE,AUDIOIOC_REGISTERMQ,
    AUDIOIOC_ENQUEUEBUFFER,AUDIOIOC_START,AUDIOIOC_CONFIGURE};
  for(size_t i=0;i<sizeof(commands)/sizeof(commands[0]);++i) {
    reset(); uint32_t id;
    pthread_mutex_lock(&lock); fail_command=commands[i]; pthread_mutex_unlock(&lock);
    assert(px_audio_tone(440,100,40,&id)==0);
    struct px_audio_result result=wait_result();
    assert(result.error==(commands[i]==-1?-ENODEV:-EIO)); verify_clean();
  }
  reset(); uint32_t id;
  pthread_mutex_lock(&lock); fail_alloc_at=2; pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,100,40,&id)==0); assert(wait_result().error==-ENOMEM);
  verify_clean();
}
static void validation_test(void) {
  reset(); uint32_t id; uint8_t pcm[4]={0};
  assert(px_audio_tone(NAN,100,80,&id)==-EINVAL);
  assert(px_audio_tone(8000,100,80,&id)==-EINVAL);
  assert(px_audio_tone(440,0,80,&id)==-EINVAL);
  assert(px_audio_tone(440,60001,80,&id)==-EINVAL);
  assert(px_audio_play_pcm(pcm,3,16000,1,&id)==-EINVAL);
  assert(px_audio_play_pcm(pcm,4,12345,1,&id)==-EINVAL);
  assert(px_audio_play_pcm(pcm,4,16000,3,&id)==-EINVAL);
  assert(px_audio_tone(440,100,80,NULL)==-EINVAL);
  assert(px_audio_stream_feed(99,pcm,4)==-ENOENT);
  assert(px_audio_poll(NULL)==-EINVAL);
  px_audio_shutdown(); assert(px_audio_get_volume()==-ENODEV);
  assert(px_audio_tone(440,100,80,&id)==-ENODEV);
}
static void capture_clock_test(void) {
  reset(); uint32_t id; uint8_t pcm[4]={0};
  assert(px_audio_capture_acquire()==0);
  assert(px_audio_capture_acquire()==-EBUSY);
  assert(px_audio_play_pcm(pcm,4,48000,1,&id)==-EBUSY);
  assert(px_audio_stream_open(24000,1,&id)==-EBUSY);
  assert(px_audio_tone(440,10,40,&id)==0);
  assert(wait_result().error==0);verify_clean();
  size_t bytes;uint8_t *wav=encoded_wav(10,&bytes);
  put32(wav+24,48000);put32(wav+28,96000);
  assert(px_audio_play_encoded(wav,bytes,&id)==0);free(wav);
  struct px_audio_result event=wait_result();
  assert(event.error==-EBUSY&&!event.started);verify_clean();
  px_audio_capture_release();
  pthread_mutex_lock(&lock);progress=false;pthread_mutex_unlock(&lock);
  assert(px_audio_play_pcm(pcm,4,48000,1,&id)==0);wait_enqueued(1);
  assert(px_audio_capture_acquire()==-EBUSY);
  assert(px_audio_stop(id)==0);assert(wait_result().error==-ECANCELED);verify_clean();
  reset();int started=-EBUSY;
  for(int attempt=0;attempt<100&&started==-EBUSY;++attempt){
    started=px_audio_tone(440,10,40,&id);if(started==-EBUSY)sleep_ms(2);
  }
  assert(started==0);
  assert(px_audio_capture_acquire()==0);
  assert(wait_result().error==0);verify_clean();px_audio_capture_release();
}
static void shutdown_test(void) {
  reset(); uint32_t id, other;
  pthread_mutex_lock(&lock); progress=false; stop_blocked=true;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,500,40,&id)==0); wait_enqueued(2);
  px_audio_shutdown();
  assert(px_audio_quiesce(0)==-ETIMEDOUT && px_audio_quiesce(80)==-ETIMEDOUT);
  assert(px_audio_init()==-EBUSY && px_audio_tone(440,10,40,&other)==-EBUSY);
  struct px_audio_result event; assert(px_audio_poll(&event)==0);
  pthread_mutex_lock(&lock); assert(allocated==2&&reserved&&opened&&queues);
  stop_blocked=false; pthread_cond_broadcast(&wake); pthread_mutex_unlock(&lock);
  assert(px_audio_quiesce(1000)==0); verify_clean();
  assert(px_audio_poll(&event)==0); assert(px_audio_init()==0);
  pthread_mutex_lock(&lock);progress=true;pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,10,40,&other)==0&&other!=id);
  assert(wait_result().error==0);verify_clean();

  /* 已完成但没有 poll 的旧 VM 结果也必须被 shutdown 丢弃。 */
  size_t bytes; uint8_t *source=encoded_wav(1,&bytes);
  assert(px_audio_play_encoded(source,bytes,&id)==0);free(source);
  assert(px_audio_quiesce(1000)==0);px_audio_shutdown();
  assert(px_audio_poll(&event)==0 && px_audio_init()==0);
  assert(px_audio_tone(440,10,40,&other)==0);
  assert(wait_result().error==0);verify_clean();
}
static void *short_vm(void *unused) {
  (void)unused;uint32_t id;
  assert(px_audio_tone(440,500,40,&id)==0);wait_enqueued(2);
  px_audio_shutdown();return NULL;
}
static void vm_exit_test(void) {
  reset();pthread_mutex_lock(&lock);progress=false;stop_blocked=true;
  pthread_mutex_unlock(&lock);
  pthread_t vm;assert(pthread_create(&vm,NULL,short_vm,NULL)==0);
  assert(pthread_join(vm,NULL)==0);assert(px_audio_quiesce(80)==-ETIMEDOUT);
  pthread_mutex_lock(&lock);assert(allocated==2);stop_blocked=false;
  pthread_cond_broadcast(&wake);pthread_mutex_unlock(&lock);
  assert(px_audio_quiesce(1000)==0);verify_clean();assert(px_audio_init()==0);
  struct px_audio_result event;assert(px_audio_poll(&event)==0);
  pthread_mutex_lock(&lock);progress=true;pthread_mutex_unlock(&lock);
  uint32_t id;assert(px_audio_tone(440,10,40,&id)==0);
  assert(wait_result().error==0);verify_clean();
}
static void release_error_test(void) {
  reset();uint32_t id;pthread_mutex_lock(&lock);progress=false;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,500,40,&id)==0);wait_enqueued(2);
  pthread_mutex_lock(&lock);fail_command=AUDIOIOC_RELEASE;pthread_mutex_unlock(&lock);
  px_audio_shutdown();assert(px_audio_quiesce(80)==-ETIMEDOUT);
  pthread_mutex_lock(&lock);assert(allocated==2&&reserved&&opened&&queues);
  pthread_mutex_unlock(&lock);
#ifdef PX_AUDIO_WORKER_TEST
  struct test_worker_status before=test_worker_snapshot();
  assert(before.active==1&&before.registered==1);sleep_ms(60);
  struct test_worker_status after=test_worker_snapshot();
  assert(after.beats==before.beats&&after.progress_ms==before.progress_ms);
#endif
  assert(px_audio_init()==-EBUSY);
  pthread_mutex_lock(&lock);fail_command=0;progress=true;pthread_mutex_unlock(&lock);
  assert(px_audio_quiesce(1000)==0);verify_clean();assert(px_audio_init()==0);
  assert(px_audio_tone(440,10,40,&id)==0);assert(wait_result().error==0);verify_clean();
}
#ifdef PX_AUDIO_WORKER_TEST
static void worker_health_test(void) {
  reset();uint32_t id;
  assert(px_audio_stream_open(16000,1,&id)==0);sleep_ms(70);
  struct test_worker_status before=test_worker_snapshot();
  assert(before.registered==1&&before.active==0&&before.beats==0&&before.stack==8192);
  sleep_ms(70);assert(test_worker_snapshot().beats==before.beats);
  uint8_t pcm[320]={0};assert(px_audio_stream_feed(id,pcm,sizeof(pcm))==0);
  wait_enqueued(1);sleep_ms(60);before=test_worker_snapshot();
  assert(before.registered==1&&before.active==0&&before.beats>0);
  assert(px_audio_stop(id)==0);assert(wait_result().error==-ECANCELED);verify_clean();
  assert(test_worker_snapshot().registered==0&&test_worker_snapshot().active==0);

  reset();pthread_mutex_lock(&lock);progress=false;stop_blocked=true;
  pthread_mutex_unlock(&lock);
  assert(px_audio_tone(440,500,40,&id)==0);wait_enqueued(2);
  before=test_worker_snapshot();assert(before.active==1);
  assert(px_audio_set_volume(40)==0);sleep_ms(90);
  struct test_worker_status waiting=test_worker_snapshot();
  assert(waiting.beats==before.beats&&waiting.progress_ms==before.progress_ms);
  assert(px_audio_pause(id,true)==0);sleep_ms(70);
  before=test_worker_snapshot();assert(before.registered==1&&before.active==0);
  sleep_ms(70);assert(test_worker_snapshot().beats==before.beats);
  assert(px_audio_pause(id,false)==0);sleep_ms(70);
  before=test_worker_snapshot();assert(before.active==1);
  px_audio_shutdown();assert(px_audio_quiesce(80)==-ETIMEDOUT);
  waiting=test_worker_snapshot();assert(waiting.active==1&&waiting.beats==before.beats);
  pthread_mutex_lock(&lock);stop_blocked=false;pthread_cond_broadcast(&wake);
  pthread_mutex_unlock(&lock);
  assert(px_audio_quiesce(1000)==0);verify_clean();
  assert(test_worker_snapshot().registered==0&&test_worker_snapshot().active==0);
}
static void worker_failure_test(void) {
  reset();uint32_t id;test_worker_create_error=-EAGAIN;
  assert(px_audio_tone(440,10,40,&id)==-EAGAIN&&px_audio_quiesce(0)==0);
  test_worker_create_error=0;test_worker_register_error=-ENOSPC;
  assert(px_audio_tone(440,10,40,&id)==0);
  assert(wait_result().error==-ENOSPC);verify_clean();
  assert(test_worker_snapshot().registered==0);
  test_worker_register_error=0;size_t bytes;uint8_t *source=encoded_wav(1,&bytes);
  assert(px_audio_play_encoded(source,bytes,&id)==0);free(source);
  assert(test_worker_snapshot().stack==32768);
  assert(wait_result().started);assert(wait_result().error==0);verify_clean();
}
#endif
int main(int argc,char **argv) {
  assert(argc==2);
  if(!strcmp(argv[1],"tone")) tone_test();
  else if(!strcmp(argv[1],"pcm")) pcm_test();
  else if(!strcmp(argv[1],"encoded")) encoded_test();
  else if(!strcmp(argv[1],"encoded_failure")) encoded_failure_test();
  else if(!strcmp(argv[1],"completion")) completion_test();
  else if(!strcmp(argv[1],"stream")) stream_test();
  else if(!strcmp(argv[1],"stream_end")) stream_late_end_test();
  else if(!strcmp(argv[1],"cancel")) cancellation_test();
  else if(!strcmp(argv[1],"timeout")) timeout_test();
  else if(!strcmp(argv[1],"pause")) pause_volume_test();
  else if(!strcmp(argv[1],"failure")) failure_test();
  else if(!strcmp(argv[1],"validation")) validation_test();
  else if(!strcmp(argv[1],"capture_clock")) capture_clock_test();
  else if(!strcmp(argv[1],"shutdown")) shutdown_test();
  else if(!strcmp(argv[1],"vm_exit")) vm_exit_test();
  else if(!strcmp(argv[1],"release_error")) release_error_test();
#ifdef PX_AUDIO_WORKER_TEST
  else if(!strcmp(argv[1],"worker_health")) worker_health_test();
  else if(!strcmp(argv[1],"worker_failure")) worker_failure_test();
#endif
  else assert(!"unknown case");
  puts("PASS"); return 0;
}
"""


class AudioTransportTests(unittest.TestCase):
    worker_mode = False
    @classmethod
    def setUpClass(cls):
        cls.deadline = time.monotonic() + 60
        cls.directory = tempfile.TemporaryDirectory(prefix="pixelbox-audio-test-")
        cls.root = Path(cls.directory.name)
        (cls.root / "audio_test_platform.h").write_text(PLATFORM)
        (cls.root / "harness.c").write_text(HARNESS)
        cls.binary = cls.root / "audio-test"
        command = [os.environ.get("CC", "cc"), "-std=c11", "-O0", "-g",
                   "-Wall", "-Wextra", "-Werror", "-DPX_AUDIO_TEST",
                   "-DPX_AUDIO_DRAIN_MS=250", "-DPX_AUDIO_STREAM_IDLE_MS=200",
                   f"-I{cls.root}", f"-I{PROJECT / 'include'}",
                   str(PROJECT / "src/audio.c"), str(PROJECT / "src/audio_decode.c"),
                   str(cls.root / "harness.c"),
                   "-pthread", "-lm", "-o", str(cls.binary)]
        if cls.worker_mode:
            (cls.root / "audio_worker_test_platform.h").write_text(WORKER_HEADER)
            (cls.root / "worker.c").write_text(WORKER_SOURCE)
            command += ["-DPX_AUDIO_WORKER_TEST", str(cls.root / "worker.c")]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def check_case(self, case):
        remaining = self.deadline - time.monotonic()
        self.assertGreater(remaining, 0)
        completed = subprocess.run([str(self.binary), case], capture_output=True,
                                   text=True, timeout=min(8, remaining))
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("PASS", completed.stdout)

    def test_tone_waveform_and_codec_protocol(self): self.check_case("tone")
    def test_pcm_ownership_and_channels(self): self.check_case("pcm")
    def test_encoded_start_event_ownership_and_progress_timeout(self): self.check_case("encoded")
    def test_encoded_decode_and_start_failures_do_not_report_started(self): self.check_case("encoded_failure")
    def test_waits_for_hardware_complete(self): self.check_case("completion")
    def test_stream_backpressure_and_drain(self): self.check_case("stream")
    def test_stream_late_and_empty_end(self): self.check_case("stream_end")
    def test_cancel_keeps_buffers_until_driver_stops(self): self.check_case("cancel")
    def test_timeout_and_stream_idle_release_safely(self): self.check_case("timeout")
    def test_pause_resume_and_volume(self): self.check_case("pause")
    def test_startup_failures_release_resources(self): self.check_case("failure")
    def test_validation_and_shutdown(self): self.check_case("validation")
    def test_capture_and_playback_clock_ownership(self): self.check_case("capture_clock")
    def test_shutdown_quiesce_and_next_vm_without_polling_old_events(self): self.check_case("shutdown")
    def test_worker_finishes_after_calling_thread_exits(self): self.check_case("vm_exit")
    def test_failed_release_keeps_buffers_and_watchdog_until_recovered(self): self.check_case("release_error")


class IndependentAudioTransportTests(AudioTransportTests):
    worker_mode = True

    def test_watchdog_only_tracks_real_work_and_cleanup(self): self.check_case("worker_health")
    def test_create_register_failure_and_decoder_stack(self): self.check_case("worker_failure")


if __name__ == "__main__":
    unittest.main()
