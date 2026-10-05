/* ES7210 采集：worker/驱动回调只处理 C 内存，JS 通过 poll 收取完整帧。 */
#include "pixelbox_mic.h"
#include "pixelbox_audio.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if defined(__NuttX__)
#  include <syslog.h>
#endif

#if defined(PX_MIC_TEST)
#  include "mic_test_platform.h"
#  define PX_MIC_PLATFORM 1
#elif defined(__NuttX__)
#  include <nuttx/config.h>
#  if defined(CONFIG_AUDIO) && defined(CONFIG_ESP32S3_I2S0_RX)
#    include <nuttx/audio/audio.h>
#    include <nuttx/audio/i2s.h>
#    include <nuttx/clock.h>
#    define PX_MIC_PLATFORM 1
#  endif
#endif

#ifdef PX_MIC_PLATFORM

#include "pixelbox_audio_worker.h"

#include <pthread.h>
#include <time.h>

#define MIC_INPUT_RATE 16000u
#define MIC_DMA_BYTES 2048u
#define MIC_DMA_COUNT 2u
#define MIC_QUEUE_MS 1000u
#ifndef PX_MIC_TIMEOUT_MS
#  define PX_MIC_TIMEOUT_MS 1000u
#endif

struct mic_slot {
  struct ap_buffer_s *buffer;
  bool in_flight;
  bool ready;
  int error;
  uint64_t sequence;
};

static struct {
  pthread_mutex_t lock;
  pthread_cond_t wake;
  bool busy;
  bool stop;
  bool running;
  int gain;
  int error;
  unsigned rate;
  size_t frame_bytes;
  size_t queue_frames;
  const char *stage;
  uint8_t *queue;
  uint8_t *partial;
  size_t partial_used;
  size_t queue_read;
  size_t queue_used;
  uint64_t input_index;
  uint64_t output_phase;
  uint64_t deadline;
  uint64_t submitted;
  int16_t previous;
  bool have_previous;
  struct i2s_dev_s *device;
  struct mic_slot slots[MIC_DMA_COUNT];
} g_mic = {
  .lock = PTHREAD_MUTEX_INITIALIZER, .wake = PTHREAD_COND_INITIALIZER, .gain = 70
};

static uint64_t now_ms(void)
{
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 + (unsigned long)value.tv_nsec / 1000000;
}

static void wait_until(struct timespec *value)
{
  clock_gettime(CLOCK_REALTIME, value);
  value->tv_nsec += 50000000;
  if (value->tv_nsec >= 1000000000L) { ++value->tv_sec; value->tv_nsec -= 1000000000L; }
}

static bool valid_rate(unsigned rate)
{
  return rate == 8000 || rate == 16000 || rate == 24000 || rate == 32000 ||
         rate == 44100 || rate == 48000;
}

static void fail_locked(int error)
{
  if (!g_mic.stop && !g_mic.error) {
    g_mic.error = error;
#ifdef __NuttX__
    /* 每次会话只记录首个失败阶段，便于区分板级初始化、DMA 与消费积压。 */
    syslog(LOG_ERR, "[pixelbox] mic failure stage=%s error=%d queued=%u submitted=%llu\n",
           g_mic.stage ? g_mic.stage : "start", error,
           (unsigned)g_mic.queue_used, (unsigned long long)g_mic.submitted);
#endif
  }
  g_mic.stop = true;
  g_mic.running = false;
}

static void captured(struct i2s_dev_s *device, struct ap_buffer_s *buffer,
                      void *argument, int result)
{
  (void)device;
  struct mic_slot *slot = argument;
  pthread_mutex_lock(&g_mic.lock);
  if (slot->buffer == buffer && slot->in_flight) {
    slot->in_flight = false;
    slot->ready = true;
    slot->error = result < 0 ? result : result ? -EIO : 0;
    g_mic.deadline = now_ms() + PX_MIC_TIMEOUT_MS;
    pthread_cond_broadcast(&g_mic.wake);
  }
  pthread_mutex_unlock(&g_mic.lock);
}

