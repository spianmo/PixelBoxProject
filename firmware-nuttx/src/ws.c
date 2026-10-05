/* RFC6455字节流核心：客户端/服务端共用，分片状态与控制帧互不覆盖。 */
#include "pixelbox_ws.h"
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

struct px_ws_decoder {
  bool server,parsed,fin,masked,active;
  int error;
  unsigned opcode,message_opcode;
  uint8_t header[14],control[125],mask[4];
  size_t header_length,header_needed,frame_length,frame_offset,limit;
  uint8_t *message;size_t message_length,message_capacity;
};
bool px_ws_utf8(const uint8_t *bytes,size_t length)
{
  for(size_t i=0;i<length;){
    uint32_t code=bytes[i++],minimum;unsigned following;
    if(code<128)continue;
    if(code>=0xc2&&code<=0xdf){code&=31;following=1;minimum=0x80;}
    else if(code>=0xe0&&code<=0xef){code&=15;following=2;minimum=0x800;}
    else if(code>=0xf0&&code<=0xf4){code&=7;following=3;minimum=0x10000;}
    else return false;
    if(following>length-i)return false;
    while(following--){uint8_t next=bytes[i++];if((next&0xc0)!=0x80)return false;code=(code<<6)|(next&63);}
    if(code<minimum||code>0x10ffff||(code>=0xd800&&code<=0xdfff))return false;
  }
  return true;
}
bool px_ws_close_code(unsigned code)
{return (code>=1000&&code<=1014&&code!=1004&&code!=1005&&code!=1006)||(code>=3000&&code<=4999);}
struct px_ws_decoder *px_ws_decoder_create(bool server,size_t limit)
{
  if(!limit||limit>16*1024*1024)return NULL;
  struct px_ws_decoder *decoder=calloc(1,sizeof(*decoder));
  if(decoder){decoder->server=server;decoder->limit=limit;decoder->header_needed=2;}
  return decoder;
}
void px_ws_decoder_free(struct px_ws_decoder *decoder)
{if(decoder){free(decoder->message);free(decoder);}}
static int reserve_message(struct px_ws_decoder *decoder,size_t extra)
{
  if(extra>decoder->limit-decoder->message_length)return -EMSGSIZE;
  size_t required=decoder->message_length+extra;
  if(required<=decoder->message_capacity)return 0;
  size_t capacity=decoder->message_capacity?decoder->message_capacity*2:256;
  if(capacity<required)capacity=required;if(capacity>decoder->limit)capacity=decoder->limit;
  uint8_t *next=realloc(decoder->message,capacity);if(!next)return -ENOMEM;
  decoder->message=next;decoder->message_capacity=capacity;return 0;
}
static int parse_header(struct px_ws_decoder *decoder)
{
  const uint8_t *head=decoder->header;unsigned marker=head[1]&127;
  decoder->fin=(head[0]&128)!=0;decoder->opcode=head[0]&15;decoder->masked=(head[1]&128)!=0;
  if((head[0]&0x70)||decoder->masked!=decoder->server)return -EPROTO;
  unsigned op=decoder->opcode;
  if(op!=0&&op!=1&&op!=2&&op!=8&&op!=9&&op!=10)return -EPROTO;
  uint64_t length=marker;size_t p=2;
  if(marker==126){length=(unsigned)head[p]<<8|head[p+1];p+=2;if(length<126)return -EPROTO;}
  else if(marker==127){
    if(head[p]&128)return -EPROTO;length=0;
    for(unsigned i=0;i<8;++i)length=(length<<8)|head[p++];
    if(length<65536)return -EPROTO;
  }
  if(op>=8){if(!decoder->fin||length>125)return -EPROTO;}
  else {
    if(op==0&&!decoder->active)return -EPROTO;
    if(op!=0&&decoder->active)return -EPROTO;
    if(length>decoder->limit-decoder->message_length)return -EMSGSIZE;
    if(op){decoder->active=true;decoder->message_opcode=op;}
    int result=reserve_message(decoder,(size_t)length);if(result)return result;
  }
  if(length>SIZE_MAX)return -EMSGSIZE;
  if(decoder->masked)memcpy(decoder->mask,head+p,4);
  decoder->frame_length=(size_t)length;decoder->frame_offset=0;decoder->parsed=true;return 0;
}
int px_ws_feed(struct px_ws_decoder *decoder,const uint8_t *data,size_t length,size_t *consumed,struct px_ws_event *event)
{
  if(!decoder||(!data&&length)||!consumed||!event)return -EINVAL;
  *consumed=0;memset(event,0,sizeof(*event));if(decoder->error)return decoder->error;
  while(*consumed<length||decoder->parsed){
    if(!decoder->parsed){
      while(decoder->header_length<decoder->header_needed&&*consumed<length)
        decoder->header[decoder->header_length++]=data[(*consumed)++];
      if(decoder->header_length<decoder->header_needed)return 0;
      if(decoder->header_needed==2){
        unsigned marker=decoder->header[1]&127;
        decoder->header_needed=2+(marker==126?2:marker==127?8:0)+((decoder->header[1]&128)?4:0);
        if(decoder->header_length<decoder->header_needed)continue;
      }
      int result=parse_header(decoder);if(result){decoder->error=result;return result;}
    }
    size_t count=decoder->frame_length-decoder->frame_offset;
    if(count>length-*consumed)count=length-*consumed;
    if(count){
      uint8_t *destination=decoder->opcode>=8?decoder->control+decoder->frame_offset:
        decoder->message+decoder->message_length;
      for(size_t i=0;i<count;++i)destination[i]=data[*consumed+i]^(decoder->masked?decoder->mask[(decoder->frame_offset+i)%4]:0);
    }
    decoder->frame_offset+=count;*consumed+=count;if(decoder->opcode<8)decoder->message_length+=count;
    if(decoder->frame_offset<decoder->frame_length)return 0;
    unsigned opcode=decoder->opcode;bool complete=decoder->fin||opcode>=8;
    decoder->parsed=false;decoder->header_length=0;decoder->header_needed=2;
    if(!complete)continue;
    if(opcode>=8){
      if(opcode==8&&(decoder->frame_length==1||(decoder->frame_length>=2&&
        (!px_ws_close_code((unsigned)decoder->control[0]<<8|decoder->control[1])||
         !px_ws_utf8(decoder->control+2,decoder->frame_length-2))))){decoder->error=-EPROTO;return decoder->error;}
      event->data=malloc(decoder->frame_length?decoder->frame_length:1);
      if(!event->data){decoder->error=-ENOMEM;return decoder->error;}
      memcpy(event->data,decoder->control,decoder->frame_length);event->length=decoder->frame_length;event->opcode=opcode;
    }else{
      if(decoder->message_opcode==1&&!px_ws_utf8(decoder->message,decoder->message_length)){
        decoder->error=-EILSEQ;return decoder->error;
      }
      event->opcode=decoder->message_opcode;event->data=decoder->message;event->length=decoder->message_length;
      decoder->message=NULL;decoder->message_length=decoder->message_capacity=0;decoder->active=false;
    }
    return 1;
  }
  return 0;
}
int px_ws_frame(unsigned opcode,bool fin,const void *data,size_t length,const uint8_t mask[4],uint8_t **out,size_t *out_length)
{
  if(!out||!out_length||(!data&&length)||(opcode!=0&&opcode!=1&&opcode!=2&&opcode!=8&&opcode!=9&&opcode!=10)||
     (opcode>=8&&(!fin||length>125))||length>16*1024*1024)return -EINVAL;
  size_t header=2+(length>65535?8:length>125?2:0)+(mask?4:0),position=2;
  uint8_t *bytes=malloc(header+length);if(!bytes)return -ENOMEM;
  bytes[0]=(fin?128:0)|opcode;bytes[1]=(mask?128:0)|(length>65535?127:length>125?126:(unsigned)length);
  if(length>65535)for(unsigned i=0;i<8;++i)bytes[position++]=(uint8_t)((uint64_t)length>>(56-i*8));
  else if(length>125){bytes[position++]=(uint8_t)(length>>8);bytes[position++]=(uint8_t)length;}
  if(mask){memcpy(bytes+position,mask,4);position+=4;}
  for(size_t i=0;i<length;++i)bytes[position+i]=((const uint8_t *)data)[i]^(mask?mask[i%4]:0);
  *out=bytes;*out_length=header+length;return 0;
}
static const char base64_alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
int px_base64_encode(const uint8_t *data,size_t length,char *out,size_t capacity)
{
  if((!data&&length)||!out||length>(INT_MAX/4)*3)return -EINVAL;
  size_t required=((length+2)/3)*4;if(capacity<=required)return -ENOBUFS;
  size_t p=0;
  for(size_t i=0;i<length;i+=3){unsigned n=(unsigned)data[i]<<16;
    if(i+1<length)n|=(unsigned)data[i+1]<<8;if(i+2<length)n|=data[i+2];
    out[p++]=base64_alphabet[n>>18];out[p++]=base64_alphabet[(n>>12)&63];
    out[p++]=i+1<length?base64_alphabet[(n>>6)&63]:'=';out[p++]=i+2<length?base64_alphabet[n&63]:'=';
  }
  out[p]=0;return (int)p;
}
static int base64_value(unsigned char value)
{const char *position=value?strchr(base64_alphabet,value):NULL;return position?(int)(position-base64_alphabet):-1;}
int px_base64_decode(const char *text,size_t length,uint8_t *out,size_t capacity,size_t *written)
{
  if(!written||(!text&&length)||(!out&&capacity)||length%4)return -EINVAL;*written=0;
  for(size_t i=0;i<length;i+=4){
    int a=base64_value(text[i]),b=base64_value(text[i+1]),c=base64_value(text[i+2]),d=base64_value(text[i+3]);
    bool pad2=text[i+2]=='=',pad3=text[i+3]=='=';
    if(a<0||b<0||(!pad2&&c<0)||(!pad3&&d<0)||(pad2&&!pad3)||((pad2||pad3)&&i+4!=length)||
       (pad2&&(b&15))||(!pad2&&pad3&&(c&3)))return -EINVAL;
    size_t count=pad2?1:pad3?2:3;if(count>capacity-*written)return -ENOBUFS;
    uint32_t n=(unsigned)a<<18|(unsigned)b<<12|(unsigned)(c<0?0:c)<<6|(unsigned)(d<0?0:d);
    out[(*written)++]=(uint8_t)(n>>16);if(count>1)out[(*written)++]=(uint8_t)(n>>8);if(count>2)out[(*written)++]=(uint8_t)n;
  }
  return 0;
}
static uint32_t rotate_left(uint32_t value,unsigned bits){return (value<<bits)|(value>>(32-bits));}
int px_ws_accept(const char *key,char out[29])
{
  uint8_t nonce[16];size_t size;
  if(!key||strlen(key)!=24||px_base64_decode(key,24,nonce,sizeof(nonce),&size)||size!=16||!out)return -EINVAL;
  uint8_t message[128]={0};memcpy(message,key,24);memcpy(message+24,"258EAFA5-E914-47DA-95CA-C5AB0DC85B11",36);
  message[60]=128;message[126]=1;message[127]=224; // (24+36)*8=480bit，SHA-1两块。
  uint32_t hash[5]={0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0};
  for(unsigned block=0;block<2;++block){
    uint32_t words[80];const uint8_t *bytes=message+64*block;
    for(unsigned i=0;i<16;++i)words[i]=(uint32_t)bytes[4*i]<<24|(uint32_t)bytes[4*i+1]<<16|(uint32_t)bytes[4*i+2]<<8|bytes[4*i+3];
    for(unsigned i=16;i<80;++i)words[i]=rotate_left(words[i-3]^words[i-8]^words[i-14]^words[i-16],1);
    uint32_t a=hash[0],b=hash[1],c=hash[2],d=hash[3],e=hash[4];
    for(unsigned i=0;i<80;++i){
      uint32_t f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d;
      uint32_t k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6;
      uint32_t next=rotate_left(a,5)+f+e+k+words[i];e=d;d=c;c=rotate_left(b,30);b=a;a=next;
    }
    hash[0]+=a;hash[1]+=b;hash[2]+=c;hash[3]+=d;hash[4]+=e;
  }
  uint8_t digest[20];for(unsigned i=0;i<5;++i)for(unsigned j=0;j<4;++j)digest[4*i+j]=(uint8_t)(hash[i]>>(24-8*j));
  return px_base64_encode(digest,sizeof(digest),out,29)==28?0:-EINVAL;
}
