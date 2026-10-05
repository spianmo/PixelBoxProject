/* PMU 寄存器由 C 模块控制；这里只构造公共电池状态与按键事件。 */
#include "quickjs.h"
#include "pixelbox_power.h"
#ifdef __NuttX__
#  include "pixelbox_system_keys.h"
#endif
#include <errno.h>
#include <stdint.h>

static JSValue battery(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_power_battery sample;
  int result = px_power_read_battery(&sample);
#ifdef __NuttX__
  if (result < 0)
    return JS_ThrowInternalError(ctx, "battery read failed (%d, detect=%d, adc=%d)",
                                result, sample.detection_enabled, sample.adc_enabled);
#else
  (void)result;
#endif
  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "level", JS_NewInt32(ctx, sample.level));
  JS_SetPropertyStr(ctx, value, "charging", JS_NewBool(ctx, sample.charging));
  JS_SetPropertyStr(ctx, value, "voltageMv", JS_NewInt32(ctx, sample.voltage_mv));
  return value;
}

static JSValue power_available(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  return JS_NewBool(ctx, px_power_available());
}

static JSValue buttons_available(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
#ifdef __NuttX__
  return JS_NewBool(ctx, px_system_keys_buttons_available());
#else
  return JS_NewBool(ctx, false);
#endif
}

#ifdef __NuttX__
static void add_button(JSContext *ctx, JSValue array, unsigned index,
                        const struct px_button_event *event)
{
  static const char *ids[] = {"boot", "user", "power"};
  static const char *types[] = {"", "down", "up", "click", "doubleClick", "longPress"};
  JSValue item = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, item, "id", JS_NewString(ctx, ids[event->id]));
  JS_SetPropertyStr(ctx, item, "type", JS_NewString(ctx, types[event->type]));
  JS_SetPropertyUint32(ctx, array, index, item);
}
#endif

static JSValue buttons_poll(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  JSValue array = JS_NewArray(ctx);
#ifdef __NuttX__
  struct px_button_event events[32];
  int count = px_system_keys_read_buttons(events, sizeof(events) / sizeof(events[0]));
  if (count < 0) {
    JS_FreeValue(ctx, array);
    return JS_ThrowInternalError(ctx, "button queue read failed (%d)", count);
  }
  for (int i = 0; i < count; ++i) add_button(ctx, array, (unsigned)i, &events[i]);
#endif
  return array;
}

static JSValue buttons_listen(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  int enabled = argc ? JS_ToBool(ctx, argv[0]) : 0;
  if (enabled < 0) return JS_EXCEPTION;
#ifdef __NuttX__
  int result = px_system_keys_listen_buttons(enabled != 0);
  if (result < 0) return JS_ThrowInternalError(ctx, "button subscription failed (%d)", result);
#else
  if (enabled) return JS_ThrowInternalError(ctx, "button subscription unavailable (%d)", -ENOTSUP);
#endif
  return JS_UNDEFINED;
}

void px_install_power(JSContext *ctx, JSValue native)
{
#ifdef __NuttX__
  px_system_keys_vm_reset();
#endif
  JS_SetPropertyStr(ctx, native, "battery", JS_NewCFunction(ctx, battery, "battery", 0));
  JS_SetPropertyStr(ctx, native, "powerAvailable", JS_NewCFunction(ctx, power_available, "powerAvailable", 0));
  JS_SetPropertyStr(ctx, native, "buttonsAvailable", JS_NewCFunction(ctx, buttons_available, "buttonsAvailable", 0));
  JS_SetPropertyStr(ctx, native, "buttonsPoll", JS_NewCFunction(ctx, buttons_poll, "buttonsPoll", 0));
  JS_SetPropertyStr(ctx, native, "buttonsListen", JS_NewCFunction(ctx, buttons_listen, "buttonsListen", 1));
}
