#ifndef PIXELBOX_AUDIO_WORKER_H
#define PIXELBOX_AUDIO_WORKER_H

#include <stdbool.h>
#include <stdint.h>

/* NuttX 的 pthread 随创建它的 VM task group 退出；音频 DMA 的清理必须
 * 由独立 kernel task 完成。主机测试保留 pthread，专门测试可替换 kthread。
 */
#if defined(__NuttX__) || defined(PX_AUDIO_WORKER_TEST)
#  include "pixelbox_watchdog.h"
#  if defined(PX_AUDIO_WORKER_TEST)
#    include "audio_worker_test_platform.h"
#  else
#    include <nuttx/kthread.h>
#  endif
#  define PX_AUDIO_INDEPENDENT_WORKER 1
#endif

#define PX_AUDIO_WORKER_PRIORITY 110
#define PX_AUDIO_WORKER_STACK 8192
#define PX_AUDIO_DECODER_STACK 32768

struct px_audio_worker_guard {
  uint32_t handle;
  bool active;
};

static inline int px_audio_worker_watch(struct px_audio_worker_guard *guard)
{
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  if (guard->active) return 0;
  int result = px_watchdog_begin(guard->handle);
  if (!result) guard->active = true;
  return result;
#else
  (void)guard;
  return 0;
#endif
}

static inline int px_audio_worker_guard_open(struct px_audio_worker_guard *guard)
{
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  int result = px_watchdog_register(&guard->handle);
  return result < 0 ? result : px_audio_worker_watch(guard);
#else
  (void)guard;
  return 0;
#endif
}

/* 只在真实 DMA 推进或一个资源回收阶段完成后调用，等待循环不能喂狗。 */
static inline int px_audio_worker_progress(struct px_audio_worker_guard *guard)
{
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  return guard->active ? px_watchdog_beat(guard->handle) : 0;
#else
  (void)guard;
  return 0;
#endif
}

static inline int px_audio_worker_idle(struct px_audio_worker_guard *guard)
{
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  if (!guard->active) return 0;
  int result = px_watchdog_end(guard->handle);
  if (!result) guard->active = false;
  return result;
#else
  (void)guard;
  return 0;
#endif
}

/* 全部驱动引用、句柄与内存释放后才能注销；故障锁存后不伪造成功。 */
static inline int px_audio_worker_guard_close(struct px_audio_worker_guard *guard)
{
#ifdef PX_AUDIO_INDEPENDENT_WORKER
  if (!guard->handle) return 0;
  int result = px_audio_worker_idle(guard);
  if (!result) result = px_watchdog_unregister(guard->handle);
  if (!result) guard->handle = 0;
  return result;
#else
  (void)guard;
  return 0;
#endif
}

#endif
