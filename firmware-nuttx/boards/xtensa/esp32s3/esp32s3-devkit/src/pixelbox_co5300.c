/****************************************************************************
 * CO5300 transport for the Waveshare ESP32-S3-Touch-AMOLED-2.16.
 ****************************************************************************/

#include <nuttx/config.h>

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <syslog.h>

#ifdef CONFIG_VIDEO_FB
#  include <nuttx/kmalloc.h>
#  include <nuttx/video/fb.h>
#endif

#include "pixelbox_board.h"

#define CO5300_WIDTH       480
#define CO5300_HEIGHT      480

#ifdef CONFIG_ESP32S3_SPI2

#include <nuttx/arch.h>
#include <nuttx/spi/qspi.h>

#include "esp32s3_gpio.h"
#include "esp32s3_qspi.h"

#define CO5300_QSPI_FAST_HZ 80000000
#define CO5300_QSPI_SAFE_HZ 40000000
#define CO5300_RESET_PIN   39
#define CO5300_PARAM_OP    0x02
#define CO5300_COLOR_OP    0x32
#define CO5300_RAMWR       0x2c
#define CO5300_RAMWRC      0x3c
/* 20 行 = 19,200 字节，配合 20 KiB QSPI DMA 上限减少长列表滚动的
 * RAMWRC 分块次数，同时给 ESP32-S3 内部堆保留可验证的尾部空间。 */
#define CO5300_BATCH_ROWS  20

struct co5300_init_s
{
  uint8_t command;
  uint8_t length;
  uint16_t delay_ms;
  uint8_t data[4];
};

/* 顺序与仓库内 esp_lcd_co5300 的微雪 2.16 初始化表一致。 */
static const struct co5300_init_s g_init[] =
  {
    {0x11, 0, 600, {0}},
    {0xfe, 1, 0, {0x20}},
    {0x19, 1, 0, {0x10}},
    {0x1c, 1, 0, {0xa0}},
    {0xfe, 1, 0, {0x00}},
    {0xc4, 1, 0, {0x80}},
    {0x3a, 1, 0, {0x55}},
    {0x35, 1, 0, {0x00}},
    {0x53, 1, 0, {0x20}},
    {0x51, 1, 0, {0xff}},
    {0x63, 1, 0, {0xff}},
    {0x2a, 4, 0, {0x00, 0x00, 0x01, 0xdf}},
    {0x2b, 4, 0, {0x00, 0x00, 0x01, 0xdf}},
    {0x36, 1, 0, {0xa0}},
    {0x29, 0, 600, {0}},
  };

static struct qspi_dev_s *g_qspi;
static bool g_ready;
static int g_brightness = 80;
/* 诊断只记录首个有效像素事务，避免刷新频繁时淹没串口。 */
static bool g_first_frame_reported;

/* 静态 BSS 位于内部 DRAM；任务栈可来自 PSRAM，不能直接交给 QSPI DMA。
 * 最多缓存 20 行 RGB565（19200 字节），实际分块还受 DMA 配置上限限制。
 * framebuffer 直接在此打包；总线锁保护缓冲直到同步 DMA 事务完成。
 */
static uint32_t g_dma_pixels[CO5300_WIDTH * CO5300_BATCH_ROWS / 2];

/* QSPI_COMMAND 会按 32 位从 buffer 取数，短参数先复制到四字节缓冲。 */
static int co5300_command(uint8_t command, const uint8_t *data, size_t length)
{
  uint32_t padded = 0;
  struct qspi_cmdinfo_s transfer;
  int ret;

  if (length > sizeof(padded) || (length > 0 && data == NULL))
    {
      return -EINVAL;
    }

  if (length > 0)
    {
      memcpy(&padded, data, length);
    }

  /* CO5300 的 0x02 寄存器事务全程单线；只有 0x32 像素负载用四线。 */
  ret = esp32s3_qspibus_set_attr(g_qspi, 0, 1, 1);
  if (ret < 0)
    {
      syslog(LOG_WARNING,
             "[pixelbox] CO5300 QSPI command attr failed cmd=0x%02x ret=%d\n",
             command, ret);
      return ret;
    }

  memset(&transfer, 0, sizeof(transfer));
  transfer.flags = QSPICMD_ADDRESS |
                   (length > 0 ? QSPICMD_WRITEDATA : 0);
  transfer.cmd = CO5300_PARAM_OP;
  transfer.addrlen = 3;
  transfer.addr = (uint32_t)command << 8;
  transfer.buflen = length;
  transfer.buffer = &padded;
  return QSPI_COMMAND(g_qspi, &transfer);
}

