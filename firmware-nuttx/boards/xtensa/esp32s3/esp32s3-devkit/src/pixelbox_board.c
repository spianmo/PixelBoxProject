/****************************************************************************
 * PixelBox board support for the Micro-雪 2.16 ESP32-S3 box.
 *
 * Board reset, I2C probes, and supported NuttX audio registration.
 ****************************************************************************/

#include <nuttx/config.h>

#include <errno.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>
#include <syslog.h>

#include <nuttx/arch.h>
#include <nuttx/i2c/i2c_master.h>
#include <nuttx/kthread.h>
#if defined(CONFIG_ESP32S3_I2S0) && defined(CONFIG_AUDIO_ES8311)
#  include <nuttx/audio/audio.h>
#  include <nuttx/audio/es8311.h>
#  include <nuttx/audio/i2s.h>
#  include <nuttx/audio/pcm.h>
#endif

#include "esp32s3_gpio.h"
#include "esp32s3_i2c.h"
#include "pixelbox_board.h"

#if defined(CONFIG_ESP32S3_I2S0) && defined(CONFIG_AUDIO_ES8311)
#  include "esp32s3_i2s.h"
#endif

#define PIXELBOX_I2C_FREQUENCY 400000

#define PIXELBOX_CO5300_RST    39
#define PIXELBOX_CST9220_INT   11
#define PIXELBOX_CST9220_RST   40
#define PIXELBOX_QMI8658_INT1  17
#define PIXELBOX_QMI8658_INT2  21
#define PIXELBOX_AMP_ENABLE    46

#define PIXELBOX_QMI8658_ADDR  0x6b
#define PIXELBOX_CST9220_ADDR  0x5a
#define PIXELBOX_ES8311_ADDR   0x18
#define PIXELBOX_ES7210_ADDR   0x40

#define PIXELBOX_QMI8658_WHO_AM_I 0x00
#define PIXELBOX_QMI8658_CTRL1    0x02
#define PIXELBOX_QMI8658_CTRL2    0x03
#define PIXELBOX_QMI8658_CTRL3    0x04
#define PIXELBOX_QMI8658_CTRL5    0x06
#define PIXELBOX_QMI8658_CTRL7    0x08
#define PIXELBOX_QMI8658_RESET    0x60
#define PIXELBOX_QMI8658_DATA     0x35

#define PIXELBOX_QMI8658_ACC_LSB_PER_G  4096.0f
#define PIXELBOX_QMI8658_GYR_LSB_PER_DPS 64.0f

static struct i2c_master_s *g_i2c;
static bool g_imu_ready;
static bool g_touch_ready;
static bool g_touch_down;
static uint16_t g_touch_x;
static uint16_t g_touch_y;
static bool g_mic_ready;
/* initialize() 在启动任务中运行，探测在 px-board-io 中运行；原子状态避免
 * serve_app 看到半写入的 ready 标志而提前创建 JS 应用。 */
static atomic_int g_io_status = ATOMIC_VAR_INIT(0);

#if defined(CONFIG_ESP32S3_I2S0) && defined(CONFIG_AUDIO_ES8311)
/* 播放和录音复用同一 I2S0；重复 initialize 会重建 DMA 队列。 */
static struct i2s_dev_s *g_i2s;
#endif

#if defined(CONFIG_ESP32S3_I2S0) && defined(CONFIG_AUDIO_ES8311)
static const struct es8311_lower_s g_es8311_lower =
  {
    .frequency = PIXELBOX_I2C_FREQUENCY,
    .address = PIXELBOX_ES8311_ADDR,
  };

static int pixelbox_es8311_register(struct i2c_master_s *i2c)
{
  struct audio_lowerhalf_s *codec;
  struct audio_lowerhalf_s *pcm;
  struct i2s_dev_s *i2s;

  if (g_i2s == NULL)
    {
      g_i2s = esp32s3_i2sbus_initialize(ESP32S3_I2S0);
    }
  i2s = g_i2s;
  if (i2s == NULL)
    {
      return -ENODEV;
    }

  codec = es8311_initialize(i2c, i2s, &g_es8311_lower);
  if (codec == NULL)
    {
      return -ENODEV;
    }

  pcm = pcm_decode_initialize(codec);
  if (pcm == NULL)
    {
      return -ENODEV;
    }

  /* ES7210 负责录音；这里只注册有硬件支撑的 ES8311 播放设备。 */
  return audio_register("pcm0", pcm);
}
#endif

