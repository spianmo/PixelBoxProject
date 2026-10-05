#ifndef PIXELBOX_SLEEP_H
#define PIXELBOX_SLEEP_H

#include <stdbool.h>
#include <stdint.h>

#define PX_SLEEP_MAX_MS 86400000u
#ifndef PX_SLEEP_CLEANUP_MS
#define PX_SLEEP_CLEANUP_MS 10000u
#endif

/* 只接受 1 毫秒至 24 小时的定时唤醒；不提供无限深睡。 */
int px_sleep_validate(double milliseconds, uint32_t *duration);
/* prepare 仅检查，不关闭共享服务；失败后监督器及 devd 继续运行。 */
int px_sleep_prepare(void *opaque, uint32_t duration);
/* VM、门户、devd、mDNS 均已停止后才调用。成功不返回；唤醒整机重启。 */
int px_sleep_enter(uint32_t duration);
/* 深睡重启时保持旧应用停止，防止其启动脚本再次进入睡眠。 */
bool px_sleep_woke_from_deep_sleep(void);

#endif
