/* 真实POSIX事件层+TLS组合测试，覆盖握手所有权移交与超时/销毁竞态。 */
#include "pixelbox_net.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#ifdef PX_NET_TEST_KTHREAD
#include "net_worker_test_platform.h"
#endif

int px_test_tls_socket(int domain,int type,int protocol)
{
  int fd=socket(domain,type,protocol);
  if(fd>=0&&type==SOCK_STREAM){int bytes=1024;assert(setsockopt(fd,SOL_SOCKET,SO_SNDBUF,&bytes,sizeof(bytes))==0);}
  return fd;
}
static uint64_t milliseconds(void)
{struct timespec value;assert(clock_gettime(CLOCK_MONOTONIC,&value)==0);return (uint64_t)value.tv_sec*1000+(unsigned)value.tv_nsec/1000000;}
static void pause_ms(unsigned delay)
{struct timespec value={(time_t)(delay/1000),(long)(delay%1000)*1000000};nanosleep(&value,NULL);}
static unsigned fd_count(void)
{unsigned count=0;for(int fd=0;fd<1024;++fd)if(fcntl(fd,F_GETFD)>=0)++count;return count;}
static void check_worker_clean(void)
{
#ifdef PX_NET_TEST_KTHREAD
  struct px_net_test_stats state = px_net_test_snapshot();
  for (unsigned i=0;i<300 && state.started!=state.finished;++i) {
    pause_ms(1); state=px_net_test_snapshot();
  }
  assert(state.started==state.finished && !state.fds && !state.borrowed && !state.pending);
#endif
}
int main(int argc,char **argv)
{
  assert(argc==3);const char *scenario=argv[1];unsigned port=(unsigned)atoi(argv[2]);
#ifdef PX_NET_TEST_KTHREAD
  px_net_test_small_send_buffer(true);
#endif
  bool timeout=!strcmp(scenario,"timeout"),destroy=!strcmp(scenario,"destroy"),pressure=!strcmp(scenario,"pressure");
  int expected=timeout?-ETIMEDOUT:!strcmp(scenario,"hostname")||!strcmp(scenario,"wrong_ca")?-EACCES:
    !strcmp(scenario,"missing")?-ENOTSUP:!strcmp(scenario,"truncated")?-ECONNRESET:0;
  /* 先初始化宿主libc的DNS服务连接，再统计本模块持有的fd变化。 */
  struct addrinfo hints={0},*addresses=NULL;hints.ai_family=AF_INET;hints.ai_socktype=SOCK_STREAM;
  assert(getaddrinfo("localhost","80",&hints,&addresses)==0);freeaddrinfo(addresses);
  unsigned baseline=fd_count();struct px_net *net=px_net_create();assert(net);uint32_t id;
  uint64_t started=milliseconds();
  assert(px_net_connect(net,!strcmp(scenario,"hostname")?"127.0.0.1":"localhost",port,true,timeout?40:5000,&id)==0);
  if(destroy){
    pause_ms(30);started=milliseconds();px_net_destroy(net);assert(milliseconds()-started<100);
    for(unsigned i=0;i<300&&fd_count()!=baseline;++i)pause_ms(1);
    assert(fd_count()==baseline);check_worker_clean();puts("PASS net+TLS destroy");return 0;
  }
  size_t sent=0,received=0,total=pressure?1024*1024:65536;bool connected=false,closed=false,saw_pressure=false;
  unsigned char block[16384];for(unsigned i=0;i<sizeof(block);++i)block[i]=pressure?0x5a:(unsigned char)(i%251);
  while(!closed&&milliseconds()-started<15000){
    if(connected&&sent<total&&!expected){
      size_t count=total-sent<sizeof(block)?total-sent:sizeof(block);
      // 为普通回环生成连续序号，保证分片/队列边界未打乱字节。
      if(!pressure)for(size_t i=0;i<count;++i)block[i]=(unsigned char)((sent+i)%251);
      int result=px_net_send(net,id,block,count,NULL,0);
      if(result==-ENOBUFS)saw_pressure=true;else{assert(result==0);sent+=count;}
    }
    struct px_net_event event;int result=px_net_poll(net,&event);assert(result>=0);
    if(result){
      assert(event.id==id);
      if(event.type==PX_NET_CONNECTED){assert(!expected||expected==-ECONNRESET);connected=true;}
      else if(event.type==PX_NET_DATA){
        for(size_t i=0;i<event.length;++i)assert(event.data[i]==(pressure?'K':expected==-ECONNRESET?"payload"[received+i]:(unsigned char)((received+i)%239)));
        received+=event.length;
      }else if(event.type==PX_NET_CLOSED){
        if(event.error!=expected)fprintf(stderr,"scenario=%s actual=%d expected=%d\n",scenario,event.error,expected);
        assert(event.error==expected);closed=true;
      }else assert(!"unexpected event");
      px_net_event_free(&event);
    }
    pause_ms(1);
  }
  assert(closed);
  if(timeout)assert(milliseconds()-started<250);
  if(!expected){assert(connected&&sent==total&&received==(pressure?1:12000));if(pressure)assert(saw_pressure);}
  if(expected==-ECONNRESET)assert(connected&&received==7);
  px_net_destroy(net);
  for(unsigned i=0;i<300&&fd_count()!=baseline;++i)pause_ms(1);
  if(fd_count()!=baseline){
    fprintf(stderr,"fd基线=%u 当前=%u scenario=%s\n",baseline,fd_count(),scenario);
    for(int fd=0;fd<64;++fd)if(fcntl(fd,F_GETFD)>=0){
      char path[1024]={0};
#ifdef F_GETPATH
      (void)fcntl(fd,F_GETPATH,path);
#endif
      fprintf(stderr,"fd=%d path=%s\n",fd,path);
    }
  }
  assert(fd_count()==baseline);check_worker_clean();printf("PASS net+TLS %s\n",scenario);return 0;
}
