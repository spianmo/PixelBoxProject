#define _POSIX_C_SOURCE 200809L
#include "pixelbox_net.h"
#include "pixelbox_tls.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#x); exit(1); } } while(0)
static _Thread_local int blackhole = -1;
static uint64_t milliseconds(void)
{ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint64_t)t.tv_sec*1000+t.tv_nsec/1000000; }
static void sleep_ms(int ms) { (void)poll(NULL,0,ms); }

/* 首个地址模拟丢弃 SYN 的黑洞，次地址使用真实 TCP 回环，保证回归可重复。 */
int px_fallback_getaddrinfo(const char *host,const char *service,const struct addrinfo *hints,struct addrinfo **out)
{
  unsigned count = !strcmp(host,"single.invalid") || !strcmp(host,"late-tls.invalid") ? 1 :
    !strcmp(host,"many.invalid") ? 64 : 2;
  struct addrinfo **tail=out;
  for(unsigned i=0;i<count;++i) {
    struct addrinfo *a=calloc(1,sizeof(*a)); CHECK(a);
    struct sockaddr_in *s=calloc(1,sizeof(*s)); CHECK(s);
    s->sin_family=AF_INET; s->sin_port=htons((unsigned short)atoi(service));
    bool good=(i==1&&(!strcmp(host,"fallback.invalid")||!strcmp(host,"fallback-tls.invalid")||!strcmp(host,"wait-tls.invalid")))||!strcmp(host,"late-tls.invalid");
    CHECK(inet_pton(AF_INET,good?"127.0.0.1":"127.0.0.2",&s->sin_addr)==1);
    a->ai_family=AF_INET; a->ai_socktype=hints->ai_socktype; a->ai_protocol=hints->ai_protocol;
    a->ai_addrlen=sizeof(*s); a->ai_addr=(struct sockaddr *)s;
    *tail=a; tail=&a->ai_next;
  }
  return 0;
}
void px_fallback_freeaddrinfo(struct addrinfo *a)
{ while(a) {struct addrinfo *next=a->ai_next;free(a->ai_addr);free(a);a=next;} }
int px_fallback_connect(int fd,const struct sockaddr *a,socklen_t length)
{
  if(ntohl(((const struct sockaddr_in *)a)->sin_addr.s_addr)==0x7f000002) {
    blackhole=fd; errno=EINPROGRESS; return -1;
  }
  return connect(fd,a,length);
}
int px_fallback_poll(struct pollfd *fds,nfds_t count,int timeout)
{
  if(count==1&&fds[0].fd==blackhole) {fds[0].revents=0;return poll(NULL,0,timeout);}
  return poll(fds,count,timeout);
}
int px_fallback_close(int fd)
{ if(fd==blackhole)blackhole=-1;return close(fd); }

/* 只替换TLS握手耗时；TCP仍使用真实回环。不会把此替身作为证书验证证据。 */
struct px_tls { int fd,delay; };
static atomic_uint tls_started,tls_freed;
bool px_tls_available(void) { return true; }
int px_tls_create(int fd,const char *host,struct px_tls **out)
{
  struct px_tls *tls=calloc(1,sizeof(*tls));CHECK(tls);tls->fd=fd;
  tls->delay=!strcmp(host,"late-tls.invalid")?180:!strcmp(host,"wait-tls.invalid")?-1:100;
  *out=tls;atomic_fetch_add(&tls_started,1);return 0;
}
int px_tls_handshake(struct px_tls *tls)
{ if(tls->delay<0)return -EAGAIN;sleep_ms(tls->delay);return 0; }
short px_tls_poll_events(struct px_tls *tls) { (void)tls;return POLLIN; }
bool px_tls_pending(struct px_tls *tls) { (void)tls;return false; }
ssize_t px_tls_read(struct px_tls *tls,void *bytes,size_t size)
{ ssize_t n=read(tls->fd,bytes,size);return n<0?-errno:n; }
ssize_t px_tls_write(struct px_tls *tls,const void *bytes,size_t size)
{ ssize_t n=write(tls->fd,bytes,size);return n<0?-errno:n; }
void px_tls_free(struct px_tls *tls)
{ if(tls){free(tls);atomic_fetch_add(&tls_freed,1);} }

