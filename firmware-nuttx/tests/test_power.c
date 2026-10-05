#include "pixelbox_power.h"
#include "power_test_platform.h"

#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

static uint8_t registers[256];
static unsigned writes;
static unsigned opens;
static unsigned closes;
static bool acknowledge_error;
static int bad_read_register = -1;
static bool return_message_count;
static bool short_transfer;
static uint8_t last_write_register;
static uint8_t last_write_value;

int px_power_test_open(const char *path, int flags)
{
  assert(flags == O_RDWR);
  if (strcmp(path, "/dev/i2c0")) { errno = ENOENT; return -1; }
  ++opens;
  return 42;
}

int px_power_test_close(int fd) { assert(fd == 42); ++closes; return 0; }

static int fixture_transfer(int command, unsigned long argument)
{
  assert(command == I2CIOC_TRANSFER);
  struct i2c_transfer_s *transaction = (struct i2c_transfer_s *)argument;
  assert(transaction && transaction->msgv && transaction->msgc >= 1 && transaction->msgc <= 2);
  struct i2c_msg_s *messages = transaction->msgv;
  for (size_t i = 0; i < transaction->msgc; ++i)
    assert(messages[i].addr == 0x34 && messages[i].frequency == 400000);
  uint8_t address = messages[0].buffer[0];
  if (transaction->msgc == 2) {
    assert(messages[0].length == 1 && messages[0].flags == I2C_M_NOSTOP);
    assert(messages[1].flags == I2C_M_READ && messages[1].length > 0);
    if (bad_read_register == address) { errno = EIO; return -1; }
    if (short_transfer) return 1;
    memcpy(messages[1].buffer, registers + address, messages[1].length);
  } else {
    /* 只允许监测使能及 PKEY 确认，任何电源轨或充电参数写入都使测试失败。 */
    assert(messages[0].length == 2 && messages[0].flags == 0);
    if (address == 0x49) assert((messages[0].buffer[1] & ~0x0c) == 0);
    else {
      assert(address == 0x68 || address == 0x30 || address == 0x41);
      uint8_t mask = address == 0x41 ? 0x0c : 1;
      assert(messages[0].buffer[1] == (registers[address] | mask));
    }
    ++writes;
    last_write_register = address;
    last_write_value = messages[0].buffer[1];
    if (acknowledge_error) { errno = EIO; return -1; }
    if (address == 0x49) registers[address] &= (uint8_t)~last_write_value;
    else registers[address] = last_write_value;
  }
  return return_message_count ? (int)transaction->msgc : 0;
}

int px_power_test_ioctl(int fd, int command, unsigned long argument)
{
  assert(fd == 42);
  return fixture_transfer(command, argument);
}

#ifdef PX_POWER_TEST_FILE
static struct file *opened_file;
int px_power_test_file_open(struct file *file, const char *path, int flags)
{
  assert(!opened_file && !file->identity);
  int result = px_power_test_open(path, flags);
  if (result < 0) { result = -errno; errno = EACCES; return result; }
  file->identity = 0x2101; opened_file = file; return 0;
}
int px_power_test_file_close(struct file *file)
{
  assert(file == opened_file && file->identity == 0x2101);
  opened_file = NULL; file->identity = 0; ++closes; return 0;
}
int px_power_test_file_ioctl(struct file *file, int command, unsigned long argument)
{
  assert(file == opened_file && file->identity == 0x2101);
  int result = fixture_transfer(command, argument);
  if (result < 0) result = -errno;
  errno = EACCES; /* 内核API负errno必须直接传播，不能误读当前调用线程的errno。 */
  return result;
}
#endif

