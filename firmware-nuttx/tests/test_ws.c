#include "pixelbox_ws.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const uint8_t mask[4]={17,92,41,103};
static uint8_t *frame(unsigned opcode,bool fin,const void *data,size_t length,bool masked,size_t *size)
{uint8_t *out=NULL;assert(px_ws_frame(opcode,fin,data,length,masked?mask:NULL,&out,size)==0);return out;}
static int feed(struct px_ws_decoder *decoder,const uint8_t *data,size_t length,size_t step,unsigned *events)
{
  for(size_t offset=0;offset<length;){
    size_t count=length-offset<step?length-offset:step,consumed=0;struct px_ws_event event;
    int result=px_ws_feed(decoder,data+offset,count,&consumed,&event);
    assert(consumed<=count);offset+=consumed;
    if(result<0)return result;
    if(result){++*events;free(event.data);}else assert(consumed||!count);
  }
  return 0;
}
int main(void)
{
  char accept[29];assert(px_ws_accept("dGhlIHNhbXBsZSBub25jZQ==",accept)==0);
  assert(!strcmp(accept,"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));assert(px_ws_accept("bad",accept)==-EINVAL);
  for(size_t length=0;length<=32768;length=length<5?length+1:length*8){
    uint8_t *input=malloc(length?length:1),*decoded=malloc(length?length:1);char *encoded=malloc((length+2)/3*4+1);
    for(size_t i=0;i<length;++i)input[i]=(uint8_t)(i*31);
    int size=px_base64_encode(input,length,encoded,(length+2)/3*4+1);assert(size>=0);
    size_t written;assert(px_base64_decode(encoded,(size_t)size,decoded,length,&written)==0&&written==length);
    assert(!memcmp(input,decoded,length));free(input);free(decoded);free(encoded);
  }
  const char *invalid[]={"a","A===","AA=A","AA==AAAA","AB==","AAB=","AA\n=","AAAA===="};
  for(unsigned i=0;i<sizeof(invalid)/sizeof(*invalid);++i){uint8_t out[32];size_t n;assert(px_base64_decode(invalid[i],strlen(invalid[i]),out,sizeof(out),&n)<0);}
  size_t lengths[]={0,1,125,126,65535,65536,262144};
  for(unsigned side=0;side<2;++side)for(unsigned i=0;i<sizeof(lengths)/sizeof(*lengths);++i){
    size_t length=lengths[i],size;uint8_t *data=malloc(length?length:1);memset(data,'x',length);
    uint8_t *encoded=frame(1,true,data,length,side,&size);struct px_ws_decoder *decoder=px_ws_decoder_create(side,262144);
    struct px_ws_event event;int result=0;
    for(size_t offset=0;offset<size;){size_t used,count=size-offset<37?size-offset:37;
      result=px_ws_feed(decoder,encoded+offset,count,&used,&event);assert(result>=0);offset+=used;
      if(result){assert(offset==size&&event.opcode==1&&event.length==length&&!memcmp(event.data,data,length));free(event.data);}
    }
    assert(result==1);px_ws_decoder_free(decoder);free(encoded);free(data);
  }
  struct px_ws_decoder *decoder=px_ws_decoder_create(true,128);size_t size,used;struct px_ws_event event;
  uint8_t *encoded=frame(1,false,"\xe4\xb8",2,true,&size);unsigned events=0;assert(feed(decoder,encoded,size,1,&events)==0&&events==0);free(encoded);
  encoded=frame(9,true,"ping",4,true,&size);assert(px_ws_feed(decoder,encoded,size,&used,&event)==1&&event.opcode==9);free(event.data);free(encoded);
  encoded=frame(0,true,"\xad",1,true,&size);assert(px_ws_feed(decoder,encoded,size,&used,&event)==1&&event.opcode==1&&event.length==3&&!memcmp(event.data,"中",3));free(event.data);free(encoded);px_ws_decoder_free(decoder);
  const uint8_t bad[][16]={{0x81,0},{0xc1,0x80,0,0,0,0},{0x80,0x80,0,0,0,0},{0x09,0x80,0,0,0,0},
    {0x81,0xfe,0,1,0,0,0,0,0},{0x82,0xff,0,0,0,0,0,0,0,1,0,0,0,0,0},
    {0x88,0x81,0,0,0,0,0},{0x88,0x82,0,0,0,0,3,0xed},{0x81,0x82,0,0,0,0,0xc0,0x80}};
  const size_t sizes[]={2,6,6,6,9,15,7,8,8};
  for(unsigned i=0;i<sizeof(sizes)/sizeof(*sizes);++i){decoder=px_ws_decoder_create(true,128);events=0;assert(feed(decoder,bad[i],sizes[i],1,&events)<0);px_ws_decoder_free(decoder);}
  uint8_t large[129]={0};encoded=frame(2,true,large,sizeof(large),true,&size);decoder=px_ws_decoder_create(true,128);events=0;
  assert(feed(decoder,encoded,size,7,&events)==-EMSGSIZE);px_ws_decoder_free(decoder);free(encoded);
  uint8_t payload[500];for(unsigned i=0;i<sizeof(payload);++i)payload[i]=(uint8_t)i;
  encoded=frame(2,true,payload,sizeof(payload),true,&size);
  for(size_t prefix=0;prefix<size;++prefix){decoder=px_ws_decoder_create(true,1024);events=0;assert(feed(decoder,encoded,prefix,13,&events)==0&&events==0);px_ws_decoder_free(decoder);}
  uint32_t random=0x12345678;
  for(unsigned i=0;i<4000;++i){uint8_t *changed=malloc(size);memcpy(changed,encoded,size);random=random*1664525+1013904223;
    changed[random%size]^=(uint8_t)(1+(random>>24));decoder=px_ws_decoder_create(true,1024);events=0;
    (void)feed(decoder,changed,size,17,&events);px_ws_decoder_free(decoder);free(changed);
  }
  free(encoded);puts("WebSocket核心通过：RFC握手向量/base64、掩码/长度边界/碎片/控制帧/UTF8、全部截断前缀、4000次帧变异");return 0;
}
