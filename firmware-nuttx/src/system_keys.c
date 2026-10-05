#include "pixelbox_system_keys.h"

#include <errno.h>
#include <string.h>

void px_system_keys_state_init(struct px_system_key_state *state)
{
  if (state) memset(state, 0, sizeof(*state));
}

static int check_time(struct px_system_key_state *state, uint64_t now)
{
  if (state->clock_started && now < state->last_ms) return -ERANGE;
  state->clock_started = true;
  state->last_ms = now;
  return 0;
}

static int request_action(const struct px_system_key_state *state, struct px_system_key_request *request,
                           enum px_system_key_action action, uint64_t now)
{
  request->action = action;
  request->at_ms = now;
  request->result = action == PX_SYSTEM_KEY_DEEP_SLEEP ||
                    (action == PX_SYSTEM_KEY_OPEN_PROVISIONING && !state->provisioning_enabled) ||
                    action == PX_SYSTEM_KEY_UNINSTALL_APP ? -ENOTSUP : 0;
  return 1;
}

int px_system_keys_feed(struct px_system_key_state *state,
                        const struct px_button_event *event, uint64_t now,
                        struct px_system_key_request *request)
{
  if (!state || !event || !request || event->id < PX_BUTTON_BOOT ||
      event->id > PX_BUTTON_POWER || event->type < PX_BUTTON_DOWN ||
      event->type > PX_BUTTON_LONG_PRESS) return -EINVAL;
  memset(request, 0, sizeof(*request));
  int result = check_time(state, now);
  if (result < 0) return result;
  if (event->id != PX_BUTTON_POWER) {
    unsigned index = (unsigned)event->id;
    if (event->type == PX_BUTTON_DOWN) {
      /* 新的 down 才清抑制；up 后到达的 click 必须继续被组合键吞掉。 */
      state->suppress[index] = false;
      state->down[index] = true;
      if (state->down[0] && state->down[1]) {
        state->combo_pending = true;
        state->combo_since_ms = now;
      }
      return 0;
    }
    if (event->type == PX_BUTTON_UP) {
      state->down[index] = false;
      state->combo_pending = false;
      return 0;
    }
    /* USER 的 1.2 秒长按不能抢在 BOOT+USER 的 2 秒组合键之前。 */
    if (state->suppress[index] || state->down[1u - index]) return 0;
  }
  if (event->id == PX_BUTTON_BOOT && event->type == PX_BUTTON_CLICK)
    return request_action(state, request, PX_SYSTEM_KEY_OPEN_SETTINGS, now);
  if (event->id == PX_BUTTON_USER && event->type == PX_BUTTON_CLICK)
    return request_action(state, request, PX_SYSTEM_KEY_TOGGLE_SCREEN, now);
  if (event->id == PX_BUTTON_USER && event->type == PX_BUTTON_LONG_PRESS)
    return request_action(state, request, PX_SYSTEM_KEY_DEEP_SLEEP, now);
  if (event->id == PX_BUTTON_POWER && event->type == PX_BUTTON_LONG_PRESS)
    return request_action(state, request, PX_SYSTEM_KEY_UNINSTALL_APP, now);
  if (event->id == PX_BUTTON_POWER && event->type == PX_BUTTON_CLICK &&
      (state->in_settings || state->in_provisioning))
    return request_action(state, request, PX_SYSTEM_KEY_RETURN_APP, now);
  return 0;
}

int px_system_keys_tick(struct px_system_key_state *state, uint64_t now,
                        struct px_system_key_request *request)
{
  if (!state || !request) return -EINVAL;
  memset(request, 0, sizeof(*request));
  int result = check_time(state, now);
  if (result < 0) return result;
  if (!state->combo_pending || !state->down[0] || !state->down[1] ||
      now - state->combo_since_ms < PX_SYSTEM_KEYS_COMBO_MS) return 0;
  state->combo_pending = false;
  state->suppress[0] = state->suppress[1] = true;
  return request_action(state, request, PX_SYSTEM_KEY_OPEN_PROVISIONING, now);
}