static void reset(void)
{
  px_power_shutdown();
  memset(registers, 0, sizeof(registers));
  registers[0x03] = 0x4a;
  registers[0x68] = 1;
  registers[0x30] = 1;
  registers[0x41] = 0x0c;
  registers[0x00] = 0x08;
  registers[0x01] = 0x20;
  registers[0xa4] = 57;
  registers[0x34] = 0x2f; /* bit5 为保留位，不能算进 VBAT。 */
  registers[0x35] = 0x9e;
  writes = opens = closes = 0;
  acknowledge_error = return_message_count = short_transfer = false;
  bad_read_register = -1;
  last_write_register = last_write_value = 0;
}

static void test_probe_and_missing_device(void)
{
  reset();
  assert(!px_power_available());
  assert(px_power_init(NULL) == -EINVAL);
  assert(px_power_init("") == -EINVAL);
  assert(px_power_init("/dev/missing") == -ENOENT);
  registers[0x03] = 0xff;
  assert(px_power_init("/dev/i2c0") == -ENODEV);
  assert(!px_power_available() && closes == 1 && writes == 0);
  registers[0x03] = 0x4a;
  assert(px_power_init("/dev/i2c0") == 0);
  assert(px_power_available());
  assert(px_power_init("/dev/i2c0") == 0 && opens == 2);
  assert(px_power_init("/dev/i2c1") == -EBUSY);
  assert(writes == 0);
}

static void test_battery_voltage_and_charging(void)
{
  reset();
  assert(px_power_init("/dev/i2c0") == 0);
  struct px_power_battery battery;
  assert(px_power_read_battery(&battery) == 0);
  assert(battery.present && battery.detection_enabled && battery.adc_enabled);
  assert(battery.level == 57 && battery.charging && battery.voltage_mv == 3998);
  registers[0x01] = 0x40;
  return_message_count = true;
  assert(px_power_read_battery(&battery) == 0 && !battery.charging);
  registers[0xa4] = 127;
  assert(px_power_read_battery(&battery) == 0 && battery.level == 100);
  assert(writes == 0);
}

static void test_enable_monitoring_preserves_other_bits(void)
{
  reset();
  assert(px_power_enable_monitoring() == -ENODEV && writes == 0);
  assert(px_power_init("/dev/i2c0") == 0);
  registers[0x68] = 0xa0;
  registers[0x30] = 0x52;
  registers[0x41] = 0x81;
  registers[0x49] = 0xac;
  assert(px_power_enable_monitoring() == 0);
  assert(registers[0x68] == 0xa1 && registers[0x30] == 0x53 && registers[0x41] == 0x8d);
  assert(registers[0x49] == 0xac && writes == 3);
  assert(px_power_enable_monitoring() == 0 && writes == 3);
  registers[0x30] = 0x52;
  acknowledge_error = true;
  assert(px_power_enable_monitoring() == -EIO);
  assert(registers[0x30] == 0x52);
}

static void test_absent_battery_and_disabled_measurement(void)
{
  reset();
  assert(px_power_init("/dev/i2c0") == 0);
  registers[0x00] = 0;
  bad_read_register = 0x30;
  struct px_power_battery battery;
  assert(px_power_read_battery(&battery) == 0);
  assert(!battery.present && battery.level == -1 && !battery.charging && battery.voltage_mv == 0);
  bad_read_register = -1;
  registers[0x68] = 0;
  assert(px_power_read_battery(&battery) == -ENODATA && !battery.detection_enabled);
  registers[0x68] = 1;
  registers[0x00] = 8;
  registers[0x30] = 0;
  assert(px_power_read_battery(&battery) == -ENODATA && battery.present && !battery.adc_enabled);
  registers[0x30] = 1;
  registers[0x34] = registers[0x35] = 0;
  assert(px_power_read_battery(&battery) == -ENODATA && battery.adc_enabled);
  assert(writes == 0);
}

