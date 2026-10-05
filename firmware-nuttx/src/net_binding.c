/* 每个native.net对象独占一个POSIX上下文；终结器关闭fd，worker不持有JS指针。 */
#include "quickjs.h"
#include "pixelbox_net.h"
#include <errno.h>
#include <math.h>
#include <string.h>

struct net_owner { struct px_net *net; };
static void finalize_net(JSRuntime *runtime, JSValue value)
{
  struct net_owner *owner = JS_GetOpaque(value, JS_GetClassID(value));
  if (owner) { px_net_destroy(owner->net); js_free_rt(runtime, owner); }
}
static const JSClassDef net_definition = {.class_name = "PixelBoxNet", .finalizer = finalize_net};
static struct net_owner *owner_of(JSContext *ctx, JSValueConst self)
{
  struct net_owner *owner = JS_GetOpaque2(ctx, self, JS_GetClassID(self));
  if (owner && !owner->net) { JS_ThrowInternalError(ctx, "ECANCELED: network context is closed"); return NULL; }
  return owner;
}
static JSValue net_error(JSContext *ctx, int result)
{
  const char *code = result == -ENOTSUP ? "ENOTSUP" : result == -ETIMEDOUT ? "ETIMEDOUT" :
    result == -ENOBUFS ? "ENOBUFS" : result == -EBUSY ? "EBUSY" : result == -EMFILE ? "EMFILE" :
    result == -EMSGSIZE ? "EMSGSIZE" : result == -ENOTCONN ? "ENOTCONN" : result == -EINVAL ? "EINVAL" : "NETWORK_ERROR";
  if (result == -ENOMEM) return JS_ThrowOutOfMemory(ctx);
  return JS_ThrowInternalError(ctx, "%s: network (%d)", code, result);
}
static int uint_arg(JSContext *ctx, JSValueConst value, unsigned minimum, unsigned maximum, unsigned *out)
{
  double number;
  if (JS_ToFloat64(ctx, &number, value)) return -1;
  if (!isfinite(number) || number < minimum || number > maximum || number != floor(number)) {
    JS_ThrowRangeError(ctx, "network numeric argument out of range"); return -1;
  }
  *out = (unsigned)number; return 0;
}
static const char *host_arg(JSContext *ctx, JSValueConst value)
{
  if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "host must be a string"); return NULL; }
  size_t length;
  const char *host = JS_ToCStringLen(ctx, &length, value);
  if (host && (!length || length >= PX_NET_HOST_BYTES || memchr(host, 0, length))) {
    JS_FreeCString(ctx, host); JS_ThrowRangeError(ctx, "invalid host length or NUL"); return NULL;
  }
  return host;
}
static int property(JSContext *ctx, JSValue object, const char *name, JSValue value)
{
  if (JS_IsException(value)) return -1;
  return JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E);
}
static JSValue connect_socket(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  struct net_owner *owner = owner_of(ctx, self);
  if (!owner) return JS_EXCEPTION;
  if (argc < 4) return JS_ThrowTypeError(ctx, "connect needs host, port, tls, timeout");
  unsigned port, timeout;
  if (uint_arg(ctx, argv[1], 1, 65535, &port) || uint_arg(ctx, argv[3], 1, 120000, &timeout)) return JS_EXCEPTION;
  const char *host = host_arg(ctx, argv[0]);
  if (!host) return JS_EXCEPTION;
  uint32_t id;
  int result = px_net_connect(owner->net, host, port, JS_ToBool(ctx, argv[2]) > 0, timeout, &id);
  JS_FreeCString(ctx, host);
  return result ? net_error(ctx, result) : JS_NewUint32(ctx, id);
}
static JSValue bound_socket(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int udp)
{
  struct net_owner *owner = owner_of(ctx, self);
  if (!owner) return JS_EXCEPTION;
  unsigned port;
  if (!argc) return JS_ThrowTypeError(ctx, "bind needs a port");
  if (uint_arg(ctx, argv[0], 0, 65535, &port)) return JS_EXCEPTION;
  uint32_t id; unsigned bound;
  int result = udp ? px_net_udp(owner->net, port, &id, &bound) : px_net_listen(owner->net, port, &id, &bound);
  if (result) return net_error(ctx, result);
  JSValue object = JS_NewObject(ctx);
  if (JS_IsException(object) || property(ctx, object, "id", JS_NewUint32(ctx, id)) < 0 ||
      property(ctx, object, "port", JS_NewUint32(ctx, bound)) < 0) {
    px_net_close(owner->net, id); JS_FreeValue(ctx, object); return JS_EXCEPTION;
  }
  return object;
}
static JSValue send_socket(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  struct net_owner *owner = owner_of(ctx, self);
  if (!owner) return JS_EXCEPTION;
  unsigned id, port = 0;
  if (argc < 2) return JS_ThrowTypeError(ctx, "send needs id and data");
  if (uint_arg(ctx, argv[0], 1, 0xffffffffu, &id)) return JS_EXCEPTION;
  const char *host = NULL, *text = NULL;
  if (argc > 2 && !JS_IsUndefined(argv[2])) {
    if (argc < 4 || uint_arg(ctx, argv[3], 1, 65535, &port)) return JS_EXCEPTION;
    host = host_arg(ctx, argv[2]); if (!host) return JS_EXCEPTION;
  }
  const uint8_t *data = NULL; size_t length = 0;
  JSValue buffer = JS_UNDEFINED;
  int invalid = 0;
  if (JS_IsString(argv[1])) {
    text = JS_ToCStringLen(ctx, &length, argv[1]); data = (const uint8_t *)text; invalid = !text;
  } else if (JS_GetTypedArrayType(argv[1]) == JS_TYPED_ARRAY_UINT8) {
    size_t offset, element, capacity;
    buffer = JS_GetTypedArrayBuffer(ctx, argv[1], &offset, &length, &element);
    if (JS_IsException(buffer)) invalid = 1;
    else {
      uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, buffer);
      invalid = JS_HasException(ctx) || offset > capacity || length > capacity - offset;
      if (!invalid) data = base ? base + offset : NULL;
    }
  } else if (JS_IsArrayBuffer(argv[1])) {
    data = JS_GetArrayBuffer(ctx, &length, argv[1]); invalid = JS_HasException(ctx);
  } else { JS_ThrowTypeError(ctx, "send needs string, ArrayBuffer or Uint8Array"); invalid = 1; }
  int result = invalid ? 0 : px_net_send(owner->net, id, data, length, host, port);
  JS_FreeValue(ctx, buffer); JS_FreeCString(ctx, text); JS_FreeCString(ctx, host);
  return invalid ? JS_EXCEPTION : result ? net_error(ctx, result) : JS_UNDEFINED;
}
static JSValue close_socket(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  struct net_owner *owner = owner_of(ctx, self);
  if (!owner) return JS_EXCEPTION;
  unsigned id;
  if (!argc) return JS_ThrowTypeError(ctx, "close needs a socket id");
  if (uint_arg(ctx, argv[0], 1, 0xffffffffu, &id)) return JS_EXCEPTION;
  px_net_close(owner->net, id); return JS_UNDEFINED;
}
static JSValue poll_socket(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)argc; (void)argv;
  struct net_owner *owner = owner_of(ctx, self);
  if (!owner) return JS_EXCEPTION;
  struct px_net_event event;
  int result = px_net_poll(owner->net, &event);
  if (result <= 0) return result ? net_error(ctx, result) : JS_NULL;
  JSValue object = JS_NewObject(ctx);
  if (JS_IsException(object) || property(ctx, object, "id", JS_NewUint32(ctx, event.id)) < 0 ||
      property(ctx, object, "type", JS_NewInt32(ctx, event.type)) < 0 ||
      property(ctx, object, "acceptedId", JS_NewUint32(ctx, event.accepted_id)) < 0 ||
      property(ctx, object, "error", JS_NewInt32(ctx, event.error)) < 0 ||
      property(ctx, object, "host", JS_NewString(ctx, event.host)) < 0 ||
      property(ctx, object, "port", JS_NewUint32(ctx, event.port)) < 0 ||
      property(ctx, object, "data", event.data ? JS_NewArrayBufferCopy(ctx, event.data, event.length) : JS_NULL) < 0) {
    if (event.accepted_id) px_net_close(owner->net, event.accepted_id);
    JS_FreeValue(ctx, object); object = JS_EXCEPTION;
  }
  px_net_event_free(&event); return object;
}
static JSValue shutdown_net(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)argc; (void)argv;
  struct net_owner *owner = JS_GetOpaque2(ctx, self, JS_GetClassID(self));
  if (!owner) return JS_EXCEPTION;
  px_net_destroy(owner->net); owner->net = NULL; return JS_UNDEFINED;
}
static JSValue queued_socket(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  struct net_owner *owner=owner_of(ctx,self);if(!owner)return JS_EXCEPTION;unsigned id;
  if(!argc)return JS_ThrowTypeError(ctx,"queued needs socket id");
  if(uint_arg(ctx,argv[0],1,0xffffffffu,&id))return JS_EXCEPTION;
  size_t bytes;int result=px_net_queued(owner->net,id,&bytes);
  return result?net_error(ctx,result):JS_NewFloat64(ctx,(double)bytes);
}
static JSValue pause_socket(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  struct net_owner *owner=owner_of(ctx,self);if(!owner)return JS_EXCEPTION;unsigned id;
  if(argc<2)return JS_ThrowTypeError(ctx,"pause needs socket id and boolean");
  if(uint_arg(ctx,argv[0],1,0xffffffffu,&id))return JS_EXCEPTION;
  int result=px_net_read_pause(owner->net,id,JS_ToBool(ctx,argv[1])>0);
  return result?net_error(ctx,result):JS_UNDEFINED;
}
/* 函数闭包固定其所属对象，不能用call/apply把其它原生opaque对象当作网络上下文。 */
static JSValue net_call(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic, JSValue *data)
{
  (void)self;
  switch (magic) {
    case 0: return connect_socket(ctx, data[0], argc, argv);
    case 1: return bound_socket(ctx, data[0], argc, argv, 0);
    case 2: return bound_socket(ctx, data[0], argc, argv, 1);
    case 3: return send_socket(ctx, data[0], argc, argv);
    case 4: return close_socket(ctx, data[0], argc, argv);
    case 5: return poll_socket(ctx, data[0], argc, argv);
    case 7: return queued_socket(ctx,data[0],argc,argv);
    case 8: return pause_socket(ctx,data[0],argc,argv);
    default: return shutdown_net(ctx, data[0], argc, argv);
  }
}
void px_install_net(JSContext *ctx, JSValue native)
{
  JSClassID net_class = 0;
  JS_NewClassID(JS_GetRuntime(ctx), &net_class);
  if (JS_NewClass(JS_GetRuntime(ctx), net_class, &net_definition) < 0) return;
  struct net_owner *owner = js_mallocz(ctx, sizeof(*owner));
  if (!owner) return;
  owner->net = px_net_create();
  if (!owner->net) { js_free(ctx, owner); JS_ThrowOutOfMemory(ctx); return; }
  JSValue object = JS_NewObjectClass(ctx, net_class);
  if (JS_IsException(object)) { px_net_destroy(owner->net); js_free(ctx, owner); return; }
  JS_SetOpaque(object, owner);
  const char *names[] = {"connect", "listen", "udp", "send", "close", "poll", "shutdown", "queued", "pause"};
  const int lengths[] = {4, 1, 1, 4, 1, 0, 0, 1, 2};
  for (int i = 0; i < 9; ++i)
    if(property(ctx,object,names[i],JS_NewCFunctionData(ctx,net_call,lengths[i],i,1,&object))<0){
      JS_FreeValue(ctx,object);return;
    }
  property(ctx,native,"net",object);
}