const char *px_system_keys_action_name(enum px_system_key_action action)
{
  switch (action) {
    case PX_SYSTEM_KEY_OPEN_SETTINGS: return "open-settings";
    case PX_SYSTEM_KEY_RETURN_APP: return "return-app";
    case PX_SYSTEM_KEY_TOGGLE_SCREEN: return "toggle-screen";
    case PX_SYSTEM_KEY_DEEP_SLEEP: return "deep-sleep";
    case PX_SYSTEM_KEY_OPEN_PROVISIONING: return "open-provisioning";
    case PX_SYSTEM_KEY_UNINSTALL_APP: return "uninstall-app";
    default: return "none";
  }
}

#if defined(__NuttX__) || defined(PX_SYSTEM_KEYS_TEST)
#include "pixelbox_watchdog.h"
#include <pthread.h>
#include <syslog.h>
#include <time.h>
#ifdef PX_SYSTEM_KEYS_TEST
#include "system_keys_test_platform.h"
#else
#include <nuttx/config.h>
#include <nuttx/kthread.h>
#include "pixelbox_board.h"
#if !defined(CONFIG_FDCLONE_STDIO) && !defined(CONFIG_FDCLONE_DISABLE)
#error "PixelBox independent workers require FDCLONE_STDIO or FDCLONE_DISABLE"
#endif
#endif

struct action_queue {
  struct px_system_key_request entries[PX_SYSTEM_KEYS_ACTION_CAPACITY];
  unsigned head, count;
  int error;
};

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static struct px_system_key_state g_state;
static struct px_system_keys_status g_status;
static struct px_button_state g_buttons[2];
static struct px_button_event g_events[PX_SYSTEM_KEYS_BUTTON_CAPACITY];
static unsigned g_event_head, g_event_count;
static int g_event_error;
static struct action_queue g_actions, g_display;
static bool g_started, g_vm_active, g_buttons_listening;

static int now_ms(uint64_t *value)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return -(errno ? errno : EIO);
  if (now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000L) return -EIO;
  *value = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
  return 0;
}

static void pause_ms(unsigned milliseconds)
{
  struct timespec delay = {milliseconds / 1000, (long)(milliseconds % 1000) * 1000000};
  while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {}
}

/* 所有队列都受同一短锁保护；硬件访问和 JS/屏幕操作不能持有此锁。 */
static void dispatch_action(const struct px_system_key_request *request)
{
  struct px_system_key_request item = *request;
  struct action_queue *queue = item.action == PX_SYSTEM_KEY_TOGGLE_SCREEN ? &g_display : &g_actions;
  if (queue == &g_display && !g_vm_active) {
    item.result = -ENODEV;
  } else if (queue->count == PX_SYSTEM_KEYS_ACTION_CAPACITY) {
    queue->error = item.result = -EOVERFLOW;
    ++g_status.overflows;
  } else {
    queue->entries[(queue->head + queue->count) % PX_SYSTEM_KEYS_ACTION_CAPACITY] = item;
    ++queue->count;
  }
  g_status.last_request = item;
  if (item.result < 0)
    syslog(LOG_ERR, "syskeys: %s failed (%d)\n", px_system_keys_action_name(item.action), item.result);
}

static void dispatch_event(const struct px_button_event *event, uint64_t now)
{
  pthread_mutex_lock(&g_lock);
  if (g_vm_active && g_buttons_listening) {
    if (g_event_count == PX_SYSTEM_KEYS_BUTTON_CAPACITY) {
      g_event_error = -EOVERFLOW;
      ++g_status.overflows;
    } else {
      g_events[(g_event_head + g_event_count) % PX_SYSTEM_KEYS_BUTTON_CAPACITY] = *event;
      ++g_event_count;
    }
  }
  struct px_system_key_request request;
  int result = px_system_keys_feed(&g_state, event, now, &request);
  if (result == 1) dispatch_action(&request);
  else if (result < 0) g_status.hardware_error = result;
  pthread_mutex_unlock(&g_lock);
}