static int co5300_window(int x, int y, int width, int height)
{
  uint8_t column[4] = {x >> 8, x, (x + width - 1) >> 8, x + width - 1};
  uint8_t row[4] = {y >> 8, y, (y + height - 1) >> 8, y + height - 1};
  int ret = co5300_command(0x2a, column, sizeof(column));

  if (ret < 0)
    {
      return ret;
    }

  return co5300_command(0x2b, row, sizeof(row));
}

static int co5300_max_rows(size_t rowbytes)
{
  size_t capacity = sizeof(g_dma_pixels);

#ifdef CONFIG_ESP32S3_SPI_DMA_BUFSIZE
  if (capacity > CONFIG_ESP32S3_SPI_DMA_BUFSIZE)
    {
      capacity = CONFIG_ESP32S3_SPI_DMA_BUFSIZE;
    }
#endif

  return (int)(capacity / rowbytes) & ~1;
}

static int co5300_write_end(int ret)
{
  QSPI_LOCK(g_qspi, false);

  if (!g_first_frame_reported)
    {
      g_first_frame_reported = true;
      if (ret < 0)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] CO5300 first frame transfer failed ret=%d\n", ret);
        }
      else
        {
          syslog(LOG_INFO, "[pixelbox] CO5300 first frame transfer complete\n");
        }
    }

  return ret;
}

static int co5300_prepare_write(int x, int y, int width, int height)
{
  int ret = co5300_window(x, y, width, height);

  if (ret < 0)
    {
      return ret;
    }

  return esp32s3_qspibus_set_attr(g_qspi, 0, 1, 4);
}

/* 一块窗口持有一次总线锁；任何失败都解锁，调用方可保留脏区后重试。 */
static int co5300_write_begin(int x, int y, int width, int height)
{
  bool first_frame = !g_first_frame_reported;
  int ret;

  if (first_frame)
    {
      syslog(LOG_INFO,
             "[pixelbox] CO5300 first frame transfer begin x=%d y=%d w=%d h=%d bytes=%u\n",
             x, y, width, height, (unsigned)width * height * 2);
    }

  ret = QSPI_LOCK(g_qspi, true);
  if (ret < 0)
    {
      if (first_frame)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] CO5300 first frame QSPI lock failed ret=%d\n", ret);
          g_first_frame_reported = true;
        }
      return ret;
    }

  ret = co5300_prepare_write(x, y, width, height);
  if (ret < 0)
    {
      if (first_frame)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] CO5300 first frame window failed ret=%d\n", ret);
        }
      return co5300_write_end(ret);
    }

  return 0;
}

static int co5300_write_pixels(int row, int rows, size_t rowbytes)
{
  struct qspi_meminfo_s transfer;
  int ret;

  /* RAMWRC 从上一个 DMA 分块后的像素继续，不重复设置窗口。 */
  memset(&transfer, 0, sizeof(transfer));
  transfer.flags = QSPIMEM_WRITE;
  transfer.cmd = CO5300_COLOR_OP;
  transfer.addrlen = 3;
  transfer.addr = (row == 0 ? CO5300_RAMWR : CO5300_RAMWRC) << 8;
  transfer.buflen = (size_t)rows * rowbytes;
  transfer.buffer = g_dma_pixels;
  ret = QSPI_MEMORY(g_qspi, &transfer);
  if (ret < 0 && !g_first_frame_reported)
    {
      syslog(LOG_WARNING,
             "[pixelbox] CO5300 first frame pixel transfer failed row=%d rows=%d bytes=%u ret=%d\n",
             row, rows, (unsigned)transfer.buflen, ret);
    }

  return ret;
}

