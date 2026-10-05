include $(APPDIR)/Make.defs

PROGNAME = $(CONFIG_INTERPRETERS_PIXELBOX_PROGNAME)
PRIORITY = $(CONFIG_INTERPRETERS_PIXELBOX_PRIORITY)
STACKSIZE = $(CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE)
MODULE = $(CONFIG_INTERPRETERS_PIXELBOX)

MAINSRC = src/main.c
CSRCS = src/runtime.c src/sha256.c src/framebuffer.c src/projection.c src/canvas.c
CSRCS += src/service.c src/devd.c src/store.c
CSRCS += src/system_keys.c src/builtin_apps.c
CSRCS += src/text.c src/text_binding.c generated/pxfont.c
CSRCS += src/wifi.c src/wifi_binding.c
CSRCS += src/net.c src/net_binding.c src/tls.c
CSRCS += src/mdns.c src/mdns_binding.c
CSRCS += src/ble.c src/ble_nimble.c src/ble_binding.c
CSRCS += src/ws.c src/ws_binding.c src/watchdog.c
CSRCS += src/system_net.c src/system_net_binding.c src/system_temperature.c
CSRCS += src/audio.c src/audio_binding.c src/audio_decode.c
CSRCS += src/mic.c src/mic_binding.c
CSRCS += src/power.c src/power_binding.c
CSRCS += src/image.c src/image_binding.c
CSRCS += generated/images/pngle.c generated/images/miniz.c
CSRCS += generated/images/gifdec.c generated/images/tjpgd.c
CSRCS += generated/quickjs-ng/quickjs.c generated/quickjs-ng/cutils.c
CSRCS += generated/quickjs-ng/libregexp.c generated/quickjs-ng/libunicode.c
CSRCS += generated/quickjs-ng/xsum.c
CSRCS += vendor/quickjs-dtoa/dtoa.c

ifeq ($(CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP),y)
CSRCS += src/sleep.c src/sleep_binding.c
CFLAGS += -DPX_TIMED_SLEEP
endif

# 默认关闭；开启后仍由 service 等待显式请求，不能在构建接线中自动开 AP。
ifeq ($(CONFIG_INTERPRETERS_PIXELBOX_PORTAL),y)
CSRCS += src/softap.c src/portal.c src/portal_platform.c src/portal_binding.c
CFLAGS += -DPX_SERVICE_PORTAL
endif

# 仅独立 profile 启用真实模型；selector 已合入 multinet7.o，不能重复编译。
ifeq ($(CONFIG_INTERPRETERS_PIXELBOX_MULTINET7),y)
CSRCS += src/wakeword.c src/wakeword_binding.c src/wakeword_model.c
CSRCS += src/wakeword_commands.c src/wakeword_port.c generated/wakeword/cJSON.c
ASRCS += generated/wakeword/model.S
EXTOBJS += generated/wakeword/multinet7.o
CFLAGS += -DPX_MULTINET7 -I$(CURDIR)/generated/wakeword
ifeq ($(wildcard $(CURDIR)/generated/wakeword/multinet7.o),)
$(error Run scripts/nuttx.py configure --target esp32s3-multinet7 to prepare audited MultiNet7 dependencies)
endif
endif

CFLAGS += -I$(CURDIR)/include -I$(CURDIR)/generated -I$(CURDIR)/generated/quickjs-ng
CFLAGS += -I$(CURDIR)/vendor/quickjs-dtoa
CFLAGS += -I$(CURDIR)/generated/images
PX_HAL = $(TOPDIR)/arch/xtensa/src/chip/esp-hal-3rdparty
# HAL 的 mbedTLS 库仅随 ESPRESSIF_WIFI 构建；无 radio 定时睡眠诊断镜像
# 保留 TLS 的明确 ENOTSUP，不能链接不存在的符号或退回不校验证书。
ifeq ($(CONFIG_ESPRESSIF_WIFI),y)
CFLAGS += -DPX_TLS_MBEDTLS -DPX_TLS_BUILTIN_CA '-DMBEDTLS_CONFIG_FILE=<mbedtls/esp_config.h>'
endif
CFLAGS += -I$(PX_HAL)/components/mbedtls/mbedtls/include
CFLAGS += -I$(PX_HAL)/components/mbedtls/port/include
CFLAGS += -I$(PX_HAL)/components/soc/esp32s3/include
CFLAGS += -I$(PX_HAL)/components/esp_rom/include -I$(PX_HAL)/nuttx/esp32s3/include
CFLAGS += -I$(PX_HAL)/components/efuse/include -I$(PX_HAL)/components/efuse/esp32s3/include
CFLAGS += -I$(PX_HAL)/components/hal/platform_port/include
CFLAGS += -I$(PX_HAL)/components/esp_common/include
CFLAGS += -I$(PX_HAL)/components/esp_hw_support/include
CFLAGS += -I$(PX_HAL)/components/hal/include -I$(PX_HAL)/components/hal/esp32s3/include
CFLAGS += -I$(PX_HAL)/components/soc/include
CFLAGS += -std=gnu11 -D_GNU_SOURCE -DNO_TM_GMTOFF -D__STDC_NO_ATOMICS__=1
CFLAGS += -fno-strict-aliasing -Wno-error -Wno-incompatible-pointer-types

# 解释器和像素循环按速度优化；投影禁用融合运算以保留JS半像素舍入结果。
generated/quickjs-ng/quickjs.c_CFLAGS += -O3
src/canvas.c_CFLAGS += -O3 -fno-inline-functions -ffp-contract=off
src/framebuffer.c_CFLAGS += -O3
src/projection.c_CFLAGS += -O3 -ffp-contract=off

# runner 在 configure 前执行 tools/prepare.py；单独 make 的错误也明确指出入口。
ifeq ($(wildcard $(CURDIR)/generated/prelude_nuttx.h),)
$(error Run python3 tools/prepare.py in the PixelBox firmware project before building)
endif

ifeq ($(CONFIG_NIMBLE),y)
# 上游关闭示例时只准备源码；真实 host 必须编入本应用。
include $(APPDIR)/wireless/bluetooth/nimble/Makefile.nimble
endif

include $(APPDIR)/Application.mk

# 增量Make.dep可能早于prelude生成；显式依赖避免新版JS仍链接旧runtime.o。
$(PREFIX)src/runtime.c$(SUFFIX)$(OBJEXT): generated/prelude_nuttx.h generated/prelude_core.h
$(PREFIX)src/tls.c$(SUFFIX)$(OBJEXT): generated/tls_ca_bundle.h
$(PREFIX)src/builtin_apps.c$(SUFFIX)$(OBJEXT): generated/builtin_apps_data.h
ifeq ($(CONFIG_INTERPRETERS_PIXELBOX_PORTAL),y)
$(PREFIX)src/portal.c$(SUFFIX)$(OBJEXT): src/portal_html.inc
endif
ifeq ($(CONFIG_INTERPRETERS_PIXELBOX_MULTINET7),y)
$(PREFIX)generated/wakeword/model.S$(SUFFIX)$(OBJEXT): generated/wakeword/srmodels.bin
endif