static int pixelbox_i2c_read(struct i2c_master_s *bus,
                             uint16_t address,
                             const uint8_t *reg,
                             size_t reglen,
                             uint8_t *data,
                             size_t datalen)
{
  struct i2c_msg_s messages[2] =
    {
      {
        .frequency = PIXELBOX_I2C_FREQUENCY,
        .addr      = address,
        .flags     = 0,
        .buffer    = (uint8_t *)reg,
        .length    = reglen,
      },
      {
        .frequency = PIXELBOX_I2C_FREQUENCY,
        .addr      = address,
        .flags     = I2C_M_READ,
        .buffer    = data,
        .length    = datalen,
      }
    };

  return I2C_TRANSFER(bus, messages, 2);
}

static int pixelbox_i2c_write8(struct i2c_master_s *bus, uint16_t address,
                               uint8_t reg, uint8_t value)
{
  uint8_t bytes[2] = {reg, value};
  struct i2c_msg_s message =
    {
      .frequency = PIXELBOX_I2C_FREQUENCY,
      .addr      = address,
      .flags     = 0,
      .buffer    = bytes,
      .length    = sizeof(bytes),
    };

  return I2C_TRANSFER(bus, &message, 1);
}

#if defined(CONFIG_ESP32S3_I2S0_RX) && defined(CONFIG_AUDIO_ES8311) && \
    defined(ESP32S3_I2S_CAPTURE_START)
static int pixelbox_es7210_write(uint8_t reg, uint8_t value)
{
  int result = pixelbox_i2c_write8(g_i2c, PIXELBOX_ES7210_ADDR, reg, value);
  return result < 0 ? result : 0;
}

bool pixelbox_board_mic_available(void)
{
  return g_mic_ready && g_i2c != NULL && g_i2s != NULL;
}

int pixelbox_board_mic_set_gain(int percent)
{
  if (!pixelbox_board_mic_available()) return -ENODEV;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  /* 沿用 ESP-IDF 的 percent * 0.42 dB 与 es7210 get_db 量化规则。 */
  unsigned db100 = (unsigned)percent * 42 + 50;
  uint8_t gain = db100 < 3300 ? db100 / 300 :
                 db100 < 3450 ? 10 : db100 < 3600 ? 12 :
                 db100 < 3700 ? 13 : 14;
  int result = pixelbox_es7210_write(0x43, 0x10 | gain);
  if (result < 0) return result;
  return pixelbox_es7210_write(0x44, 0x10 | gain);
}

void pixelbox_board_mic_cancel(void)
{
  if (g_i2s != NULL) I2S_IOCTL(g_i2s, ESP32S3_I2S_CAPTURE_STOP, 0);
}

void pixelbox_board_mic_powerdown(void)
{
  pixelbox_board_mic_cancel();
  if (g_i2c == NULL || !g_mic_ready) return;
  static const uint8_t shutdown[][2] = {
    {0x47, 0xff}, {0x48, 0xff}, {0x49, 0xff}, {0x4a, 0xff},
    {0x4b, 0xff}, {0x4c, 0xff}, {0x40, 0xc0}, {0x01, 0x7f}, {0x06, 0x07}
  };
  for (unsigned i = 0; i < sizeof(shutdown) / sizeof(shutdown[0]); ++i)
    {
      int result = pixelbox_es7210_write(shutdown[i][0], shutdown[i][1]);
      if (result < 0)
        syslog(LOG_WARNING, "[pixelbox] ES7210 shutdown reg=0x%02x error=%d\n",
               shutdown[i][0], result);
    }
}

