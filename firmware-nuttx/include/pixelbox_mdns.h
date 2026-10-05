#ifndef PIXELBOX_NUTTX_MDNS_H
#define PIXELBOX_NUTTX_MDNS_H
#include <stddef.h>
#include <stdint.h>

#define PX_MDNS_MAX_QUERIES 4u
#define PX_MDNS_MAX_RESULTS 20u
#define PX_MDNS_MAX_ADVERTISEMENTS 8u
#define PX_MDNS_TXT_BYTES 512u

struct px_mdns;
struct px_mdns_service {
  char name[64], host[256], ip[16];
  uint16_t port, txt_length;
  uint8_t txt[PX_MDNS_TXT_BYTES]; /* DNS-SD长度前缀TXT，不能当C字符串。 */
};
struct px_mdns_result {
  uint32_t id;
  int error;
  size_t count;
  struct px_mdns_service *services;
};

/* 常驻worker独占全部socket；owner只跨线程传递纯C值。公开API线程安全。
 * 每VM销毁owner即可取消全部查询和广播，devd的广播独立于VM。
 */
struct px_mdns *px_mdns_create(void);
void px_mdns_destroy(struct px_mdns *owner);
int px_mdns_discover(struct px_mdns *owner, const char *service,
                     unsigned timeout_ms, uint32_t *id);
int px_mdns_cancel(struct px_mdns *owner, uint32_t id);
int px_mdns_poll(struct px_mdns *owner, struct px_mdns_result *result);
void px_mdns_result_free(struct px_mdns_result *result);
int px_mdns_advertise(struct px_mdns *owner, const char *name, const char *service,
                      unsigned port, const uint8_t *txt, size_t txt_length,
                      uint32_t *id);
int px_mdns_unadvertise(struct px_mdns *owner, uint32_t id);

/* 网络缓存变化时由常驻监督线程调用；ipv4=0.0.0.0撤回广播并等待联网。 */
int px_mdns_configure(const char *hostname, const char *ipv4);
int px_mdns_publish_devd(const char *name, unsigned port, const char *model,
                         const char *firmware, const char *app);
int px_mdns_status(void);
/* 必须先销毁全部VM owner；等待worker关闭fd，最长2秒，超时返回-ETIMEDOUT。 */
int px_mdns_shutdown(void);

#endif