int pixelbox_board_display_set_brightness(int percent)
{
  int ret;
  uint8_t level;

  if (!g_ready)
    {
      return -ENODEV;
    }

  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  level = (uint8_t)((percent * 255) / 100);
  ret = QSPI_LOCK(g_qspi, true);
  if (ret < 0)
    {
      return ret;
    }

  ret = co5300_command(0x51, &level, sizeof(level));
  if (ret >= 0)
    {
      /* 只有面板命令发送成功才提交状态，失败时 getter 仍返回原亮度。 */
      g_brightness = percent;
    }

  QSPI_LOCK(g_qspi, false);
  return ret;
}

int pixelbox_board_display_get_brightness(void)
{
  return g_ready ? g_brightness : -ENODEV;
}

bool pixelbox_board_display_available(void)
{
  return g_ready;
}

int pixelbox_board_display_initialize(void)
{
  int ret;

  if (g_ready)
    {
      return 0;
    }

  g_qspi = esp32s3_qspibus_initialize(ESP32S3_SPI2);
  if (g_qspi == NULL)
    {
      syslog(LOG_WARNING, "[pixelbox] CO5300 QSPI2 initialize failed ret=%d\n",
             -ENODEV);
      return -ENODEV;
    }

  syslog(LOG_INFO, "[pixelbox] CO5300 QSPI2 device found cs=12 clk=38 d0-d3=4/5/6/7\n");

  syslog(LOG_INFO, "[pixelbox] CO5300 QSPI2 requested fast hz=%u safe hz=%u\n",
         CO5300_QSPI_FAST_HZ, CO5300_QSPI_SAFE_HZ);

  ret = QSPI_LOCK(g_qspi, true);
  if (ret < 0)
    {
      syslog(LOG_WARNING, "[pixelbox] CO5300 QSPI lock failed ret=%d\n", ret);
      return ret;
    }

  QSPI_SETMODE(g_qspi, QSPIDEV_MODE0);
  QSPI_SETBITS(g_qspi, 8);
  uint32_t actual_hz = QSPI_SETFREQUENCY(g_qspi, CO5300_QSPI_FAST_HZ);
  if (actual_hz == 0)
    {
      syslog(LOG_WARNING,
             "[pixelbox] CO5300 fast QSPI frequency setup failed; trying safe hz=%u\n",
             CO5300_QSPI_SAFE_HZ);
      actual_hz = QSPI_SETFREQUENCY(g_qspi, CO5300_QSPI_SAFE_HZ);
      if (actual_hz == 0)
        {
          ret = -EIO;
          syslog(LOG_WARNING,
                 "[pixelbox] CO5300 safe QSPI frequency setup failed ret=%d\n",
                 ret);
          goto out;
        }
    }

  if (actual_hz < CO5300_QSPI_SAFE_HZ)
    {
      syslog(LOG_WARNING,
             "[pixelbox] CO5300 QSPI controller returned low hz=%u; trying safe hz=%u\n",
             actual_hz, CO5300_QSPI_SAFE_HZ);
      actual_hz = QSPI_SETFREQUENCY(g_qspi, CO5300_QSPI_SAFE_HZ);
      if (actual_hz == 0)
        {
          ret = -EIO;
          goto out;
        }
    }

  syslog(LOG_INFO, "[pixelbox] CO5300 QSPI2 configured hz=%u mode=0 bits=8\n",
         actual_hz);

  /* framebuffer 在 board_late_initialize 阶段注册，复位必须归显示驱动
   * 所有，避免应用入口再次复位后 g_ready 仍为 true 而跳过面板初始化。
   */
  ret = esp32s3_configgpio(CO5300_RESET_PIN, OUTPUT);
  if (ret < 0)
    {
      syslog(LOG_WARNING, "[pixelbox] CO5300 reset GPIO setup failed ret=%d\n",
             ret);
      goto out;
    }

  esp32s3_gpiowrite(CO5300_RESET_PIN, false);
  up_mdelay(10);
  esp32s3_gpiowrite(CO5300_RESET_PIN, true);
  up_mdelay(150);

  for (size_t index = 0; index < sizeof(g_init) / sizeof(g_init[0]); index++)
    {
      const struct co5300_init_s *entry = &g_init[index];
      ret = co5300_command(entry->command, entry->data, entry->length);
      if (ret < 0)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] CO5300 init command index=%u cmd=0x%02x len=%u failed ret=%d\n",
                 (unsigned)index, entry->command, entry->length, ret);
          goto out;
        }

      if (entry->delay_ms > 0)
        {
          up_mdelay(entry->delay_ms);
        }
    }

  /* 原 ESP-IDF 在完整面板初始化后把默认亮度设为 80%。 */
  uint8_t level = (uint8_t)((g_brightness * 255) / 100);
  ret = co5300_command(0x51, &level, sizeof(level));
  if (ret >= 0)
    {
      g_ready = true;
      syslog(LOG_INFO,
             "[pixelbox] CO5300 initialized 480x480 RGB565 qspi=quad brightness=%d\n",
             g_brightness);
    }
  else
    {
      syslog(LOG_WARNING,
             "[pixelbox] CO5300 brightness command failed ret=%d\n", ret);
    }