int pixelbox_board_mic_prepare(unsigned rate, int gain, struct i2s_dev_s **out)
{
  if (out == NULL || rate != 16000) return -EINVAL;
  *out = NULL;
  if (!pixelbox_board_mic_available()) return -ENODEV;
  /* ES7210 为 slave；双工时 BCLK/WS 来自 TX，物理采样率固定 16k。 */
  int result = (int32_t)I2S_TXDATAWIDTH(g_i2s, 16);
  if (result <= 0) return result < 0 ? result : -EIO;
  result = (int32_t)I2S_RXDATAWIDTH(g_i2s, 16);
  if (result <= 0) return result < 0 ? result : -EIO;
  result = I2S_TXCHANNELS(g_i2s, 2);
  if (result < 0) return result;
  result = I2S_RXCHANNELS(g_i2s, 2);
  if (result < 0) return result;
  result = (int32_t)I2S_SETMCLKFREQUENCY(g_i2s, rate * 256);
  if (result <= 0) return result < 0 ? result : -EIO;
  result = (int32_t)I2S_TXSAMPLERATE(g_i2s, rate);
  if (result <= 0) return result < 0 ? result : -EIO;
  result = (int32_t)I2S_RXSAMPLERATE(g_i2s, rate);
  if (result <= 0) return result < 0 ? result : -EIO;

  /* 寄存器序列来自项目内 Apache-2.0 的 esp_codec_dev ES7210 驱动。 */
  static const uint8_t initialize[][2] = {
    {0x00, 0xff}, {0x00, 0x41}, {0x01, 0x3f}, {0x09, 0x30}, {0x0a, 0x30},
    {0x23, 0x2a}, {0x22, 0x0a}, {0x20, 0x0a}, {0x21, 0x2a}, {0x08, 0x00},
    {0x40, 0x43}, {0x41, 0x70}, {0x42, 0x70}, {0x07, 0x20}, {0x02, 0xc1},
    {0x11, 0x60}, {0x12, 0x00}, {0x06, 0x00}, {0x47, 0x08}, {0x48, 0x08},
    {0x49, 0xff}, {0x4a, 0xff}, {0x4b, 0x00}, {0x4c, 0xff},
    {0x45, 0x00}, {0x46, 0x00}, {0x01, 0x34}, {0x14, 0x00}, {0x15, 0x00}
  };
  for (unsigned i = 0; i < sizeof(initialize) / sizeof(initialize[0]); ++i)
    {
      result = pixelbox_es7210_write(initialize[i][0], initialize[i][1]);
      if (result < 0) goto fail;
    }
  result = pixelbox_board_mic_set_gain(gain);
  if (result < 0) goto fail;
  result = pixelbox_es7210_write(0x00, 0x71);
  if (result < 0) goto fail;
  result = pixelbox_es7210_write(0x00, 0x41);
  if (result < 0) goto fail;
  result = I2S_IOCTL(g_i2s, ESP32S3_I2S_CAPTURE_START, 0);
  if (result < 0) goto fail;
  *out = g_i2s;
  return 0;
fail:
  pixelbox_board_mic_powerdown();
  return result;
}
#else
bool pixelbox_board_mic_available(void) { return false; }
int pixelbox_board_mic_prepare(unsigned rate, int gain, struct i2s_dev_s **out)
{
  (void)rate; (void)gain; if (out != NULL) *out = NULL; return -ENOTSUP;
}
int pixelbox_board_mic_set_gain(int gain) { (void)gain; return -ENOTSUP; }
void pixelbox_board_mic_cancel(void) {}
void pixelbox_board_mic_powerdown(void) {}
#endif

static int pixelbox_qmi8658_configure(struct i2c_master_s *bus)
{
  int ret;

  /* 与 ESP-IDF 实现保持一致：自增、小端、±8g、±512dps、低通、双轴使能。 */
  ret = pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                            PIXELBOX_QMI8658_RESET, 0xb0);
  if (ret < 0)
    {
      return ret;
    }

  up_mdelay(15);

  ret = pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                            PIXELBOX_QMI8658_CTRL1, 0x40);
  if (ret < 0) return ret;
  ret = pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                            PIXELBOX_QMI8658_CTRL2, 0x27);
  if (ret < 0) return ret;
  ret = pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                            PIXELBOX_QMI8658_CTRL3, 0x54);
  if (ret < 0) return ret;
  ret = pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                            PIXELBOX_QMI8658_CTRL5, 0x11);
  if (ret < 0) return ret;
  return pixelbox_i2c_write8(bus, PIXELBOX_QMI8658_ADDR,
                             PIXELBOX_QMI8658_CTRL7, 0x03);
}