static int sample_once(uint64_t now, bool poll_power)
{
  int failure = 0;
  for (unsigned index = 0; index < 2; ++index) {
    bool pressed = false;
    int result = pixelbox_board_button_read(index, &pressed);
    struct px_button_event event;
    if (!result) result = px_button_feed(&g_buttons[index], pressed, now, &event);
    if (result == 1) dispatch_event(&event, now);
    else if (result < 0 && !failure) failure = result;
  }
  if (poll_power) {
    struct px_button_event event;
    int result = px_power_poll_key(&event);
    if (result == 1) dispatch_event(&event, now);
    else if (result < 0 && !failure) failure = result;
  }
  pthread_mutex_lock(&g_lock);
  struct px_system_key_request request;
  int result = px_system_keys_tick(&g_state, now, &request);
  if (result == 1) dispatch_action(&request);
  else if (result < 0 && !failure) failure = result;
  /* 成功的纯 GPIO 轮询不能掩盖上一轮 PMU 读错。 */
  if (failure || poll_power) g_status.hardware_error = failure;
  pthread_mutex_unlock(&g_lock);
  return failure;
}

static int keys_worker(int argc, char **argv)
{
  (void)argc; (void)argv;
  uint32_t handle = 0;
  int result = px_watchdog_register(&handle);
  pthread_mutex_lock(&g_lock);
  g_status.running = result == 0;
  g_status.error = result;
  pthread_mutex_unlock(&g_lock);
  uint64_t last_power = 0;
  bool have_power_sample = false;
  while (!result) {
    result = px_watchdog_begin(handle);
    if (result < 0) break;
    uint64_t now;
    result = now_ms(&now);
    if (result < 0) break;
    bool poll_power = !have_power_sample || now - last_power >= 200;
    /* begin 后才能进入 GPIO/I2C；若 I2C 卡住，end 永远不会伪造进展。 */
    (void)sample_once(now, poll_power);
    if (poll_power) { last_power = now; have_power_sample = true; }
    result = px_watchdog_end(handle);
    if (result < 0) break;
    pause_ms(5);
  }
  pthread_mutex_lock(&g_lock);
  g_status.running = false;
  g_status.error = result;
  pthread_mutex_unlock(&g_lock);
  /* 故障后仍为 busy 的 handle 不能注销掉，交给监督任务判定/复位。 */
  if (handle) (void)px_watchdog_unregister(handle);
  return result;
}

int px_system_keys_start(void)
{
  pthread_mutex_lock(&g_lock);
  bool create = !g_started;
  if (create) {
    g_started = true;
    g_status.error = -EINPROGRESS;
    px_system_keys_state_init(&g_state);
    px_button_state_init(&g_buttons[0], PX_BUTTON_BOOT);
    px_button_state_init(&g_buttons[1], PX_BUTTON_USER);
  }
  pthread_mutex_unlock(&g_lock);
  if (create) {
    int pid = kthread_create("px-keys", 110, 4096, keys_worker, NULL);
    if (pid < 0) {
      /* kthread_create 直接返回负 errno，不能读取调用线程残留的 errno。 */
      int result = pid;
      pthread_mutex_lock(&g_lock);
      g_status.error = result;
      pthread_mutex_unlock(&g_lock);
      return result;
    }
  }
  for (unsigned i = 0; i < 200; ++i) {
    pthread_mutex_lock(&g_lock);
    int result = g_status.running ? 0 : g_status.error;
    pthread_mutex_unlock(&g_lock);
    if (result != -EINPROGRESS) return result;
    pause_ms(10);
  }
  return -EINPROGRESS;
}

int px_system_keys_get_status(struct px_system_keys_status *status)
{
  if (!status) return -EINVAL;
  pthread_mutex_lock(&g_lock);
  *status = g_status;
  pthread_mutex_unlock(&g_lock);
  return 0;
}

bool px_system_keys_buttons_available(void)
{
  pthread_mutex_lock(&g_lock);
  bool running = g_status.running;
  pthread_mutex_unlock(&g_lock);
  return running;
}

void px_system_keys_set_settings(bool in_settings)
{
  pthread_mutex_lock(&g_lock);
  g_state.in_settings = in_settings;
  pthread_mutex_unlock(&g_lock);
}
void px_system_keys_set_provisioning_enabled(bool enabled)
{
  pthread_mutex_lock(&g_lock);
  g_state.provisioning_enabled = enabled;
  if (!enabled) g_state.in_provisioning = false;
  pthread_mutex_unlock(&g_lock);
}
void px_system_keys_set_provisioning_active(bool active)
{
  pthread_mutex_lock(&g_lock);
  g_state.in_provisioning = active && g_state.provisioning_enabled;
  pthread_mutex_unlock(&g_lock);
}