static int append_locked(int16_t sample)
{
  g_mic.partial[g_mic.partial_used++] = (uint8_t)sample;
  g_mic.partial[g_mic.partial_used++] = (uint8_t)((uint16_t)sample >> 8);
  if (g_mic.partial_used == g_mic.frame_bytes) {
    /* 回调处理不及时必须报溢出，不能把丢帧伪装成完整录音。 */
    if (g_mic.queue_used == g_mic.queue_frames) return -EOVERFLOW;
    size_t write = (g_mic.queue_read + g_mic.queue_used) % g_mic.queue_frames;
    memcpy(g_mic.queue + write * g_mic.frame_bytes, g_mic.partial, g_mic.frame_bytes);
    ++g_mic.queue_used;
    g_mic.partial_used = 0;
  }
  return 0;
}

static int convert_locked(const struct ap_buffer_s *buffer)
{
  if (!buffer->nbytes || buffer->curbyte > buffer->nbytes ||
      buffer->nbytes > buffer->nmaxbytes || (buffer->nbytes - buffer->curbyte) % 4)
    return -EPROTO;
  for (size_t i = buffer->curbyte; i < buffer->nbytes; i += 4) {
    /* MIC1 位于左声道；保持与原 ESP-IDF 单声道读取一致。 */
    int16_t current = (int16_t)(buffer->samp[i] | (uint16_t)buffer->samp[i + 1] << 8);
    /* 物理和请求采样率相同时直接提取左声道，避免每样本64位插值除法。 */
    if (g_mic.rate == MIC_INPUT_RATE) {
      int error = append_locked(current);
      if (error) return error;
      continue;
    }
    if (!g_mic.have_previous) {
      g_mic.have_previous = true;
      g_mic.previous = current;
      g_mic.input_index = 0;
      g_mic.output_phase = MIC_INPUT_RATE;
      int error = append_locked(current);
      if (error) return error;
      continue;
    }
    ++g_mic.input_index;
    uint64_t right = g_mic.input_index * g_mic.rate;
    uint64_t left = right - g_mic.rate;
    while (g_mic.output_phase <= right) {
      uint64_t fraction = g_mic.output_phase - left;
      int64_t mixed = (int64_t)g_mic.previous * (int64_t)(g_mic.rate - fraction) +
                      (int64_t)current * (int64_t)fraction;
      int error = append_locked((int16_t)(mixed / g_mic.rate));
      if (error) return error;
      g_mic.output_phase += MIC_INPUT_RATE;
    }
    g_mic.previous = current;
  }
  return 0;
}

static int submit(struct mic_slot *slot)
{
  pthread_mutex_lock(&g_mic.lock);
  if (g_mic.stop) { pthread_mutex_unlock(&g_mic.lock); return 0; }
  g_mic.stage = "submit";
  slot->buffer->nbytes = 0;
  slot->buffer->curbyte = 0;
  slot->buffer->flags = 0;
  slot->ready = false;
  slot->in_flight = true;
  slot->sequence = g_mic.submitted++;
  pthread_mutex_unlock(&g_mic.lock);
  int result = I2S_RECEIVE(g_mic.device, slot->buffer, captured, slot,
                           MSEC2TICK(PX_MIC_TIMEOUT_MS));
  if (result < 0) {
    pthread_mutex_lock(&g_mic.lock);
    slot->in_flight = false;
    fail_locked(result);
    pthread_mutex_unlock(&g_mic.lock);
  }
  return result;
}

