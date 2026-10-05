#ifndef PIXELBOX_NUTTX_NET_H
#define PIXELBOX_NUTTX_NET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PX_NET_MAX_SOCKETS 16
#define PX_NET_SEND_BYTES 65536
#define PX_NET_SEND_MESSAGES 16
#define PX_NET_UDP_BYTES 65507
#define PX_NET_HOST_BYTES 256

struct px_net;
enum px_net_event_type { PX_NET_CONNECTED = 1, PX_NET_ACCEPTED, PX_NET_DATA,
                         PX_NET_DATAGRAM, PX_NET_CLOSED };
struct px_net_event {
  enum px_net_event_type type;
  uint32_t id;
  uint32_t accepted_id;
  int error;
  unsigned port;
  char host[PX_NET_HOST_BYTES];
  uint8_t *data;
  size_t length;
};

/* 每个VM独立拥有上下文；主线程调用全部API，后台只解析DNS/连接。
 * destroy不等待DNS，不引用JS；迟到worker只释放自己的C资源。
 * TLS启用时，DNS/TCP/TLS握手共用timeout；CA/时钟/主机名全部通过才通知connected。
 * 未编译TLS时，tls=true在任何网络操作前返回-ENOTSUP。
 */
struct px_net *px_net_create(void);
void px_net_destroy(struct px_net *net);
int px_net_connect(struct px_net *net, const char *host, unsigned port,
                   bool tls, unsigned timeout_ms, uint32_t *id);
int px_net_listen(struct px_net *net, unsigned port, uint32_t *id, unsigned *bound_port);
int px_net_udp(struct px_net *net, unsigned port, uint32_t *id, unsigned *bound_port);
int px_net_send(struct px_net *net, uint32_t id, const uint8_t *data, size_t length,
                const char *udp_host, unsigned udp_port);
int px_net_close(struct px_net *net, uint32_t id);
/* WebSocket发送队列据此等待同一消息实际排空，保持16条/64KiB背压语义。 */
int px_net_queued(struct px_net *net,uint32_t id,size_t *bytes);
/* 仅暂停TCP读取，继续发送/显式关闭；恢复后按顺序读取已缓存数据和远端EOF。 */
int px_net_read_pause(struct px_net *net,uint32_t id,bool paused);
/* poll从不等待网络；1=事件，0=暂无，负errno=失败。事件data由event_free释放。 */
int px_net_poll(struct px_net *net, struct px_net_event *event);
void px_net_event_free(struct px_net_event *event);

#endif
