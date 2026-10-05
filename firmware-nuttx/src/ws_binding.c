/* WebSocket纯C核心的QuickJS绑定；decoder由闭包固定拥有，GC/显式free都安全。 */
#include "quickjs.h"
#include "pixelbox_ws.h"
#include <stdlib.h>
#include <string.h>
struct decoder_owner {struct px_ws_decoder *decoder;};
static void decoder_finalizer(JSRuntime *runtime,JSValue value)
{
  struct decoder_owner *owner=JS_GetOpaque(value,JS_GetClassID(value));
  if(owner){px_ws_decoder_free(owner->decoder);js_free_rt(runtime,owner);}
}
static const JSClassDef decoder_definition={.class_name="PixelBoxWsDecoder",.finalizer=decoder_finalizer};
static int property(JSContext *ctx,JSValue object,const char *name,JSValue value)
{return JS_IsException(value)?-1:JS_DefinePropertyValueStr(ctx,object,name,value,JS_PROP_C_W_E);}
static int bytes(JSContext *ctx,JSValueConst value,const uint8_t **data,size_t *length,JSValue *owned)
{
  *owned=JS_UNDEFINED;
  if(JS_GetTypedArrayType(value)==JS_TYPED_ARRAY_UINT8){
    size_t offset,element,capacity;*owned=JS_GetTypedArrayBuffer(ctx,value,&offset,length,&element);
    if(JS_IsException(*owned))return -1;
    uint8_t *base=JS_GetArrayBuffer(ctx,&capacity,*owned);
    if(JS_HasException(ctx))return -1;
    if(offset>capacity||*length>capacity-offset){JS_ThrowRangeError(ctx,"invalid typed array");return -1;}
    *data=base?base+offset:NULL;return 0;
  }
  if(JS_IsArrayBuffer(value)){*data=JS_GetArrayBuffer(ctx,length,value);return JS_HasException(ctx)?-1:0;}
  JS_ThrowTypeError(ctx,"WebSocket bytes need ArrayBuffer or Uint8Array");return -1;
}
static JSValue decoder_call(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv,int magic,JSValue *captured)
{
  (void)self;struct decoder_owner *owner=JS_GetOpaque2(ctx,captured[0],JS_GetClassID(captured[0]));
  if(!owner)return JS_EXCEPTION;
  if(magic){px_ws_decoder_free(owner->decoder);owner->decoder=NULL;return JS_UNDEFINED;}
  if(!owner->decoder)return JS_ThrowInternalError(ctx,"WebSocket decoder is closed");
  if(!argc)return JS_ThrowTypeError(ctx,"feed needs bytes");
  const uint8_t *data;size_t length;JSValue buffer;
  if(bytes(ctx,argv[0],&data,&length,&buffer)){JS_FreeValue(ctx,buffer);return JS_EXCEPTION;}
  JSValue events=JS_NewArray(ctx);unsigned index=0;
  if(JS_IsException(events)){JS_FreeValue(ctx,buffer);return events;}
  for(size_t offset=0;offset<length;){
    size_t used;struct px_ws_event event;int result=px_ws_feed(owner->decoder,data+offset,length-offset,&used,&event);offset+=used;
    if(result<0){JS_FreeValue(ctx,events);JS_FreeValue(ctx,buffer);return JS_ThrowInternalError(ctx,"WebSocket invalid frame (%d)",result);}
    if(!result)continue;
    JSValue object=JS_NewObject(ctx);
    int failed=JS_IsException(object)||property(ctx,object,"opcode",JS_NewUint32(ctx,event.opcode))<0||
      property(ctx,object,"data",JS_NewArrayBufferCopy(ctx,event.data,event.length))<0;
    free(event.data);
    if(failed){JS_FreeValue(ctx,object);JS_FreeValue(ctx,events);JS_FreeValue(ctx,buffer);return JS_EXCEPTION;}
    char number[16];snprintf(number,sizeof(number),"%u",index++);
    if(property(ctx,events,number,object)<0){JS_FreeValue(ctx,events);JS_FreeValue(ctx,buffer);return JS_EXCEPTION;}
  }
  JS_FreeValue(ctx,buffer);return events;
}
static JSValue decoder_create(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv,int magic,JSValue *captured)
{
  (void)self;(void)magic;uint32_t limit=262144;
  if(argc>1&&JS_ToUint32(ctx,&limit,argv[1]))return JS_EXCEPTION;
  if(!limit||limit>1048576)return JS_ThrowRangeError(ctx,"WebSocket message limit");
  uint32_t id;if(JS_ToUint32(ctx,&id,captured[0]))return JS_EXCEPTION;
  struct decoder_owner *owner=js_mallocz(ctx,sizeof(*owner));if(!owner)return JS_EXCEPTION;
  owner->decoder=px_ws_decoder_create(argc&&JS_ToBool(ctx,argv[0])>0,limit);
  if(!owner->decoder){js_free(ctx,owner);return JS_ThrowOutOfMemory(ctx);}
  JSValue object=JS_NewObjectClass(ctx,id);
  if(JS_IsException(object)){px_ws_decoder_free(owner->decoder);js_free(ctx,owner);return object;}
  JS_SetOpaque(object,owner);
  if(property(ctx,object,"feed",JS_NewCFunctionData(ctx,decoder_call,1,0,1,&object))<0||
     property(ctx,object,"free",JS_NewCFunctionData(ctx,decoder_call,0,1,1,&object))<0){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
  return object;
}
static JSValue encode_frame(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;if(argc<2)return JS_ThrowTypeError(ctx,"frame needs opcode and data");
  uint32_t opcode;if(JS_ToUint32(ctx,&opcode,argv[0]))return JS_EXCEPTION;
  const uint8_t *data=NULL,*mask=NULL;size_t length=0,mask_length=0;JSValue buffer=JS_UNDEFINED,mask_buffer=JS_UNDEFINED;
  if(bytes(ctx,argv[1],&data,&length,&buffer))goto failed;
  if(argc>2&&!JS_IsNull(argv[2])&&!JS_IsUndefined(argv[2])){
    if(bytes(ctx,argv[2],&mask,&mask_length,&mask_buffer))goto failed;
    if(mask_length!=4){JS_ThrowRangeError(ctx,"WebSocket mask must be 4 bytes");goto failed;}
  }
  uint8_t *encoded=NULL;size_t size;int result=px_ws_frame(opcode,true,data,length,mask,&encoded,&size);
  JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,mask_buffer);
  if(result)return JS_ThrowInternalError(ctx,"WebSocket frame failed (%d)",result);
  JSValue value=JS_NewArrayBufferCopy(ctx,encoded,size);free(encoded);return value;
failed:
  JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,mask_buffer);return JS_EXCEPTION;
}
static JSValue accept_key(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;if(!argc||!JS_IsString(argv[0]))return JS_ThrowTypeError(ctx,"accept needs key string");
  size_t length;const char *key=JS_ToCStringLen(ctx,&length,argv[0]);if(!key)return JS_EXCEPTION;
  char output[29];int result=length!=24?-1:px_ws_accept(key,output);JS_FreeCString(ctx,key);
  return result?JS_ThrowTypeError(ctx,"invalid WebSocket key"):JS_NewString(ctx,output);
}
void px_install_ws(JSContext *ctx,JSValue native)
{
  JSClassID id=0;JS_NewClassID(JS_GetRuntime(ctx),&id);
  if(JS_NewClass(JS_GetRuntime(ctx),id,&decoder_definition)<0)return;
  JSValue captured=JS_NewUint32(ctx,id);
  JSValue object=JS_NewObject(ctx);if(JS_IsException(object))return;
  if(property(ctx,object,"createDecoder",JS_NewCFunctionData(ctx,decoder_create,2,0,1,&captured))<0||
    property(ctx,object,"frame",JS_NewCFunction(ctx,encode_frame,"frame",3))<0||
    property(ctx,object,"accept",JS_NewCFunction(ctx,accept_key,"accept",1))<0){JS_FreeValue(ctx,object);return;}
  property(ctx,native,"ws",object);
}
