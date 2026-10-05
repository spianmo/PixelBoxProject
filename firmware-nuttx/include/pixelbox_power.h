#ifndef PIXELBOX_POWER_H
#define PIXELBOX_POWER_H

#include <stdbool.h>
#include <stdint.h>

struct px_power_battery {
  int level;             /* 0..100；检测确认无电池时为 -1。 */
  bool charging;
  int voltage_mv;
  bool present;
  bool detection_enabled;
  bool adc_enabled;
};

enum px_button_id {
  PX_BUTTON_BOOT = 0,
  PX_BUTTON_USER,
  PX_BUTTON_POWER
};

enum px_button_type {
  PX_BUTTON_DOWN = 1,
  PX_BUTTON_UP,
  PX_BUTTON_CLICK,
  PX_BUTTON_DOUBLE_CLICK,
  PX_BUTTON_LONG_PRESS
};

struct px_button_event {
  enum px_button_id id;
  enum px_button_type type;
};

/* 仅探测 AXP2101，不使能/关闭电源轨，不改充电、ADC 或 IRQ 配置。
 * 板级先注册 /dev/i2c0；失败返回负 errno，主机返回 -ENOTSUP。
 */
int px_power_init(const char *i2c_path);
/* 仅开启电池检测、VBAT ADC 和 PKEY 事件位；保留充电、电压、电源轨及其它 IRQ。 */
int px_power_enable_monitoring(void);
bool px_power_available(void);
void px_power_shutdown(void);

/* 电池检测或在位电池 ADC 未启用时返回 -ENODATA，不能据此声称无电池。
 * I2C 失败返回负 errno；仅返回 0 时将三个 SDK 字段交给 JS。
 */
int px_power_read_battery(struct px_power_battery *battery);

/* 建议每 200ms 调用：1=事件，0=暂无事件，负值=错误。
 * 仅消费 INTSTS2/0x49 的 PKEY 两位；长按优先。此函数的唯一寄存器写操作
 * 为写 1 清除已读的 PKEY 位，其余 IRQ 原样保留。
 * PKEY 中断未启用且没有待处理事件时返回 -ENODATA。
 * PWR 只产生 click/longPress，不能合成 down/up/doubleClick。
 */
int px_power_poll_key(struct px_button_event *event);

#define PX_BUTTON_DEBOUNCE_MS 10u
#define PX_BUTTON_REPEAT_MS 180u
#define PX_BUTTON_LONG_MS 1200u

/* BOOT/USER 纯状态机：板级喂入已经转换为“按下=true”的 GPIO 样本。
 * 对齐原 espressif/button 的五种 SDK 事件；不直接读 GPIO、不调用 JS。
 * 建议每 5..10ms 喂一次；时间必须为不回退的单调毫秒数。
 */
struct px_button_state {
  enum px_button_id id;
  unsigned phase;
  unsigned repeats;
  bool sampled;
  bool raw_pressed;
  bool stable_pressed;
  uint64_t raw_since_ms;
  uint64_t phase_since_ms;
  uint64_t last_sample_ms;
};

int px_button_state_init(struct px_button_state *state, enum px_button_id id);
int px_button_feed(struct px_button_state *state, bool pressed,
                    uint64_t monotonic_ms, struct px_button_event *event);

#endif