static void pixelbox_log_probe(const char *name, uint16_t address,
                               const uint8_t *reg, size_t reglen,
                               const uint8_t *data, size_t datalen, int ret)
{
  if (ret < 0)
    {
      syslog(LOG_WARNING,
             "[pixelbox] %s addr=0x%02x reg=0x%02x ret=%d error=%d errno=%d\n",
             name, address, reglen == 1 ? reg[0] : reg[0], ret, -ret, errno);
      return;
    }

  if (reglen == 2)
    {
      syslog(LOG_INFO,
             "[pixelbox] %s addr=0x%02x reg=0x%02x%02x len=%u:",
             name, address, reg[0], reg[1], (unsigned)datalen);
    }
  else
    {
      syslog(LOG_INFO,
             "[pixelbox] %s addr=0x%02x reg=0x%02x len=%u:",
             name, address, reg[0], (unsigned)datalen);
    }

  for (size_t index = 0; index < datalen; index++)
    {
      syslog(LOG_INFO, " %02x", data[index]);
    }

  syslog(LOG_INFO, " ret=%d error=0 errno=%d\n", ret, errno);
}

/* I2C 控制器或某个外设异常时，I2C_TRANSFER 可能长时间等待。
 * 传感器和音频探测不能阻塞显示、NSH、看门狗及网络服务，因此只在独立的
 * 低优先级任务中执行；显示初始化仍在前台完成，启动后立即可用。 */
static int pixelbox_board_io_worker(int argc, char **argv)
{
  (void)argc;
  (void)argv;
#if defined(CONFIG_ESPRESSIF_I2C_PERIPH_MASTER_MODE) && \
    defined(CONFIG_ESP32S3_I2C0)
  struct i2c_master_s *i2c;
  uint8_t reg8;
  uint8_t reg16[2];
  uint8_t data[7];
  int ret;

  syslog(LOG_INFO, "[pixelbox] board I2C worker starting\n");
  i2c = esp32s3_i2cbus_initialize(0);
  if (i2c == NULL)
    {
      syslog(LOG_WARNING,
             "[pixelbox] I2C0 init failed addr=0x00 reg=0x00 ret=-%d error=%d errno=%d\n",
             ENODEV, ENODEV, errno);
      atomic_store_explicit(&g_io_status, -ENODEV, memory_order_release);
      return -ENODEV;
    }
  g_i2c = i2c;

  /* QMI8658 WHO_AM_I must return 0x05. */
  reg8 = PIXELBOX_QMI8658_WHO_AM_I;
  ret = pixelbox_i2c_read(i2c, PIXELBOX_QMI8658_ADDR, &reg8, 1, data, 1);
  pixelbox_log_probe("QMI8658 WHO_AM_I", PIXELBOX_QMI8658_ADDR,
                     &reg8, 1, data, 1, ret);
  if (ret >= 0 && data[0] == 0x05)
    {
      ret = pixelbox_qmi8658_configure(i2c);
      if (ret < 0)
        {
          syslog(LOG_WARNING,
                 "[pixelbox] QMI8658 configure failed ret=%d errno=%d\n",
                 ret, errno);
        }
      else
        {
          g_imu_ready = true;
          syslog(LOG_INFO, "[pixelbox] QMI8658 ready (±8g/±512dps)\n");
        }
    }
  else
    {
      g_imu_ready = false;
    }

  /* CST9220 reports a seven-byte touch frame at register 0xd000. */
  reg16[0] = 0xd0;
  reg16[1] = 0x00;
  ret = pixelbox_i2c_read(i2c, PIXELBOX_CST9220_ADDR, reg16, 2, data, 7);
  pixelbox_log_probe("CST9220 frame", PIXELBOX_CST9220_ADDR,
                     reg16, 2, data, 7, ret);
  /* ESP-IDF 驱动以 I2C 应答作为在位判断，0xab 只校验后续帧。 */
  g_touch_ready = ret >= 0;

  reg8 = 0x00;
  ret = pixelbox_i2c_read(i2c, PIXELBOX_ES8311_ADDR, &reg8, 1, data, 1);
  pixelbox_log_probe("ES8311 probe", PIXELBOX_ES8311_ADDR,
                     &reg8, 1, data, 1, ret);
#if defined(CONFIG_ESP32S3_I2S0) && defined(CONFIG_AUDIO_ES8311)
  if (ret >= 0)
    {
      ret = pixelbox_es8311_register(i2c);
      if (ret < 0)
        {
          syslog(LOG_WARNING, "[pixelbox] ES8311 registration failed: %d\n",
                 ret);
        }
    }
#endif

  ret = pixelbox_i2c_read(i2c, PIXELBOX_ES7210_ADDR, &reg8, 1, data, 1);
  pixelbox_log_probe("ES7210 probe", PIXELBOX_ES7210_ADDR,
                     &reg8, 1, data, 1, ret);
  g_mic_ready = ret >= 0;
#else
  syslog(LOG_WARNING,
         "[pixelbox] I2C0 master disabled; no sensor probes performed\n");
#endif
  /* 单个可选器件探测失败仍属于“流程完成”：调用方可分别查询 touch/IMU/
   * mic 能力；只有 I2C 控制器初始化失败才会在上面发布负 errno。 */
  atomic_store_explicit(&g_io_status, 1, memory_order_release);
  syslog(LOG_INFO, "[pixelbox] board I2C worker complete\n");
  return 0;
}

