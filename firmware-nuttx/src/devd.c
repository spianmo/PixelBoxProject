/* 常驻开发服务：网络线程只处理JSON；应用操作通过纯C邮箱交给VM所属线程。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_devd.h"
#include "pixelbox_mdns.h"
#include "pixelbox_net.h"
#include "pixelbox_store.h"
#include "pixelbox_ws.h"
#include "quickjs.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

#define CLIENTS 4
#define HEADER_BYTES 8192
#define MESSAGE_BYTES (96u*1024u)
#define TX_BYTES (128u*1024u)
#define TX_MESSAGES 32
#define MAILBOX 8
#define LOG_COUNT 128
#define ROOT_BYTES 512
#define EVAL_BYTES 16384
#define RESPONSE_BYTES 32768
/* JSON 处理只占一半栈，留出网络/文件系统调用余量；大消息缓冲均在堆上。 */
#define DEVD_STACK_BYTES (16u * 1024u)
#define DEVD_JSON_STACK_BYTES (DEVD_STACK_BYTES / 2u)

struct output {uint8_t *bytes;size_t length,offset;struct output *next;};
struct client {
  uint32_t socket;uint64_t serial;bool upgraded,closing,subscribed;
  uint64_t deadline,tx_since,log_seq,state_seq;
  char *header;size_t header_size,tx_bytes,tx_count;
  struct px_ws_decoder *decoder;struct output *head,*tail;
};
struct log_entry {uint64_t seq,ts;char level[16],tag[32],message[512];};
struct pending_eval {uint64_t token,client,deadline;double id;};
struct completion {uint64_t token;bool success;char *text;};
struct push_package {
  char *manifest,*entry;struct px_store_file *files;size_t count;
  double id;
};
struct px_devd {
  pthread_t thread;pthread_mutex_t mutex;pthread_cond_t ready;
  bool initialized,stopping,advertise,mdns_dirty;int start_result;unsigned port;
  char storage[ROOT_BYTES],name[64],model[64],firmware[48],ip[64],mac[32];size_t heap_free;
  void (*notify)(void *);void *opaque;
  struct px_devd_action actions[MAILBOX];size_t action_head,action_count;
  struct completion completed[MAILBOX];size_t completed_head,completed_count;
  uint64_t push_token;bool push_pause_ready;int push_pause_error;
  struct log_entry logs[LOG_COUNT];uint64_t log_seq,state_seq;char state[16],state_error[256];
  char current[ROOT_BYTES],entry[PX_STORE_MAX_PATH+1],app[128],version[64];
  /* 以下字段仅服务线程访问，不能传递JSValue到调用线程。 */
  JSRuntime *runtime;JSContext *json;struct px_net *net;struct px_store *store;uint32_t listener;
  struct client clients[CLIENTS];uint64_t next_client,next_token;
  struct pending_eval pending[MAILBOX];
  char session[33],boot[33];uint64_t owner;
  struct push_package *push;bool push_storage_started,push_ending;
  int mdns_error;uint64_t mdns_retry;
};

static uint64_t now_ms(void)
{struct timespec value;clock_gettime(CLOCK_MONOTONIC,&value);return (uint64_t)value.tv_sec*1000+(unsigned long)value.tv_nsec/1000000;}
static uint64_t wall_ms(void)
{struct timespec value;clock_gettime(CLOCK_REALTIME,&value);return (uint64_t)value.tv_sec*1000+(unsigned long)value.tv_nsec/1000000;}
static void copy_text(char *out,size_t capacity,const char *value)
{snprintf(out,capacity,"%s",value?value:"");}
static int random_token(char out[33])
{
  uint8_t bytes[16];int fd=open("/dev/urandom",O_RDONLY);if(fd<0)return -errno;
  for(size_t offset=0;offset<sizeof(bytes);){ssize_t count=read(fd,bytes+offset,sizeof(bytes)-offset);
    if(count<0&&errno==EINTR)continue;if(count<=0){int result=count<0?-errno:-EIO;close(fd);return result;}offset+=(size_t)count;}
  close(fd);static const char hex[]="0123456789abcdef";
  for(size_t i=0;i<sizeof(bytes);++i){out[i*2]=hex[bytes[i]>>4];out[i*2+1]=hex[bytes[i]&15];}out[32]=0;return 0;
}
static void clear_exception(JSContext *ctx)
{JSValue error=JS_GetException(ctx);JS_FreeValue(ctx,error);}
static void text_property(JSContext *ctx,JSValue object,const char *key,const char *value)
{JS_SetPropertyStr(ctx,object,key,JS_NewString(ctx,value?value:""));}
static void number_property(JSContext *ctx,JSValue object,const char *key,double value)
{JS_SetPropertyStr(ctx,object,key,JS_NewFloat64(ctx,value));}
static JSValue ok_value(JSContext *ctx)
{JSValue value=JS_NewObject(ctx);JS_SetPropertyStr(ctx,value,"ok",JS_TRUE);return value;}
static char *string_property(JSContext *ctx,JSValueConst object,const char *key,size_t maximum,bool required)
{
  JSValue value=JS_GetPropertyStr(ctx,object,key);char *result=NULL;
  if(!required&&JS_IsUndefined(value))result=strdup("");
  else if(JS_IsString(value)){size_t length=0;const char *text=JS_ToCStringLen(ctx,&length,value);
    if(text&&length<=maximum&&strlen(text)==length)result=strdup(text);JS_FreeCString(ctx,text);}
  JS_FreeValue(ctx,value);return result;
}
static int number_value(JSContext *ctx,JSValueConst value,double maximum,double *out)
{
  double number;if(!JS_IsNumber(value)||JS_ToFloat64(ctx,&number,value)||!isfinite(number)||number<0||number>maximum||floor(number)!=number)return -EINVAL;
  *out=number;return 0;
}
static int number_field(JSContext *ctx,JSValueConst object,const char *key,double maximum,double *out)
{JSValue value=JS_GetPropertyStr(ctx,object,key);int result=number_value(ctx,value,maximum,out);JS_FreeValue(ctx,value);return result;}