static int take_action(struct action_queue *queue, struct px_system_key_request *request)
{
  if (!request) return -EINVAL;
  memset(request, 0, sizeof(*request));
  pthread_mutex_lock(&g_lock);
  int result = 0;
  if (queue->error) {
    result = queue->error;
    queue->error = 0;
  } else if (queue->count) {
    *request = queue->entries[queue->head];
    queue->head = (queue->head + 1) % PX_SYSTEM_KEYS_ACTION_CAPACITY;
    --queue->count;
    result = 1;
  } else if (!g_status.running) result = g_status.error ? g_status.error : -ENODEV;
  pthread_mutex_unlock(&g_lock);
  return result;
}

int px_system_keys_next_action(struct px_system_key_request *request)
{ return take_action(&g_actions, request); }
int px_system_keys_next_display(struct px_system_key_request *request)
{ return take_action(&g_display, request); }

static void set_vm(bool active)
{
  pthread_mutex_lock(&g_lock);
  g_vm_active = active;
  g_buttons_listening = false;
  g_event_head = g_event_count = 0;
  g_event_error = 0;
  memset(&g_display, 0, sizeof(g_display));
  pthread_mutex_unlock(&g_lock);
}

void px_system_keys_vm_reset(void) { set_vm(true); }
void px_system_keys_vm_detach(void) { set_vm(false); }

int px_system_keys_listen_buttons(bool enabled)
{
  pthread_mutex_lock(&g_lock);
  int result = enabled && !g_vm_active ? -ENODEV : 0;
  if (!result && enabled != g_buttons_listening) {
    g_buttons_listening = enabled;
    g_event_head = g_event_count = 0;
    g_event_error = 0;
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

int px_system_keys_read_buttons(struct px_button_event *events, size_t capacity)
{
  if (!events || !capacity || capacity > PX_SYSTEM_KEYS_BUTTON_CAPACITY) return -EINVAL;
  pthread_mutex_lock(&g_lock);
  int result = 0;
  if (!g_vm_active) result = -ENODEV;
  else if (g_event_error) { result = g_event_error; g_event_error = 0; }
  else {
    while (g_event_count && (size_t)result < capacity) {
      events[result++] = g_events[g_event_head];
      g_event_head = (g_event_head + 1) % PX_SYSTEM_KEYS_BUTTON_CAPACITY;
      --g_event_count;
    }
    if (!result && !g_status.running) result = g_status.error ? g_status.error : -ENODEV;
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

#ifdef PX_SYSTEM_KEYS_TEST
/* 测试注入使用同一分发路径，只用于确定时序/队列容量验证。 */
void px_system_keys_test_inject(const struct px_button_event *event, uint64_t now)
{ dispatch_event(event, now); }
#endif

#else
int px_system_keys_start(void) { return -ENOTSUP; }
int px_system_keys_get_status(struct px_system_keys_status *status)
{
  if (!status) return -EINVAL;
  memset(status, 0, sizeof(*status));
  status->error = -ENOTSUP;
  return 0;
}
bool px_system_keys_buttons_available(void) { return false; }
void px_system_keys_set_settings(bool in_settings) { (void)in_settings; }
void px_system_keys_set_provisioning_enabled(bool enabled) { (void)enabled; }
void px_system_keys_set_provisioning_active(bool active) { (void)active; }
void px_system_keys_vm_reset(void) {}
void px_system_keys_vm_detach(void) {}
int px_system_keys_listen_buttons(bool enabled) { (void)enabled; return -ENOTSUP; }
int px_system_keys_read_buttons(struct px_button_event *events, size_t capacity)
{ (void)events; (void)capacity; return -ENOTSUP; }
int px_system_keys_next_action(struct px_system_key_request *request)
{ (void)request; return -ENOTSUP; }
int px_system_keys_next_display(struct px_system_key_request *request)
{ (void)request; return -ENOTSUP; }
#endif
