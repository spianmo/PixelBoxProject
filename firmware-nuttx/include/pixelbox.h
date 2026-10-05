#ifndef PIXELBOX_NUTTX_H
#define PIXELBOX_NUTTX_H

#include <stddef.h>

/* 同一份入口在 NuttX NSH 与 POSIX 主机运行，便于验证真实 QuickJS FFI。 */
struct px_options {
  const char *app_root;
  const char *data_root;
  const char *entry;
  size_t heap_limit;
  unsigned turn_timeout_ms;
  unsigned runtime_timeout_ms;
  const char *eval_source;
};

int px_run(const struct px_options *options);
/* 入睡最后阶段与非托管 NSH VM 互斥；调用线程持锁至不返回的睡眠或失败回滚。 */
int px_runtime_lock_for_sleep(void);
void px_runtime_unlock_after_sleep_failure(void);
struct JSContext;
/* 原生密集循环复用当前 JS 轮次/运行总期限及 VM 停止条件，返回 -1 时已设置异常。 */
int px_runtime_poll_interrupt(struct JSContext *ctx);
int pixelbox_main(int argc, char *argv[]);
int pixelbox_boot_main(int argc, char *argv[]);

#endif