out:
  QSPI_LOCK(g_qspi, false);
  return ret;
}

int pixelbox_board_display_write(int x, int y, int width, int height,
                                 const uint8_t *pixels, size_t length)
{
  size_t rowbytes;
  int max_rows;
  int row;
  int ret;

  if (!g_ready)
    {
      return -ENODEV;
    }

  /* CO5300 窗口坐标要求二像素对齐；每个 DMA 分块也保持偶数行。 */
  if (pixels == NULL || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      width > CO5300_WIDTH || height > CO5300_HEIGHT ||
      x > CO5300_WIDTH - width || y > CO5300_HEIGHT - height ||
      ((x | y | width | height) & 1) != 0 ||
      length != (size_t)width * height * 2)
    {
      return -EINVAL;
    }

  rowbytes = (size_t)width * 2;
  max_rows = co5300_max_rows(rowbytes);
  if (max_rows < 2)
    {
      return -EINVAL;
    }

  ret = co5300_write_begin(x, y, width, height);
  if (ret < 0)
    {
      return ret;
    }

  for (row = 0; row < height; )
    {
      int chunk_rows = height - row;
      if (chunk_rows > max_rows)
        {
          chunk_rows = max_rows;
        }

      /* 调用方像素可能位于 PSRAM 或栈，复制到内部 DRAM 后再启动 DMA。 */
      memcpy(g_dma_pixels, pixels + (size_t)row * rowbytes,
             (size_t)chunk_rows * rowbytes);
      ret = co5300_write_pixels(row, chunk_rows, rowbytes);
      if (ret < 0)
        {
          /* 失败时立即向上返回，避免重复发送已部分写入的窗口。
           * framebuffer 保留脏标记，由上层在确认链路状态后重试。 */
          break;
        }

      row += chunk_rows;
    }

  return co5300_write_end(ret);
}

#else

bool pixelbox_board_display_available(void) { return false; }
int pixelbox_board_display_initialize(void) { return -ENOTSUP; }
int pixelbox_board_display_set_brightness(int percent)
{
  (void)percent;
  return -ENOTSUP;
}
int pixelbox_board_display_get_brightness(void) { return -ENOTSUP; }
int pixelbox_board_display_write(int x, int y, int width, int height,
                                 const uint8_t *pixels, size_t length)
{
  (void)x;
  (void)y;
  (void)width;
  (void)height;
  (void)pixels;
  (void)length;
  return -ENOTSUP;
}

#endif

#ifdef CONFIG_VIDEO_FB

#define PIXELBOX_FB_BPP       2
#define PIXELBOX_FB_STRIDE    (CO5300_WIDTH * PIXELBOX_FB_BPP)
#define PIXELBOX_FB_SIZE      (PIXELBOX_FB_STRIDE * CO5300_HEIGHT)

/*
 * CO5300 没有独立的 NuttX LCD lower-half。这里提供 framebuffer lower-half：
 * 应用写入 fbmem 后通过 FBIO_UPDATE 把脏矩形复制到 QSPI 屏幕。
 */
