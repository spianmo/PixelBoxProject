#define _POSIX_C_SOURCE 200809L
#include "pixelbox_net.h"
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(x) do { if (!(x)) {fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#x);exit(1);} } while(0)
static uint64_t milliseconds(void) {struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (uint64_t)t.tv_sec*1000+t.tv_nsec/1000000;}
static void sleep_ms(unsigned value) {struct timespec t={value/1000,(long)(value%1000)*1000000};nanosleep(&t,NULL);}
static bool without_tcp_options;
int px_test_setsockopt(int fd,int level,int option,const void *value,socklen_t length)
{
  if (without_tcp_options && level==IPPROTO_TCP && option==TCP_NODELAY) {
    errno=ENOPROTOOPT;return -1;
  }
  return setsockopt(fd,level,option,value,length);
}
int px_test_getaddrinfo(const char *host,const char *service,const struct addrinfo *hints,struct addrinfo **out)
{
  if (!strcmp(host,"slow.invalid")) {sleep_ms(350);return EAI_NONAME;}
  return getaddrinfo(host,service,hints,out);
}
static struct px_net_event next_event(struct px_net *net)
{
  struct px_net_event event={0};uint64_t deadline=milliseconds()+3000;
  int result;
  while (!(result=px_net_poll(net,&event)) && milliseconds()<deadline) sleep_ms(1);
  CHECK(result==1);return event;
}
int main(int argc,char **argv)
{
  (void)argv;without_tcp_options=argc>1;
  struct px_net *net=px_net_create();CHECK(net);
  uint32_t listener,client,accepted=0;unsigned port;
  CHECK(!px_net_listen(net,0,&listener,&port));CHECK(port);
  CHECK(px_net_connect(net,"127.0.0.1",port,true,1000,&client)==-ENOTSUP);
  CHECK(!px_net_connect(net,"localhost",port,false,1000,&client));
  bool connected=false;
  while(!connected||!accepted) {
    struct px_net_event event=next_event(net);
    if(event.type==PX_NET_CONNECTED) {CHECK(event.id==client);connected=true;}
    else {CHECK(event.type==PX_NET_ACCEPTED && event.id==listener);accepted=event.accepted_id;}
    px_net_event_free(&event);
  }
  uint8_t data[4096];for(unsigned i=0;i<sizeof(data);++i)data[i]=(uint8_t)i;
  CHECK(!px_net_read_pause(net,accepted,true));
  for(unsigned i=0;i<16;++i)CHECK(!px_net_send(net,client,data,sizeof(data),NULL,0));
  CHECK(px_net_send(net,client,data,1,NULL,0)==-ENOBUFS);
  memset(data,0,sizeof(data)); // send复制输入，调用者改写不能影响待发队列。
  for(unsigned i=0;i<25;++i){struct px_net_event event;CHECK(px_net_poll(net,&event)==0);sleep_ms(1);}
  const uint8_t answer[]={1,2,3};CHECK(!px_net_send(net,accepted,answer,sizeof(answer),NULL,0));
  struct px_net_event answer_event=next_event(net);
  CHECK(answer_event.id==client&&answer_event.type==PX_NET_DATA&&answer_event.length==sizeof(answer)&&!memcmp(answer_event.data,answer,sizeof(answer)));
  px_net_event_free(&answer_event);CHECK(!px_net_read_pause(net,accepted,false));
  size_t received=0;
  while(received<65536) {
    struct px_net_event event=next_event(net);CHECK(event.id==accepted&&event.type==PX_NET_DATA);
    for(size_t i=0;i<event.length;++i)CHECK(event.data[i]==(uint8_t)(received+i));
    received+=event.length;px_net_event_free(&event);
  }
  CHECK(!px_net_read_pause(net,client,true));CHECK(!px_net_close(net,client));
  unsigned closes=0;
  while(closes<2) {struct px_net_event event=next_event(net);CHECK(event.type==PX_NET_CLOSED&&!event.error);++closes;px_net_event_free(&event);}
  CHECK(px_net_send(net,client,data,1,NULL,0)==-EBADF);
  uint32_t udp1,udp2;unsigned port1,port2;
  CHECK(!px_net_udp(net,0,&udp1,&port1));CHECK(!px_net_udp(net,0,&udp2,&port2));
  uint8_t message[]={0,255,3,4};
  CHECK(!px_net_send(net,udp1,message,sizeof(message),"localhost",port2));
  CHECK(!px_net_send(net,udp1,NULL,0,"127.0.0.1",port2));
  struct px_net_event event=next_event(net);
  CHECK(event.type==PX_NET_DATAGRAM&&event.id==udp2&&event.port==port1&&event.length==4&&!memcmp(event.data,message,4));
  px_net_event_free(&event);event=next_event(net);
  CHECK(event.type==PX_NET_DATAGRAM&&event.id==udp2&&event.length==0);px_net_event_free(&event);
  CHECK(px_net_send(net,udp1,message,PX_NET_UDP_BYTES+1,"127.0.0.1",port2)==-EMSGSIZE);
  uint32_t slow;uint64_t start=milliseconds();
  CHECK(!px_net_connect(net,"slow.invalid",1,false,25,&slow));
  event=next_event(net);CHECK(event.id==slow&&event.type==PX_NET_CLOSED&&event.error==-ETIMEDOUT);
  CHECK(milliseconds()-start<200);px_net_event_free(&event);
  start=milliseconds();px_net_destroy(net);CHECK(milliseconds()-start<100);
  sleep_ms(450);
  net=px_net_create();CHECK(net);
  for(unsigned i=0;i<4;++i)CHECK(!px_net_connect(net,"slow.invalid",1,false,1000,&slow));
  CHECK(px_net_connect(net,"slow.invalid",1,false,1000,&slow)==-EBUSY);
  px_net_destroy(net);sleep_ms(450);
  net=px_net_create();CHECK(net);
  for(unsigned i=0;i<PX_NET_MAX_SOCKETS;++i)CHECK(!px_net_udp(net,0,&udp1,&port1));
  CHECK(px_net_udp(net,0,&udp1,&port1)==-EMFILE);
  px_net_destroy(net);
  puts("POSIX网络核心通过：异步DNS/连接、64KiB有序发送、读暂停期间TX/显式close、恢复顺序、背压、UDP二进制/空包、超时、VM销毁、worker/socket限额、TLS拒绝");
  return 0;
}
