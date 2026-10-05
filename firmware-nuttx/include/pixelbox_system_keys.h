#ifndef PIXELBOX_SYSTEM_KEYS_H
#define PIXELBOX_SYSTEM_KEYS_H

#include "pixelbox_power.h"
#include <stddef.h>

#define PX_SYSTEM_KEYS_COMBO_MS 2000u
#define PX_SYSTEM_KEYS_BUTTON_CAPACITY 64u
#define PX_SYSTEM_KEYS_ACTION_CAPACITY 16u

enum px_system_key_action {
  PX_SYSTEM_KEY_NONE = 0,
  PX_SYSTEM_KEY_OPEN_SETTINGS,
  PX_SYSTEM_KEY_RETURN_APP,
  PX_SYSTEM_KEY_TOGGLE_SCREEN,
  PX_SYSTEM_KEY_DEEP_SLEEP,
  PX_SYSTEM_KEY_OPEN_PROVISIONING,
  PX_SYSTEM_KEY_UNINSTALL_APP
};

struct px_system_key_request {
  enum px_system_key_action action;
  /* 0 表示已排队待消费者执行，绝不表示硬件动作已完成。
   * 深睡/卸载及未启用能力的配网为 -ENOTSUP，消费者不得执行。
   */
  int result;
  uint64_t at_ms;
};

/* 纯状态机可由主机输入事件与单调时间验证，不触碰 GPIO/PMU/屏幕。 */
struct px_system_key_state {
  bool down[2];
  bool suppress[2];
  bool combo_pending;
  bool in_settings;
  bool provisioning_enabled;
  bool in_provisioning;
  bool clock_started;
  uint64_t combo_since_ms;
  uint64_t last_ms;
};

void px_system_keys_state_init(struct px_system_key_state *state);
int px_system_keys_feed(struct px_system_key_state *state,
                        const struct px_button_event *event, uint64_t now_ms,
                        struct px_system_key_request *request);
int px_system_keys_tick(struct px_system_key_state *state, uint64_t now_ms,
                        struct px_system_key_request *request);

struct px_system_keys_status {
  bool running;
  int error;
  int hardware_error;
  unsigned overflows;
  struct px_system_key_request last_request;
};

/* PMU 和 watchdog 初始化后，由常驻启动任务调用。独立 kthread 每 5ms
 * 采样 GPIO，每 200ms 唯一消费 PMU PKEY；不操作屏幕、JS 或 USB。
 * 0=后台采样已就绪；2s 内未就绪为 -EINPROGRESS，再次调用仅查状态。
 */
int px_system_keys_start(void);
int px_system_keys_get_status(struct px_system_keys_status *status);
bool px_system_keys_buttons_available(void);

/* service 负责维护真实模式；BOOT 即便已在设置中也产生重载请求。
 * next_action: 1=请求，0=空，负 errno=队列/服务错误。
 * 仅 service 消费此队列；result<0 时记录错误，不能声称动作成功。
 */
void px_system_keys_set_settings(bool in_settings);
/* 仅 service 在门户 init 成功后开启能力，结束时关闭；默认不启用。
 * active 让门户期间 PWR 短按生成 RETURN_APP，不把门户误作设置 VM。
 */
void px_system_keys_set_provisioning_enabled(bool enabled);
void px_system_keys_set_provisioning_active(bool active);
int px_system_keys_next_action(struct px_system_key_request *request);

/* px_run 已保证只有一个活动 VM：在安装 native power 时 reset，VM
 * 退出时 detach。只清除旧 VM 原始事件/显示动作，不重置物理按住状态。
 * 亮灭屏由当前 VM 事件循环消费 next_display 并执行，后台不碰帧缓冲。
 */
void px_system_keys_vm_reset(void);
void px_system_keys_vm_detach(void);
/* JS 首个订阅/末个退订切换原始事件投递；不影响系统键动作采样。
 * 改变订阅状态时丢弃旧原始事件，新 VM 初始没有订阅。
 */
int px_system_keys_listen_buttons(bool enabled);
int px_system_keys_read_buttons(struct px_button_event *events, size_t capacity);
int px_system_keys_next_display(struct px_system_key_request *request);
const char *px_system_keys_action_name(enum px_system_key_action action);

#endif