static void finish_push(struct px_devd *service,bool committed);
static void client_drop(struct px_devd *service,struct client *client)
{
  if(!client->socket)return;
  px_net_close(service->net,client->socket);
  if(service->owner==client->serial)finish_push(service,false);
  for(size_t i=0;i<MAILBOX;++i)if(service->pending[i].client==client->serial)service->pending[i].token=0;
  for(struct output *item=client->head;item;){struct output *next=item->next;free(item->bytes);free(item);item=next;}
  free(client->header);px_ws_decoder_free(client->decoder);memset(client,0,sizeof(*client));
}
/* 自有输出队列一直保留到TCP真实排空，慢读客户端不能无限累积日志。 */
static int queue_raw(struct px_devd *service,struct client *client,uint8_t *bytes,size_t length)
{
  if(!client->socket||length>TX_BYTES-client->tx_bytes||client->tx_count>=TX_MESSAGES){free(bytes);client_drop(service,client);return -ENOBUFS;}
  struct output *item=calloc(1,sizeof(*item));if(!item){free(bytes);client_drop(service,client);return -ENOMEM;}
  item->bytes=bytes;item->length=length;if(client->tail)client->tail->next=item;else client->head=item;
  client->tail=item;client->tx_bytes+=length;client->tx_count++;if(!client->tx_since)client->tx_since=now_ms();return 0;
}
static int queue_frame(struct px_devd *service,struct client *client,unsigned opcode,const void *bytes,size_t length)
{
  uint8_t *frame=NULL;size_t size=0;int result=px_ws_frame(opcode,true,bytes,length,NULL,&frame,&size);
  if(result){client_drop(service,client);return result;}return queue_raw(service,client,frame,size);
}
static int send_json(struct px_devd *service,struct client *client,JSValue value)
{
  JSContext *ctx=service->json;JSValue text=JS_JSONStringify(ctx,value,JS_UNDEFINED,JS_UNDEFINED);JS_FreeValue(ctx,value);
  size_t length=0;const char *bytes=JS_IsException(text)?NULL:JS_ToCStringLen(ctx,&length,text);
  int result=bytes?queue_frame(service,client,1,bytes,length):-ENOMEM;
  JS_FreeCString(ctx,bytes);JS_FreeValue(ctx,text);if(result){clear_exception(ctx);client_drop(service,client);}return result;
}
static void response(struct px_devd *service,struct client *client,double id,JSValue value)
{
  JSContext *ctx=service->json;JSValue object=JS_NewObject(ctx);
  JS_SetPropertyStr(ctx,object,"id",isfinite(id)?JS_NewFloat64(ctx,id):JS_NULL);
  JS_SetPropertyStr(ctx,object,"result",value);send_json(service,client,object);
}
static void failure(struct px_devd *service,struct client *client,double id,int code,const char *message)
{
  JSContext *ctx=service->json;JSValue object=JS_NewObject(ctx),error=JS_NewObject(ctx);
  JS_SetPropertyStr(ctx,object,"id",isfinite(id)?JS_NewFloat64(ctx,id):JS_NULL);number_property(ctx,error,"code",code);
  text_property(ctx,error,"message",message);JS_SetPropertyStr(ctx,object,"error",error);send_json(service,client,object);
}
static void event_json(struct px_devd *service,struct client *client,const char *name,JSValue data)
{JSContext *ctx=service->json;JSValue object=JS_NewObject(ctx);text_property(ctx,object,"event",name);JS_SetPropertyStr(ctx,object,"data",data);send_json(service,client,object);}
static void flush_client(struct px_devd *service,struct client *client)
{
  while(client->socket&&client->head){
    struct output *item=client->head;
    if(item->offset==item->length){size_t queued=0;
      if(px_net_queued(service->net,client->socket,&queued)){client_drop(service,client);return;}if(queued)break;
      client->head=item->next;if(!client->head)client->tail=NULL;client->tx_bytes-=item->length;client->tx_count--;
      free(item->bytes);free(item);client->tx_since=client->head?now_ms():0;continue;}
    size_t length=item->length-item->offset;if(length>16384)length=16384;
    int result=px_net_send(service->net,client->socket,item->bytes+item->offset,length,NULL,0);
    if(result==-ENOBUFS)break;if(result){client_drop(service,client);return;}item->offset+=length;
  }
  if(client->socket&&client->closing&&!client->head)client_drop(service,client);
}

