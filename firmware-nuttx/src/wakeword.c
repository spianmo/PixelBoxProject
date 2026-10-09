/* 独立任务拥有全部 MN7 状态；JS 只投递 PCM 和轮询事件，绝不跨线程访问 VM。 */
#include "pixelbox_wakeword.h"
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#if defined(PX_MULTINET7) || defined(PX_WAKEWORD_TEST)
#include "pixelbox_mn7_abi.h"
#include "pixelbox_mn7_memory.h"
#include "pixelbox_audio_worker.h"
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#include <syslog.h>
#ifdef __NuttX__
#include <nuttx/config.h>
#include <malloc.h>
/* 当前NuttX上下文不逐任务保存CPENABLE；启动时必须统一启用CP0和MN7的CP3。
 * 任务内切换此寄存器会影响同核其它任务，SMP迁移后也不能保证目标核已启用。 */
#if !defined(CONFIG_XTENSA_CP_INITSET) || CONFIG_XTENSA_CP_INITSET != 0x0009
#error "MultiNet7 requires CONFIG_XTENSA_CP_INITSET=0x0009 (CP0 and CP3)"
#endif
#endif

/* 与 VM 同级轮转，使同步模型初始化和 JS 定时器都能推进；栈保留在内部 RAM。 */
enum { RATE = 16000, QUEUE = 8192, MAX_PENDING = 2560, STACK = 16384,
       WORKER_PRIORITY = 100 };
#ifndef PX_WAKEWORD_AUDIO_TIMEOUT_MS
#define PX_WAKEWORD_AUDIO_TIMEOUT_MS 3000u
#endif
static struct {
  pthread_mutex_t lock;
  pthread_cond_t wake;
  bool busy, stopped, ready, discontinuity;
  uint32_t sequence, job;
  char pinyin[64];
  float threshold;
  int16_t *queue;
  size_t begin, used;
  uint64_t last_audio;
  struct px_wakeword_event events[2];
  unsigned event_begin, event_used;
} state = {.lock = PTHREAD_MUTEX_INITIALIZER, .wake = PTHREAD_COND_INITIALIZER};

static uint64_t now_ms(void)
{
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (unsigned long)t.tv_nsec / 1000000;
}
static void wait_tick(void)
{
  struct timespec t; clock_gettime(CLOCK_REALTIME, &t); t.tv_nsec += 50000000;
  if (t.tv_nsec >= 1000000000L) { ++t.tv_sec; t.tv_nsec -= 1000000000L; }
  pthread_cond_timedwait(&state.wake, &state.lock, &t);
}
static void event_locked(int kind, int error, float probability)
{
  /* 只有 READY 和单个终止事件；消费者未轮询 READY 时也不覆盖它。 */
  if (state.event_used < 2) {
    unsigned slot = (state.event_begin + state.event_used++) % 2;
    state.events[slot] = (struct px_wakeword_event){state.job, kind, error, probability};
  }
}
static bool stopped(void)
{
  pthread_mutex_lock(&state.lock); bool value = state.stopped; pthread_mutex_unlock(&state.lock); return value;
}
static bool candidate(const esp_mn_iface_t *api, model_iface_data_t *model, float threshold, float *probability)
{
  const esp_mn_results_t *r = api->get_results(model);
  if (!r || r->num < 1 || r->num > 5 || r->command_id[0] != 1 ||
      !isfinite(r->prob[0]) || r->prob[0] < threshold || r->prob[0] > 1.0f) return false;
  *probability = r->prob[0]; return true;
}
static int16_t *aligned_samples(size_t samples)
{
  return px_mn7_malloc(samples * sizeof(int16_t));
}

