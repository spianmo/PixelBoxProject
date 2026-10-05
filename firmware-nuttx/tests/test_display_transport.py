#!/usr/bin/env python3
"""编译真实 CO5300 驱动，用 QSPI/GPIO 替身验证线上协议与 framebuffer。

不访问真机、不编译 NuttX；每条子进程均有超时，整组测试总预算 60 秒。
可设置 PIXELBOX_TEST_SANITIZERS=address,undefined 启用 ASan/UBSan。
"""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import unittest


PROJECT = Path(__file__).resolve().parents[1]
DRIVER = PROJECT / "boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_co5300.c"

HEADERS = {
    "nuttx/config.h": """#pragma once
#ifndef PIXELBOX_TEST_NO_SPI2
#define CONFIG_ESP32S3_SPI2 1
#endif
#define CONFIG_ESP32S3_SPI_DMA 1
#ifndef CONFIG_ESP32S3_SPI_DMA_BUFSIZE
#define CONFIG_ESP32S3_SPI_DMA_BUFSIZE 2048
#endif
#define CONFIG_VIDEO_FB 1
#define CONFIG_FB_UPDATE 1
#define FAR
""",
    "nuttx/arch.h": "#pragma once\nvoid up_mdelay(unsigned int ms);\n",
    "nuttx/kmalloc.h": """#pragma once
#include <stdlib.h>
#define kmm_zalloc(size) calloc(1, size)
#define kmm_free free
""",
    "nuttx/spi/qspi.h": """#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#define QSPICMD_ADDRESS 1
#define QSPICMD_WRITEDATA 2
/* 与 .deps/nuttx/include/nuttx/spi/qspi.h 一致：位2表示 memory write。 */
#define QSPIMEM_WRITE (1 << 2)
#define QSPIDEV_MODE0 0
struct qspi_dev_s { int unused; };
struct qspi_cmdinfo_s {
  uint8_t flags, addrlen; uint16_t cmd; uint32_t addr;
  size_t buflen; void *buffer;
};
struct qspi_meminfo_s {
  uint8_t flags, addrlen; uint16_t cmd; uint32_t addr;
  size_t buflen; void *buffer; uint8_t dummies;
};
int mock_lock(struct qspi_dev_s *, bool);
void mock_setmode(struct qspi_dev_s *, int);
void mock_setbits(struct qspi_dev_s *, int);
uint32_t mock_frequency(struct qspi_dev_s *, uint32_t);
int mock_command(struct qspi_dev_s *, struct qspi_cmdinfo_s *);
int mock_memory(struct qspi_dev_s *, struct qspi_meminfo_s *);
#define QSPI_LOCK mock_lock
#define QSPI_SETMODE mock_setmode
#define QSPI_SETBITS mock_setbits
#define QSPI_SETFREQUENCY mock_frequency
#define QSPI_COMMAND mock_command
#define QSPI_MEMORY mock_memory
""",
    "esp32s3_qspi.h": """#pragma once
#include <nuttx/spi/qspi.h>
#define ESP32S3_SPI2 2
struct qspi_dev_s *esp32s3_qspibus_initialize(int port);
int esp32s3_qspibus_set_attr(struct qspi_dev_s *, uint8_t, uint8_t, uint8_t);
""",
    "esp32s3_gpio.h": """#pragma once
#include <stdbool.h>
#define OUTPUT 1
int esp32s3_configgpio(int pin, int mode);
void esp32s3_gpiowrite(int pin, bool value);
""",
    "nuttx/video/fb.h": """#pragma once
#include <stddef.h>
#include <stdint.h>
#define FB_FMT_RGB16_565 1
struct fb_videoinfo_s { int fmt, xres, yres, nplanes; };
struct fb_planeinfo_s {
  void *fbmem; size_t fblen, stride; int display, bpp, xres_virtual, yres_virtual;
};
struct fb_area_s { uint16_t x, y, w, h; };
struct fb_vtable_s {
  int (*getvideoinfo)(struct fb_vtable_s *, struct fb_videoinfo_s *);
  int (*getplaneinfo)(struct fb_vtable_s *, int, struct fb_planeinfo_s *);
  int (*open)(struct fb_vtable_s *);
  int (*close)(struct fb_vtable_s *);
  int (*updatearea)(struct fb_vtable_s *, const struct fb_area_s *);
  int (*pandisplay)(struct fb_vtable_s *, struct fb_planeinfo_s *);
  int (*setframerate)(struct fb_vtable_s *, int);
  int (*getframerate)(struct fb_vtable_s *);
  int (*getpower)(struct fb_vtable_s *);
  int (*setpower)(struct fb_vtable_s *, int);
  int (*ioctl)(struct fb_vtable_s *, int, unsigned long);
  void *priv;
};
""",
}