int pixelbox_board_initialize(void)
{
  static bool initialized;
  int ret;

  if (initialized)
    {
      return 0;
    }

  initialized = true;
  esp32s3_configgpio(0, INPUT | PULLUP);
  esp32s3_configgpio(18, INPUT | PULLUP);

  /* 屏幕复位由 framebuffer 初始化负责；这里不能再次复位已就绪的面板。 */
  esp32s3_configgpio(PIXELBOX_CST9220_RST, OUTPUT);
  esp32s3_gpiowrite(PIXELBOX_CST9220_RST, false);
  up_mdelay(10);
  esp32s3_gpiowrite(PIXELBOX_CST9220_RST, true);
  /* CST9220 释放复位后需要至少 100ms 才响应 0xd000 读请求。 */
  up_mdelay(120);
  esp32s3_configgpio(PIXELBOX_CST9220_INT, INPUT);
  esp32s3_configgpio(PIXELBOX_QMI8658_INT1, INPUT);
  esp32s3_configgpio(PIXELBOX_QMI8658_INT2, INPUT);

  esp32s3_configgpio(PIXELBOX_AMP_ENABLE, OUTPUT);
  esp32s3_gpiowrite(PIXELBOX_AMP_ENABLE, true);

  /* 先初始化 CO5300，避免任何 I2C 事务延迟 framebuffer 注册和首帧。 */
  ret = pixelbox_board_display_initialize();
  if (ret < 0)
    {
      syslog(LOG_WARNING, "[pixelbox] CO5300 registration failed: %d\n",
             ret);
    }

  int io_pid = kthread_create("px-board-io", 60, 8192,
                              pixelbox_board_io_worker, NULL);
  if (io_pid < 0)
    {
      atomic_store_explicit(&g_io_status, io_pid, memory_order_release);
      syslog(LOG_WARNING, "[pixelbox] board I2C worker failed: %d\n", io_pid);
    }
  else
    {
      syslog(LOG_INFO, "[pixelbox] board I2C worker started: pid=%d\n", io_pid);
    }

  syslog(LOG_INFO,
         "[pixelbox] board reset ready: CO5300 rst=%d, CST9220 int/rst=%d/%d, "
         "QMI8658 int1/int2=%d/%d, amp_en=%d\n",
         PIXELBOX_CO5300_RST, PIXELBOX_CST9220_INT, PIXELBOX_CST9220_RST,
         PIXELBOX_QMI8658_INT1, PIXELBOX_QMI8658_INT2, PIXELBOX_AMP_ENABLE);
  return 0;
}

int pixelbox_board_io_status(void)
{
  return atomic_load_explicit(&g_io_status, memory_order_acquire);
}

bool pixelbox_board_imu_available(void)
{
  return g_imu_ready && g_i2c != NULL;
}

