/* 所有JSValue只由VM线程创建/释放；NimBLE只通过纯C邮箱交互。 */
#include "quickjs.h"
#include "pixelbox_ble.h"
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
struct ble_owner {struct px_ble *ble;};
static void finalize(JSRuntime *runtime,JSValue value)
{struct ble_owner *owner=JS_GetOpaque(value,JS_GetClassID(value));if(owner){px_ble_destroy(owner->ble);js_free_rt(runtime,owner);}}
static const JSClassDef definition={.class_name="PixelBoxBLE",.finalizer=finalize};
static JSValue failure(JSContext *ctx,int error)
{if(error==-ENOMEM)return JS_ThrowOutOfMemory(ctx);const char *code=error==-ENOTSUP?"ENOTSUP":error==-ENOTCONN?"ENOTCONN":error==-EBUSY?"EBUSY":error==-ENOBUFS?"ENOBUFS":error==-ETIMEDOUT?"ETIMEDOUT":error==-ECANCELED?"ECANCELED":error==-EMSGSIZE?"EMSGSIZE":error==-ENOENT?"ENOENT":error==-ENOSPC?"ENOSPC":"BLE_ERROR";return JS_ThrowInternalError(ctx,"%s: BLE (%d)",code,error);}
static int number(JSContext *ctx,JSValueConst value,unsigned low,unsigned high,unsigned *out)
{double n;if(JS_ToFloat64(ctx,&n,value))return -1;if(!isfinite(n)||n<low||n>high||n!=floor(n)){JS_ThrowRangeError(ctx,"BLE numeric argument out of range");return -1;}*out=(unsigned)n;return 0;}
static int string(JSContext *ctx,JSValueConst value,char *out,size_t capacity)
{if(!JS_IsString(value)){JS_ThrowTypeError(ctx,"BLE needs a string");return -1;}size_t n;const char *text=JS_ToCStringLen(ctx,&n,value);if(!text)return -1;if(n>=capacity||memchr(text,0,n)){JS_FreeCString(ctx,text);JS_ThrowRangeError(ctx,"BLE string too long or contains NUL");return -1;}memcpy(out,text,n+1);JS_FreeCString(ctx,text);return 0;}
static int uuid(JSContext *ctx,JSValueConst value,char out[37])
{char input[37];if(string(ctx,value,input,sizeof(input)))return -1;if(!px_ble_uuid(input,out)){JS_ThrowTypeError(ctx,"invalid BLE UUID");return -1;}return 0;}
static int bytes(JSContext *ctx,JSValueConst value,uint8_t out[512],size_t *length)
{
  const uint8_t *data=NULL;JSValue buffer=JS_UNDEFINED;size_t n=0;
  if(JS_IsArrayBuffer(value)){data=JS_GetArrayBuffer(ctx,&n,value);if(JS_HasException(ctx))return -1;}
  else if(JS_GetTypedArrayType(value)==JS_TYPED_ARRAY_UINT8){size_t offset,element,capacity;buffer=JS_GetTypedArrayBuffer(ctx,value,&offset,&n,&element);if(JS_IsException(buffer))return -1;uint8_t *base=JS_GetArrayBuffer(ctx,&capacity,buffer);
    if(JS_HasException(ctx)||offset>capacity||n>capacity-offset){JS_FreeValue(ctx,buffer);return -1;}data=base?base+offset:NULL;
  }else{JS_ThrowTypeError(ctx,"BLE data needs ArrayBuffer or Uint8Array");return -1;}
  if(n>PX_BLE_VALUE_BYTES){JS_FreeValue(ctx,buffer);JS_ThrowRangeError(ctx,"BLE value exceeds 512 bytes");return -1;}
  if(n)memcpy(out,data,n);
  *length=n;JS_FreeValue(ctx,buffer);return 0;
}
static int property(JSContext *ctx,JSValue object,const char *name,JSValue value)
{if(JS_IsException(value))return -1;return JS_DefinePropertyValueStr(ctx,object,name,value,JS_PROP_C_W_E);}
static int array_length(JSContext *ctx,JSValueConst array,unsigned limit,unsigned *out)
{if(!JS_IsArray(array)){JS_ThrowTypeError(ctx,"BLE services/characteristics must be arrays");return -1;}JSValue length=JS_GetPropertyStr(ctx,array,"length");int rc=number(ctx,length,0,limit,out);JS_FreeValue(ctx,length);return rc;}
static int parse_definition(JSContext *ctx,JSValueConst name,JSValueConst services,struct px_ble_definition *out)
{
  if(string(ctx,name,out->name,sizeof(out->name))||array_length(ctx,services,PX_BLE_SERVICES,&out->service_count))return -1;
  for(unsigned s=0;s<out->service_count;s++){
    JSValue service=JS_GetPropertyUint32(ctx,services,s),id=JS_GetPropertyStr(ctx,service,"uuid"),chars=JS_GetPropertyStr(ctx,service,"characteristics");unsigned count=0;
    int rc=uuid(ctx,id,out->services[s])||array_length(ctx,chars,PX_BLE_CHARACTERISTICS-out->characteristic_count,&count);JS_FreeValue(ctx,id);
    for(unsigned c=0;!rc&&c<count;c++){
      JSValue chr=JS_GetPropertyUint32(ctx,chars,c),value=JS_GetPropertyStr(ctx,chr,"uuid");struct px_ble_characteristic *target=&out->characteristics[out->characteristic_count];target->service=s;target->tag=out->characteristic_count;
      rc=uuid(ctx,value,target->uuid);JS_FreeValue(ctx,value);value=JS_GetPropertyStr(ctx,chr,"properties");if(!rc)rc=number(ctx,value,1,31,&target->properties);JS_FreeValue(ctx,value);
      value=JS_GetPropertyStr(ctx,chr,"onRead");target->on_read=JS_ToBool(ctx,value)>0;JS_FreeValue(ctx,value);
      value=JS_GetPropertyStr(ctx,chr,"value");if(!rc)rc=bytes(ctx,value,target->value,&target->length);JS_FreeValue(ctx,value);JS_FreeValue(ctx,chr);out->characteristic_count++;
    }
    JS_FreeValue(ctx,chars);JS_FreeValue(ctx,service);if(rc)return -1;
  }
  return 0;
}
static JSValue services_value(JSContext *ctx,const struct px_ble_services *info)
{
  if(info->service_count>PX_BLE_SERVICES||info->characteristic_count>PX_BLE_CHARACTERISTICS)return JS_ThrowInternalError(ctx,"invalid BLE discovery result");
  JSValue services=JS_NewArray(ctx);if(JS_IsException(services))return services;
  for(unsigned s=0;s<info->service_count;s++){
    const struct px_ble_service_info *item=&info->services[s];if(item->first>info->characteristic_count||item->count>info->characteristic_count-item->first){JS_FreeValue(ctx,services);return JS_ThrowInternalError(ctx,"invalid BLE characteristic range");}
    JSValue service=JS_NewObject(ctx),chars=JS_NewArray(ctx);if(JS_IsException(service)||JS_IsException(chars))goto fail_service;
    for(unsigned j=0;j<item->count;j++){
      const struct px_ble_characteristic_info *item_chr=&info->characteristics[item->first+j];JSValue chr=JS_NewObject(ctx),props=JS_NewArray(ctx);if(JS_IsException(chr)||JS_IsException(props)){JS_FreeValue(ctx,chr);JS_FreeValue(ctx,props);goto fail_service;}
      const char *names[]={"read","write","writeNoRsp","notify","indicate"};unsigned count=0;
      for(unsigned bit=0;bit<5;bit++)if(item_chr->properties&(1u<<bit))if(JS_SetPropertyUint32(ctx,props,count++,JS_NewString(ctx,names[bit]))<0){JS_FreeValue(ctx,props);JS_FreeValue(ctx,chr);goto fail_service;}
      if(property(ctx,chr,"uuid",JS_NewString(ctx,item_chr->uuid))<0){JS_FreeValue(ctx,props);JS_FreeValue(ctx,chr);goto fail_service;}
      if(property(ctx,chr,"properties",props)<0){JS_FreeValue(ctx,chr);goto fail_service;}
      if(JS_SetPropertyUint32(ctx,chars,j,chr)<0)goto fail_service;
    }
    if(property(ctx,service,"uuid",JS_NewString(ctx,item->uuid))<0)goto fail_service;
    if(property(ctx,service,"characteristics",chars)<0){chars=JS_UNDEFINED;goto fail_service;}chars=JS_UNDEFINED;
    if(JS_SetPropertyUint32(ctx,services,s,service)<0){JS_FreeValue(ctx,services);return JS_EXCEPTION;}continue;
fail_service:JS_FreeValue(ctx,chars);JS_FreeValue(ctx,service);JS_FreeValue(ctx,services);return JS_EXCEPTION;
  }
  return services;
}
static JSValue poll(JSContext *ctx,struct px_ble *ble)
{
  struct px_ble_event event={0};int rc=px_ble_poll(ble,&event);if(rc<=0)return rc?failure(ctx,rc):JS_NULL;
  JSValue object=JS_NewObject(ctx);if(JS_IsException(object))goto fail;
#define FIELD(name,value) if(property(ctx,object,name,value)<0)goto fail
  FIELD("type",JS_NewInt32(ctx,event.type));FIELD("connection",JS_NewUint32(ctx,event.connection));FIELD("request",JS_NewUint32(ctx,event.request));FIELD("tag",JS_NewUint32(ctx,event.tag));FIELD("error",JS_NewInt32(ctx,event.error));
  FIELD("id",JS_NewString(ctx,event.id));FIELD("name",event.has_name?JS_NewString(ctx,event.name):JS_NULL);FIELD("rssi",JS_NewInt32(ctx,event.rssi));FIELD("hasManufacturer",JS_NewBool(ctx,event.has_manufacturer));
  FIELD("service",JS_NewString(ctx,event.service));FIELD("characteristic",JS_NewString(ctx,event.characteristic));
  if(event.type==PX_BLE_RESULT&&event.tag==PX_BLE_DISCOVER&&!event.error){if(event.length!=sizeof(struct px_ble_services)){JS_ThrowInternalError(ctx,"invalid BLE services payload");goto fail;}FIELD("data",services_value(ctx,(const struct px_ble_services *)event.data));}
  else {FIELD("data",JS_NewArrayBufferCopy(ctx,event.data,event.length));}
#undef FIELD
  px_ble_event_free(&event);return object;
fail:px_ble_event_free(&event);JS_FreeValue(ctx,object);return JS_EXCEPTION;
}
static JSValue call(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv,int magic,JSValue *data)
{
  (void)self;struct ble_owner *owner=JS_GetOpaque2(ctx,data[0],JS_GetClassID(data[0]));if(!owner)return JS_EXCEPTION;
  if(magic==10){px_ble_destroy(owner->ble);owner->ble=NULL;return JS_UNDEFINED;}
  if(magic==0)return JS_NewBool(ctx,px_ble_available(owner->ble));
  if(!owner->ble)return failure(ctx,-ECANCELED);
  int needed[]={0,2,0,3,1,0,2,1,7,3,0,0};if(argc<needed[magic])return JS_ThrowTypeError(ctx,"missing BLE arguments");
  uint8_t buffer[512];size_t length=0;char service[37],characteristic[37];unsigned connection=0,request=0,operation=0,timeout=0;int rc=0;
  switch(magic){
    case 1:{struct px_ble_definition *definition=calloc(1,sizeof(*definition));if(!definition)return JS_ThrowOutOfMemory(ctx);if(parse_definition(ctx,argv[0],argv[1],definition)){free(definition);return JS_EXCEPTION;}rc=px_ble_peripheral_start(owner->ble,definition);free(definition);break;}
    case 2:rc=px_ble_peripheral_stop(owner->ble);break;
    case 3:if(uuid(ctx,argv[0],service)||uuid(ctx,argv[1],characteristic)||bytes(ctx,argv[2],buffer,&length))return JS_EXCEPTION;rc=px_ble_notify(owner->ble,service,characteristic,buffer,length);break;
    case 4:if(number(ctx,argv[0],1,120000,&timeout))return JS_EXCEPTION;rc=px_ble_scan(owner->ble,timeout);break;
    case 5:rc=px_ble_stop_scan(owner->ble);break;
    case 6:{char id[18];if(string(ctx,argv[0],id,sizeof(id))||number(ctx,argv[1],1,120000,&timeout))return JS_EXCEPTION;rc=px_ble_connect(owner->ble,id,timeout,&connection);return rc?failure(ctx,rc):JS_NewUint32(ctx,connection);}
    case 7:if(number(ctx,argv[0],1,UINT32_MAX,&connection))return JS_EXCEPTION;rc=px_ble_disconnect(owner->ble,connection);break;
    case 8:if(number(ctx,argv[0],1,UINT32_MAX,&connection)||number(ctx,argv[1],1,UINT32_MAX,&request)||number(ctx,argv[2],1,4,&operation))return JS_EXCEPTION;
      service[0]=characteristic[0]=0;if(operation!=PX_BLE_DISCOVER&&(uuid(ctx,argv[3],service)||uuid(ctx,argv[4],characteristic)))return JS_EXCEPTION;
      if(bytes(ctx,argv[5],buffer,&length))return JS_EXCEPTION;
      rc=px_ble_operate(owner->ble,connection,request,operation,service,characteristic,buffer,length,JS_ToBool(ctx,argv[6])>0);break;
    case 9:if(number(ctx,argv[0],1,UINT32_MAX,&request)||bytes(ctx,argv[1],buffer,&length))return JS_EXCEPTION;rc=px_ble_read_reply(owner->ble,request,buffer,length,JS_ToBool(ctx,argv[2])>0);if(rc==-ESTALE)rc=0;break;
    default:return poll(ctx,owner->ble);
  }
  return rc?failure(ctx,rc):JS_UNDEFINED;
}
void px_install_ble(JSContext *ctx,JSValue native)
{
  JSClassID id=0;JS_NewClassID(JS_GetRuntime(ctx),&id);if(JS_NewClass(JS_GetRuntime(ctx),id,&definition)<0)return;
  struct ble_owner *owner=js_mallocz(ctx,sizeof(*owner));if(!owner)return;owner->ble=px_ble_create();if(!owner->ble){js_free(ctx,owner);failure(ctx,errno==EBUSY?-EBUSY:-ENOMEM);return;}
  JSValue object=JS_NewObjectClass(ctx,id);if(JS_IsException(object)){px_ble_destroy(owner->ble);js_free(ctx,owner);return;}JS_SetOpaque(object,owner);
  const char *names[]={"available","peripheralStart","peripheralStop","notify","scan","stopScan","connect","disconnect","operate","readReply","shutdown","poll"};int lengths[]={0,2,0,3,1,0,2,1,7,3,0,0};
  for(int i=0;i<12;i++)if(property(ctx,object,names[i],JS_NewCFunctionData(ctx,call,lengths[i],i,1,&object))<0){JS_FreeValue(ctx,object);return;}
  property(ctx,native,"ble",object);
}
