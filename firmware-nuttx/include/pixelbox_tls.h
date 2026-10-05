#ifndef PIXELBOX_NUTTX_TLS_H
#define PIXELBOX_NUTTX_TLS_H

#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>

#define PX_TLS_MAX_CONTEXTS 4
#define PX_TLS_MAX_CA_BYTES (256u * 1024u)
#define PX_TLS_WRITE_BYTES 4096u
#ifndef PX_TLS_CA_FILE
#define PX_TLS_CA_FILE "/data/certs/ca-bundle.pem"
#endif

struct px_tls;

/* available只表示编译了TLS；create还会校验CA、时钟和非阻塞fd。
 * 每个上下文由一个线程使用，可在握手后移交所有权；free永不关闭fd。
 * 默认CA文件必须包含可信PEM证书；启用PX_TLS_BUILTIN_CA时文件缺失则使用
 * 固定内置根证书，损坏覆盖文件仍失败。未启用且没有CA时返回-ENOTSUP，时钟未同步
 * （早于2024-01-01）返回-ETIME；证书/主机名验证失败返回-EACCES。
 */
bool px_tls_available(void);
int px_tls_create(int fd, const char *hostname, struct px_tls **out);
int px_tls_create_with_ca(int fd, const char *hostname, const void *ca_pem,
                          size_t ca_length, struct px_tls **out);
/* handshake: 0=成功，-EAGAIN=按poll_events等待，其他负errno=失败。 */
int px_tls_handshake(struct px_tls *tls);
/* 已完成握手且没有未完成write时，将同一socket在新任务组的fd重新绑定。
 * 调用者保证两个fd引用同一连接，并串行移交上下文；此接口不复制/关闭fd。 */
int px_tls_rebind_fd(struct px_tls *tls, int fd);
short px_tls_poll_events(struct px_tls *tls);
ssize_t px_tls_read(struct px_tls *tls, void *buffer, size_t length);
/* 最多写4096字节。-EAGAIN后必须重试相同前4096字节/长度，直到返回
 * 正数才推进偏移；不同内容返回-EBUSY。未完成write期间read返回-EAGAIN。
 * read/write均返回字节数或负errno；非空read的0仅表示收到TLS close_notify。
 */
ssize_t px_tls_write(struct px_tls *tls, const void *buffer, size_t length);
bool px_tls_pending(struct px_tls *tls);
void px_tls_free(struct px_tls *tls);

#endif
