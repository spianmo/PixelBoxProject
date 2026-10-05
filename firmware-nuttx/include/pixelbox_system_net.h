#ifndef PIXELBOX_NUTTX_SYSTEM_NET_H
#define PIXELBOX_NUTTX_SYSTEM_NET_H

#include <stdint.h>

#define PX_SYSTEM_NTP_TIMEOUT_MS 15000u
#define PX_SYSTEM_NTP_MAX_JOBS 4u
#define PX_SYSTEM_NTP_HOST_BYTES 256u

struct px_system_net;
struct px_system_net_result { uint32_t id; int error; };

/* 每个VM独占context，全部公开API由同一个主线程调用。
 * DNS/UDP worker不访问JS，不设置系统时间；poll成功消费后才设置CLOCK_REALTIME。
 * destroy/cancel不等待DNS，迟到worker只释放自身资源；全局最多4个存活worker。
 */
struct px_system_net *px_system_net_create(void);
void px_system_net_destroy(struct px_system_net *context);
int px_system_ntp_start(struct px_system_net *context, const char *server,
                        unsigned timeout_ms, uint32_t *id);
int px_system_ntp_cancel(struct px_system_net *context, uint32_t id);
/* 1=已消费结果，0=尚无结果，负errno=参数错误；结果error=0才代表已设置时间。 */
int px_system_net_poll(struct px_system_net *context, struct px_system_net_result *result);

/* 返回芯片内部温度（摄氏），并非环境温度；负errno表示读取失败。 */
int px_system_temperature(double *celsius);

#endif