struct pixelbox_fb_s
{
  struct fb_vtable_s vtable;
  FAR uint8_t *fbmem;
  int power;
  int rotation;
  bool initialized;
};

static struct pixelbox_fb_s g_fb;
#ifdef CONFIG_FB_UPDATE
/* FBIO_UPDATE 只报告第一次调用及其结果；后续刷新不打印日志。 */
static bool g_first_fb_update_reported;
static int pixelbox_fb_updatearea(FAR struct fb_vtable_s *vtable,
                                  FAR const struct fb_area_s *area);
#endif

int pixelbox_board_display_set_rotation(int degrees)
{
  if (!g_fb.initialized)
    {
      return -ENODEV;
    }

  if (degrees != 0 && degrees != 90 && degrees != 180 && degrees != 270)
    {
      return -EINVAL;
    }

  if (degrees != g_fb.rotation)
    {
      /* 与原 ESP-IDF 一致：旋转修改逻辑画布，不改面板 MADCTL 和触摸坐标。
       * 2.16 面板为正方形，四个方向都保持 480×480；下次 flush 才提交。
       */
      g_fb.rotation = degrees;
      memset(g_fb.fbmem, 0, PIXELBOX_FB_SIZE);
    }

  return 0;
}

int pixelbox_board_display_get_rotation(void)
{
  return g_fb.initialized ? g_fb.rotation : -ENODEV;
}

static int pixelbox_fb_getvideoinfo(FAR struct fb_vtable_s *vtable,
                                    FAR struct fb_videoinfo_s *vinfo)
{
  (void)vtable;

  if (vinfo == NULL)
    {
      return -EINVAL;
    }

  memset(vinfo, 0, sizeof(*vinfo));
  vinfo->fmt = FB_FMT_RGB16_565;
  vinfo->xres = CO5300_WIDTH;
  vinfo->yres = CO5300_HEIGHT;
  vinfo->nplanes = 1;
  return 0;
}

static int pixelbox_fb_getplaneinfo(FAR struct fb_vtable_s *vtable,
                                    int planeno,
                                    FAR struct fb_planeinfo_s *pinfo)
{
  (void)vtable;

  if (planeno != 0 || pinfo == NULL || !g_fb.initialized)
    {
      return -EINVAL;
    }

  memset(pinfo, 0, sizeof(*pinfo));
  pinfo->fbmem = g_fb.fbmem;
  pinfo->fblen = PIXELBOX_FB_SIZE;
  pinfo->stride = PIXELBOX_FB_STRIDE;
  pinfo->display = 0;
  pinfo->bpp = 16;
  pinfo->xres_virtual = CO5300_WIDTH;
  pinfo->yres_virtual = CO5300_HEIGHT;
  return 0;
}

static int pixelbox_fb_open(FAR struct fb_vtable_s *vtable)
{
  (void)vtable;
  return 0;
}

static int pixelbox_fb_close(FAR struct fb_vtable_s *vtable)
{
  (void)vtable;
  return 0;
}

