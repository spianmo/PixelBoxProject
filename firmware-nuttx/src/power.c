#include "pixelbox_power.h"

#include <errno.h>
#include <string.h>

#if defined(PX_POWER_TEST) || defined(PX_POWER_TEST_FILE)
#  include "power_test_platform.h"
#  define PX_POWER_PLATFORM 1
#  if defined(PX_POWER_TEST_FILE)
#    define PX_POWER_FILE_API 1
#  endif
#elif defined(__NuttX__)
#  include <nuttx/config.h>
#  if defined(CONFIG_I2C_DRIVER)
#    include <nuttx/fs/fs.h>
#    include <nuttx/i2c/i2c_master.h>
#    define PX_POWER_PLATFORM 1
#    define PX_POWER_FILE_API 1
#  endif
#endif

static void empty_battery(struct px_power_battery *battery)
{
  memset(battery, 0, sizeof(*battery));
  battery->level = -1;
}

#ifdef PX_POWER_PLATFORM

#include <fcntl.h>
#include <pthread.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define AXP2101_ADDRESS 0x34
#define AXP2101_CHIP_ID 0x4a
#define AXP2101_STATUS1 0x00
#define AXP2101_ID 0x03
#define AXP2101_ADC_CONTROL 0x30
#define AXP2101_VBAT 0x34
#define AXP2101_IRQ_ENABLE2 0x41
#define AXP2101_IRQ_STATUS2 0x49
#define AXP2101_BATTERY_DETECT 0x68
#define AXP2101_PERCENT 0xa4
#define AXP2101_PKEY_SHORT 0x08
#define AXP2101_PKEY_LONG 0x04
#define AXP2101_PKEY_MASK (AXP2101_PKEY_SHORT | AXP2101_PKEY_LONG)

static pthread_mutex_t g_power_lock = PTHREAD_MUTEX_INITIALIZER;
#ifdef PX_POWER_FILE_API
/* PMU由boot打开、VM和系统按键服务共用；struct file不依赖调用task group的fd表。 */
static struct file g_power_file;
#else
static int g_power_fd = -1;
#endif
static bool g_power_open;
static char g_i2c_path[64];

/* 调用方始终持有g_power_lock，含probe失败与shutdown，避免跨线程读/关竞态。 */
static int open_device(const char *path)
{
#ifdef PX_POWER_FILE_API
  int result = file_open(&g_power_file, path, O_RDWR);
  if (result < 0) return result;
#else
  errno = 0;
  g_power_fd = open(path, O_RDWR);
  if (g_power_fd < 0) return -(errno ? errno : ENODEV);
#endif
  g_power_open = true;
  return 0;
}
static void close_device(void)
{
  if (!g_power_open) return;
#ifdef PX_POWER_FILE_API
  (void)file_close(&g_power_file);
#else
  (void)close(g_power_fd);
  g_power_fd = -1;
#endif
  g_power_open = false;
}

static int transfer(struct i2c_msg_s *messages, size_t count)
{
  struct i2c_transfer_s transaction = {.msgv = messages, .msgc = count};
#ifdef PX_POWER_FILE_API
  /* 内核file API直接返回负errno，不能读取调用线程的旧errno。 */
  int result = file_ioctl(&g_power_file, I2CIOC_TRANSFER, (unsigned long)&transaction);
  if (result < 0) return result;
#else
  errno = 0;
  int result = ioctl(g_power_fd, I2CIOC_TRANSFER, (unsigned long)&transaction);
  if (result < 0) return -(errno ? errno : EIO);
#endif
  /* NuttX 允许返回 0 或完成的消息数；正数短传输不能当成功。 */
  return result > 0 && (size_t)result != count ? -EIO : 0;
}

static int read_registers(uint8_t address, uint8_t *data, size_t length)
{
  struct i2c_msg_s messages[2] = {
    {.frequency = 400000, .addr = AXP2101_ADDRESS, .flags = I2C_M_NOSTOP,
     .buffer = &address, .length = 1},
    {.frequency = 400000, .addr = AXP2101_ADDRESS, .flags = I2C_M_READ,
     .buffer = data, .length = length}
  };
  return transfer(messages, 2);
}

static int acknowledge_key(uint8_t key_bits)
{
  /* 只清理已消费的 PKEY 位；其它中断不能被顺带确认。 */
  uint8_t data[2] = {AXP2101_IRQ_STATUS2, key_bits & AXP2101_PKEY_MASK};
  struct i2c_msg_s message = {
    .frequency = 400000, .addr = AXP2101_ADDRESS, .flags = 0,
    .buffer = data, .length = sizeof(data)
  };
  return transfer(&message, 1);
}