HARNESS = r"""
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp32s3_gpio.h"
#include DRIVER_PATH
#undef assert
#define assert(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); exit(1); \
  } \
} while (0)

struct event {
  char kind;
  unsigned value, address_lines, data_lines;
  size_t length;
  uintptr_t buffer;
  uint8_t bytes[CONFIG_ESP32S3_SPI_DMA_BUFSIZE];
};
static struct event events[1024];
#define EXPECTED_QSPIMEM_WRITE (1 << 2)
static size_t count;
static unsigned address_lines, data_lines;
static bool locked;
static int fail_command = -1, fail_memory;
static int fail_memory_at = -1, fail_data_lines = -1, fail_lock;
static unsigned memory_calls, lock_acquires, lock_releases;
static struct qspi_dev_s device;

static struct event *record(char kind, unsigned value) {
  assert(count < sizeof(events) / sizeof(events[0]));
  struct event *event = &events[count++];
  memset(event, 0, sizeof(*event));
  event->kind = kind; event->value = value;
  event->address_lines = address_lines; event->data_lines = data_lines;
  return event;
}

int mock_lock(struct qspi_dev_s *dev, bool acquire) {
  assert(dev == &device);
  if (acquire && fail_lock) return fail_lock;
  assert(locked != acquire); locked = acquire;
  if (acquire) lock_acquires++; else lock_releases++;
  return 0;
}
void mock_setmode(struct qspi_dev_s *dev, int mode) { assert(dev == &device && mode == 0); }
void mock_setbits(struct qspi_dev_s *dev, int bits) { assert(dev == &device && bits == 8); }
uint32_t mock_frequency(struct qspi_dev_s *dev, uint32_t hz) {
  assert(dev == &device); return hz;
}
struct qspi_dev_s *esp32s3_qspibus_initialize(int port) {
  assert(port == ESP32S3_SPI2); return &device;
}
int esp32s3_qspibus_set_attr(struct qspi_dev_s *dev, uint8_t dummy,
                           uint8_t address, uint8_t data) {
  assert(dev == &device && locked && dummy == 0);
  if (data == fail_data_lines) return -EIO;
  address_lines = address; data_lines = data; return 0;
}
int esp32s3_configgpio(int pin, int mode) {
  assert(pin == 39 && mode == OUTPUT); return 0;
}
void esp32s3_gpiowrite(int pin, bool value) {
  assert(pin == 39); record('R', value);
}
void up_mdelay(unsigned int ms) { record('D', ms); }
int mock_command(struct qspi_dev_s *dev, struct qspi_cmdinfo_s *transfer) {
  assert(dev == &device && locked);
  assert(transfer->cmd == 0x02 && transfer->addrlen == 3);
  assert((transfer->flags & QSPICMD_ADDRESS) != 0);
  assert(transfer->buflen <= 4 && (transfer->addr & 0xff) == 0);
  struct event *event = record('C', transfer->addr >> 8);
  event->length = transfer->buflen;
  /* 真实 QSPI 驱动每次按4字节取数，ASan 会捕捉未填充的短buffer。 */
  memcpy(event->bytes, transfer->buffer, 4);
  return (int)event->value == fail_command ? -EIO : 0;
}
int mock_memory(struct qspi_dev_s *dev, struct qspi_meminfo_s *transfer) {
  assert(dev == &device && locked);
  /* 独立于替身头文件再次校验真实 NuttX 标志，避免误写成 1。 */
  assert(transfer->flags == EXPECTED_QSPIMEM_WRITE &&
         transfer->flags == QSPIMEM_WRITE && transfer->cmd == 0x32);
  assert((transfer->addr == 0x002c00 || transfer->addr == 0x003c00) &&
         transfer->addrlen == 3);
  assert(transfer->buflen <= CONFIG_ESP32S3_SPI_DMA_BUFSIZE);
  assert(((uintptr_t)transfer->buffer & 3) == 0);
  assert(transfer->buffer == g_dma_pixels);
  struct event *event = record('M', transfer->addr >> 8);
  event->buffer = (uintptr_t)transfer->buffer; event->length = transfer->buflen;
  memcpy(event->bytes, transfer->buffer, transfer->buflen);
  memory_calls++;
  return fail_memory_at == (int)memory_calls ? -ETIMEDOUT : fail_memory;
}

static void setup(void) {
  assert(up_fbinitialize(0) == 0);
  struct fb_videoinfo_s video;
  struct fb_planeinfo_s plane;
  struct fb_vtable_s *fb = up_fbgetvplane(0, 0);
  assert(fb != NULL && fb->getvideoinfo(fb, &video) == 0);
  assert(video.xres == 480 && video.yres == 480 && video.fmt == FB_FMT_RGB16_565);
  assert(fb->getplaneinfo(fb, 0, &plane) == 0);
  assert(plane.stride == 960 && plane.fblen == 480 * 960 && plane.bpp == 16);
  assert(!locked);
}

static void test_initialization(void) {
  setup();
  assert(count >= 6);
  assert(events[0].kind == 'R' && events[0].value == 0);
  assert(events[1].kind == 'D' && events[1].value == 10);
  assert(events[2].kind == 'R' && events[2].value == 1);
  assert(events[3].kind == 'D' && events[3].value == 150);
  unsigned commands = 0;
  for (size_t i = 0; i < count; i++) if (events[i].kind == 'C') {
    assert(events[i].address_lines == 1 && events[i].data_lines == 1);
    for (size_t j = events[i].length; j < 4; j++) assert(events[i].bytes[j] == 0);
    commands++;
  }
  assert(commands == 16);
  assert(events[count - 1].value == 0x51 && events[count - 1].bytes[0] == 204);
  size_t before = count;
  assert(pixelbox_board_display_initialize() == 0 && count == before);
}

static void test_full_frame(void) {
  setup(); count = 0;
  unsigned locks = lock_acquires, unlocks = lock_releases;
  uint16_t *pixels = (uint16_t *)g_fb.fbmem;
  const uint16_t colors[] = {0xf800, 0x07e0, 0x001f, 0xffff};
  for (size_t i = 0; i < 480 * 480; i++) pixels[i] = colors[i % 4];
  struct fb_area_s area = {0, 0, 480, 480};
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
#if CONFIG_ESP32S3_SPI_DMA_BUFSIZE == 2048
  const size_t blocks = 240, blockbytes = 1920;
#else
  const size_t blocks = 60, blockbytes = 7680;
#endif
  assert(count == 2 + blocks);
  assert(lock_acquires == locks + 1 && lock_releases == unlocks + 1);
  assert(events[0].kind == 'C' && events[0].value == 0x2a && events[0].data_lines == 1);
  assert(events[1].kind == 'C' && events[1].value == 0x2b && events[1].data_lines == 1);
  const uint8_t window[] = {0, 0, 1, 0xdf};
  assert(memcmp(events[0].bytes, window, 4) == 0);
  assert(memcmp(events[1].bytes, window, 4) == 0);
  const uint8_t expected[] = {0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff};
  for (size_t i = 2; i < count; i++) {
    struct event *color = &events[i];
    assert(color->kind == 'M' && color->data_lines == 4 && color->address_lines == 1);
    assert(color->value == (i == 2 ? 0x2c : 0x3c));
    assert(color->length == blockbytes);
    for (size_t j = 0; j < color->length; j += sizeof(expected))
      assert(memcmp(color->bytes + j, expected, sizeof(expected)) == 0);
  }
  assert(pixels[0] == 0xf800 && pixels[1] == 0x07e0 && !locked);
}

static void test_dirty_stride(void) {
  setup(); count = 0;
  uint16_t *pixels = (uint16_t *)g_fb.fbmem;
  pixels[480 * 2 + 2] = 0x1234; pixels[480 * 2 + 3] = 0x5678;
  pixels[480 * 3 + 2] = 0x9abc; pixels[480 * 3 + 3] = 0xdef0;
  struct fb_area_s area = {3, 3, 1, 1};
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
  const uint8_t window[] = {0, 2, 0, 3};
  const uint8_t expected[] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};
  assert(count == 3 && events[2].length == sizeof(expected));
  assert(memcmp(events[0].bytes, window, 4) == 0);
  assert(memcmp(events[1].bytes, window, 4) == 0);
  assert(memcmp(events[2].bytes, expected, sizeof(expected)) == 0);
}

static void test_error_propagation(void) {
  setup(); count = 0;
  struct fb_area_s area = {0, 0, 2, 2};
  fail_command = 0x2a;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -EIO);
  assert(count == 1 && !locked);
  fail_command = -1; fail_memory = -ETIMEDOUT; count = 0;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -ETIMEDOUT);
  assert(count == 3 && !locked);
  fail_memory = 0;
  uint8_t pixels[8] = {0}; count = 0;
  assert(pixelbox_board_display_write(1, 0, 2, 2, pixels, 8) == -EINVAL);
  assert(pixelbox_board_display_write(0, 0, 2, 2, pixels, 7) == -EINVAL);
  assert(count == 0 && !locked);
  assert(pixelbox_board_display_write(INT_MAX, 0, 2, 2, pixels, 8) == -EINVAL);
  assert(pixelbox_board_display_write(0, 0, INT_MAX, 2, pixels, 8) == -EINVAL);
}

static void test_continuous_write(void) {
  setup(); count = 0;
  const int width = 48;
  const int height = 42;
  const size_t length = (size_t)width * height * 2;
  uint8_t *pixels = malloc(length);
  assert(pixels != NULL);
  for (size_t i = 0; i < length; i++) pixels[i] = (uint8_t)i;
  assert(pixelbox_board_display_write(0, 0, width, height, pixels, length) == 0);
  assert(events[0].kind == 'C' && events[0].value == 0x2a);
  assert(events[1].kind == 'C' && events[1].value == 0x2b);
#if CONFIG_ESP32S3_SPI_DMA_BUFSIZE == 2048
  assert(count == 5);
  assert(events[2].kind == 'M' && events[2].value == 0x2c && events[2].length == 1920);
  assert(events[3].kind == 'M' && events[3].value == 0x3c && events[3].length == 1920);
  assert(events[4].kind == 'M' && events[4].value == 0x3c && events[4].length == 192);
  assert(memcmp(events[2].bytes, pixels, events[2].length) == 0);
  assert(memcmp(events[3].bytes, pixels + events[2].length, events[3].length) == 0);
  assert(memcmp(events[4].bytes, pixels + events[2].length + events[3].length,
                events[4].length) == 0);
#else
  assert(count == 3);
  assert(events[2].kind == 'M' && events[2].value == 0x2c && events[2].length == length);
  assert(memcmp(events[2].bytes, pixels, length) == 0);
#endif
  assert(!locked);
  free(pixels);
}

static void test_continuous_write_error(void) {
  setup(); count = 0;
  const int width = 48;
  const int height = 42;
  const size_t length = (size_t)width * height * 2;
  uint8_t *pixels = calloc(1, length);
  assert(pixels != NULL);
  fail_memory = -ETIMEDOUT;
  assert(pixelbox_board_display_write(0, 0, width, height, pixels, length) == -ETIMEDOUT);
  assert(count == 3 && !locked);
  fail_memory = 0;
  free(pixels);
}

static void test_midstream_retry(void) {
  setup(); count = 0;
  struct fb_area_s area = {2, 4, 478, 20};
  unsigned locks = lock_acquires, unlocks = lock_releases;
  fail_memory_at = 2;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -ETIMEDOUT);
  assert(count == 4 && events[2].value == 0x2c && events[3].value == 0x3c);
  assert(!locked && lock_acquires == locks + 1 && lock_releases == unlocks + 1);
  fail_memory_at = -1; count = 0;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
  assert(events[0].value == 0x2a && events[1].value == 0x2b && events[2].value == 0x2c);
  assert(!locked && lock_acquires == locks + 2 && lock_releases == unlocks + 2);
  count = 0; memory_calls = 0; fail_memory_at = 2;
  uint8_t pixels[480 * 20 * 2] = {0};
  assert(pixelbox_board_display_write(0, 0, 480, 20, pixels, sizeof(pixels)) == -ETIMEDOUT);
  assert(count == 4 && !locked);
  fail_memory_at = -1; count = 0;
  assert(pixelbox_board_display_write(0, 0, 480, 20, pixels, sizeof(pixels)) == 0);
  assert(events[0].value == 0x2a && events[1].value == 0x2b && events[2].value == 0x2c);
  assert(!locked);
}

static void test_begin_failures(void) {
  setup(); count = 0;
  struct fb_area_s area = {0, 0, 480, 20};
  unsigned locks = lock_acquires, unlocks = lock_releases;
  fail_lock = -EBUSY;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -EBUSY);
  assert(count == 0 && !locked && lock_acquires == locks && lock_releases == unlocks);
  fail_lock = 0;
  fail_data_lines = 1;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -EIO);
  assert(count == 0 && !locked && lock_acquires == locks + 1 && lock_releases == unlocks + 1);
  fail_data_lines = 4;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -EIO);
  assert(count == 2 && !locked && lock_acquires == locks + 2 && lock_releases == unlocks + 2);
  fail_data_lines = -1; count = 0; fail_command = 0x2b;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == -EIO);
  assert(count == 2 && !locked && lock_acquires == locks + 3 && lock_releases == unlocks + 3);
  fail_command = -1; count = 0;
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
  assert(events[2].value == 0x2c && !locked);
}

static uintptr_t send_with_different_stack(unsigned depth) {
  volatile uint8_t stack_padding[256];
  memset((void *)stack_padding, 0, sizeof(stack_padding));
  if (depth) return send_with_different_stack(depth - 1) + stack_padding[0];
  uint8_t pixels[8] = {0};
  assert(pixelbox_board_display_write(0, 0, 2, 2, pixels, sizeof(pixels)) == 0);
  return events[count - 1].buffer;
}

static void test_dma_lifetime(void) {
  setup(); count = 0;
  uintptr_t shallow = send_with_different_stack(0);
  uintptr_t deep = send_with_different_stack(4);
  /* 改变调用栈后地址仍固定，保证真正交给DMA的buffer不来自任务栈。 */
  assert(shallow == deep);
}

static void test_power_sequence(void) {
  setup(); count = 0;
  struct fb_vtable_s *fb = &g_fb.vtable;
  assert(fb->setpower(fb, 0) == 0 && fb->getpower(fb) == 0);
  assert(count == 2);
  assert(events[0].kind == 'C' && events[0].value == 0x28);
  assert(events[1].kind == 'C' && events[1].value == 0x10);
  assert(events[0].data_lines == 1 && events[1].data_lines == 1);
  assert(fb->setpower(fb, 0) == 0 && count == 2);
  count = 0;
  assert(fb->setpower(fb, 1) == 0 && fb->getpower(fb) == 1);
  assert(events[0].kind == 'C' && events[0].value == 0x11);
  assert(events[1].kind == 'D' && events[1].value == 600);
  assert(events[2].kind == 'C' && events[2].value == 0x29);
  assert(!locked);
  count = 0; fail_command = 0x28;
  assert(fb->setpower(fb, 0) == -EIO);
  assert(fb->getpower(fb) == 1 && count == 1 && !locked);
}

static void test_brightness(void) {
  assert(pixelbox_board_display_get_brightness() == -ENODEV);
  assert(pixelbox_board_display_set_brightness(50) == -ENODEV);
  setup(); count = 0;
  assert(pixelbox_board_display_get_brightness() == 80);
  const int requested[] = {50, 200, -10, 27};
  const int expected[] = {50, 100, 0, 27};
  const uint8_t levels[] = {127, 255, 0, 68};
  for (size_t i = 0; i < 4; i++) {
    assert(pixelbox_board_display_set_brightness(requested[i]) == 0);
    assert(pixelbox_board_display_get_brightness() == expected[i]);
    assert(events[i].kind == 'C' && events[i].value == 0x51);
    assert(events[i].data_lines == 1 && events[i].length == 1);
    assert(events[i].bytes[0] == levels[i]);
  }
  fail_command = 0x51;
  assert(pixelbox_board_display_set_brightness(60) == -EIO);
  assert(pixelbox_board_display_get_brightness() == 27 && !locked);
  fail_command = -1;
  assert(g_fb.vtable.setpower(&g_fb.vtable, 0) == 0);
  count = 0;
  assert(g_fb.vtable.setpower(&g_fb.vtable, 1) == 0);
  assert(events[3].kind == 'C' && events[3].value == 0x51 && events[3].bytes[0] == 68);
}

static void test_rotation(void) {
  assert(pixelbox_board_display_get_rotation() == -ENODEV);
  assert(pixelbox_board_display_set_rotation(90) == -ENODEV);
  setup(); count = 0;
  uint16_t *pixels = (uint16_t *)g_fb.fbmem;
  const int degrees[] = {0, 90, 180, 270};
  const unsigned x[] = {2, 474, 476, 4};
  const unsigned y[] = {4, 2, 474, 476};
  const uint8_t expected[][8] = {
    {0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0},
    {0x9a,0xbc,0x12,0x34,0xde,0xf0,0x56,0x78},
    {0xde,0xf0,0x9a,0xbc,0x56,0x78,0x12,0x34},
    {0x56,0x78,0xde,0xf0,0x12,0x34,0x9a,0xbc},
  };
  for (size_t i = 0; i < 4; i++) {
    pixels[0] = 0xffff; count = 0;
    assert(pixelbox_board_display_set_rotation(degrees[i]) == 0);
    assert(pixelbox_board_display_get_rotation() == degrees[i] && count == 0);
    assert(pixels[0] == (i == 0 ? 0xffff : 0));
    pixels[4 * 480 + 2] = 0x1234; pixels[4 * 480 + 3] = 0x5678;
    pixels[5 * 480 + 2] = 0x9abc; pixels[5 * 480 + 3] = 0xdef0;
    struct fb_area_s area = {3, 5, 1, 1};
    assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0 && count == 3);
    const uint8_t column[] = {x[i] >> 8, x[i], (x[i] + 1) >> 8, x[i] + 1};
    const uint8_t row[] = {y[i] >> 8, y[i], (y[i] + 1) >> 8, y[i] + 1};
    assert(memcmp(events[0].bytes, column, 4) == 0);
    assert(memcmp(events[1].bytes, row, 4) == 0);
    assert(events[2].length == 8 && memcmp(events[2].bytes, expected[i], 8) == 0);
    assert(pixelbox_board_display_set_rotation(degrees[i]) == 0);
    assert(pixels[4 * 480 + 2] == 0x1234);
  }
  assert(pixelbox_board_display_set_rotation(45) == -EINVAL);
  assert(pixelbox_board_display_get_rotation() == 270 && pixels[4 * 480 + 2] == 0x1234);
}

static void test_rotated_blocks(void) {
  setup();
  uint16_t *pixels = (uint16_t *)g_fb.fbmem;
  uint16_t *expected = malloc(480 * 480 * sizeof(uint16_t));
  assert(expected != NULL);
  const int degrees[] = {0, 90, 180, 270};
  const int x[] = {2, 0, 0, 4}, y[] = {4, 2, 0, 0};
  const int width[] = {478, 476, 478, 476};
  const int height[] = {476, 478, 476, 478};
  struct fb_area_s area = {3, 5, 477, 475};
  for (size_t i = 0; i < 4; i++) {
    assert(pixelbox_board_display_set_rotation(degrees[i]) == 0);
    /* 按逻辑坐标正向旋转生成整幅期望图，独立校验驱动的逆向读取。 */
    for (int sy = 0; sy < 480; sy++) for (int sx = 0; sx < 480; sx++) {
      uint16_t value = (uint16_t)(sx * 19 + sy * 239);
      pixels[sy * 480 + sx] = value;
      int dx = sx, dy = sy;
      if (degrees[i] == 90) { dx = 479 - sy; dy = sx; }
      if (degrees[i] == 180) { dx = 479 - sx; dy = 479 - sy; }
      if (degrees[i] == 270) { dx = sy; dy = 479 - sx; }
      expected[dy * 480 + dx] = value;
    }
    count = 0;
    unsigned locks = lock_acquires, unlocks = lock_releases;
    assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
    assert(lock_acquires == locks + 1 && lock_releases == unlocks + 1 && !locked);
    const uint8_t column[] = {x[i] >> 8, x[i], (x[i] + width[i] - 1) >> 8, x[i] + width[i] - 1};
    const uint8_t row[] = {y[i] >> 8, y[i], (y[i] + height[i] - 1) >> 8, y[i] + height[i] - 1};
    assert(events[0].value == 0x2a && memcmp(events[0].bytes, column, 4) == 0);
    assert(events[1].value == 0x2b && memcmp(events[1].bytes, row, 4) == 0);
    size_t position = 0;
    for (size_t block = 2; block < count; block++) {
      struct event *event = &events[block];
      assert(event->kind == 'M' && event->value == (block == 2 ? 0x2c : 0x3c));
      assert(event->length % (width[i] * 4) == 0 && event->data_lines == 4);
      for (size_t byte = 0; byte < event->length; byte += 2, position++) {
        unsigned dx = x[i] + position % width[i];
        unsigned dy = y[i] + position / width[i];
        uint16_t value = expected[dy * 480 + dx];
        assert(event->bytes[byte] == (value >> 8) && event->bytes[byte + 1] == (uint8_t)value);
      }
    }
    assert(position == (size_t)width[i] * height[i]);
  }
  free(expected);
}

static void test_clipped_edge(void) {
  setup(); count = 0;
  uint16_t *pixels = (uint16_t *)g_fb.fbmem;
  pixels[478 * 480 + 478] = 0x1234; pixels[478 * 480 + 479] = 0x5678;
  pixels[479 * 480 + 478] = 0x9abc; pixels[479 * 480 + 479] = 0xdef0;
  struct fb_area_s area = {479, 479, UINT16_MAX, UINT16_MAX};
  assert(pixelbox_fb_updatearea(&g_fb.vtable, &area) == 0);
  const uint8_t window[] = {1, 0xde, 1, 0xdf};
  const uint8_t expected[] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};
  assert(count == 3 && events[2].length == sizeof(expected));
  assert(memcmp(events[0].bytes, window, 4) == 0);
  assert(memcmp(events[1].bytes, window, 4) == 0);
  assert(memcmp(events[2].bytes, expected, sizeof(expected)) == 0 && !locked);
}

int main(int argc, char **argv) {
  assert(argc == 2);
  if (!strcmp(argv[1], "initialization")) test_initialization();
  else if (!strcmp(argv[1], "full_frame")) test_full_frame();
  else if (!strcmp(argv[1], "dirty_stride")) test_dirty_stride();
  else if (!strcmp(argv[1], "error_propagation")) test_error_propagation();
  else if (!strcmp(argv[1], "continuous_write")) test_continuous_write();
  else if (!strcmp(argv[1], "continuous_write_error")) test_continuous_write_error();
  else if (!strcmp(argv[1], "midstream_retry")) test_midstream_retry();
  else if (!strcmp(argv[1], "begin_failures")) test_begin_failures();
  else if (!strcmp(argv[1], "dma_lifetime")) test_dma_lifetime();
  else if (!strcmp(argv[1], "power_sequence")) test_power_sequence();
  else if (!strcmp(argv[1], "brightness")) test_brightness();
  else if (!strcmp(argv[1], "rotation")) test_rotation();
  else if (!strcmp(argv[1], "rotated_blocks")) test_rotated_blocks();
  else if (!strcmp(argv[1], "clipped_edge")) test_clipped_edge();
  else return 2;
  up_fbuninitialize(0);
  puts("CO5300 transport test passed");
  return 0;
}
"""