#ifdef CONFIG_FB_UPDATE
static int pixelbox_fb_updatearea(FAR struct fb_vtable_s *vtable,
                                   FAR const struct fb_area_s *area)
{
#ifndef CONFIG_ESP32S3_SPI2
  (void)vtable;
  (void)area;
  return -ENOTSUP;
#else
  int x0;
  int y0;
  int x1;
  int y1;
  int width;
  int max_rows;
  int ret;
  size_t rowbytes;
  int rotation = g_fb.rotation;
  bool first_update = !g_first_fb_update_reported;

  (void)vtable;

  if (first_update && area != NULL)
    {
      syslog(LOG_INFO,
             "[pixelbox] FBIO_UPDATE first request x=%u y=%u w=%u h=%u rotation=%d\n",
             area->x, area->y, area->w, area->h, rotation);
    }

  if (area == NULL || !g_fb.initialized || g_fb.fbmem == NULL)
    {
      if (first_update)
        {
          syslog(LOG_WARNING, "[pixelbox] FBIO_UPDATE first request rejected ret=%d\n",
                 -EINVAL);
          g_first_fb_update_reported = true;
        }
      return -EINVAL;
    }

  if (area->w == 0 || area->h == 0 || area->x >= CO5300_WIDTH ||
      area->y >= CO5300_HEIGHT)
    {
      if (first_update)
        {
          syslog(LOG_WARNING, "[pixelbox] FBIO_UPDATE first request rejected ret=%d\n",
                 -EINVAL);
          g_first_fb_update_reported = true;
        }
      return -EINVAL;
    }

  /* CO5300 窗口和像素流都必须从偶数坐标、偶数尺寸开始。 */
  x0 = area->x & ~1;
  y0 = area->y & ~1;
  x1 = area->x + area->w;
  y1 = area->y + area->h;
  if (x1 > CO5300_WIDTH)
    {
      x1 = CO5300_WIDTH;
    }

  if (y1 > CO5300_HEIGHT)
    {
      y1 = CO5300_HEIGHT;
    }

  x1 = (x1 + 1) & ~1;
  y1 = (y1 + 1) & ~1;
  if (x1 > CO5300_WIDTH)
    {
      x1 = CO5300_WIDTH;
    }

  if (y1 > CO5300_HEIGHT)
    {
      y1 = CO5300_HEIGHT;
    }

  /* FBIO_UPDATE 接收逻辑脏区，先映射到物理窗口，继续保持偶数对齐。 */
  int logical_x0 = x0;
  int logical_y0 = y0;
  int logical_x1 = x1;
  int logical_y1 = y1;
  switch (rotation)
    {
      case 90:
        x0 = CO5300_WIDTH - logical_y1;
        x1 = CO5300_WIDTH - logical_y0;
        y0 = logical_x0;
        y1 = logical_x1;
        break;
      case 180:
        x0 = CO5300_WIDTH - logical_x1;
        x1 = CO5300_WIDTH - logical_x0;
        y0 = CO5300_HEIGHT - logical_y1;
        y1 = CO5300_HEIGHT - logical_y0;
        break;
      case 270:
        x0 = logical_y0;
        x1 = logical_y1;
        y0 = CO5300_HEIGHT - logical_x1;
        y1 = CO5300_HEIGHT - logical_x0;
        break;
      default:
        break;
    }

  width = x1 - x0;
  if (width <= 0 || (width & 1) != 0 || y1 <= y0 || ((y1 - y0) & 1) != 0)
    {
      if (first_update)
        {
          syslog(LOG_WARNING, "[pixelbox] FBIO_UPDATE first window rejected ret=%d\n",
                 -EINVAL);
          g_first_fb_update_reported = true;
        }
      return -EINVAL;
    }

  if (!g_ready)
    {
      return -ENODEV;
    }

  rowbytes = (size_t)width * PIXELBOX_FB_BPP;
  max_rows = co5300_max_rows(rowbytes);
  if (max_rows < 2)
    {
      return -EINVAL;
    }

  ret = co5300_write_begin(x0, y0, width, y1 - y0);
  if (ret < 0)
    {
      goto out;
    }

  /* 整块脏区共用一个窗口，RGB565 直接打包到 DMA 缓冲，省去中间副本。 */
  for (int row = y0; row < y1; )
    {
      int batch_rows = y1 - row;
      if (batch_rows > max_rows)
        {
          batch_rows = max_rows;
        }

      /* framebuffer 保留原生 RGB565；只在传输副本中转为高字节先发。
       * rotation=0 是默认热路径，直接按行读取，避免每像素坐标计算和 switch。 */
      if (rotation == 0)
        {
          for (int line = 0; line < batch_rows; line++)
            {
              uint32_t *destination = g_dma_pixels +
                                      (size_t)line * rowbytes / sizeof(uint32_t);
              FAR const uint16_t *source = (FAR const uint16_t *)(
                g_fb.fbmem + (size_t)(row + line) * PIXELBOX_FB_STRIDE +
                (size_t)x0 * sizeof(uint16_t));
              FAR const uint16_t *aligned_source =
                __builtin_assume_aligned(source, 4);
              /* 窗口和行宽已保证偶数，成对交换每个565的高低字节。
               * memcpy保持别名规则；按四字节加载/写入减少PSRAM访问次数。 */
              for (int pixel = 0; pixel < width; pixel += 2)
                {
                  uint32_t pair;
                  memcpy(&pair, aligned_source + pixel, sizeof(pair));
                  /* XOR交换避免目标编译器生成每对像素一次的软件bswap调用。 */
                  uint32_t difference = (pair ^ (pair >> 8)) & UINT32_C(0x00ff00ff);
                  pair ^= difference ^ (difference << 8);
                  destination[pixel / 2] = pair;
                }
            }
        }
      else
        {
          FAR const uint16_t *source =
            (FAR const uint16_t *)g_fb.fbmem;
          for (int line = 0; line < batch_rows; line++)
            {
              uint8_t *destination = (uint8_t *)g_dma_pixels +
                                     (size_t)line * rowbytes;
              int physical_y = row + line;
              ptrdiff_t source_offset;
              int source_step;

              /* 每行只定位一次源像素；横向扫描的步长由旋转角度确定。 */
              switch (rotation)
                {
                  case 90:
                    source_offset = (ptrdiff_t)(CO5300_WIDTH - 1 - x0) *
                                    CO5300_WIDTH + physical_y;
                    source_step = -CO5300_WIDTH;
                    break;
                  case 180:
                    source_offset = (ptrdiff_t)(CO5300_HEIGHT - 1 - physical_y) *
                                    CO5300_WIDTH + CO5300_WIDTH - 1 - x0;
                    source_step = -1;
                    break;
                  default: /* 270 度 */
                    source_offset = (ptrdiff_t)x0 * CO5300_WIDTH +
                                    CO5300_HEIGHT - 1 - physical_y;
                    source_step = CO5300_WIDTH;
                    break;
                }

              for (int pixel = 0; pixel < width; pixel++)
                {
                  uint16_t value = source[source_offset];
                  destination[pixel * 2] = value >> 8;
                  destination[pixel * 2 + 1] = value;
                  source_offset += source_step;
                }
            }
        }

      ret = co5300_write_pixels(row - y0, batch_rows, rowbytes);
      if (ret < 0)
        {
          break;
        }
      row += batch_rows;
    }

  ret = co5300_write_end(ret);

out:
  if (first_update)
    {
      if (ret < 0)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] FBIO_UPDATE first transfer failed ret=%d\n", ret);
        }
      else
        {
          syslog(LOG_INFO,
                 "[pixelbox] FBIO_UPDATE first transfer complete physical x=%d y=%d w=%d h=%d\n",
                 x0, y0, width, y1 - y0);
        }
      g_first_fb_update_reported = true;
    }

  return ret;