static void test_i2c_errors_and_short_transfer(void)
{
  reset();
  bad_read_register = 3;
  assert(px_power_init("/dev/i2c0") == -EIO && !px_power_available());
  bad_read_register = -1;
  assert(px_power_init("/dev/i2c0") == 0);
  struct px_power_battery battery;
  const int failures[] = {0x68, 0x00, 0xa4, 0x30, 0x34};
  for (unsigned i = 0; i < sizeof(failures) / sizeof(failures[0]); ++i) {
    bad_read_register = failures[i];
    assert(px_power_read_battery(&battery) == -EIO);
  }
  bad_read_register = -1;
  short_transfer = true;
  assert(px_power_read_battery(&battery) == -EIO);
  short_transfer = false;
  assert(writes == 0);
  assert(px_power_read_battery(NULL) == -EINVAL);
  px_power_shutdown();
  assert(px_power_read_battery(&battery) == -ENODEV && battery.level == -1);
}

static void test_power_key_irqs(void)
{
  reset();
  assert(px_power_init("/dev/i2c0") == 0);
  struct px_button_event event;
  assert(px_power_poll_key(&event) == 0 && writes == 0);
  registers[0x41] = 0;
  assert(px_power_poll_key(&event) == -ENODATA && writes == 0);
  registers[0x49] = 0xa8;
  assert(px_power_poll_key(&event) == 1 && event.id == PX_BUTTON_POWER && event.type == PX_BUTTON_CLICK);
  assert(last_write_register == 0x49 && last_write_value == 8 && registers[0x49] == 0xa0);
  registers[0x41] = 0x0c;
  assert(px_power_poll_key(&event) == 0 && writes == 1);
  registers[0x49] = 0xa4;
  assert(px_power_poll_key(&event) == 1 && event.type == PX_BUTTON_LONG_PRESS);
  assert(last_write_value == 4 && registers[0x49] == 0xa0);
  registers[0x49] = 0xac;
  assert(px_power_poll_key(&event) == 1 && event.type == PX_BUTTON_LONG_PRESS);
  assert(last_write_value == 0x0c && registers[0x49] == 0xa0);
  assert(px_power_poll_key(NULL) == -EINVAL);
}

static void test_power_key_error_does_not_publish(void)
{
  reset();
  assert(px_power_init("/dev/i2c0") == 0);
  struct px_button_event event;
  registers[0x49] = 8;
  acknowledge_error = true;
  assert(px_power_poll_key(&event) == -EIO && event.type == 0);
  assert(registers[0x49] == 8);
  acknowledge_error = false;
  assert(px_power_poll_key(&event) == 1 && event.type == PX_BUTTON_CLICK);
  assert(px_power_poll_key(&event) == 0);
  bad_read_register = 0x49;
  assert(px_power_poll_key(&event) == -EIO && event.type == 0);
  px_power_shutdown();
  assert(px_power_poll_key(&event) == -ENODEV);
}

static void *boot_open(void *unused)
{
  (void)unused;
  assert(!px_power_init("/dev/i2c0"));
  assert(!px_power_enable_monitoring());
  return NULL;
}
static void *application_read(void *unused)
{
  (void)unused;
  for (unsigned i = 0; i < 100; ++i) {
    struct px_power_battery battery;
    struct px_button_event event;
    assert(px_power_available());
    assert(!px_power_read_battery(&battery));
    assert(battery.level == 57 && battery.voltage_mv == 3998);
    assert(!px_power_poll_key(&event));
  }
  return NULL;
}
static void *system_close(void *unused)
{
  (void)unused;
  px_power_shutdown();
  return NULL;
}
static void test_cross_caller_lifetime(void)
{
  reset();
  pthread_t boot, app[3], cleanup;
  assert(!pthread_create(&boot, NULL, boot_open, NULL));
  assert(!pthread_join(boot, NULL));
  /* 开启调用者已经退出，三个新调用线程仍共用同一个文件对象且访问序列化。 */
  for (unsigned i = 0; i < 3; ++i)
    assert(!pthread_create(&app[i], NULL, application_read, NULL));
  for (unsigned i = 0; i < 3; ++i) assert(!pthread_join(app[i], NULL));
  assert(opens == 1 && closes == 0);
  assert(!pthread_create(&cleanup, NULL, system_close, NULL));
  assert(!pthread_join(cleanup, NULL));
  assert(opens == 1 && closes == 1 && !px_power_available());
}