static void *mic_worker(void *unused)
{
  (void)unused;
  bool cancelled = false;
  bool prepared = false;
  struct px_audio_worker_guard guard = {0};
  int result = px_audio_worker_guard_open(&guard);
  pthread_mutex_lock(&g_mic.lock);
  if (result < 0) fail_locked(result);
  bool stop = g_mic.stop;
  int applied_gain = g_mic.gain;
  g_mic.stage = "prepare";
  pthread_mutex_unlock(&g_mic.lock);
  if (stop) goto done;
  /* prepare 会访问 I2C/I2S，必须在独立 worker 内完成，不能让 VM 持锁
   * 等硬件，更不能随 VM task group 退出而遗留一半初始化的设备。
   */
  prepared = true;
  result = pixelbox_board_mic_prepare(MIC_INPUT_RATE, applied_gain, &g_mic.device);
  pthread_mutex_lock(&g_mic.lock);
  if (result < 0 || !g_mic.device) fail_locked(result < 0 ? result : -ENODEV);
  g_mic.deadline = now_ms() + PX_MIC_TIMEOUT_MS;
  stop = g_mic.stop;
  pthread_mutex_unlock(&g_mic.lock);
  if (stop) goto done;
  for (unsigned i = 0; i < MIC_DMA_COUNT; ++i) {
    g_mic.stage = "allocate";
    /* I2S 驱动负责内部 SRAM bounce；APB 可以在普通堆中。 */
    struct audio_buf_desc_s desc = {.numbytes = MIC_DMA_BYTES};
    desc.u.pbuffer = &g_mic.slots[i].buffer;
    result = apb_alloc(&desc);
    if (result < 0 || !g_mic.slots[i].buffer) {
      pthread_mutex_lock(&g_mic.lock);
      fail_locked(result < 0 ? result : -ENOMEM);
      pthread_mutex_unlock(&g_mic.lock);
      break;
    }
  }
  for (unsigned i = 0; i < MIC_DMA_COUNT; ++i)
    if (g_mic.slots[i].buffer) submit(&g_mic.slots[i]);

  for (;;) {
    pthread_mutex_lock(&g_mic.lock);
    g_mic.stage = "capture";
    if (!g_mic.stop && now_ms() >= g_mic.deadline) fail_locked(-ETIMEDOUT);
    bool in_flight = false;
    int oldest = -1;
    for (unsigned i = 0; i < MIC_DMA_COUNT; ++i) {
      in_flight |= g_mic.slots[i].in_flight;
      if ((g_mic.slots[i].ready || g_mic.slots[i].in_flight) &&
          (oldest < 0 || g_mic.slots[i].sequence < g_mic.slots[oldest].sequence))
        oldest = (int)i;
    }
    if (g_mic.stop && !in_flight) {
      pthread_mutex_unlock(&g_mic.lock);
      break;
    }
    if (g_mic.stop && in_flight && !cancelled) {
      cancelled = true;
      pthread_mutex_unlock(&g_mic.lock);
      /* 驱动将 active/pending 回调为 ECANCELED，随后才能释放 APB。 */
      pixelbox_board_mic_cancel();
      /* cancel 返回只代表请求已提交；DMA 回调未全到齐时不报告进展。 */
      continue;
    }
    int desired_gain = g_mic.gain;
    if (!g_mic.stop && desired_gain != applied_gain) {
      g_mic.stage = "gain";
      pthread_mutex_unlock(&g_mic.lock);
      result = pixelbox_board_mic_set_gain(desired_gain);
      pthread_mutex_lock(&g_mic.lock);
      if (result < 0) fail_locked(result);
      else applied_gain = desired_gain;
      pthread_mutex_unlock(&g_mic.lock);
      continue;
    }
    int ready = oldest >= 0 && g_mic.slots[oldest].ready ? oldest : -1;
    if (!g_mic.stop && ready >= 0) {
      struct mic_slot *slot = &g_mic.slots[ready];
      g_mic.stage = slot->error ? "callback" : "convert";
      int error = slot->error ? slot->error : convert_locked(slot->buffer);
      slot->ready = false;
      if (error) fail_locked(error);
      pthread_mutex_unlock(&g_mic.lock);
      if (!error) {
        int health = px_audio_worker_progress(&guard);
        if (health < 0) {
          pthread_mutex_lock(&g_mic.lock);
          fail_locked(health);
          pthread_mutex_unlock(&g_mic.lock);
        } else submit(slot);
      }
      continue;
    }
    /* 超时先通知 JS；未返回的 DMA 仍持有缓冲时绝不释放。 */
    struct timespec until;
    wait_until(&until);
    pthread_cond_timedwait(&g_mic.wake, &g_mic.lock, &until);
    pthread_mutex_unlock(&g_mic.lock);
  }
done:
  /* 只有所有已提交的 RX 回调完成才会走到这里；全程保留健康检查。 */
  if (prepared) {
    pixelbox_board_mic_powerdown();
    px_audio_worker_progress(&guard);
  }
  for (unsigned i = 0; i < MIC_DMA_COUNT; ++i)
    if (g_mic.slots[i].buffer) {
      apb_free(g_mic.slots[i].buffer);
      px_audio_worker_progress(&guard);
    }
  px_audio_capture_release();
  px_audio_worker_progress(&guard);
  free(g_mic.queue);
  px_audio_worker_progress(&guard);
  int health = px_audio_worker_guard_close(&guard);
  pthread_mutex_lock(&g_mic.lock);
  if (health < 0 && !g_mic.stop) fail_locked(health);
  memset(g_mic.slots, 0, sizeof(g_mic.slots));
  g_mic.device = NULL;
  g_mic.running = false;
  g_mic.busy = false;
  g_mic.queue = g_mic.partial = NULL;
  g_mic.queue_used = 0;
  pthread_cond_broadcast(&g_mic.wake);
  pthread_mutex_unlock(&g_mic.lock);
  return NULL;
}