#endif
}
#endif

static int pixelbox_fb_pandisplay(FAR struct fb_vtable_s *vtable,
                                  FAR struct fb_planeinfo_s *pinfo)
{
  (void)vtable;
  (void)pinfo;
  /* 单 framebuffer、无硬件滚屏；内容由 FBIO_UPDATE 显式提交。 */
  return 0;
}

static int pixelbox_fb_setframerate(FAR struct fb_vtable_s *vtable, int rate)
{
  (void)vtable;
  (void)rate;
  return 0;
}

static int pixelbox_fb_getframerate(FAR struct fb_vtable_s *vtable)
{
  (void)vtable;
  return 0;
}

static int pixelbox_fb_getpower(FAR struct fb_vtable_s *vtable)
{
  (void)vtable;
  return g_fb.power;
}

static int pixelbox_fb_setpower(FAR struct fb_vtable_s *vtable, int power)
{
  (void)vtable;
#ifdef CONFIG_ESP32S3_SPI2
  int requested = power > 0 ? power : 0;
  int ret;

  if (!g_fb.initialized || !g_ready)
    {
      return -ENODEV;
    }

  if ((requested > 0) == (g_fb.power > 0))
    {
      g_fb.power = requested;
      return 0;
    }

  ret = QSPI_LOCK(g_qspi, true);
  if (ret < 0)
    {
      return ret;
    }

  /* 与 ESP-IDF 保持相同的睡眠协议；唤醒后必须等 600ms 再打开画面。 */
  if (requested > 0)
    {
      ret = co5300_command(0x11, NULL, 0);
      if (ret >= 0)
        {
          up_mdelay(600);
          ret = co5300_command(0x29, NULL, 0);
          if (ret >= 0)
            {
              uint8_t level = (uint8_t)((g_brightness * 255) / 100);
              ret = co5300_command(0x51, &level, sizeof(level));
            }
        }
    }
  else
    {
      ret = co5300_command(0x28, NULL, 0);
      if (ret >= 0)
        {
          ret = co5300_command(0x10, NULL, 0);
        }
    }

  QSPI_LOCK(g_qspi, false);
  if (ret < 0)
    {
      return ret;
    }

  g_fb.power = requested;
#ifdef CONFIG_FB_UPDATE
  if (requested > 0)
    {
      /* 恢复后提交保留的整帧，避免应用停帧时一直保留休眠前的黑画面。 */
      struct fb_area_s area = {0, 0, CO5300_WIDTH, CO5300_HEIGHT};
      return pixelbox_fb_updatearea(vtable, &area);
    }
#endif
  return ret;
#else
  (void)power;
  return -ENOTSUP;
#endif
}