struct model_session {
  struct px_audio_worker_guard *guard;
  bool detected;
  float probability;
};
static int run_model(void *argument)
{
  struct model_session *session = argument;
  struct px_audio_worker_guard *guard = session->guard;
  const esp_mn_iface_t *api = NULL;
  model_iface_data_t *model = NULL;
  int16_t *frame = NULL, *history = NULL;
  int result = 0;
  bool detected = false; float probability = 0;
  if (stopped()) goto done;
  uint64_t stage_started = now_ms();
  syslog(LOG_INFO, "[pixelbox] mn7 stage=model-load begin handle=%lu\n", (unsigned long)guard->handle);
  result = px_mn7_model_builtin();
  syslog(LOG_INFO, "[pixelbox] mn7 stage=model-load result=%d elapsed=%llums\n",
         result, (unsigned long long)(now_ms() - stage_started));
  if (result < 0) goto done;
  result = px_audio_worker_progress(guard);
  if (result < 0 || stopped()) goto done;
  api = esp_mn_handle_from_name("mn7_cn");
  if (!api || !api->create || !api->destroy || !api->detect || !api->get_results ||
      !api->get_samp_rate || !api->get_samp_chunksize || !api->set_det_threshold || !api->clean) { result = -ENOTSUP; goto done; }
  /* create() 是第三方同步初始化，真机实测最长 259 秒且期间没有可报告的
   * 音频进展。暂时结束本 worker 的健康槽，让独立看门狗继续喂硬件；
   * create 返回后立即重新开始监督。这样不会把同步初始化误判为线程卡死，
   * 同时硬件 60 秒期限仍能兜底真正失控。 */
  result = px_audio_worker_idle(guard);
  if (result < 0) goto done;
  stage_started = now_ms();
  syslog(LOG_INFO, "[pixelbox] mn7 stage=create begin handle=%lu\n", (unsigned long)guard->handle);
  model = api->create("mn7_cn", 6000);
  syslog(LOG_INFO, "[pixelbox] mn7 stage=create result=%d elapsed=%llums\n",
         model ? 0 : -ENOMEM, (unsigned long long)(now_ms() - stage_started));
  if (!model) { result = -ENOMEM; goto done; }
  result = px_audio_worker_watch(guard);
  if (result < 0) goto done;
  result = px_audio_worker_progress(guard);
  if (result < 0 || stopped()) goto done;
  int chunk = api->get_samp_chunksize(model);
  if (api->get_samp_rate(model) != RATE || chunk < 1 || chunk > 4096) { result = -EPROTO; goto done; }
  stage_started = now_ms();
  syslog(LOG_INFO, "[pixelbox] mn7 stage=commands begin handle=%lu\n", (unsigned long)guard->handle);
  int commands_result = esp_mn_commands_alloc(api, model);
  if (!commands_result) commands_result = esp_mn_commands_clear();
  if (!commands_result) commands_result = esp_mn_commands_add(1, state.pinyin);
  if (!commands_result && esp_mn_commands_update()) commands_result = -EINVAL;
  syslog(LOG_INFO, "[pixelbox] mn7 stage=commands result=%d elapsed=%llums\n",
         commands_result, (unsigned long long)(now_ms() - stage_started));
  if (commands_result) { result = -EINVAL; goto done; }
  /* ESP-SR 返回截断后的 logf(threshold)，合法阈值小于 1 时也可为负数。 */
  int threshold_result = api->set_det_threshold(model, state.threshold);
  syslog(LOG_INFO, "[pixelbox] mn7 stage=threshold value=%d\n", threshold_result);
  size_t capacity = (RATE / 5 + (size_t)chunk - 1) / (size_t)chunk;
  frame = aligned_samples((size_t)chunk);
  history = aligned_samples(capacity * (size_t)chunk);
  if (!frame || !history) { result = -ENOMEM; goto done; }
  size_t history_next = 0, history_used = 0, quiet = 0;
  result = px_audio_worker_progress(guard);
  if (result < 0 || stopped()) goto done;
  pthread_mutex_lock(&state.lock);
  /* stop可在上一次stopped检查后到达；READY提交必须与取消保持同一锁。 */
  if (state.stopped) { pthread_mutex_unlock(&state.lock); goto done; }
  state.ready = true; state.last_audio = now_ms(); event_locked(PX_WAKEWORD_READY, 0, 0);
  pthread_mutex_unlock(&state.lock);
  while (!stopped()) {
    result = px_audio_worker_idle(guard); if (result < 0) break;
    pthread_mutex_lock(&state.lock);
    while (!state.stopped && state.used < (size_t)chunk && now_ms() - state.last_audio < PX_WAKEWORD_AUDIO_TIMEOUT_MS) wait_tick();
    if (state.stopped) { pthread_mutex_unlock(&state.lock); break; }
    if (now_ms() - state.last_audio >= PX_WAKEWORD_AUDIO_TIMEOUT_MS) { pthread_mutex_unlock(&state.lock); result = -ETIMEDOUT; break; }
    bool reset = state.discontinuity;
    state.discontinuity = false;
    /* 最多保留160ms旧前缀；丢弃后重置模型，禁止拼接跨缺口的句子。 */
    size_t pending_limit = MAX_PENDING > chunk ? MAX_PENDING : (size_t)chunk;
    if (state.used > pending_limit) {
      size_t discard = state.used - pending_limit;
      state.begin = (state.begin + discard) % QUEUE; state.used -= discard; reset = true;
    }
    for (int i = 0; i < chunk; ++i) frame[i] = state.queue[(state.begin + (size_t)i) % QUEUE];
    state.begin = (state.begin + (size_t)chunk) % QUEUE; state.used -= (size_t)chunk;
    pthread_mutex_unlock(&state.lock);
    result = px_audio_worker_watch(guard); if (result < 0) break;
    if (reset) { api->clean(model); history_next = history_used = quiet = 0; }
    uint64_t energy = 0;
    for (int i = 0; i < chunk; ++i) energy += (uint64_t)((int64_t)frame[i] * frame[i]);
    bool boundary = energy > (uint64_t)128 * 128 * (unsigned)chunk && quiet >= RATE / 2;
    if (energy <= (uint64_t)128 * 128 * (unsigned)chunk) {
      quiet += (size_t)chunk; if (quiet > RATE / 2) quiet = RATE / 2;
    } else quiet = 0;
    if (boundary) {
      api->clean(model);
      for (size_t i = 0; i < history_used && !stopped(); ++i) {
        size_t slot = (history_next + capacity - history_used + i) % capacity;
        esp_mn_state_t value = api->detect(model, history + slot * (size_t)chunk);
        result = px_audio_worker_progress(guard); if (result < 0) break;
        if (value == ESP_MN_STATE_DETECTED && candidate(api, model, state.threshold, &probability)) { detected = true; break; }
        if (value != ESP_MN_STATE_DETECTING) api->clean(model);
      }
      if (detected || result < 0 || stopped()) break;
    }
    esp_mn_state_t value = api->detect(model, frame);
    result = px_audio_worker_progress(guard); if (result < 0) break;
    if (value == ESP_MN_STATE_DETECTED && candidate(api, model, state.threshold, &probability)) { detected = true; break; }
    if (value != ESP_MN_STATE_DETECTING) {
      if (value != ESP_MN_STATE_DETECTED && value != ESP_MN_STATE_TIMEOUT) { result = -EPROTO; break; }
      api->clean(model); history_next = history_used = quiet = 0;
    }
    memcpy(history + history_next * (size_t)chunk, frame, (size_t)chunk * sizeof(int16_t));
    history_next = (history_next + 1) % capacity; if (history_used < capacity) ++history_used;
    usleep(1000);
  }
done:
  /* 模型、命令表和只读映射必须按此顺序释放；destroy 内部也会 free commands。 */
  if (model) {
    int health = px_audio_worker_watch(guard); if (!result && health < 0) result = health;
    api->destroy(model);
    int progress = px_audio_worker_progress(guard); if (!result && progress < 0) result = progress;
  }
  esp_mn_commands_free(); px_mn7_model_unload(); px_mn7_free(frame); px_mn7_free(history);
  session->detected = detected; session->probability = probability;
  return result;
}
static void *worker(void *unused)
{
  (void)unused;
  struct px_audio_worker_guard guard = {0};
  struct model_session session = {.guard = &guard};
  struct px_mn7_memory_stats stats = {0};
  int result = px_audio_worker_guard_open(&guard);
  if (!result && !stopped()) result = px_mn7_memory_run(run_model, &session, &stats);
  int health = px_audio_worker_guard_close(&guard); if (!result && health < 0) result = health;
  syslog(LOG_INFO, "[pixelbox] mn7 memory result=%d budget=%zu initial=%zu heap_peak=%zu free=%zu largest=%zu psram_peak=%zu internal_peak=%zu overhead_peak=%zu failed_size=%zu failed_caps=%lx reclaimed=%zu cleanup=%d\n",
         result, stats.budget, stats.heap_initial, stats.heap_peak, stats.heap_free, stats.heap_largest, stats.psram_peak, stats.internal_peak,
         stats.overhead_peak, stats.failed_size, (unsigned long)stats.failed_caps, stats.reclaimed, stats.cleanup_error);
  pthread_mutex_lock(&state.lock);
  free(state.queue); state.queue = NULL; state.used = state.begin = 0;
  state.ready = false; state.busy = false;
  if (!state.stopped) {
    if (result < 0) event_locked(PX_WAKEWORD_ERROR, result, 0);
    else if (session.detected) event_locked(PX_WAKEWORD_DETECTED, 0, session.probability);
  }
  pthread_cond_broadcast(&state.wake); pthread_mutex_unlock(&state.lock);
  return NULL;
}
#ifdef PX_AUDIO_INDEPENDENT_WORKER
static int worker_task(int argc, char **argv) { (void)argc; (void)argv; worker(NULL); return 0; }
#endif