static int action_queue(struct px_devd *service,enum px_devd_action_type type,uint64_t token,char *code)
{
  pthread_mutex_lock(&service->mutex);
  bool finish=type==PX_DEVD_PUSH_COMMIT||type==PX_DEVD_PUSH_ABORT;
  size_t capacity=MAILBOX-(service->push_token&&!finish?1u:0u);
  if(service->action_count>=capacity){pthread_mutex_unlock(&service->mutex);return -ENOBUFS;}
  size_t index=(service->action_head+service->action_count)%MAILBOX;
  service->actions[index]=(struct px_devd_action){type,token,code};service->action_count++;
  pthread_mutex_unlock(&service->mutex);
  if(service->notify)service->notify(service->opaque);return 0;
}
static void free_push_package(struct push_package *package)
{
  if(!package)return;
  for(size_t i=0;i<package->count;++i)free((char *)package->files[i].path);
  free(package->files);free(package->manifest);free(package->entry);free(package);
}
static void finish_push(struct px_devd *service,bool committed)
{
  if(service->push_ending)return;
  if(!committed&&service->push_storage_started)(void)px_store_abort(service->store);
  free_push_package(service->push);service->push=NULL;service->push_storage_started=false;
  struct client *client=NULL;
  for(size_t i=0;i<CLIENTS;++i)if(service->clients[i].serial==service->owner){client=&service->clients[i];break;}
  if(client)client->deadline=0;
  service->owner=0;service->session[0]=0;service->push_ending=true;
  pthread_mutex_lock(&service->mutex);uint64_t token=service->push_token;pthread_mutex_unlock(&service->mutex);
  /* 所有其他生产动作保留一个槽，本动作不分配内存，不能遗失恢复旧 VM 的通知。 */
  if(token)(void)action_queue(service,committed?PX_DEVD_PUSH_COMMIT:PX_DEVD_PUSH_ABORT,token,NULL);
}
static int manifest_fields(JSContext *ctx,JSValueConst value,char **entry,char **app,char **version)
{
  if(!JS_IsObject(value)||JS_IsArray(value))return -EINVAL;
  char *name=string_property(ctx,value,"name",127,true);*app=string_property(ctx,value,"id",127,true);
  *version=string_property(ctx,value,"version",63,true);*entry=string_property(ctx,value,"entry",PX_STORE_MAX_PATH,false);
  if(*entry&&!**entry){free(*entry);*entry=strdup("main.js");}
  bool valid=name&&*name&&*app&&**app&&*version&&**version&&*entry&&px_store_valid_path(*entry);
  free(name);return valid?0:-EINVAL;
}
static void refresh_app(struct px_devd *service)
{
  char *text=NULL,*entry=NULL,*app=NULL,*version=NULL,root[ROOT_BYTES]={0};JSValue value=JS_UNDEFINED;
  bool valid=!px_store_current_root(service->store,root,sizeof(root))&&!px_store_manifest(service->store,&text);
  if(valid){value=JS_ParseJSON(service->json,text,strlen(text),"manifest");valid=!JS_IsException(value)&&!manifest_fields(service->json,value,&entry,&app,&version);}
  pthread_mutex_lock(&service->mutex);
  copy_text(service->current,sizeof(service->current),valid?root:"");copy_text(service->entry,sizeof(service->entry),valid?entry:"");
  copy_text(service->app,sizeof(service->app),valid?app:"");copy_text(service->version,sizeof(service->version),valid?version:"");
  service->mdns_dirty=true;
  pthread_mutex_unlock(&service->mutex);free(text);free(entry);free(app);free(version);JS_FreeValue(service->json,value);clear_exception(service->json);
}
static int hex_value(char value)
{if(value>='0'&&value<='9')return value-'0';if(value>='a'&&value<='f')return value-'a'+10;if(value>='A'&&value<='F')return value-'A'+10;return -1;}
static int digest_parse(const char *text,uint8_t bytes[32])
{if(!text||strlen(text)!=64)return -EINVAL;for(size_t i=0;i<32;++i){int a=hex_value(text[i*2]),b=hex_value(text[i*2+1]);if(a<0||b<0)return -EINVAL;bytes[i]=(uint8_t)(a*16+b);}return 0;}
static void push_begin(struct px_devd *service,struct client *client,double id,JSValueConst params)
{
  JSContext *ctx=service->json;
  pthread_mutex_lock(&service->mutex);bool active=service->push_token!=0;
  bool room=service->action_count<MAILBOX-1;pthread_mutex_unlock(&service->mutex);
  if(active){failure(service,client,id,409,"another push is active");return;}
  if(!room){failure(service,client,id,503,"application action queue full");return;}
  JSValue manifest=JS_GetPropertyStr(ctx,params,"manifest"),files=JS_GetPropertyStr(ctx,params,"files");
  char *entry=NULL,*app=NULL,*version=NULL,*json=NULL;struct px_store_file *descriptors=NULL;double count=0;size_t used=0;
  int result=manifest_fields(ctx,manifest,&entry,&app,&version);
  if(!result&&(!JS_IsArray(files)||number_field(ctx,files,"length",PX_STORE_MAX_FILES,&count)||count<1))result=-EINVAL;
  if(!result){JSValue serialized=JS_JSONStringify(ctx,manifest,JS_UNDEFINED,JS_UNDEFINED);size_t length=0;const char *value=JS_IsException(serialized)?NULL:JS_ToCStringLen(ctx,&length,serialized);
    if(value&&length<=PX_STORE_MANIFEST_BYTES)json=strdup(value);JS_FreeCString(ctx,value);JS_FreeValue(ctx,serialized);if(!json)result=-EINVAL;}
  if(!result){descriptors=calloc((size_t)count,sizeof(*descriptors));if(!descriptors)result=-ENOMEM;}
  size_t total=0;bool has_entry=false;
  for(size_t i=0;!result&&i<(size_t)count;++i){
    JSValue file=JS_GetPropertyUint32(ctx,files,(uint32_t)i);double size=0;
    char *path=string_property(ctx,file,"path",PX_STORE_MAX_PATH,true),*sha=string_property(ctx,file,"sha256",64,true);
    descriptors[i].path=path;used=i+1;
    if(!path||!px_store_valid_path(path)||number_field(ctx,file,"size",PX_STORE_FILE_BYTES,&size)||
       digest_parse(sha,descriptors[i].sha256)||size>PX_STORE_TOTAL_BYTES-total)result=-EINVAL;
    if(!result){total+=(size_t)size;if(!strcmp(path,entry))has_entry=true;
      for(size_t j=0;j<i;++j)if(!strcmp(path,descriptors[j].path))result=-EINVAL;}
    descriptors[i].size=(size_t)size;free(sha);JS_FreeValue(ctx,file);
  }
  if(!result&&!has_entry)result=-EINVAL;
  char token[33];if(!result)result=random_token(token);
  struct push_package *package=result?NULL:calloc(1,sizeof(*package));
  if(!result&&!package)result=-ENOMEM;
  if(!result){
    *package=(struct push_package){json,entry,descriptors,(size_t)count,id};
    json=entry=NULL;descriptors=NULL;used=0;service->push=package;service->push_ending=false;
    copy_text(service->session,sizeof(service->session),token);service->owner=client->serial;
    pthread_mutex_lock(&service->mutex);uint64_t ticket=++service->next_token;
    service->push_token=ticket;service->push_pause_ready=false;service->push_pause_error=0;pthread_mutex_unlock(&service->mutex);
    client->deadline=now_ms()+30000;
    /* 这里只排队，网络线程继续处理日志/hello；确认旧 VM 已 join 后才触碰闪存。 */
    result=action_queue(service,PX_DEVD_PUSH_PREPARE,ticket,NULL);
    if(result){free_push_package(service->push);service->push=NULL;service->owner=0;service->session[0]=0;client->deadline=0;
      pthread_mutex_lock(&service->mutex);service->push_token=0;pthread_mutex_unlock(&service->mutex);}
  }
  if(result)failure(service,client,id,result==-EINVAL?-32602:500,"invalid push package or storage failure");
  for(size_t i=0;i<used;++i)free((char *)descriptors[i].path);free(descriptors);free(json);free(entry);free(app);free(version);
  JS_FreeValue(ctx,manifest);JS_FreeValue(ctx,files);clear_exception(ctx);
}
static bool valid_session(struct px_devd *service,struct client *client,JSValueConst params)
{char *text=string_property(service->json,params,"session",32,true);bool valid=text&&!service->push&&service->owner==client->serial&&service->session[0]&&!strcmp(text,service->session);free(text);return valid;}
static void push_chunk(struct px_devd *service,struct client *client,double id,JSValueConst params)
{
  if(!valid_session(service,client,params)){failure(service,client,id,409,"invalid push session");return;}
  JSContext *ctx=service->json;double offset=0;
  char *path=string_property(ctx,params,"path",PX_STORE_MAX_PATH,true),*encoded=string_property(ctx,params,"dataB64",((PX_STORE_CHUNK_BYTES+2)/3)*4,true);
  uint8_t *data=malloc(PX_STORE_CHUNK_BYTES);size_t length=0;int result=-EINVAL;
  if(!data)result=-ENOMEM;
  else if(path&&encoded&&!number_field(ctx,params,"offset",PX_STORE_FILE_BYTES,&offset)&&
          !px_base64_decode(encoded,strlen(encoded),data,PX_STORE_CHUNK_BYTES,&length))result=px_store_write(service->store,path,(size_t)offset,data,length);
  free(path);free(encoded);free(data);
  if(result){finish_push(service,false);failure(service,client,id,result==-EINVAL?-32602:500,"invalid chunk or storage failure");}
  else{client->deadline=now_ms()+30000;JSValue value=JS_NewObject(ctx);number_property(ctx,value,"received",length);response(service,client,id,value);}
}
static void push_end(struct px_devd *service,struct client *client,double id,JSValueConst params)
{
  if(!valid_session(service,client,params)){failure(service,client,id,409,"invalid push session");return;}
  int result=px_store_commit(service->store);
  if(result){finish_push(service,false);failure(service,client,id,500,result==-EBADMSG?"size or SHA-256 mismatch":"package commit failed");return;}
  refresh_app(service);px_devd_state(service,"updating",NULL);finish_push(service,true);
  response(service,client,id,ok_value(service->json));
}
static void request_eval(struct px_devd *service,struct client *client,double id,JSValueConst params)
{
  char *code=string_property(service->json,params,"code",EVAL_BYTES,true);
  if(!code){failure(service,client,id,-32602,"invalid eval code");return;}
  struct pending_eval *pending=NULL;for(size_t i=0;i<MAILBOX;++i)if(!service->pending[i].token){pending=&service->pending[i];break;}
  if(!pending){free(code);failure(service,client,id,503,"eval queue full");return;}
  uint64_t token=++service->next_token;*pending=(struct pending_eval){token,client->serial,now_ms()+15000,id};
  if(action_queue(service,PX_DEVD_EVAL,token,code)){pending->token=0;free(code);failure(service,client,id,503,"application action queue full");}
}
static void request_message(struct px_devd *service,struct client *client,const uint8_t *data,size_t length)
{
  JSContext *ctx=service->json;
  /* WebSocket 只保证字节长度；QuickJS 还要求 data[length] 为 NUL。 */
  char *text=js_strndup(ctx,data?(const char *)data:"",length);
  JSValue request=text?JS_ParseJSON(ctx,text,length,"devd"):JS_EXCEPTION;
  js_free(ctx,text);
  if(JS_IsException(request)){clear_exception(ctx);failure(service,client,NAN,-32700,"invalid JSON");return;}
  double id=NAN;char *method=NULL;JSValue params=JS_UNDEFINED;
  if(!JS_IsObject(request)||JS_IsArray(request)||number_field(ctx,request,"id",9007199254740991.0,&id)||
     !(method=string_property(ctx,request,"method",64,true))){failure(service,client,NAN,-32600,"invalid request");goto done;}
  params=JS_GetPropertyStr(ctx,request,"params");
  if(JS_IsUndefined(params))params=JS_NewObject(ctx);
  if(!JS_IsObject(params)||JS_IsArray(params)){failure(service,client,id,-32602,"invalid params");goto done;}
  if(!strcmp(method,"hello")){
    JSValue value=JS_NewObject(ctx);pthread_mutex_lock(&service->mutex);
    text_property(ctx,value,"name",service->name);text_property(ctx,value,"model",service->model);text_property(ctx,value,"fw",service->firmware);
    text_property(ctx,value,"app",service->app);text_property(ctx,value,"appVersion",service->version);text_property(ctx,value,"ip",service->ip);
    text_property(ctx,value,"mac",service->mac);number_property(ctx,value,"heapFree",service->heap_free);pthread_mutex_unlock(&service->mutex);response(service,client,id,value);
  }else if(!strcmp(method,"app.push_begin"))push_begin(service,client,id,params);
  else if(!strcmp(method,"app.push_chunk"))push_chunk(service,client,id,params);
  else if(!strcmp(method,"app.push_end"))push_end(service,client,id,params);
  else if(!strcmp(method,"app.push_abort")){
    if(!valid_session(service,client,params))failure(service,client,id,409,"invalid push session");
    else{finish_push(service,false);response(service,client,id,ok_value(ctx));}
  }
  else if(!strcmp(method,"app.restart")||!strcmp(method,"app.stop")||!strcmp(method,"system.settings")){
    enum px_devd_action_type type=!strcmp(method,"app.restart")?PX_DEVD_RESTART:
      !strcmp(method,"app.stop")?PX_DEVD_STOP:PX_DEVD_SETTINGS;
    if(action_queue(service,type,0,NULL))failure(service,client,id,503,"application action queue full");
    else response(service,client,id,ok_value(ctx));
  }else if(!strcmp(method,"js.eval"))request_eval(service,client,id,params);
  else if(!strcmp(method,"logs.subscribe")||!strcmp(method,"logs.unsubscribe")){
    double since=0;JSValue value=JS_GetPropertyStr(ctx,params,"since");bool valid=JS_IsUndefined(value)||!number_value(ctx,value,9007199254740991.0,&since);JS_FreeValue(ctx,value);
    if(!valid){failure(service,client,id,-32602,"invalid log sequence");goto done;}
    pthread_mutex_lock(&service->mutex);uint64_t last=service->log_seq;pthread_mutex_unlock(&service->mutex);
    client->subscribed=!strcmp(method,"logs.subscribe");client->log_seq=since>last?0:(uint64_t)since;
    JSValue result=ok_value(ctx);number_property(ctx,result,"last_seq",last);number_property(ctx,result,"boot",strtoul(service->boot+24,NULL,16));response(service,client,id,result);
  }else failure(service,client,id,-32601,"unknown method");
done:
  free(method);JS_FreeValue(ctx,params);JS_FreeValue(ctx,request);clear_exception(ctx);
}