NO_SPI_HARNESS = r"""
#include <assert.h>
#include <stdio.h>
#include DRIVER_PATH

int main(void) {
  struct fb_area_s area = {0, 0, 2, 2};
  assert(!pixelbox_board_display_available());
  assert(pixelbox_board_display_initialize() == -ENOTSUP);
  assert(pixelbox_board_display_write(0, 0, 2, 2, NULL, 0) == -ENOTSUP);
  assert(up_fbinitialize(0) == -ENOTSUP);
  assert(pixelbox_fb_updatearea(NULL, &area) == -ENOTSUP);
  assert(pixelbox_fb_setpower(NULL, 1) == -ENOTSUP);
  puts("CO5300 transport test passed");
  return 0;
}
"""


class DisplayTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.deadline = time.monotonic() + 60
        cls.temp = tempfile.TemporaryDirectory(prefix="pixelbox-co5300-")
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        for name, body in HEADERS.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body)
        harness = root / "test.c"
        harness.write_text(HARNESS)
        cls.executables = {}
        sanitizers = os.environ.get("PIXELBOX_TEST_SANITIZERS")
        # 内存检查一旦发现错误就返回失败，避免 UBSan 仅打印警告后假通过。
        extra_flags = ([f"-fsanitize={sanitizers}", "-fno-sanitize-recover=all"]
                       if sanitizers else [])
        for capacity in (2048, 8192):
            executable = root / f"test-{capacity}"
            result = subprocess.run([
                os.environ.get("CC", "cc"), "-std=c11", "-O0", "-g", "-Wall", "-Wextra", "-Werror",
                *extra_flags, f'-DDRIVER_PATH="{DRIVER}"',
                f"-DCONFIG_ESP32S3_SPI_DMA_BUFSIZE={capacity}",
                "-I", str(root), "-I", str(PROJECT / "include"), str(harness), "-o", str(executable),
            ], capture_output=True, text=True, timeout=min(30, cls.deadline - time.monotonic()))
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            cls.executables[capacity] = executable
        no_spi_harness = root / "test-no-spi.c"
        no_spi_harness.write_text(NO_SPI_HARNESS)
        cls.no_spi_executable = root / "test-no-spi"
        result = subprocess.run([
            os.environ.get("CC", "cc"), "-std=c11", "-O0", "-g", "-Wall", "-Wextra", "-Werror",
            *extra_flags, f'-DDRIVER_PATH="{DRIVER}"', "-DPIXELBOX_TEST_NO_SPI2",
            "-I", str(root), "-I", str(PROJECT / "include"), str(no_spi_harness),
            "-o", str(cls.no_spi_executable),
        ], capture_output=True, text=True, timeout=min(30, cls.deadline - time.monotonic()))
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    def check_case(self, case):
        for capacity, executable in self.executables.items():
            with self.subTest(dma_capacity=capacity):
                remaining = self.deadline - time.monotonic()
                self.assertGreater(remaining, 0, "CO5300 回归测试超过 60 秒总预算")
                result = subprocess.run([str(executable), case], capture_output=True, text=True,
                                        timeout=min(10, remaining))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("test passed", result.stdout)

    def test_initialization(self):
        self.check_case("initialization")

    def test_full_frame(self):
        self.check_case("full_frame")

    def test_dirty_stride(self):
        self.check_case("dirty_stride")

    def test_error_propagation(self):
        self.check_case("error_propagation")

    def test_continuous_write(self):
        self.check_case("continuous_write")

    def test_continuous_write_error(self):
        self.check_case("continuous_write_error")

    def test_midstream_retry(self):
        self.check_case("midstream_retry")

    def test_begin_failures(self):
        self.check_case("begin_failures")

    def test_dma_lifetime(self):
        self.check_case("dma_lifetime")

    def test_power_sequence(self):
        self.check_case("power_sequence")

    def test_brightness(self):
        self.check_case("brightness")

    def test_rotation(self):
        self.check_case("rotation")

    def test_rotated_blocks(self):
        self.check_case("rotated_blocks")

    def test_clipped_edge(self):
        self.check_case("clipped_edge")

    def test_no_spi2(self):
        remaining = self.deadline - time.monotonic()
        self.assertGreater(remaining, 0, "CO5300 回归测试超过 60 秒总预算")
        result = subprocess.run([str(self.no_spi_executable)], capture_output=True, text=True,
                                timeout=min(10, remaining))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("test passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
