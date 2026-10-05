/* JS闭包捕获自己的owner；完成ToString/getter后重查关闭状态，防止重入释放。 */
#include "quickjs.h"
#include "pixelbox_mdns.h"
#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <string.h>

struct mdns_owner { struct px_mdns *context; };
static void finalize_mdns(JSRuntime *runtime, JSValue value)
{
  struct mdns_owner *owner = JS_GetOpaque(value, JS_GetClassID(value));
  if (owner) { px_mdns_destroy(owner->context); js_free_rt(runtime, owner); }
}
static const JSClassDef mdns_definition = {.class_name = "PixelBoxMdns", .finalizer = finalize_mdns};
static struct mdns_owner *get_owner(JSContext *ctx, JSValueConst value, bool open)
{
  struct mdns_owner *owner = JS_GetOpaque2(ctx, value, JS_GetClassID(value));
  if (owner && open && !owner->context) { JS_ThrowInternalError(ctx, "ECANCELED: mDNS context is closed"); return NULL; }
  return owner;
}
static const char *error_code(int error)
{
  switch (error) {
    case 0: return "";
    case -ENOMEM: return "ENOMEM";
    case -EINVAL: return "EINVAL";
    case -EBUSY: return "EBUSY";
    case -ENOSPC: return "ENOSPC";
    case -EEXIST: return "EEXIST";
    case -ENOENT: return "ENOENT";
    case -ENOTSUP: return "ENOTSUP";
    case -EADDRINUSE: return "EADDRINUSE";
    case -ENETDOWN: return "ENETDOWN";
    case -ENODEV: return "ENODEV";
    case -ECANCELED: return "ECANCELED";
    default: return "MDNS_ERROR";
  }
}
static JSValue throw_error(JSContext *ctx, int error)
{
  return error == -ENOMEM ? JS_ThrowOutOfMemory(ctx) :
    JS_ThrowInternalError(ctx, "%s: mDNS operation (%d)", error_code(error), error);
}
static int property(JSContext *ctx, JSValue object, const char *name, JSValue value)
{ return JS_IsException(value) ? -1 : JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E); }
static int positive(JSContext *ctx, JSValueConst value, uint32_t max, unsigned *output)
{
  double number;
  if (JS_ToFloat64(ctx, &number, value)) return -1;
  if (!isfinite(number) || number < 1 || number > max || number != floor(number)) {
    JS_ThrowRangeError(ctx, "mDNS integer argument out of range"); return -1;
  }
  *output = (unsigned)number; return 0;
}
static const char *string_arg(JSContext *ctx, JSValueConst value, size_t maximum)
{
  size_t length; const char *text = JS_ToCStringLen(ctx, &length, value);
  if (!text) return NULL;
  if (!length || length > maximum || memchr(text, 0, length)) {
    JS_FreeCString(ctx, text); JS_ThrowRangeError(ctx, "mDNS name length or NUL is invalid"); return NULL;
  }
  return text;
}
static JSValue discover(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  if (!get_owner(ctx, self, true)) return JS_EXCEPTION;
  if (!argc) return JS_ThrowTypeError(ctx, "discover requires a service");
  const char *service = string_arg(ctx, argv[0], 22); if (!service) return JS_EXCEPTION;
  unsigned timeout = 3000;
  if (argc > 1 && !JS_IsUndefined(argv[1]) && positive(ctx, argv[1], 120000, &timeout)) {
    JS_FreeCString(ctx, service); return JS_EXCEPTION;
  }
  struct mdns_owner *owner = get_owner(ctx, self, true);
  if (!owner) { JS_FreeCString(ctx, service); return JS_EXCEPTION; }
  uint32_t id; int error = px_mdns_discover(owner->context, service, timeout, &id);
  JS_FreeCString(ctx, service); return error ? throw_error(ctx, error) : JS_NewUint32(ctx, id);
}
static int encode_txt(JSContext *ctx, JSValueConst value, uint8_t output[PX_MDNS_TXT_BYTES], size_t *length)
{
  *length = 0;
  if (JS_IsUndefined(value) || JS_IsNull(value)) return 0;
  if (!JS_IsObject(value)) { JS_ThrowTypeError(ctx, "mDNS txt must be an object"); return -1; }
  JSPropertyEnum *properties = NULL; uint32_t count = 0;
  if (JS_GetOwnPropertyNames(ctx, &properties, &count, value, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) return -1;
  int error = 0;
  for (uint32_t i = 0; i < count && !error; ++i) {
    JSValue key_value = JS_AtomToValue(ctx, properties[i].atom);
    size_t key_size = 0, value_size = 0;
    const char *key = JS_IsException(key_value) ? NULL : JS_ToCStringLen(ctx, &key_size, key_value);
    JS_FreeValue(ctx, key_value);
    JSValue item = key ? JS_GetProperty(ctx, value, properties[i].atom) : JS_EXCEPTION;
    const char *text = JS_IsException(item) ? NULL : JS_ToCStringLen(ctx, &value_size, item);
    JS_FreeValue(ctx, item);
    if (!key || !text) error = -1;
    else {
      bool valid = key_size != 0;
      for (size_t k = 0; k < key_size; ++k)
        if ((unsigned char)key[k] < 32 || (unsigned char)key[k] > 126 || key[k] == '=') valid = false;
      size_t bytes = key_size + value_size + 1;
      if (!valid || bytes > 255 || *length + bytes + 1 > PX_MDNS_TXT_BYTES) {
        JS_ThrowRangeError(ctx, "mDNS TXT key/item/total length is invalid"); error = -1;
      } else {
        output[(*length)++] = (uint8_t)bytes; memcpy(output + *length, key, key_size); *length += key_size;
        output[(*length)++] = '='; memcpy(output + *length, text, value_size); *length += value_size;
      }
    }
    JS_FreeCString(ctx, key); JS_FreeCString(ctx, text);
  }
  for (uint32_t i = 0; i < count; ++i) JS_FreeAtom(ctx, properties[i].atom);
  js_free(ctx, properties); return error;
}
static JSValue advertise(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  if (!get_owner(ctx, self, true)) return JS_EXCEPTION;
  if (argc < 3) return JS_ThrowTypeError(ctx, "advertise requires name, service and port");
  const char *name = string_arg(ctx, argv[0], 63); if (!name) return JS_EXCEPTION;
  const char *service = string_arg(ctx, argv[1], 22);
  if (!service) { JS_FreeCString(ctx, name); return JS_EXCEPTION; }
  unsigned port; uint8_t txt[PX_MDNS_TXT_BYTES]; size_t length = 0;
  int error = positive(ctx, argv[2], 65535, &port);
  if (!error && argc > 3) error = encode_txt(ctx, argv[3], txt, &length);
  struct mdns_owner *owner = error ? NULL : get_owner(ctx, self, true);
  uint32_t id = 0;
  int result = owner ? px_mdns_advertise(owner->context, name, service, port, txt, length, &id) : 0;
  JS_FreeCString(ctx, name); JS_FreeCString(ctx, service);
  if (!owner) return JS_EXCEPTION;
  return result ? throw_error(ctx, result) : JS_NewUint32(ctx, id);
}
static JSValue decode_txt(JSContext *ctx, const struct px_mdns_service *service)
{
  JSValue object = JS_NewObject(ctx); if (JS_IsException(object)) return object;
  for (size_t at = 0; at < service->txt_length;) {
    unsigned length = service->txt[at++], key = 0;
    if (!length) continue;
    while (key < length && service->txt[at + key] != '=') ++key;
    size_t start = key < length ? key + 1 : length;
    JSAtom atom = JS_NewAtomLen(ctx, (const char *)service->txt + at, key);
    JSValue value = JS_NewStringLen(ctx, (const char *)service->txt + at + start, length - start);
    int result = !atom || JS_IsException(value) ? -1 : JS_DefinePropertyValue(ctx, object, atom, value, JS_PROP_C_W_E);
    if (!atom) JS_FreeValue(ctx, value);
    JS_FreeAtom(ctx, atom);
    if (result < 0) { JS_FreeValue(ctx, object); return JS_EXCEPTION; }
    at += length;
  }
  return object;
}
static JSValue poll_results(JSContext *ctx, JSValueConst self)
{
  struct mdns_owner *owner = get_owner(ctx, self, true); if (!owner) return JS_EXCEPTION;
  struct px_mdns_result result; int available = px_mdns_poll(owner->context, &result);
  if (available <= 0) return available ? throw_error(ctx, available) : JS_NULL;
  JSValue object = JS_NewObject(ctx), list = JS_NewArray(ctx);
  bool failed = JS_IsException(object) || JS_IsException(list);
  for (size_t i = 0; i < result.count && !failed; ++i) {
    const struct px_mdns_service *service = &result.services[i];
    JSValue item = JS_NewObject(ctx);
    failed = JS_IsException(item) || property(ctx, item, "name", JS_NewString(ctx, service->name)) < 0 ||
      property(ctx, item, "host", JS_NewString(ctx, service->host)) < 0 || property(ctx, item, "ip", JS_NewString(ctx, service->ip)) < 0 ||
      property(ctx, item, "port", JS_NewUint32(ctx, service->port)) < 0 || property(ctx, item, "txt", decode_txt(ctx, service)) < 0;
    if (failed) JS_FreeValue(ctx, item);
    else failed = JS_DefinePropertyValueUint32(ctx, list, (uint32_t)i, item, JS_PROP_C_W_E) < 0;
  }
  if (!failed) failed = property(ctx, object, "id", JS_NewUint32(ctx, result.id)) < 0 ||
    property(ctx, object, "error", JS_NewInt32(ctx, result.error)) < 0 || property(ctx, object, "code", JS_NewString(ctx, error_code(result.error))) < 0;
  px_mdns_result_free(&result);
  if (failed) { JS_FreeValue(ctx, object); JS_FreeValue(ctx, list); return JS_EXCEPTION; }
  if (property(ctx, object, "services", list) < 0) { JS_FreeValue(ctx, object); return JS_EXCEPTION; }
  return object;
}
static JSValue mdns_call(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic, JSValue *data)
{
  (void)self;
  if (magic == 0) return discover(ctx, data[0], argc, argv);
  if (magic == 1) return advertise(ctx, data[0], argc, argv);
  if (magic == 4) return poll_results(ctx, data[0]);
  struct mdns_owner *owner = get_owner(ctx, data[0], magic != 5); if (!owner) return JS_EXCEPTION;
  if (magic == 5) { px_mdns_destroy(owner->context); owner->context = NULL; return JS_UNDEFINED; }
  unsigned id;
  if (!argc || positive(ctx, argv[0], UINT32_MAX, &id)) return argc ? JS_EXCEPTION : JS_ThrowTypeError(ctx, "mDNS handle required");
  owner = get_owner(ctx, data[0], true); if (!owner) return JS_EXCEPTION;
  int result = magic == 2 ? px_mdns_cancel(owner->context, id) : px_mdns_unadvertise(owner->context, id);
  return result && result != -ENOENT ? throw_error(ctx, result) : JS_UNDEFINED;
}
void px_install_mdns(JSContext *ctx, JSValue native)
{
  JSClassID id = 0; JS_NewClassID(JS_GetRuntime(ctx), &id);
  if (JS_NewClass(JS_GetRuntime(ctx), id, &mdns_definition) < 0) return;
  struct mdns_owner *owner = js_mallocz(ctx, sizeof(*owner)); if (!owner) return;
  owner->context = px_mdns_create();
  if (!owner->context) { js_free(ctx, owner); JS_ThrowOutOfMemory(ctx); return; }
  JSValue object = JS_NewObjectClass(ctx, id);
  if (JS_IsException(object)) { px_mdns_destroy(owner->context); js_free(ctx, owner); return; }
  JS_SetOpaque(object, owner);
  const char *names[] = {"discover", "advertise", "cancel", "unadvertise", "poll", "shutdown"};
  const unsigned lengths[] = {2, 4, 1, 1, 0, 0};
  for (unsigned i = 0; i < sizeof(names) / sizeof(*names); ++i)
    if (property(ctx, object, names[i], JS_NewCFunctionData(ctx, mdns_call, lengths[i], (int)i, 1, &object)) < 0) {
      JS_FreeValue(ctx, object); return;
    }
  property(ctx, native, "mdns", object);
}