static void close_frame(struct px_devd *service,struct client *client,unsigned code)
{uint8_t data[2]={(uint8_t)(code>>8),(uint8_t)code};if(!queue_frame(service,client,8,data,sizeof(data))){client->closing=true;client->deadline=now_ms()+1000;}}
static void websocket_data(struct px_devd *service,struct client *client,const uint8_t *data,size_t length)
{
  while(length&&client->socket&&!client->closing){size_t consumed=0;struct px_ws_event event={0};int result=px_ws_feed(client->decoder,data,length,&consumed,&event);
    if(result<0){close_frame(service,client,result==-EMSGSIZE?1009:1002);return;}
    data+=consumed;length-=consumed;
    if(result>0){
      if(event.opcode==1)request_message(service,client,event.data,event.length);
      else if(event.opcode==2)close_frame(service,client,1003);
      else if(event.opcode==9)queue_frame(service,client,10,event.data,event.length);
      else if(event.opcode==8){queue_frame(service,client,8,event.data,event.length);client->closing=true;client->deadline=now_ms()+1000;}
      free(event.data);
    }
    if(!consumed&&!result)break;
  }
}
static char *trim(char *text)
{while(*text==' '||*text=='\t')++text;size_t n=strlen(text);while(n&&(text[n-1]==' '||text[n-1]=='\t'))text[--n]=0;return text;}
static bool connection_upgrade(const char *text)
{
  while(*text){while(*text==' '||*text=='\t'||*text==',')++text;const char *end=strchr(text,',');size_t n=end?(size_t)(end-text):strlen(text);
    while(n&&(text[n-1]==' '||text[n-1]=='\t'))--n;if(n==7&&!strncasecmp(text,"upgrade",7))return true;if(!end)break;text=end+1;}return false;
}
static bool validate_upgrade(char *header,char accept[29])
{
  char *line=strstr(header,"\r\n");if(!line)return false;*line=0;if(strcmp(header,"GET /devd HTTP/1.1"))return false;
  char *key=NULL,*upgrade=NULL,*connection=NULL,*version=NULL,*host=NULL;line+=2;
  while(*line){char *end=strstr(line,"\r\n");if(!end)return false;*end=0;if(!*line)break;
    if(*line==' '||*line=='\t')return false;char *colon=strchr(line,':');if(!colon)return false;*colon=0;
    for(const char *p=line;*p;++p)if(!((*p>='A'&&*p<='Z')||(*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||*p=='-'))return false;
    char *value=trim(colon+1);for(const unsigned char *p=(const unsigned char *)value;*p;++p)if(*p<32&&*p!='\t')return false;
    char **slot=NULL;
    if(!strcasecmp(line,"Sec-WebSocket-Key"))slot=&key;else if(!strcasecmp(line,"Upgrade"))slot=&upgrade;
    else if(!strcasecmp(line,"Connection"))slot=&connection;else if(!strcasecmp(line,"Sec-WebSocket-Version"))slot=&version;
    else if(!strcasecmp(line,"Host"))slot=&host;
    /* 客户端可提出压缩扩展；不在101响应选中即保持普通RFC6455帧。 */
    else if(!strcasecmp(line,"Content-Length")||!strcasecmp(line,"Transfer-Encoding"))return false;
    if(slot){if(*slot)return false;*slot=value;}line=end+2;
  }
  uint8_t decoded[16];size_t n=0;
  return host&&*host&&key&&upgrade&&connection&&version&&!strcasecmp(upgrade,"websocket")&&connection_upgrade(connection)&&!strcmp(version,"13")&&
    !px_base64_decode(key,strlen(key),decoded,sizeof(decoded),&n)&&n==16&&!px_ws_accept(key,accept);
}
static void receive_client(struct px_devd *service,struct client *client,const uint8_t *data,size_t length)
{
  if(client->closing)return;if(client->upgraded){websocket_data(service,client,data,length);return;}
  /* 逐字节只复制HTTP头，防止同一TCP包中首个WS大帧被误算进8KiB头限制。 */
  size_t offset=0;
  for(;offset<length;++offset){
    if(!data[offset]||client->header_size==HEADER_BYTES){client_drop(service,client);return;}
    client->header[client->header_size++]=(char)data[offset];client->header[client->header_size]=0;
    if(client->header_size>=4&&!memcmp(client->header+client->header_size-4,"\r\n\r\n",4)){++offset;break;}
  }
  if(client->header_size<4||memcmp(client->header+client->header_size-4,"\r\n\r\n",4))return;
  char accept[29];if(!validate_upgrade(client->header,accept)){client_drop(service,client);return;}
  char response_text[160];int count=snprintf(response_text,sizeof(response_text),"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",accept);
  uint8_t *response_data=malloc((size_t)count);if(!response_data){client_drop(service,client);return;}memcpy(response_data,response_text,(size_t)count);
  if(queue_raw(service,client,response_data,(size_t)count))return;
  client->decoder=px_ws_decoder_create(true,MESSAGE_BYTES);if(!client->decoder){client_drop(service,client);return;}
  free(client->header);client->header=NULL;client->header_size=0;client->upgraded=true;client->deadline=0;
  if(offset<length)websocket_data(service,client,data+offset,length-offset);
}
static struct client *find_client(struct px_devd *service,uint64_t serial)
{for(size_t i=0;i<CLIENTS;++i)if(service->clients[i].socket&&service->clients[i].serial==serial)return &service->clients[i];return NULL;}
static void complete_push_pause(struct px_devd *service)
{
  if(!service->push)return;
  pthread_mutex_lock(&service->mutex);bool ready=service->push_pause_ready;
  int result=service->push_pause_error;pthread_mutex_unlock(&service->mutex);
  if(!ready)return;
  struct client *client=find_client(service,service->owner);
  if(!client){finish_push(service,false);return;}
  double id=service->push->id;
  if(!result){
    service->push_storage_started=true;
    result=px_store_begin(service->store,service->push->manifest,service->push->entry,
                          service->push->files,service->push->count);
  }
  if(result){finish_push(service,false);failure(service,client,id,503,"application pause or storage preparation failed");return;}
  free_push_package(service->push);service->push=NULL;client->deadline=now_ms()+30000;
  JSValue value=JS_NewObject(service->json);text_property(service->json,value,"session",service->session);
  response(service,client,id,value);
}
static void accept_client(struct px_devd *service,uint32_t socket)
{
  for(size_t i=0;i<CLIENTS;++i)if(!service->clients[i].socket){
    struct client *client=&service->clients[i];client->socket=socket;client->serial=++service->next_client;client->deadline=now_ms()+5000;
    client->header=malloc(HEADER_BYTES+1);if(!client->header)client_drop(service,client);return;}
  px_net_close(service->net,socket);
}
static void pump_network(struct px_devd *service)
{
  for(unsigned count=0;count<32;++count){struct px_net_event event;int result=px_net_poll(service->net,&event);if(result<=0)break;
    if(event.type==PX_NET_ACCEPTED&&event.id==service->listener)accept_client(service,event.accepted_id);
    else for(size_t i=0;i<CLIENTS;++i){struct client *client=&service->clients[i];if(client->socket!=event.id)continue;
      if(event.type==PX_NET_DATA)receive_client(service,client,event.data,event.length);else if(event.type==PX_NET_CLOSED)client_drop(service,client);break;}
    px_net_event_free(&event);
  }
}
static void complete_pending(struct px_devd *service)
{
  for(;;){struct completion item={0};pthread_mutex_lock(&service->mutex);
    if(service->completed_count){item=service->completed[service->completed_head];service->completed_head=(service->completed_head+1)%MAILBOX;service->completed_count--;}
    pthread_mutex_unlock(&service->mutex);if(!item.token)break;
    for(size_t i=0;i<MAILBOX;++i){struct pending_eval *pending=&service->pending[i];if(pending->token!=item.token)continue;
      struct client *client=find_client(service,pending->client);
      if(client){if(item.success){JSValue value=JS_NewObject(service->json);text_property(service->json,value,"result",item.text);response(service,client,pending->id,value);}
        else failure(service,client,pending->id,500,item.text);}
      pending->token=0;break;
    }
    free(item.text);
  }
  uint64_t now=now_ms();for(size_t i=0;i<MAILBOX;++i){struct pending_eval *pending=&service->pending[i];if(pending->token&&pending->deadline<=now){
    struct client *client=find_client(service,pending->client);if(client)failure(service,client,pending->id,504,"eval timed out");pending->token=0;}}
}
static void broadcast(struct px_devd *service,struct client *client)
{
  if(!client->socket||!client->upgraded||client->closing)return;JSContext *ctx=service->json;
  /* 回放速度不能超过TCP发送；保留控制响应空间，未发送的日志不推进游标。 */
  if(client->tx_count>=TX_MESSAGES-8||client->tx_bytes>TX_BYTES-8192)return;
  pthread_mutex_lock(&service->mutex);uint64_t version=service->state_seq;char state[16],error[256];
  copy_text(state,sizeof(state),service->state);copy_text(error,sizeof(error),service->state_error);pthread_mutex_unlock(&service->mutex);
  if(client->state_seq<version){JSValue value=JS_NewObject(ctx);text_property(ctx,value,"state",state);if(error[0])text_property(ctx,value,"error",error);
    client->state_seq=version;event_json(service,client,"app.state",value);}
  /* 每客户端每轮最多8条，保持请求/控制帧公平；每条日志只复制一次到栈。 */
  for(unsigned count=0;client->socket&&client->subscribed&&count<8;++count){struct log_entry entry={0};pthread_mutex_lock(&service->mutex);
    if(client->tx_count>=TX_MESSAGES-8||client->tx_bytes>TX_BYTES-8192){pthread_mutex_unlock(&service->mutex);break;}
    uint64_t first=service->log_seq>=LOG_COUNT?service->log_seq-LOG_COUNT+1:1;
    uint64_t next=client->log_seq+1;if(next<first)next=first;
    if(next<=service->log_seq)entry=service->logs[(next-1)%LOG_COUNT];pthread_mutex_unlock(&service->mutex);
    if(!entry.seq)break;client->log_seq=entry.seq;JSValue value=JS_NewObject(ctx);
    text_property(ctx,value,"level",entry.level);text_property(ctx,value,"tag",entry.tag);text_property(ctx,value,"msg",entry.message);
    number_property(ctx,value,"ts",entry.ts);number_property(ctx,value,"seq",entry.seq);event_json(service,client,"log",value);
  }
}

/* QuickJS的分配头提供NuttX可用的usable_size，并严格计入JSON堆限制。 */
union json_header {size_t size;long double alignment;void *pointer;};
static void *json_malloc(void *opaque,size_t size)
{(void)opaque;if(size>SIZE_MAX-sizeof(union json_header))return NULL;union json_header *header=malloc(sizeof(*header)+size);if(!header)return NULL;header->size=size;return header+1;}
static void json_free(void *opaque,void *pointer)
{(void)opaque;if(pointer)free((union json_header *)pointer-1);}
static void *json_calloc(void *opaque,size_t count,size_t size)
{if(size&&count>SIZE_MAX/size)return NULL;void *pointer=json_malloc(opaque,count*size);if(pointer)memset(pointer,0,count*size);return pointer;}
static void *json_realloc(void *opaque,void *pointer,size_t size)
{if(!pointer)return json_malloc(opaque,size);if(!size){json_free(opaque,pointer);return NULL;}if(size>SIZE_MAX-sizeof(union json_header))return NULL;
  union json_header *header=realloc((union json_header *)pointer-1,sizeof(*header)+size);if(!header)return NULL;header->size=size;return header+1;}
static size_t json_usable(const void *pointer)
{return pointer?((const union json_header *)pointer-1)->size:0;}
/* 仅 devd 线程发布快照；网络回调只标记 dirty，避免并发调用回写旧 IP/TXT。 */
static void refresh_mdns(struct px_devd *service)
{
  if(!service->advertise||!service->listener)return;
  char ip[64],mac[32],app[128],hostname[64];uint64_t now=now_ms();
  pthread_mutex_lock(&service->mutex);
  bool update=service->mdns_dirty||(service->mdns_error&&now>=service->mdns_retry);
  if(update){service->mdns_dirty=false;copy_text(ip,sizeof(ip),service->ip);copy_text(mac,sizeof(mac),service->mac);copy_text(app,sizeof(app),service->app);}
  pthread_mutex_unlock(&service->mutex);if(!update)return;
  bool valid_mac=strlen(mac)==17;
  for(size_t i=0;valid_mac&&i<17;++i)valid_mac=i%3==2?mac[i]==':':hex_value(mac[i])>=0;
  if(valid_mac){static const char hex[]="0123456789abcdef";memcpy(hostname,"pixelbox-",9);
    for(size_t i=0,j=9;i<17;++i)if(i%3!=2)hostname[j++]=hex[hex_value(mac[i])];hostname[21]=0;}
  else snprintf(hostname,sizeof(hostname),"pixelbox-%.12s",service->boot);
  int result=px_mdns_configure(hostname,ip[0]?ip:"0.0.0.0");
  if(!result)result=px_mdns_publish_devd(service->name,service->port,service->model,service->firmware,app);
  if(result&&result!=service->mdns_error)fprintf(stderr,"[pixelbox] devd mDNS update failed: %d\n",result);
  service->mdns_error=result;service->mdns_retry=now+1000;
}
static void *serve(void *opaque)
{
  struct px_devd *service=opaque;int result=0;
  const JSMallocFunctions allocator={json_calloc,json_malloc,json_free,json_realloc,json_usable};
  service->runtime=JS_NewRuntime2(&allocator,NULL);if(!service->runtime){result=-ENOMEM;goto ready;}
  JS_SetMemoryLimit(service->runtime,1024*1024);JS_SetMaxStackSize(service->runtime,DEVD_JSON_STACK_BYTES);
  service->json=JS_NewContextRaw(service->runtime);if(!service->json){result=-ENOMEM;goto ready;}
  JS_AddIntrinsicBaseObjects(service->json);JS_AddIntrinsicJSON(service->json);
  service->store=px_store_open(service->storage);if(!service->store){result=-errno;goto ready;}refresh_app(service);
  if((result=random_token(service->boot)))goto ready;
  service->net=px_net_create();if(!service->net){result=-ENOMEM;goto ready;}
  result=px_net_listen(service->net,service->port,&service->listener,&service->port);
  if(!result)refresh_mdns(service);
ready:
  pthread_mutex_lock(&service->mutex);service->start_result=result;service->initialized=true;pthread_cond_signal(&service->ready);pthread_mutex_unlock(&service->mutex);
  if(!result)for(;;){
    pthread_mutex_lock(&service->mutex);bool stop=service->stopping;pthread_mutex_unlock(&service->mutex);if(stop)break;
    pump_network(service);complete_pending(service);complete_push_pause(service);refresh_mdns(service);uint64_t now=now_ms();
    for(size_t i=0;i<CLIENTS;++i){struct client *client=&service->clients[i];if(!client->socket)continue;
      if((client->deadline&&now>=client->deadline)||(client->tx_since&&now-client->tx_since>=5000)){client_drop(service,client);continue;}
      flush_client(service,client);broadcast(service,client);flush_client(service,client);
    }
    struct timespec delay={0,2000000};nanosleep(&delay,NULL);
  }
  for(size_t i=0;i<CLIENTS;++i)client_drop(service,&service->clients[i]);
  px_net_destroy(service->net);px_store_close(service->store);
  if(service->json)JS_FreeContext(service->json);if(service->runtime)JS_FreeRuntime(service->runtime);return NULL;
}

int px_devd_start(const struct px_devd_config *config,struct px_devd **out)
{
  if(!config||!out||config->port>65535)return -EINVAL;*out=NULL;
  const char *root=config->storage_root?config->storage_root:"/data/apps";if(strlen(root)>=ROOT_BYTES-9)return -ENAMETOOLONG;
  struct px_devd *service=calloc(1,sizeof(*service));if(!service)return -ENOMEM;
  copy_text(service->storage,sizeof(service->storage),root);service->port=config->port;service->notify=config->notify_action;service->opaque=config->opaque;
  service->advertise=config->advertise;
  copy_text(service->name,sizeof(service->name),config->name?config->name:"PixelBox");copy_text(service->model,sizeof(service->model),config->model);
  copy_text(service->firmware,sizeof(service->firmware),config->firmware);copy_text(service->ip,sizeof(service->ip),config->ip);copy_text(service->mac,sizeof(service->mac),config->mac);
  copy_text(service->state,sizeof(service->state),"stopped");service->state_seq=1;
  int result=pthread_mutex_init(&service->mutex,NULL);if(result){free(service);return -result;}
  result=pthread_cond_init(&service->ready,NULL);if(result){pthread_mutex_destroy(&service->mutex);free(service);return -result;}
  pthread_attr_t attributes;result=pthread_attr_init(&attributes);
  if(!result){size_t stack=DEVD_STACK_BYTES;
#if defined(PTHREAD_STACK_MIN)
    if(stack<PTHREAD_STACK_MIN)stack=PTHREAD_STACK_MIN;
#endif
    result=pthread_attr_setstacksize(&attributes,stack);if(!result)result=pthread_create(&service->thread,&attributes,serve,service);pthread_attr_destroy(&attributes);}
  if(result){pthread_cond_destroy(&service->ready);pthread_mutex_destroy(&service->mutex);free(service);return -result;}
  pthread_mutex_lock(&service->mutex);while(!service->initialized)pthread_cond_wait(&service->ready,&service->mutex);result=service->start_result;pthread_mutex_unlock(&service->mutex);
  if(result){px_devd_stop(service);return result;}*out=service;return 0;
}
void px_devd_stop(struct px_devd *service)
{
  if(!service)return;pthread_mutex_lock(&service->mutex);service->stopping=true;pthread_mutex_unlock(&service->mutex);pthread_join(service->thread,NULL);
  for(size_t i=0;i<service->action_count;++i)free(service->actions[(service->action_head+i)%MAILBOX].code);
  for(size_t i=0;i<service->completed_count;++i)free(service->completed[(service->completed_head+i)%MAILBOX].text);
  pthread_cond_destroy(&service->ready);pthread_mutex_destroy(&service->mutex);free(service);
}
unsigned px_devd_port(struct px_devd *service)
{return service?service->port:0;}
int px_devd_take_action(struct px_devd *service,struct px_devd_action *out)
{
  if(!service||!out)return -EINVAL;memset(out,0,sizeof(*out));pthread_mutex_lock(&service->mutex);
  if(!service->action_count){pthread_mutex_unlock(&service->mutex);return 0;}
  *out=service->actions[service->action_head];service->action_head=(service->action_head+1)%MAILBOX;service->action_count--;pthread_mutex_unlock(&service->mutex);return 1;
}
void px_devd_action_free(struct px_devd_action *action)
{if(action){free(action->code);memset(action,0,sizeof(*action));}}
int px_devd_complete_eval(struct px_devd *service,uint64_t token,bool success,const char *text)
{
  if(!service||!token||!text)return -EINVAL;if(strlen(text)>RESPONSE_BYTES)return -EFBIG;
  char *copy=strdup(text);if(!copy)return -ENOMEM;pthread_mutex_lock(&service->mutex);
  if(service->stopping||service->completed_count>=MAILBOX){pthread_mutex_unlock(&service->mutex);free(copy);return -ENOBUFS;}
  size_t index=(service->completed_head+service->completed_count)%MAILBOX;service->completed[index]=(struct completion){token,success,copy};service->completed_count++;
  pthread_mutex_unlock(&service->mutex);return 0;
}
int px_devd_complete_push_pause(struct px_devd *service,uint64_t token,int error)
{
  if(!service||!token)return -EINVAL;
  pthread_mutex_lock(&service->mutex);
  int result=service->push_token!=token?-ESTALE:0;
  if(!result){service->push_pause_error=error;service->push_pause_ready=true;}
  pthread_mutex_unlock(&service->mutex);return result;
}
void px_devd_release_push(struct px_devd *service,uint64_t token)
{
  if(!service||!token)return;
  pthread_mutex_lock(&service->mutex);
  if(service->push_token==token){service->push_token=0;service->push_pause_ready=false;}
  pthread_mutex_unlock(&service->mutex);
}
int px_devd_current_app(struct px_devd *service,char *root,size_t root_capacity,char *entry,size_t entry_capacity)
{
  if(!service||!root||!entry)return -EINVAL;pthread_mutex_lock(&service->mutex);int result=0;
  if(!service->current[0])result=-ENOENT;else if(strlen(service->current)>=root_capacity||strlen(service->entry)>=entry_capacity)result=-ENAMETOOLONG;
  else{strcpy(root,service->current);strcpy(entry,service->entry);}pthread_mutex_unlock(&service->mutex);return result;
}
void px_devd_log(struct px_devd *service,const char *level,const char *tag,const char *message)
{
  if(!service)return;pthread_mutex_lock(&service->mutex);uint64_t sequence=++service->log_seq;struct log_entry *entry=&service->logs[(sequence-1)%LOG_COUNT];
  entry->seq=sequence;entry->ts=wall_ms();copy_text(entry->level,sizeof(entry->level),level?level:"info");copy_text(entry->tag,sizeof(entry->tag),tag);copy_text(entry->message,sizeof(entry->message),message);
  pthread_mutex_unlock(&service->mutex);
}
void px_devd_state(struct px_devd *service,const char *state,const char *error)
{
  if(!service||!state||(strcmp(state,"running")&&strcmp(state,"stopped")&&strcmp(state,"updating")&&strcmp(state,"crashed")))return;
  pthread_mutex_lock(&service->mutex);copy_text(service->state,sizeof(service->state),state);copy_text(service->state_error,sizeof(service->state_error),error);service->state_seq++;
  pthread_mutex_unlock(&service->mutex);
}
void px_devd_network(struct px_devd *service,const char *ip,const char *mac,size_t heap_free)
{if(service){pthread_mutex_lock(&service->mutex);
  if(strcmp(service->ip,ip?ip:"")||strcmp(service->mac,mac?mac:""))service->mdns_dirty=true;
  copy_text(service->ip,sizeof(service->ip),ip);copy_text(service->mac,sizeof(service->mac),mac);service->heap_free=heap_free;pthread_mutex_unlock(&service->mutex);}}
