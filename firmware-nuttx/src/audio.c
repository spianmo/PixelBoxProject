#include "pixelbox_audio.h"
#include "pixelbox_audio_decode.h"

#include <errno.h>
#include <string.h>

#if defined(PX_AUDIO_TEST)
#  include "audio_test_platform.h"
#  define PX_AUDIO_PLATFORM 1
#elif defined(__NuttX__)
#  include <nuttx/config.h>
#  if defined(CONFIG_AUDIO) && defined(CONFIG_AUDIO_FORMAT_PCM)
#    include <nuttx/audio/audio.h>
#    include <mqueue.h>
#    define PX_AUDIO_PLATFORM 1
#  endif
#endif

#ifdef PX_AUDIO_PLATFORM

#include "pixelbox_audio_worker.h"

#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define PX_AUDIO_RING_BYTES 65536u
#define PX_AUDIO_PCM_MAX_BYTES (8u * 1024u * 1024u)
#define PX_AUDIO_BUFFER_BYTES 4096u
#define PX_AUDIO_BUFFER_COUNT 2u
#ifndef PX_AUDIO_STREAM_IDLE_MS
#  define PX_AUDIO_STREAM_IDLE_MS 30000u
#endif
#ifndef PX_AUDIO_DRAIN_MS
#  define PX_AUDIO_DRAIN_MS 5000u
#endif
#define PX_AUDIO_POLL_MS 50u
#ifdef __NuttX__
#  define AUDIO_TRACE(stage, value) fprintf(stderr, "[pixelbox.audio] job=%lu %s=%d\n", \
       (unsigned long)g_audio.job.id, stage, value)
#else
#  define AUDIO_TRACE(stage, value) ((void)0)
#endif

enum source_kind { SOURCE_PCM, SOURCE_TONE, SOURCE_STREAM, SOURCE_ENCODED };

struct audio_job {
  uint32_t id;
  enum source_kind kind;
  unsigned rate;
  unsigned channels;
  uint8_t *data;
  size_t length;
  size_t offset;
  size_t ring_read;
  size_t ring_used;
  size_t queued_bytes;
  uint64_t deadline_ms;
  uint64_t paused_at_ms;
  bool eos;
  bool paused;
  int cancel_error;
  float tone_phase;
  float tone_step;
  float tone_amplitude;
  size_t tone_samples;
  size_t tone_position;
  size_t tone_fade;
  struct px_audio_decoder *decoder;
};

static struct {
  pthread_mutex_t lock;
  bool initialized;
  bool stopping;
  bool busy;
  bool resolved;
  bool result_ready;
  bool started_ready;
  bool capture;
  int volume;
  uint32_t next_id;
  struct audio_job job;
  struct px_audio_result result;
  struct px_audio_result started_result;
} g_audio = { .lock = PTHREAD_MUTEX_INITIALIZER, .volume = 70 };

static uint64_t now_ms(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (unsigned long)ts.tv_nsec / 1000000;
}

static void deadline(struct timespec *ts, unsigned delay_ms)
{
  clock_gettime(CLOCK_REALTIME, ts);
  ts->tv_sec += delay_ms / 1000;
  ts->tv_nsec += (long)(delay_ms % 1000) * 1000000;
  if (ts->tv_nsec >= 1000000000L) {
    ++ts->tv_sec;
    ts->tv_nsec -= 1000000000L;
  }
}

static int call_ioctl(struct px_audio_worker_guard *guard, int fd,
                      int command, unsigned long argument)
{
  int watched = px_audio_worker_watch(guard);
  if (watched < 0) return watched;
  errno = 0;
  int result = ioctl(fd, command, argument);
  return result < 0 ? -(errno ? errno : EIO) : result;
}

