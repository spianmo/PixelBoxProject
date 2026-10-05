/* 直接验证真实请求入口：WebSocket 消息只保证长度，不保证末尾 NUL。 */
#include "../src/devd.c"
#include <assert.h>

static JSValue invoke(struct px_devd *service,const uint8_t *data,size_t length)
{
  struct client client={.socket=1,.serial=1};
  request_message(service,&client,data,length);
  assert(client.tx_count==1&&client.head&&client.head==client.tail);

  struct px_ws_decoder *decoder=px_ws_decoder_create(false,RESPONSE_BYTES);
  struct px_ws_event event={0};size_t consumed=0;
  assert(decoder);
  assert(px_ws_feed(decoder,client.head->bytes,client.head->length,&consumed,&event)==1);
  assert(consumed==client.head->length&&event.opcode==1);
  char *text=js_strndup(service->json,(const char *)event.data,event.length);
  assert(text);
  JSValue value=JS_ParseJSON(service->json,text,event.length,"test-response");
  js_free(service->json,text);
  assert(!JS_IsException(value));
  free(event.data);px_ws_decoder_free(decoder);
  free(client.head->bytes);free(client.head);
  return value;
}

static void valid_request(struct px_devd *service,size_t length)
{
  static const char request[]="{\"id\":1,\"method\":\"hello\",\"params\":{}}";
  assert(length>=sizeof(request)-1);
  uint8_t *input=malloc(length+16),*snapshot=malloc(length+16);
  assert(input&&snapshot);
  memset(input,' ',length);memcpy(input,request,sizeof(request)-1);
  /* 尾部固定非零，确保旧实现稳定失败，而非依赖 malloc 恰好返回零。 */
  memset(input+length,'#',16);memcpy(snapshot,input,length+16);
  JSValue reply=invoke(service,input,length),id=JS_GetPropertyStr(service->json,reply,"id");
  double number=0;
  assert(JS_IsNumber(id)&&!JS_ToFloat64(service->json,&number,id)&&number==1);
  JSValue result=JS_GetPropertyStr(service->json,reply,"result");
  char *name=string_property(service->json,result,"name",64,true);
  assert(name&&!strcmp(name,"json-fixture"));
  assert(!memcmp(input,snapshot,length+16));
  free(name);JS_FreeValue(service->json,result);JS_FreeValue(service->json,id);
  JS_FreeValue(service->json,reply);free(snapshot);free(input);
}

static void invalid_request(struct px_devd *service,const uint8_t *input,size_t length)
{
  JSValue reply=invoke(service,input,length),id=JS_GetPropertyStr(service->json,reply,"id");
  assert(JS_IsNull(id));
  JSValue error=JS_GetPropertyStr(service->json,reply,"error");
  JSValue code=JS_GetPropertyStr(service->json,error,"code");
  int32_t number=0;
  assert(JS_IsNumber(code)&&!JS_ToInt32(service->json,&number,code)&&number==-32700);
  JS_FreeValue(service->json,code);JS_FreeValue(service->json,error);
  JS_FreeValue(service->json,id);JS_FreeValue(service->json,reply);
}

int main(void)
{
  struct px_devd service={0};
  const JSMallocFunctions allocator={json_calloc,json_malloc,json_free,json_realloc,json_usable};
  service.runtime=JS_NewRuntime2(&allocator,NULL);assert(service.runtime);
  JS_SetMemoryLimit(service.runtime,1024*1024);JS_SetMaxStackSize(service.runtime,16*1024);
  service.json=JS_NewContextRaw(service.runtime);assert(service.json);
  JS_AddIntrinsicBaseObjects(service.json);JS_AddIntrinsicJSON(service.json);
  assert(!pthread_mutex_init(&service.mutex,NULL));
  copy_text(service.name,sizeof(service.name),"json-fixture");

  const size_t lengths[]={37,255,256,257,511,512,513,MESSAGE_BYTES};
  for(size_t i=0;i<sizeof(lengths)/sizeof(lengths[0]);++i)valid_request(&service,lengths[i]);
  invalid_request(&service,NULL,0);
  static const uint8_t invalid[]={'{','#'};
  invalid_request(&service,invalid,1);
  /* 保留显式长度：内嵌 NUL 后还有数据时，不能被误当成有效前缀。 */
  static const uint8_t embedded[]="{\"id\":1,\"method\":\"hello\"}\0trailing";
  invalid_request(&service,embedded,sizeof(embedded)-1);
  valid_request(&service,37);

  assert(!pthread_mutex_destroy(&service.mutex));
  JS_FreeContext(service.json);JS_FreeRuntime(service.runtime);
  puts("devd JSON 边界通过：非零尾字节、容量边界、空消息、无效 JSON、内嵌 NUL、输入不变及错误后恢复");
  return 0;
}