static int pixelbox_fb_ioctl(FAR struct fb_vtable_s *vtable, int cmd,
                             unsigned long arg)
{
  (void)vtable;
  (void)cmd;
  (void)arg;
  return -ENOTTY;
}

int up_fbinitialize(int display)
{
  int ret;

  if (display != 0)
    {
      return -EINVAL;
    }

  if (g_fb.initialized)
    {
      return 0;
    }

  /* 允许测试或运行时重新注册 framebuffer 时重新获取首帧诊断。 */
#ifdef CONFIG_ESP32S3_SPI2
  g_first_frame_reported = false;
#endif
#ifdef CONFIG_FB_UPDATE
  g_first_fb_update_reported = false;
#endif

  ret = pixelbox_board_display_initialize();
  if (ret < 0)
    {
      return ret;
    }

  g_fb.fbmem = kmm_zalloc(PIXELBOX_FB_SIZE);
  if (g_fb.fbmem == NULL)
    {
      return -ENOMEM;
    }

  memset(&g_fb.vtable, 0, sizeof(g_fb.vtable));
  g_fb.vtable.getvideoinfo = pixelbox_fb_getvideoinfo;
  g_fb.vtable.getplaneinfo = pixelbox_fb_getplaneinfo;
  g_fb.vtable.open = pixelbox_fb_open;
  g_fb.vtable.close = pixelbox_fb_close;
#ifdef CONFIG_FB_UPDATE
  g_fb.vtable.updatearea = pixelbox_fb_updatearea;
#endif
  g_fb.vtable.pandisplay = pixelbox_fb_pandisplay;
  g_fb.vtable.setframerate = pixelbox_fb_setframerate;
  g_fb.vtable.getframerate = pixelbox_fb_getframerate;
  g_fb.vtable.getpower = pixelbox_fb_getpower;
  g_fb.vtable.setpower = pixelbox_fb_setpower;
  g_fb.vtable.ioctl = pixelbox_fb_ioctl;
  g_fb.vtable.priv = &g_fb;
  g_fb.power = 1;
  g_fb.initialized = true;
  syslog(LOG_INFO, "[pixelbox] framebuffer lower-half ready device geometry=480x480 stride=%u\n",
         (unsigned)PIXELBOX_FB_STRIDE);
  return 0;
}

FAR struct fb_vtable_s *up_fbgetvplane(int display, int vplane)
{
  if (display != 0 || vplane != 0 || !g_fb.initialized)
    {
      return NULL;
    }

  return &g_fb.vtable;
}

void up_fbuninitialize(int display)
{
  if (display != 0)
    {
      return;
    }

  if (g_fb.fbmem != NULL)
    {
      kmm_free(g_fb.fbmem);
    }

  memset(&g_fb, 0, sizeof(g_fb));
}

#else

int pixelbox_board_display_set_rotation(int degrees)
{
  (void)degrees;
  return -ENOTSUP;
}

int pixelbox_board_display_get_rotation(void) { return -ENOTSUP; }

#endif /* CONFIG_VIDEO_FB */
