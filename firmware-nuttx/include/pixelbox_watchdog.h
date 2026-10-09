#ifndef PIXELBOX_NUTTX_WATCHDOG_H
#define PIXELBOX_NUTTX_WATCHDOG_H

#include <stdbool.h>
#include <stdint.h>

#define PX_WATCHDOG_MAX_CLIENTS 8
#ifndef PX_WATCHDOG_STALL_MS
/* VM/音频任务的普通阶段须在硬件 60 秒窗口前报告进展；MultiNet7 的
 * 同步 create() 阶段会暂时退出健康槽，由独立硬件 watchdog 兜底。 */
#define PX_WATCHDOG_STALL_MS 45000u
#endif
#ifndef PX_WATCHDOG_HARDWARE_MS
#define PX_WATCHDOG_HARDWARE_MS 60000u
#endif

struct px_watchdog_status {
  bool running;
  bool fault_latched;
  int error;
  uint32_t failed_handle;
  unsigned registered;
  unsigned busy;
  uint64_t last_feed_ms;
};

/* 异步创建独立监督任务；0=任务已创建或硬件已确认，负errno=失败。
 * 重复调用时，硬件仍在启动返回-EINPROGRESS，不会重复建任务；
 * 硬件START及GETSTATUS均确认后 status.running 才为true。
 * NSH空闲时监督任务持续检查后喂狗，不依赖应用任务存活。
 */
int px_watchdog_start(void);
/* 每个VM或持续运行的服务独立注册。handle不可跨注销复用。
 * 启动中最多短睡眠等待2秒（不持锁、不访问设备），超时返回-ETIMEDOUT；
 * 未调用start返回-EAGAIN。仅硬件确认就绪后成功注册，失败时handle为0。 */
int px_watchdog_register(uint32_t *handle);
int px_watchdog_begin(uint32_t handle);
/* 只能在完成事件循环一轮或JS/native调用返回后报告进展；
 * 禁止从QuickJS中断回调、定时器中断或无条件后台线程调用beat。 */
int px_watchdog_beat(uint32_t handle);
int px_watchdog_end(uint32_t handle);
/* busy时注销返回-EBUSY，避免丢掉仍在运行的健康检查。 */
int px_watchdog_unregister(uint32_t handle);
int px_watchdog_get_status(struct px_watchdog_status *status);

#endif