static int clamp_volume(int value)
{
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

static bool valid_format(unsigned rate, unsigned channels)
{
  return (channels == 1 || channels == 2) &&
    (rate == 8000 || rate == 11025 || rate == 12000 || rate == 16000 ||
     rate == 22050 || rate == 24000 || rate == 32000 || rate == 44100 ||
     rate == 48000);
}

static int cancel_locked(void)
{
  if (g_audio.stopping) return -ECANCELED;
  if (g_audio.job.cancel_error) return g_audio.job.cancel_error;
  if (!g_audio.job.paused && now_ms() >= g_audio.job.deadline_ms)
    return -ETIMEDOUT;
  return 0;
}

static void publish_locked(int error)
{
  if (!g_audio.resolved) {
    g_audio.result.job_id = g_audio.job.id;
    g_audio.result.error = error;
    g_audio.result.started = false;
    g_audio.resolved = true;
    g_audio.result_ready = true;
  }
}

/* RELEASE/FREEBUFFER 未成功就仍然拥有资源；保留 busy 与监督，等待驱动
 * 真正回收或硬件看门狗复位。重试失败不算进展，不能把错误返回当成清理完成。
 */
static void cleanup_ioctl(struct px_audio_worker_guard *guard, int fd,
                           int command, unsigned long argument, int *error)
{
  for (;;) {
    errno = 0;
    int result = ioctl(fd, command, argument);
    if (result >= 0) {
      int health = px_audio_worker_progress(guard);
      if (!*error && health < 0) *error = health;
      return;
    }
    int failed = -(errno ? errno : EIO);
    if (!*error) *error = failed;
    pthread_mutex_lock(&g_audio.lock);
    if (!g_audio.stopping) publish_locked(failed);
    pthread_mutex_unlock(&g_audio.lock);
    struct timespec delay = {0, PX_AUDIO_POLL_MS * 1000000L};
    nanosleep(&delay, NULL);
  }
}

static void little16(uint8_t *p, uint16_t value)
{
  p[0] = (uint8_t)value;
  p[1] = (uint8_t)(value >> 8);
}

static void little32(uint8_t *p, uint32_t value)
{
  little16(p, (uint16_t)value);
  little16(p + 2, (uint16_t)(value >> 16));
}

/* pcm_decode 首包必须含完整 WAV 头；它仅跳过头部，结束由 FINAL 控制。
 * 输出固定双声道，单声道复制到左右两路，避免 codec 丢掉奇数采样。
 */
#ifndef CONFIG_AUDIO_FORMAT_RAW
static void wav_header(uint8_t *p, const struct audio_job *job)
{
  uint32_t data_bytes = job->kind == SOURCE_STREAM || job->kind == SOURCE_ENCODED ? 0x7fffffd0u :
    (uint32_t)(job->kind == SOURCE_TONE ? job->tone_samples * 4 :
               job->length / (job->channels * 2) * 4);
  memcpy(p, "RIFF", 4);
  little32(p + 4, data_bytes + 36);
  memcpy(p + 8, "WAVEfmt ", 8);
  little32(p + 16, 16);
  little16(p + 20, 1);
  little16(p + 22, 2);
  little32(p + 24, job->rate);
  little32(p + 28, job->rate * 4);
  little16(p + 32, 4);
  little16(p + 34, 16);
  memcpy(p + 36, "data", 4);
  little32(p + 40, data_bytes);
}
#endif

/* 所有源都在模块持有的内存中；从环中取样与 feed 共用同一把锁。 */
static ssize_t fill_buffer(struct ap_buffer_s *buffer, bool first,
                          bool *finished)
{
  pthread_mutex_lock(&g_audio.lock);
  struct audio_job *job = &g_audio.job;
  size_t header = 0;
#ifndef CONFIG_AUDIO_FORMAT_RAW
  if (first) header = 44;
#else
  (void)first;
#endif
  size_t frames = (buffer->nmaxbytes - header) / 4;
  size_t count = 0;
  uint8_t *out = buffer->samp + header;
  if (job->kind == SOURCE_ENCODED) {
    /* 解码仅操作 worker 独占状态；不持互斥锁耗时运算，停止请求可及时进入。 */
    pthread_mutex_unlock(&g_audio.lock);
    ssize_t decoded = px_audio_decoder_read(job->decoder, out, frames, finished);
    if (decoded < 0) return decoded;
    pthread_mutex_lock(&g_audio.lock);
    count = (size_t)decoded;
  } else if (job->kind == SOURCE_TONE) {
    size_t remaining = job->tone_samples - job->tone_position;
    if (frames > remaining) frames = remaining;
    for (count = 0; count < frames; ++count) {
      float envelope = 1;
      if (job->tone_fade) {
        if (job->tone_position < job->tone_fade)
          envelope = (float)job->tone_position / job->tone_fade;
        else if (job->tone_samples - job->tone_position < job->tone_fade)
          envelope = (float)(job->tone_samples - job->tone_position) /
                     job->tone_fade;
      }
      int16_t sample = (int16_t)(sinf(job->tone_phase) *
                                 job->tone_amplitude * envelope);
      little16(out + count * 4, (uint16_t)sample);
      little16(out + count * 4 + 2, (uint16_t)sample);
      job->tone_phase += job->tone_step;
      if (job->tone_phase >= 6.28318530718f)
        job->tone_phase -= 6.28318530718f;
      ++job->tone_position;
    }
    *finished = job->tone_position == job->tone_samples;
  } else {
    const size_t frame_bytes = job->channels * 2;
    size_t available = job->kind == SOURCE_STREAM ? job->ring_used :
                       job->length - job->offset;
    if (frames > available / frame_bytes) frames = available / frame_bytes;
    for (count = 0; count < frames; ++count) {
      uint8_t sample[4];
      for (size_t b = 0; b < frame_bytes; ++b) {
        if (job->kind == SOURCE_STREAM) {
          sample[b] = job->data[job->ring_read];
          job->ring_read = (job->ring_read + 1) % PX_AUDIO_RING_BYTES;
          --job->ring_used;
        } else sample[b] = job->data[job->offset++];
      }
      out[count * 4] = sample[0];
      out[count * 4 + 1] = sample[1];
      out[count * 4 + 2] = sample[job->channels == 2 ? 2 : 0];
      out[count * 4 + 3] = sample[job->channels == 2 ? 3 : 1];
    }
    *finished = job->kind == SOURCE_STREAM ? job->eos && !job->ring_used :
                 job->offset == job->length;
  }
  /* 流在最后一次 feed 已送出后才 end 时，追加一帧静音承载 FINAL。
   * 完全空流不启动硬件，由 worker 直接完成。
   */
  if (!count && *finished && !first) {
    memset(out, 0, 4);
    count = 1;
  }
#ifndef CONFIG_AUDIO_FORMAT_RAW
  if (count && first) wav_header(buffer->samp, job);
#endif
  buffer->curbyte = 0;
  buffer->nbytes = count ? (uint16_t)(count * 4 + header) : 0;
  buffer->flags = *finished ? AUDIO_APB_FINAL : 0;
  pthread_mutex_unlock(&g_audio.lock);
  return count * 4;
}

static int set_device_volume(struct px_audio_worker_guard *guard,
                             int fd, int volume)
{
  struct audio_caps_desc_s caps;
  memset(&caps, 0, sizeof(caps));
  caps.caps.ac_len = sizeof(struct audio_caps_s);
  caps.caps.ac_type = AUDIO_TYPE_FEATURE;
  caps.caps.ac_format.hw = AUDIO_FU_VOLUME;
  caps.caps.ac_controls.hw[0] = (uint16_t)(volume * 10);
  return call_ioctl(guard, fd, AUDIOIOC_CONFIGURE, (unsigned long)&caps);
}

static void *audio_worker(void *unused)
{
  (void)unused;
  struct ap_buffer_s *buffers[PX_AUDIO_BUFFER_COUNT] = {0};
  bool in_flight[PX_AUDIO_BUFFER_COUNT] = {0};
  size_t buffer_bytes[PX_AUDIO_BUFFER_COUNT] = {0};
  struct audio_buf_desc_s desc;
  bool reserved = false, registered = false, started = false;
  bool final_sent = false, complete = false, applied_pause = false;
  int applied_volume = -1, result = 0;
  mqd_t queue = (mqd_t)-1;
  char queue_name[48];
  int fd = -1;
  struct px_audio_worker_guard guard = {0};
  AUDIO_TRACE("worker", 0);
  result = px_audio_worker_guard_open(&guard);
  if (result < 0) goto done;
  if (g_audio.job.kind == SOURCE_ENCODED) {
    unsigned rate, channels;
    result = px_audio_decoder_open(g_audio.job.data, g_audio.job.length,
      &g_audio.job.decoder, &rate, &channels);
    if (result < 0) goto done;
    pthread_mutex_lock(&g_audio.lock);
    g_audio.job.rate = rate;
    g_audio.job.channels = channels;
    if (g_audio.capture && rate != 16000) result = -EBUSY;
    pthread_mutex_unlock(&g_audio.lock);
    if (result < 0) goto done;
  }
  fd = open("/dev/audio/pcm0", O_RDWR);
  AUDIO_TRACE("open", fd);
  if (fd < 0) { result = -(errno ? errno : ENODEV); goto done; }
  result = call_ioctl(&guard, fd, AUDIOIOC_RESERVE, 0);
  AUDIO_TRACE("reserve", result);
  if (result < 0) goto done;
  reserved = true;

  struct mq_attr attr = {0};
  attr.mq_maxmsg = PX_AUDIO_BUFFER_COUNT + 4;
  attr.mq_msgsize = sizeof(struct audio_msg_s);
  snprintf(queue_name, sizeof(queue_name), "/pxaudio-%ld-%lu",
           (long)getpid(), (unsigned long)g_audio.job.id);
  queue = mq_open(queue_name, O_RDWR | O_CREAT | O_EXCL, 0600, &attr);
  if (queue == (mqd_t)-1) { result = -errno; goto done; }
  result = call_ioctl(&guard, fd, AUDIOIOC_REGISTERMQ, (unsigned long)queue);
  if (result < 0) goto done;
  registered = true;

  for (unsigned i = 0; i < PX_AUDIO_BUFFER_COUNT; ++i) {
    memset(&desc, 0, sizeof(desc));
    desc.numbytes = PX_AUDIO_BUFFER_BYTES;
    desc.u.pbuffer = &buffers[i];
    result = call_ioctl(&guard, fd, AUDIOIOC_ALLOCBUFFER, (unsigned long)&desc);
    /* ALLOCBUFFER 的成功返回值是描述符大小，不是 0。 */
    if (result < 0 || !buffers[i] ||
        buffers[i]->nmaxbytes < PX_AUDIO_BUFFER_BYTES) {
      if (result >= 0) result = -ENOMEM;
      goto done;
    }
  }
#ifdef CONFIG_AUDIO_FORMAT_RAW
  struct audio_caps_desc_s format = {0};
  format.caps.ac_len = sizeof(struct audio_caps_s);
  format.caps.ac_type = AUDIO_TYPE_OUTPUT;
  format.caps.ac_channels = 2;
  format.caps.ac_controls.hw[0] = (uint16_t)g_audio.job.rate;
  format.caps.ac_controls.b[2] = 16;
  result = call_ioctl(&guard, fd, AUDIOIOC_CONFIGURE, (unsigned long)&format);
  if (result < 0) goto done;
#endif

  while (!complete) {
    pthread_mutex_lock(&g_audio.lock);
    result = cancel_locked();
    bool paused = g_audio.job.paused;
    bool have_input = g_audio.job.kind != SOURCE_STREAM ||
                      g_audio.job.ring_used || g_audio.job.eos;
    int volume = g_audio.volume;
    pthread_mutex_unlock(&g_audio.lock);
    if (result < 0) break;

    if (started && paused != applied_pause) {
      result = call_ioctl(&guard, fd, paused ? AUDIOIOC_PAUSE : AUDIOIOC_RESUME, 0);
      if (result < 0) break;
      applied_pause = paused;
    }
    if (!paused && have_input && !final_sent) {
      result = px_audio_worker_watch(&guard);
      if (result < 0) break;
      for (unsigned i = 0; i < PX_AUDIO_BUFFER_COUNT && !final_sent; ++i) {
        if (in_flight[i]) continue;
        bool finished = false;
        ssize_t bytes = fill_buffer(buffers[i], !started, &finished);
        if (bytes < 0) { result = (int)bytes; goto done; }
        if (!bytes) {
          if (finished && !started) complete = true;
          break;
        }
        memset(&desc, 0, sizeof(desc));
        desc.numbytes = buffers[i]->nbytes;
        desc.u.buffer = buffers[i];
        if (!started) AUDIO_TRACE("enqueue-begin", (int)desc.numbytes);
        result = call_ioctl(&guard, fd, AUDIOIOC_ENQUEUEBUFFER, (unsigned long)&desc);
        if (!started) AUDIO_TRACE("enqueue-end", result);
        if (result < 0) goto done;
        in_flight[i] = true;
        buffer_bytes[i] = bytes;
        pthread_mutex_lock(&g_audio.lock);
        g_audio.job.queued_bytes += bytes;
        pthread_mutex_unlock(&g_audio.lock);
        final_sent = finished;
        if (!started) {
          /* WAV 解析会重置 codec 音量；解析后、启动 I2S 前设置期望音量。 */
          result = set_device_volume(&guard, fd, volume);
          if (result < 0) goto done;
          applied_volume = volume;
          result = call_ioctl(&guard, fd, AUDIOIOC_START, 0);
          AUDIO_TRACE("start", result);
          if (result != 0) {
            if (result > 0) result = -result;
            goto done;
          }
          started = true;
          if (g_audio.job.kind == SOURCE_ENCODED) {
            pthread_mutex_lock(&g_audio.lock);
            g_audio.started_result = (struct px_audio_result){
              .job_id = g_audio.job.id, .error = 0, .started = true};
            g_audio.started_ready = !g_audio.stopping;
            pthread_mutex_unlock(&g_audio.lock);
          }
        }
      }
    }
    if (started && volume != applied_volume) {
      result = set_device_volume(&guard, fd, volume);
      if (result < 0) break;
      applied_volume = volume;
    }
    if (complete) break;
    bool pending = false;
    for (unsigned i = 0; i < PX_AUDIO_BUFFER_COUNT; ++i) pending |= in_flight[i];
    pthread_mutex_lock(&g_audio.lock);
    bool waiting_input = g_audio.job.kind == SOURCE_STREAM &&
                         !g_audio.job.ring_used && !g_audio.job.eos;
    pthread_mutex_unlock(&g_audio.lock);
    /* 已确认 PAUSE，或流已经排空且在等待调用方 feed，属于合法闲置。
     * 未返回的 DMA、最终 COMPLETE 和所有 STOP/RELEASE 始终受监督。
     */
    result = (paused && (!started || applied_pause)) || (waiting_input && !pending)
      ? px_audio_worker_idle(&guard) : px_audio_worker_watch(&guard);
    if (result < 0) break;
    struct audio_msg_s message;
    struct timespec until;
    deadline(&until, PX_AUDIO_POLL_MS);
    ssize_t size = mq_timedreceive(queue, (char *)&message,
                                  sizeof(message), NULL, &until);
    if (size < 0) {
      if (errno == ETIMEDOUT || errno == EINTR || errno == EAGAIN) continue;
      result = -errno;
      break;
    }
    if (size != sizeof(message)) { result = -EPROTO; break; }
    if (message.msg_id == AUDIO_MSG_DEQUEUE) {
      bool found = false;
      for (unsigned i = 0; i < PX_AUDIO_BUFFER_COUNT; ++i) {
        if (message.u.ptr != buffers[i] || !in_flight[i]) continue;
        in_flight[i] = false;
        found = true;
        pthread_mutex_lock(&g_audio.lock);
        g_audio.job.queued_bytes -= buffer_bytes[i];
        if (g_audio.job.kind == SOURCE_ENCODED)
          g_audio.job.deadline_ms =
            (g_audio.job.paused ? g_audio.job.paused_at_ms : now_ms()) + PX_AUDIO_DRAIN_MS;
        pthread_mutex_unlock(&g_audio.lock);
        break;
      }
      if (!found) { result = -EPROTO; break; }
      result = px_audio_worker_progress(&guard);
      if (result < 0) break;
    } else if (message.msg_id == AUDIO_MSG_COMPLETE) {
      if (!final_sent) result = -EIO;
      else result = px_audio_worker_progress(&guard);
      complete = true;
    } else if (message.msg_id == AUDIO_MSG_IOERR) {
      result = -EIO;
      break;
    }
  }

done:
  AUDIO_TRACE("cleanup-begin", result);
  /* 错误先投递给主循环；STOP 内部等待 I2S，不允许它阻塞 JS。
   * busy 保持到 STOP/RELEASE 返回。APB 仍由驱动引用时不释放内存。
   */
  pthread_mutex_lock(&g_audio.lock);
  if (result >= 0) result = cancel_locked();
  if (result < 0 && !g_audio.stopping) publish_locked(result);
  pthread_mutex_unlock(&g_audio.lock);
  /* 即使先前处于暂停/等数据，也必须在真实回收前恢复监督。 */
  if (guard.handle) {
    int watched = px_audio_worker_watch(&guard);
    if (!result && watched < 0) result = watched;
  }
  if (started) {
    /* 故障已锁存时依旧尝试安全回收，不能绕过 STOP 提前释放 DMA 缓冲。 */
    errno = 0;
    int stopped = ioctl(fd, AUDIOIOC_STOP, 0ul);
    if (stopped < 0) stopped = -(errno ? errno : EIO);
    else px_audio_worker_progress(&guard);
    if (result == 0 && stopped < 0) result = stopped;
  }
  /* RELEASE 在 FREEBUFFER 前执行，驱动完成线程回收后再释放用户引用。 */
  if (reserved) {
    cleanup_ioctl(&guard, fd, AUDIOIOC_RELEASE, 0ul, &result);
  }
  for (unsigned i = 0; i < PX_AUDIO_BUFFER_COUNT; ++i) {
    if (!buffers[i]) continue;
    memset(&desc, 0, sizeof(desc));
    desc.u.buffer = buffers[i];
    cleanup_ioctl(&guard, fd, AUDIOIOC_FREEBUFFER, (unsigned long)&desc, &result);
  }
  if (registered) {
    cleanup_ioctl(&guard, fd, AUDIOIOC_UNREGISTERMQ, (unsigned long)queue, &result);
  }
  if (fd >= 0) {
    close(fd);
    px_audio_worker_progress(&guard);
  }
  if (queue != (mqd_t)-1) {
    mq_close(queue);
    mq_unlink(queue_name);
    px_audio_worker_progress(&guard);
  }
  /* 解码器与源数据只有本 worker 使用，释放时不能持锁卡住 stop/quiesce。 */
  px_audio_decoder_close(g_audio.job.decoder);
  free(g_audio.job.data);
  px_audio_worker_progress(&guard);
  int health = px_audio_worker_guard_close(&guard);
  if (!result && health < 0) result = health;
  pthread_mutex_lock(&g_audio.lock);
  g_audio.job.decoder = NULL;
  g_audio.job.data = NULL;
  g_audio.job.queued_bytes = 0;
  if (!g_audio.stopping) publish_locked(result < 0 ? result : 0);
  g_audio.busy = false;
  if (g_audio.stopping) {
    g_audio.initialized = false;
    g_audio.stopping = false;
    g_audio.result_ready = g_audio.started_ready = false;
  }
  pthread_mutex_unlock(&g_audio.lock);
  AUDIO_TRACE("cleanup-end", result);
  return NULL;
}

#ifdef PX_AUDIO_INDEPENDENT_WORKER
static int audio_task(int argc, char **argv)
{
  (void)argc;
  (void)argv;
  audio_worker(NULL);
  return 0;
}
#endif

static int start_job(struct audio_job *job, uint32_t *job_id)
{
  if (!job_id) { free(job->data); return -EINVAL; }
  pthread_mutex_lock(&g_audio.lock);
  int result = 0;
  if (!g_audio.initialized) result = -ENODEV;
  else if (g_audio.busy || g_audio.stopping || g_audio.result_ready || g_audio.started_ready)
    result = -EBUSY;
  else if (g_audio.capture && job->kind != SOURCE_ENCODED && job->rate != 16000)
    result = -EBUSY;
  if (!result) {
    job->id = ++g_audio.next_id;
    if (!job->id) job->id = ++g_audio.next_id;
    g_audio.job = *job;
    g_audio.busy = true;
    g_audio.resolved = false;
#ifdef PX_AUDIO_INDEPENDENT_WORKER
    int pid = kthread_create("px-audio", PX_AUDIO_WORKER_PRIORITY,
      job->kind == SOURCE_ENCODED ? PX_AUDIO_DECODER_STACK : PX_AUDIO_WORKER_STACK,
      audio_task, NULL);
    int created = pid < 0 ? -pid : 0;
#else
    pthread_t thread;
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    int created = pthread_create(&thread, &attributes, audio_worker, NULL);
    pthread_attr_destroy(&attributes);
#endif
    if (created) {
      g_audio.busy = false;
      g_audio.job.data = NULL;
      result = -created;
    } else *job_id = job->id;
  }
  pthread_mutex_unlock(&g_audio.lock);
  if (result) free(job->data);
  return result;
}

int px_audio_init(void)
{
#ifdef __NuttX__
  if (access("/dev/audio/pcm0", F_OK) < 0)
    return -(errno ? errno : ENODEV);
#endif
  pthread_mutex_lock(&g_audio.lock);
  int result = g_audio.stopping ? -EBUSY : 0;
  if (!result) g_audio.initialized = true;
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_capture_acquire(void)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = g_audio.capture || g_audio.stopping ||
    (g_audio.busy && g_audio.job.rate != 16000) ? -EBUSY : 0;
  if (!result) g_audio.capture = true;
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

void px_audio_capture_release(void)
{
  pthread_mutex_lock(&g_audio.lock);
  g_audio.capture = false;
  pthread_mutex_unlock(&g_audio.lock);
}

void px_audio_shutdown(void)
{
  pthread_mutex_lock(&g_audio.lock);
  g_audio.stopping = g_audio.busy;
  /* 所属 VM 已退出，旧事件不能阻塞下一 VM；busy 仍由 worker 真实回收后清除。 */
  g_audio.result_ready = g_audio.started_ready = false;
  if (!g_audio.busy) g_audio.initialized = false;
  pthread_mutex_unlock(&g_audio.lock);
}

int px_audio_quiesce(unsigned timeout_ms)
{
  uint64_t began = now_ms();
  for (;;) {
    pthread_mutex_lock(&g_audio.lock);
    bool busy = g_audio.busy;
    pthread_mutex_unlock(&g_audio.lock);
    if (!busy) return 0;
    uint64_t elapsed = now_ms() - began;
    if (elapsed >= timeout_ms) return -ETIMEDOUT;
    unsigned remaining = timeout_ms - (unsigned)elapsed;
    struct timespec delay = {0, (long)(remaining < 10 ? remaining : 10) * 1000000L};
    nanosleep(&delay, NULL);
  }
}

int px_audio_set_volume(int percent)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = g_audio.initialized ? 0 : -ENODEV;
  if (!result) g_audio.volume = clamp_volume(percent);
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_get_volume(void)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = g_audio.initialized ? g_audio.volume : -ENODEV;
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_tone(float frequency, unsigned duration_ms, int volume,
                  uint32_t *job_id)
{
  if (!isfinite(frequency) || frequency < 20 || frequency >= 8000 ||
      !duration_ms || duration_ms > 60000) return -EINVAL;
  struct audio_job job = {0};
  job.kind = SOURCE_TONE;
  job.rate = 16000;
  job.channels = 1;
  job.tone_samples = (size_t)job.rate * duration_ms / 1000;
  job.tone_step = 6.28318530718f * frequency / job.rate;
  job.tone_amplitude = clamp_volume(volume) / 100.0f * 0.8f * 32767;
  job.tone_fade = job.rate / 200;
  if (job.tone_fade * 2 > job.tone_samples)
    job.tone_fade = job.tone_samples / 4;
  job.deadline_ms = now_ms() + duration_ms + PX_AUDIO_DRAIN_MS;
  return start_job(&job, job_id);
}

int px_audio_play_pcm(const void *pcm, size_t bytes, unsigned sample_rate,
                      unsigned channels, uint32_t *job_id)
{
  if (!pcm || !bytes || bytes > PX_AUDIO_PCM_MAX_BYTES ||
      !valid_format(sample_rate, channels) || bytes % (channels * 2))
    return -EINVAL;
  struct audio_job job = {0};
  job.kind = SOURCE_PCM;
  job.rate = sample_rate;
  job.channels = channels;
  job.length = bytes;
  job.data = malloc(bytes);
  if (!job.data) return -ENOMEM;
  memcpy(job.data, pcm, bytes);
  job.deadline_ms = now_ms() + (uint64_t)bytes * 1000 /
                    (sample_rate * channels * 2) + PX_AUDIO_DRAIN_MS;
  return start_job(&job, job_id);
}

int px_audio_stream_open(unsigned sample_rate, unsigned channels,
                         uint32_t *job_id)
{
  if (!valid_format(sample_rate, channels)) return -EINVAL;
  struct audio_job job = {0};
  job.kind = SOURCE_STREAM;
  job.rate = sample_rate;
  job.channels = channels;
  job.data = malloc(PX_AUDIO_RING_BYTES);
  if (!job.data) return -ENOMEM;
  job.deadline_ms = now_ms() + PX_AUDIO_STREAM_IDLE_MS;
  return start_job(&job, job_id);
}

int px_audio_play_encoded(const void *encoded, size_t bytes, uint32_t *job_id)
{
  if (!encoded || !bytes || bytes > PX_AUDIO_PCM_MAX_BYTES) return -EINVAL;
  struct audio_job job = {0};
  job.kind = SOURCE_ENCODED;
  job.length = bytes;
  job.data = malloc(bytes);
  if (!job.data) return -ENOMEM;
  memcpy(job.data, encoded, bytes);
  /* 按真实硬件进度续期，长文件不会被固定的整首播放期限截断。 */
  job.deadline_ms = now_ms() + PX_AUDIO_DRAIN_MS;
  return start_job(&job, job_id);
}

static int job_locked(uint32_t job_id)
{
  if (!g_audio.initialized) return -ENODEV;
  if (!job_id || !g_audio.busy || g_audio.job.id != job_id ||
      g_audio.resolved || g_audio.stopping || g_audio.job.cancel_error)
    return -ENOENT;
  return 0;
}

int px_audio_stream_feed(uint32_t job_id, const void *pcm, size_t bytes)
{
  if (!pcm && bytes) return -EINVAL;
  pthread_mutex_lock(&g_audio.lock);
  int result = job_locked(job_id);
  struct audio_job *job = &g_audio.job;
  if (!result && (job->kind != SOURCE_STREAM || job->eos ||
                   bytes % (job->channels * 2))) result = -EINVAL;
  if (!result && bytes > PX_AUDIO_RING_BYTES - job->ring_used)
    result = -EAGAIN;
  if (!result && bytes) {
    size_t offset = (job->ring_read + job->ring_used) % PX_AUDIO_RING_BYTES;
    size_t first = PX_AUDIO_RING_BYTES - offset;
    if (first > bytes) first = bytes;
    memcpy(job->data + offset, pcm, first);
    memcpy(job->data, (const uint8_t *)pcm + first, bytes - first);
    job->ring_used += bytes;
    job->deadline_ms = (job->paused ? job->paused_at_ms : now_ms()) +
                       PX_AUDIO_STREAM_IDLE_MS;
  }
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_stream_end(uint32_t job_id)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = job_locked(job_id);
  if (!result && g_audio.job.kind != SOURCE_STREAM) result = -EINVAL;
  if (!result) {
    g_audio.job.eos = true;
    g_audio.job.deadline_ms =
      (g_audio.job.paused ? g_audio.job.paused_at_ms : now_ms()) +
      (uint64_t)g_audio.job.ring_used * 1000 /
       (g_audio.job.rate * g_audio.job.channels * 2) + PX_AUDIO_DRAIN_MS;
  }
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_buffered_ms(uint32_t job_id)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = job_locked(job_id);
  if (!result) {
    struct audio_job *job = &g_audio.job;
    uint64_t frames = job->queued_bytes / 4;
    if (job->kind == SOURCE_STREAM) frames += job->ring_used / (job->channels * 2);
    else if (job->kind == SOURCE_PCM)
      frames += (job->length - job->offset) / (job->channels * 2);
    else if (job->kind == SOURCE_TONE) frames += job->tone_samples - job->tone_position;
    result = job->rate ? (int)(frames * 1000 / job->rate) : 0;
  }
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_pause(uint32_t job_id, bool paused)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = job_locked(job_id);
  if (!result && paused != g_audio.job.paused) {
    uint64_t now = now_ms();
    if (paused) g_audio.job.paused_at_ms = now;
    else g_audio.job.deadline_ms += now - g_audio.job.paused_at_ms;
    g_audio.job.paused = paused;
  }
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

int px_audio_stop(uint32_t job_id)
{
  pthread_mutex_lock(&g_audio.lock);
  int result = job_locked(job_id);
  if (!result) g_audio.job.cancel_error = -ECANCELED;
  pthread_mutex_unlock(&g_audio.lock);
  return result;
}

void px_audio_stop_all(void)
{
  pthread_mutex_lock(&g_audio.lock);
  if (g_audio.busy) g_audio.job.cancel_error = -ECANCELED;
  pthread_mutex_unlock(&g_audio.lock);
}

bool px_audio_playing(uint32_t job_id)
{
  pthread_mutex_lock(&g_audio.lock);
  bool playing = g_audio.busy && !g_audio.resolved && !g_audio.job.paused &&
                  !g_audio.job.cancel_error && !g_audio.stopping &&
                  (!job_id || job_id == g_audio.job.id);
  pthread_mutex_unlock(&g_audio.lock);
  return playing;
}

int px_audio_poll(struct px_audio_result *result)
{
  if (!result) return -EINVAL;
  pthread_mutex_lock(&g_audio.lock);
  if (g_audio.busy && !g_audio.resolved && !g_audio.stopping) {
    int cancelled = cancel_locked();
    if (cancelled) {
      g_audio.job.cancel_error = cancelled;
      publish_locked(cancelled);
    }
  }
  int ready = g_audio.started_ready || g_audio.result_ready ? 1 : 0;
  if (g_audio.started_ready) {
    *result = g_audio.started_result;
    g_audio.started_ready = false;
  } else if (g_audio.result_ready) {
    *result = g_audio.result;
    g_audio.result_ready = false;
  }
  pthread_mutex_unlock(&g_audio.lock);
  return ready;
}

#else

int px_audio_init(void) { return -ENOTSUP; }
int px_audio_capture_acquire(void) { return -ENOTSUP; }
void px_audio_capture_release(void) {}
void px_audio_shutdown(void) {}
int px_audio_quiesce(unsigned timeout_ms) { (void)timeout_ms; return 0; }
int px_audio_set_volume(int percent) { (void)percent; return -ENOTSUP; }
int px_audio_get_volume(void) { return -ENOTSUP; }
int px_audio_tone(float f, unsigned ms, int v, uint32_t *id)
{ (void)f; (void)ms; (void)v; (void)id; return -ENOTSUP; }
int px_audio_play_pcm(const void *p, size_t n, unsigned r, unsigned c, uint32_t *id)
{ (void)p; (void)n; (void)r; (void)c; (void)id; return -ENOTSUP; }
int px_audio_play_encoded(const void *p, size_t n, uint32_t *id)
{ (void)p; (void)n; (void)id; return -ENOTSUP; }
int px_audio_stream_open(unsigned r, unsigned c, uint32_t *id)
{ (void)r; (void)c; (void)id; return -ENOTSUP; }
int px_audio_stream_feed(uint32_t id, const void *p, size_t n)
{ (void)id; (void)p; (void)n; return -ENOTSUP; }
int px_audio_stream_end(uint32_t id) { (void)id; return -ENOTSUP; }
int px_audio_buffered_ms(uint32_t id) { (void)id; return -ENOTSUP; }
int px_audio_pause(uint32_t id, bool paused)
{ (void)id; (void)paused; return -ENOTSUP; }
int px_audio_stop(uint32_t id) { (void)id; return -ENOTSUP; }
void px_audio_stop_all(void) {}
bool px_audio_playing(uint32_t id) { (void)id; return false; }
int px_audio_poll(struct px_audio_result *result)
{ return result ? 0 : -EINVAL; }

#endif