int pixelbox_board_button_read(unsigned index, bool *pressed)
{
  if (index > 1 || pressed == NULL) return -EINVAL;
  *pressed = !esp32s3_gpioread(index == 0 ? 0 : 18);
  return 0;
}

int pixelbox_board_imu_read(struct pixelbox_imu_sample *sample)
{
  uint8_t reg = PIXELBOX_QMI8658_DATA;
  uint8_t raw[12];
  int ret;

  if (sample == NULL || !pixelbox_board_imu_available())
    {
      return -ENODEV;
    }

  ret = pixelbox_i2c_read(g_i2c, PIXELBOX_QMI8658_ADDR, &reg, 1,
                          raw, sizeof(raw));
  if (ret < 0)
    {
      return ret;
    }

  /* QMI8658 数据寄存器是连续的小端 int16。 */
  int16_t ax = (int16_t)((uint16_t)raw[0] | ((uint16_t)raw[1] << 8));
  int16_t ay = (int16_t)((uint16_t)raw[2] | ((uint16_t)raw[3] << 8));
  int16_t az = (int16_t)((uint16_t)raw[4] | ((uint16_t)raw[5] << 8));
  int16_t gx = (int16_t)((uint16_t)raw[6] | ((uint16_t)raw[7] << 8));
  int16_t gy = (int16_t)((uint16_t)raw[8] | ((uint16_t)raw[9] << 8));
  int16_t gz = (int16_t)((uint16_t)raw[10] | ((uint16_t)raw[11] << 8));
  sample->ax = (float)ax / PIXELBOX_QMI8658_ACC_LSB_PER_G;
  sample->ay = (float)ay / PIXELBOX_QMI8658_ACC_LSB_PER_G;
  sample->az = (float)az / PIXELBOX_QMI8658_ACC_LSB_PER_G;
  sample->gx = (float)gx / PIXELBOX_QMI8658_GYR_LSB_PER_DPS;
  sample->gy = (float)gy / PIXELBOX_QMI8658_GYR_LSB_PER_DPS;
  sample->gz = (float)gz / PIXELBOX_QMI8658_GYR_LSB_PER_DPS;
  return 0;
}

bool pixelbox_board_touch_available(void)
{
  return g_touch_ready && g_i2c != NULL;
}

int pixelbox_board_touch_read(struct pixelbox_touch_event *event)
{
  uint8_t reg[2] = {0xd0, 0x00};
  uint8_t data[7];
  int ret;
  bool now_down;

  if (event == NULL || !pixelbox_board_touch_available())
    {
      return -ENODEV;
    }

  ret = pixelbox_i2c_read(g_i2c, PIXELBOX_CST9220_ADDR, reg, 2,
                          data, sizeof(data));
  if (ret < 0)
    {
      return ret;
    }

  /* 0xab 是 CST9220 有效帧标记；无触摸时也可能返回空帧。 */
  if (data[6] != 0xab)
    {
      return -EAGAIN;
    }

  now_down = (data[5] & 0x7f) > 0 && (data[0] & 0x0f) == 0x06;
  if (now_down)
    {
      uint16_t raw_x = (uint16_t)(((uint16_t)data[1] << 4) |
                                  (data[3] >> 4));
      uint16_t raw_y = (uint16_t)(((uint16_t)data[2] << 4) |
                                  (data[3] & 0x0f));
      /* 面板 MADCTL=0xa0 对应 swap_xy=1 + mirror_y=1。 */
      uint16_t x = raw_y >= 480 ? 0 : (uint16_t)(479 - raw_y);
      uint16_t y = raw_x >= 480 ? 479 : raw_x;

      if (!g_touch_down)
        {
          event->type = PIXELBOX_TOUCH_DOWN;
        }
      else if (x != g_touch_x || y != g_touch_y)
        {
          event->type = PIXELBOX_TOUCH_MOVE;
        }
      else
        {
          return -EAGAIN;
        }

      g_touch_down = true;
      g_touch_x = x;
      g_touch_y = y;
      event->x = x;
      event->y = y;
      return 0;
    }

  if (!g_touch_down)
    {
      return -EAGAIN;
    }

  g_touch_down = false;
  event->type = PIXELBOX_TOUCH_UP;
  event->x = g_touch_x;
  event->y = g_touch_y;
  return 0;
}