#ifdef PX_AUDIO_INDEPENDENT_WORKER
static int mic_task(int argc, char **argv)
{
  (void)argc;
  (void)argv;
  mic_worker(NULL);
  return 0;
}
#endif

bool px_mic_available(void)
{
  return pixelbox_board_mic_available();
}

int px_mic_start(unsigned rate, unsigned frame_ms)
{
  if (!valid_rate(rate) || frame_ms < 10 || frame_ms > 500) return -EINVAL;
  if (!px_mic_available()) return -ENODEV;
  pthread_mutex_lock(&g_mic.lock);
  if (g_mic.busy) { pthread_mutex_unlock(&g_mic.lock); return -EBUSY; }
  /* 失败先由 poll 或显式 stop 消费，重启不能覆盖尚未观察到的终态。
   * 这同时封住 poll 返回空后、JS 检查 busy 前 worker 才退出的竞态。
   */
  if (g_mic.error) {
    int pending_error = g_mic.error;
    pthread_mutex_unlock(&g_mic.lock);
    return pending_error;
  }
  int result = px_audio_capture_acquire();
  if (result < 0) { pthread_mutex_unlock(&g_mic.lock); return result; }
  g_mic.frame_bytes = (size_t)rate * frame_ms / 1000 * 2;
  /* welcome 一次渲染约 250ms；按音频时长保留有界积压，而非固定八帧。
   * 16k/10ms 需要 32,000B 队列，长帧不会按相同槽数成倍占用内存。
   */
  g_mic.queue_frames = (MIC_QUEUE_MS + frame_ms - 1) / frame_ms;
  g_mic.queue = malloc(g_mic.frame_bytes * (g_mic.queue_frames + 1));
  if (!g_mic.queue) { result = -ENOMEM; goto fail; }
  g_mic.partial = g_mic.queue + g_mic.frame_bytes * g_mic.queue_frames;
  g_mic.stage = "guard";
  g_mic.device = NULL;
  g_mic.rate = rate;
  g_mic.busy = g_mic.running = true;
  g_mic.stop = g_mic.have_previous = false;
  g_mic.error = 0;
  g_mic.queue_read = g_mic.queue_used = g_mic.partial_used = 0;
  g_mic.submitted = 0;
  g_mic.deadline = 0; /* worker 在 prepare 完成后才开始计算 RX 截止时间。 */
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  int pid = kthread_create("px-mic", PX_AUDIO_WORKER_PRIORITY,
    PX_AUDIO_WORKER_STACK, mic_task, NULL);
  int created = pid < 0 ? -pid : 0;
#else
  pthread_t thread;
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  int created = pthread_create(&thread, &attributes, mic_worker, NULL);
  pthread_attr_destroy(&attributes);
#endif
  if (created) { result = -created; g_mic.busy = g_mic.running = false; goto fail; }
  pthread_mutex_unlock(&g_mic.lock);
  return 0;
fail:
  free(g_mic.queue);
  g_mic.queue = g_mic.partial = NULL;
  px_audio_capture_release();
  pthread_mutex_unlock(&g_mic.lock);
  return result;
}