bool px_wakeword_available(void) { return true; }
bool px_wakeword_busy(void)
{
  pthread_mutex_lock(&state.lock); bool busy = state.busy; pthread_mutex_unlock(&state.lock); return busy;
}
int px_wakeword_start(const char *pinyin, float threshold, uint32_t *job_id)
{
  if (!pinyin || !job_id || !isfinite(threshold) || threshold < 0 || threshold > .9999f) return -EINVAL;
  size_t n = strlen(pinyin); if (n < 2 || n >= sizeof(state.pinyin)) return -EINVAL;
  for (size_t i = 0; i < n; ++i)
    if (!(pinyin[i] >= 'a' && pinyin[i] <= 'z') &&
        !(pinyin[i] == ' ' && i && i + 1 < n && pinyin[i - 1] != ' ')) return -EINVAL;
  pthread_mutex_lock(&state.lock);
  if (state.busy) { pthread_mutex_unlock(&state.lock); return -EBUSY; }
  state.queue = malloc(QUEUE * sizeof(int16_t));
  if (!state.queue) { pthread_mutex_unlock(&state.lock); return -ENOMEM; }
  strcpy(state.pinyin, pinyin); state.threshold = threshold;
  if (!++state.sequence) ++state.sequence;
  state.job = state.sequence; state.busy = true; state.stopped = state.ready = state.discontinuity = false;
  state.used = state.begin = 0; state.event_used = state.event_begin = 0;
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  int pid = kthread_create("px-wakeword", WORKER_PRIORITY, STACK, worker_task, NULL);
  int error = pid < 0 ? -pid : 0;
#else
  pthread_t thread; pthread_attr_t attr; pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int error = pthread_create(&thread, &attr, worker, NULL); pthread_attr_destroy(&attr);
#endif
  if (error) { free(state.queue); state.queue = NULL; state.busy = false; }
  else *job_id = state.job;
  pthread_mutex_unlock(&state.lock); return -error;
}
int px_wakeword_feed(uint32_t id, const uint8_t *pcm, size_t bytes)
{
  if (!pcm || !bytes || bytes % 2 || bytes > QUEUE * 2) return -EINVAL;
  pthread_mutex_lock(&state.lock);
  int result = 0;
  if (id != state.job || state.stopped) result = -ECANCELED;
  else if (!state.ready) {
    /* 推理任务已结束，但JS可能先收到最后一帧PCM、随后才轮询终止事件。
     * 此窗口丢弃同一任务的音频，保留真实唤醒/错误；不能伪报取消吞掉事件。 */
    bool terminal_pending = false;
    for (unsigned i = 0; i < state.event_used; ++i) {
      int kind = state.events[(state.event_begin + i) % 2].kind;
      if (kind == PX_WAKEWORD_DETECTED || kind == PX_WAKEWORD_ERROR) terminal_pending = true;
    }
    if (!terminal_pending) result = -ECANCELED;
  }
  else {
    size_t samples = bytes / 2;
    if (samples > QUEUE - state.used) { state.begin = state.used = 0; state.discontinuity = true; }
    for (size_t i = 0; i < samples; ++i)
      state.queue[(state.begin + state.used + i) % QUEUE] = (int16_t)(pcm[2 * i] | (uint16_t)pcm[2 * i + 1] << 8);
    state.used += samples; state.last_audio = now_ms(); pthread_cond_signal(&state.wake);
  }
  pthread_mutex_unlock(&state.lock); return result;
}
int px_wakeword_poll(struct px_wakeword_event *event)
{
  if (!event) return -EINVAL;
  pthread_mutex_lock(&state.lock); int result = state.event_used != 0;
  if (result) { *event = state.events[state.event_begin]; state.event_begin = (state.event_begin + 1) % 2; --state.event_used; }
  pthread_mutex_unlock(&state.lock); return result;
}
void px_wakeword_stop(uint32_t id)
{
  pthread_mutex_lock(&state.lock);
  if (!id || id == state.job) {
    state.stopped = true; state.ready = false; state.event_used = 0;
    pthread_cond_broadcast(&state.wake);
  }
  pthread_mutex_unlock(&state.lock);
}
int px_wakeword_quiesce(unsigned timeout_ms)
{
  uint64_t deadline = now_ms() + timeout_ms;
  pthread_mutex_lock(&state.lock);
  while (state.busy && now_ms() < deadline) wait_tick();
  int result = state.busy ? -ETIMEDOUT : 0; pthread_mutex_unlock(&state.lock); return result;
}
#else
bool px_wakeword_available(void) { return false; }
bool px_wakeword_busy(void) { return false; }
int px_wakeword_start(const char *p, float t, uint32_t *id) { (void)p; (void)t; (void)id; return -ENOTSUP; }
int px_wakeword_feed(uint32_t id, const uint8_t *p, size_t n) { (void)id; (void)p; (void)n; return -ENOTSUP; }
int px_wakeword_poll(struct px_wakeword_event *e) { (void)e; return 0; }
void px_wakeword_stop(uint32_t id) { (void)id; }
int px_wakeword_quiesce(unsigned ms) { (void)ms; return 0; }
#endif