static int enable_bits(uint8_t address, uint8_t bits)
{
  uint8_t value;
  int result = read_registers(address, &value, 1);
  if (result < 0 || (value & bits) == bits) return result;
  uint8_t bytes[] = {address, value | bits};
  struct i2c_msg_s message = {
    .frequency = 400000, .addr = AXP2101_ADDRESS, .flags = 0,
    .buffer = bytes, .length = sizeof(bytes)
  };
  result = transfer(&message, 1);
  if (result < 0) return result;
  result = read_registers(address, &value, 1);
  return result < 0 ? result : ((value & bits) == bits ? 0 : -EIO);
}

int px_power_enable_monitoring(void)
{
  pthread_mutex_lock(&g_power_lock);
  int result = -ENODEV;
  if (g_power_open) {
    /* 与原 ESP-IDF 电池/按键路径一致；不触碰充电参数和各路供电。 */
    result = enable_bits(AXP2101_BATTERY_DETECT, 0x01);
    if (!result) result = enable_bits(AXP2101_ADC_CONTROL, 0x01);
    if (!result) result = enable_bits(AXP2101_IRQ_ENABLE2, AXP2101_PKEY_MASK);
  }
  pthread_mutex_unlock(&g_power_lock);
  return result;
}

int px_power_init(const char *i2c_path)
{
  if (!i2c_path || !*i2c_path || strlen(i2c_path) >= sizeof(g_i2c_path)) return -EINVAL;
  pthread_mutex_lock(&g_power_lock);
  if (g_power_open) {
    int result = strcmp(i2c_path, g_i2c_path) ? -EBUSY : 0;
    pthread_mutex_unlock(&g_power_lock);
    return result;
  }
  int result = open_device(i2c_path);
  if (result < 0) {
    pthread_mutex_unlock(&g_power_lock);
    return result;
  }
  uint8_t id = 0;
  result = read_registers(AXP2101_ID, &id, 1);
  /* 严格识别后才允许后续写 1 清 IRQ，不能对未知 PMU 写寄存器。 */
  if (result == 0 && id != AXP2101_CHIP_ID) result = -ENODEV;
  if (result < 0) {
    close_device();
  } else {
    memcpy(g_i2c_path, i2c_path, strlen(i2c_path) + 1);
  }
  pthread_mutex_unlock(&g_power_lock);
  return result;
}

bool px_power_available(void)
{
  pthread_mutex_lock(&g_power_lock);
  bool available = g_power_open;
  pthread_mutex_unlock(&g_power_lock);
  return available;
}

void px_power_shutdown(void)
{
  pthread_mutex_lock(&g_power_lock);
  close_device();
  g_i2c_path[0] = '\0';
  pthread_mutex_unlock(&g_power_lock);
}

int px_power_read_battery(struct px_power_battery *battery)
{
  if (!battery) return -EINVAL;
  empty_battery(battery);
  pthread_mutex_lock(&g_power_lock);
  int result = -ENODEV;
  if (!g_power_open) goto done;
  uint8_t detection = 0, status[2] = {0}, adc = 0, percent = 0, voltage[2] = {0};
  result = read_registers(AXP2101_BATTERY_DETECT, &detection, 1);
  if (result < 0) goto done;
  battery->detection_enabled = (detection & 1) != 0;
  if (!battery->detection_enabled) { result = -ENODATA; goto done; }
  result = read_registers(AXP2101_STATUS1, status, sizeof(status));
  if (result < 0) goto done;
  battery->present = (status[0] & 0x08) != 0;
  if (!battery->present) goto done;
  battery->charging = ((status[1] >> 5) & 3) == 1;
  result = read_registers(AXP2101_PERCENT, &percent, 1);
  if (result < 0) goto done;
  battery->level = percent > 100 ? 100 : percent;
  result = read_registers(AXP2101_ADC_CONTROL, &adc, 1);
  if (result < 0) goto done;
  battery->adc_enabled = (adc & 1) != 0;
  if (!battery->adc_enabled) { result = -ENODATA; goto done; }
  /* AXP2101 VBAT 为高 5 位加低 8 位，单位 mV；一起读避免高低字节撕裂。 */
  result = read_registers(AXP2101_VBAT, voltage, sizeof(voltage));
  if (result < 0) goto done;
  battery->voltage_mv = ((unsigned)(voltage[0] & 0x1f) << 8) | voltage[1];
  if (!battery->voltage_mv) result = -ENODATA;
done:
  pthread_mutex_unlock(&g_power_lock);
  return result;
}