void px_mic_stop(void)
{
  pthread_mutex_lock(&g_mic.lock);
  g_mic.stop = true;
  g_mic.running = false;
  g_mic.queue_used = 0;
  g_mic.error = 0;
  pthread_cond_broadcast(&g_mic.wake);
  pthread_mutex_unlock(&g_mic.lock);
}

int px_mic_quiesce(unsigned timeout_ms)
{
  uint64_t began = now_ms();
  for (;;) {
    if (!px_mic_busy()) return 0;
    uint64_t elapsed = now_ms() - began;
    if (elapsed >= timeout_ms) return -ETIMEDOUT;
    unsigned remaining = timeout_ms - (unsigned)elapsed;
    struct timespec delay = {0, (long)(remaining < 10 ? remaining : 10) * 1000000L};
    nanosleep(&delay, NULL);
  }
}

bool px_mic_active(void)
{
  pthread_mutex_lock(&g_mic.lock);
  bool active = g_mic.running && !g_mic.stop;
  pthread_mutex_unlock(&g_mic.lock);
  return active;
}

bool px_mic_busy(void)
{
  pthread_mutex_lock(&g_mic.lock);
  bool busy = g_mic.busy;
  pthread_mutex_unlock(&g_mic.lock);
  return busy;
}

int px_mic_set_gain(int percent)
{
  if (!px_mic_available()) return -ENODEV;
  int gain = percent < 0 ? 0 : percent > 100 ? 100 : percent;
  pthread_mutex_lock(&g_mic.lock);
  /* 硬件更新交给同一个独立 worker；I2C 错误由 poll 异步报告。 */
  g_mic.gain = gain;
  pthread_cond_broadcast(&g_mic.wake);
  pthread_mutex_unlock(&g_mic.lock);
  return 0;
}

int px_mic_poll(struct px_mic_frame *frame, unsigned max_frames)
{
  if (!frame || !max_frames) return -EINVAL;
  memset(frame, 0, sizeof(*frame));
  pthread_mutex_lock(&g_mic.lock);
  int result = 0;
  if (g_mic.error) { result = g_mic.error; g_mic.error = 0; }
  else if (g_mic.queue_used && !g_mic.stop) {
    /* 只合并已经就绪的完整帧，不等待凑批；减少 JS 小帧分配和跨语言调用。 */
    size_t count = g_mic.queue_used < max_frames ? g_mic.queue_used : max_frames;
    size_t bytes = count * g_mic.frame_bytes;
    frame->data = malloc(bytes);
    if (!frame->data) result = -ENOMEM;
    else {
      size_t first = g_mic.queue_frames - g_mic.queue_read;
      if (first > count) first = count;
      first *= g_mic.frame_bytes;
      memcpy(frame->data, g_mic.queue + g_mic.queue_read * g_mic.frame_bytes, first);
      memcpy(frame->data + first, g_mic.queue, bytes - first);
      frame->bytes = bytes;
      frame->sample_rate = g_mic.rate;
      g_mic.queue_read = (g_mic.queue_read + count) % g_mic.queue_frames;
      g_mic.queue_used -= count;
      result = 1;
    }
  }
  pthread_mutex_unlock(&g_mic.lock);
  return result;
}

#else

bool px_mic_available(void) { return false; }
int px_mic_start(unsigned r, unsigned f) { (void)r; (void)f; return -ENOTSUP; }
void px_mic_stop(void) {}
int px_mic_quiesce(unsigned timeout_ms) { (void)timeout_ms; return 0; }
bool px_mic_active(void) { return false; }
bool px_mic_busy(void) { return false; }
int px_mic_set_gain(int p) { (void)p; return -ENOTSUP; }
int px_mic_poll(struct px_mic_frame *f, unsigned n) { return f && n ? 0 : -EINVAL; }

#endif