static void feed(struct px_button_state *state, bool pressed, uint64_t time,
                   enum px_button_type expected)
{
  struct px_button_event event;
  int result = px_button_feed(state, pressed, time, &event);
  assert(result == (expected != 0));
  if (expected) assert(event.type == expected && event.id == state->id);
}

static void test_gpio_click_and_debounce(void)
{
  struct px_button_state button;
  assert(px_button_state_init(&button, PX_BUTTON_BOOT) == 0);
  feed(&button, false, 0, 0);
  feed(&button, true, 10, 0);
  feed(&button, false, 15, 0);
  feed(&button, true, 20, 0);
  feed(&button, true, 29, 0);
  feed(&button, true, 30, PX_BUTTON_DOWN);
  feed(&button, false, 100, 0);
  feed(&button, true, 105, 0);
  feed(&button, false, 110, 0);
  feed(&button, false, 120, PX_BUTTON_UP);
  feed(&button, false, 300, 0);
  feed(&button, false, 301, PX_BUTTON_CLICK);
  feed(&button, false, 500, 0);
}

static void test_gpio_double_click(void)
{
  struct px_button_state button;
  assert(px_button_state_init(&button, PX_BUTTON_USER) == 0);
  feed(&button, true, 0, 0);
  feed(&button, true, 10, PX_BUTTON_DOWN);
  feed(&button, false, 40, 0);
  feed(&button, false, 50, PX_BUTTON_UP);
  feed(&button, true, 100, 0);
  feed(&button, true, 110, PX_BUTTON_DOWN);
  feed(&button, false, 140, 0);
  feed(&button, false, 150, PX_BUTTON_UP);
  feed(&button, false, 330, 0);
  feed(&button, false, 331, PX_BUTTON_DOUBLE_CLICK);
  feed(&button, false, 500, 0);
}

static void test_gpio_long_press_and_time_errors(void)
{
  struct px_button_state button;
  struct px_button_event event;
  assert(px_button_state_init(&button, PX_BUTTON_BOOT) == 0);
  feed(&button, true, 0, 0);
  feed(&button, true, 10, PX_BUTTON_DOWN);
  feed(&button, true, 1209, 0);
  feed(&button, true, 1210, PX_BUTTON_LONG_PRESS);
  feed(&button, true, 3000, 0);
  feed(&button, false, 3010, 0);
  feed(&button, false, 3020, PX_BUTTON_UP);
  feed(&button, false, 3300, 0);
  struct px_button_state before = button;
  assert(px_button_feed(&button, false, 1000, &event) == -ERANGE);
  assert(!memcmp(&before, &button, sizeof(button)));
  assert(px_button_state_init(&button, PX_BUTTON_POWER) == -EINVAL);
  assert(px_button_state_init(NULL, PX_BUTTON_BOOT) == -EINVAL);
  assert(px_button_feed(NULL, false, 0, &event) == -EINVAL);
}

int main(void)
{
  test_probe_and_missing_device();
  test_battery_voltage_and_charging();
  test_enable_monitoring_preserves_other_bits();
  test_absent_battery_and_disabled_measurement();
  test_i2c_errors_and_short_transfer();
  test_power_key_irqs();
  test_power_key_error_does_not_publish();
  test_cross_caller_lifetime();
  test_gpio_click_and_debounce();
  test_gpio_double_click();
  test_gpio_long_press_and_time_errors();
  reset();
  puts("Power: 11 test groups passed (AXP2101 monitoring/IRQ, cross-caller lifetime, GPIO debounce/click/double/long)");
  return 0;
}