static void run(const char *host,bool success)
{
  struct px_net *net=px_net_create();CHECK(net);
  uint32_t listener,client,accepted=0;unsigned port;
  CHECK(!px_net_listen(net,0,&listener,&port));
  uint64_t start=milliseconds(),deadline=start+1600;
  CHECK(!px_net_connect(net,host,port,strstr(host,"tls")!=NULL,600,&client));
  bool done=false,connected=false;
  while(!done&&milliseconds()<deadline) {
    struct px_net_event event={0};int result=px_net_poll(net,&event);CHECK(result>=0);
    if(!result){sleep_ms(1);continue;}
    if(event.type==PX_NET_ACCEPTED){CHECK(success&&event.id==listener);accepted=event.accepted_id;}
    else if(event.type==PX_NET_CONNECTED){CHECK(success&&event.id==client);connected=true;}
    else {CHECK(!success&&event.id==client&&event.type==PX_NET_CLOSED&&event.error==-ETIMEDOUT);done=true;}
    px_net_event_free(&event);
    if(connected&&accepted)done=true;
  }
  CHECK(done);
  uint64_t elapsed=milliseconds()-start;
  CHECK(elapsed>=250&&elapsed<1000);
  if(success) {
    CHECK(elapsed<550);
    const uint8_t bytes[]={3,7,0,255};CHECK(!px_net_send(net,client,bytes,sizeof(bytes),NULL,0));
    bool received=false;
    while(!received&&milliseconds()<deadline) {
      struct px_net_event event={0};int result=px_net_poll(net,&event);CHECK(result>=0);
      if(!result){sleep_ms(1);continue;}
      CHECK(event.type==PX_NET_DATA&&event.id==accepted&&event.length==sizeof(bytes)&&!memcmp(event.data,bytes,sizeof(bytes)));
      received=true;px_net_event_free(&event);
    }
    CHECK(received);
  } else CHECK(elapsed>=550);
  px_net_destroy(net);sleep_ms(30);
}
static void timeout_case(const char *host,unsigned timeout,unsigned before_poll)
{
  struct px_net *net=px_net_create();CHECK(net);uint32_t listener,client;unsigned port;
  CHECK(!px_net_listen(net,0,&listener,&port));uint64_t start=milliseconds();
  CHECK(!px_net_connect(net,host,port,strstr(host,"tls")!=NULL,timeout,&client));
  sleep_ms((int)before_poll);bool done=false;
  while(!done&&milliseconds()-start<timeout+before_poll+300) {
    struct px_net_event event={0};int result=px_net_poll(net,&event);CHECK(result>=0);
    if(!result){sleep_ms(1);continue;}
    if(event.id==client){CHECK(event.type==PX_NET_CLOSED&&event.error==-ETIMEDOUT);done=true;}
    else CHECK(event.id==listener&&event.type==PX_NET_ACCEPTED);
    px_net_event_free(&event);
  }
  CHECK(done);CHECK(milliseconds()-start>=timeout);px_net_destroy(net);sleep_ms(30);
}
int main(void)
{
  run("fallback.invalid",true);
  run("fallback-tls.invalid",true);
  run("all-dead.invalid",false);
  run("single.invalid",false);
  timeout_case("wait-tls.invalid",600,0);
  /* 暂不轮询主线程，让慢握手有机会越过deadline返回；不能发布迟到成功。 */
  timeout_case("late-tls.invalid",80,240);
  timeout_case("many.invalid",1,0);
  struct px_net *net=px_net_create();CHECK(net);uint32_t client;
  CHECK(!px_net_connect(net,"fallback.invalid",1,false,600,&client));sleep_ms(40);
  uint64_t start=milliseconds();px_net_destroy(net);CHECK(milliseconds()-start<100);sleep_ms(100);
  net=px_net_create();CHECK(net);uint32_t listener;unsigned port;
  CHECK(!px_net_listen(net,0,&listener,&port));unsigned started=atomic_load(&tls_started),freed=atomic_load(&tls_freed);
  CHECK(!px_net_connect(net,"wait-tls.invalid",port,true,600,&client));start=milliseconds();
  while(atomic_load(&tls_started)==started&&milliseconds()-start<500)sleep_ms(1);
  CHECK(atomic_load(&tls_started)==started+1);start=milliseconds();px_net_destroy(net);CHECK(milliseconds()-start<100);
  while(atomic_load(&tls_freed)==freed&&milliseconds()-start<150)sleep_ms(1);
  CHECK(atomic_load(&tls_freed)==freed+1);CHECK(atomic_load(&tls_freed)==atomic_load(&tls_started));
  puts("TCP 多地址回退通过：真实回环收包、TLS保留总期限/迟到成功拒绝、64地址1ms预算、TCP及TLS取消回收");
  return 0;
}