int px_power_poll_key(struct px_button_event *event)
{
  if (!event) return -EINVAL;
  memset(event, 0, sizeof(*event));
  pthread_mutex_lock(&g_power_lock);
  int result = -ENODEV;
  if (!g_power_open) goto done;
  uint8_t status = 0;
  result = read_registers(AXP2101_IRQ_STATUS2, &status, 1);
  if (result < 0) goto done;
  uint8_t pending = status & AXP2101_PKEY_MASK;
  if (!pending) {
    uint8_t enabled = 0;
    result = read_registers(AXP2101_IRQ_ENABLE2, &enabled, 1);
    if (result == 0 && (enabled & AXP2101_PKEY_MASK) != AXP2101_PKEY_MASK)
      result = -ENODATA;
    goto done;
  }
  result = acknowledge_key(pending);
  if (result < 0) goto done;
  event->id = PX_BUTTON_POWER;
  event->type = pending & AXP2101_PKEY_LONG ? PX_BUTTON_LONG_PRESS : PX_BUTTON_CLICK;
  result = 1;
done:
  pthread_mutex_unlock(&g_power_lock);
  return result;
}

#else

int px_power_init(const char *i2c_path) { (void)i2c_path; return -ENOTSUP; }
int px_power_enable_monitoring(void) { return -ENOTSUP; }
bool px_power_available(void) { return false; }
void px_power_shutdown(void) {}
int px_power_read_battery(struct px_power_battery *battery)
{ if (!battery) return -EINVAL; empty_battery(battery); return -ENOTSUP; }
int px_power_poll_key(struct px_button_event *event)
{ if (!event) return -EINVAL; memset(event, 0, sizeof(*event)); return -ENOTSUP; }

#endif

enum button_phase { BUTTON_IDLE, BUTTON_DOWN, BUTTON_WAIT_REPEAT,
                    BUTTON_REPEAT_DOWN, BUTTON_LONG_DOWN };

int px_button_state_init(struct px_button_state *state, enum px_button_id id)
{
  if (!state || (id != PX_BUTTON_BOOT && id != PX_BUTTON_USER)) return -EINVAL;
  memset(state, 0, sizeof(*state));
  state->id = id;
  return 0;
}

int px_button_feed(struct px_button_state *state, bool pressed,
                    uint64_t monotonic_ms, struct px_button_event *event)
{
  if (!state || !event || (state->id != PX_BUTTON_BOOT && state->id != PX_BUTTON_USER) ||
      state->phase > BUTTON_LONG_DOWN) return -EINVAL;
  if (state->sampled && monotonic_ms < state->last_sample_ms) return -ERANGE;
  memset(event, 0, sizeof(*event));
  if (!state->sampled || pressed != state->raw_pressed) {
    state->raw_pressed = pressed;
    state->raw_since_ms = monotonic_ms;
  }
  state->sampled = true;
  state->last_sample_ms = monotonic_ms;
  if (state->stable_pressed != state->raw_pressed &&
      monotonic_ms - state->raw_since_ms >= PX_BUTTON_DEBOUNCE_MS)
    state->stable_pressed = state->raw_pressed;
  uint64_t elapsed = monotonic_ms - state->phase_since_ms;
  enum px_button_type type = 0;
  switch (state->phase) {
  case BUTTON_IDLE:
    if (state->stable_pressed) {
      type = PX_BUTTON_DOWN;
      state->repeats = 1;
      state->phase_since_ms = monotonic_ms;
      state->phase = BUTTON_DOWN;
    }
    break;
  case BUTTON_DOWN:
    if (!state->stable_pressed) {
      type = PX_BUTTON_UP;
      state->phase_since_ms = monotonic_ms;
      state->phase = BUTTON_WAIT_REPEAT;
    } else if (elapsed >= PX_BUTTON_LONG_MS) {
      type = PX_BUTTON_LONG_PRESS;
      state->phase = BUTTON_LONG_DOWN;
    }
    break;
  case BUTTON_WAIT_REPEAT:
    /* 与原 iot_button 一致：去抖后的第二次按下优先于点击窗口超时。 */
    if (state->stable_pressed) {
      type = PX_BUTTON_DOWN;
      if (state->repeats < 3) ++state->repeats;
      state->phase_since_ms = monotonic_ms;
      state->phase = BUTTON_REPEAT_DOWN;
    } else if (elapsed > PX_BUTTON_REPEAT_MS) {
      if (state->repeats == 1) type = PX_BUTTON_CLICK;
      else if (state->repeats == 2) type = PX_BUTTON_DOUBLE_CLICK;
      state->phase = BUTTON_IDLE;
      state->repeats = 0;
    }
    break;
  case BUTTON_REPEAT_DOWN:
    if (!state->stable_pressed) {
      type = PX_BUTTON_UP;
      state->phase = elapsed < PX_BUTTON_REPEAT_MS ? BUTTON_WAIT_REPEAT : BUTTON_IDLE;
      state->phase_since_ms = monotonic_ms;
      if (state->phase == BUTTON_IDLE) state->repeats = 0;
    }
    break;
  case BUTTON_LONG_DOWN:
    if (!state->stable_pressed) {
      type = PX_BUTTON_UP;
      state->phase = BUTTON_IDLE;
      state->repeats = 0;
    }
    break;
  }
  if (!type) return 0;
  event->id = state->id;
  event->type = type;
  return 1;
}
