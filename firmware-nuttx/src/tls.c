#include "pixelbox_tls.h"

#include <errno.h>
#include <poll.h>

#ifdef PX_TLS_MBEDTLS
#ifdef PX_TLS_BUILTIN_CA
#include "tls_ca_bundle.h"
#endif
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/platform_time.h>
#include <mbedtls/platform_util.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>

/* NuttX的HAL为mbedTLS导出符号加esp_前缀；类型及配置必须使用同一套头。 */
#ifdef __NuttX__
#define TLS_FN(name) esp_mbedtls_##name
#else
#define TLS_FN(name) mbedtls_##name
#endif

#define TLS_VALID_EPOCH ((time_t)1704067200)

#if defined(__NuttX__) && defined(MBEDTLS_PLATFORM_MS_TIME_ALT)
/* HAL选择了MS_TIME_ALT，但旧esp_timing.c未提供3.6新增的毫秒时钟。
 * 这是同一HAL配置要求的平台入口；不能另编译一份platform_util.c。 */
mbedtls_ms_time_t esp_mbedtls_ms_time(void)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
  return (mbedtls_ms_time_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
#endif

struct px_tls {
  int fd;
  int error;
  int io_error;
  short want;
  bool ready;
  bool closed;
  bool transport_eof;
  bool clock_invalid;
  size_t write_length;
  unsigned char write_buffer[PX_TLS_WRITE_BYTES];
  mbedtls_ssl_context ssl;
  mbedtls_ssl_config config;
  mbedtls_x509_crt ca;
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context drbg;
};

static pthread_mutex_t g_context_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned g_context_count;

static int reserve_context(void)
{
  int result = 0;
  pthread_mutex_lock(&g_context_lock);
  if (g_context_count >= PX_TLS_MAX_CONTEXTS) result = -EMFILE;
  else ++g_context_count;
  pthread_mutex_unlock(&g_context_lock);
  return result;
}

static void release_context(void)
{
  pthread_mutex_lock(&g_context_lock);
  --g_context_count;
  pthread_mutex_unlock(&g_context_lock);
}

static bool current_date(mbedtls_x509_time *date)
{
  time_t now = time(NULL);
  struct tm utc;
  if (now < TLS_VALID_EPOCH || !gmtime_r(&now, &utc)) return false;
  date->year = utc.tm_year + 1900;
  date->mon = utc.tm_mon + 1;
  date->day = utc.tm_mday;
  date->hour = utc.tm_hour;
  date->min = utc.tm_min;
  date->sec = utc.tm_sec;
  return true;
}

static int compare_date(const mbedtls_x509_time *a, const mbedtls_x509_time *b)
{
  const int aa[] = {a->year, a->mon, a->day, a->hour, a->min, a->sec};
  const int bb[] = {b->year, b->mon, b->day, b->hour, b->min, b->sec};
  for (unsigned i = 0; i < sizeof(aa) / sizeof(aa[0]); ++i)
    if (aa[i] != bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}

static int verify_date(void *context, mbedtls_x509_crt *crt, int depth,
                       uint32_t *flags)
{
  struct px_tls *tls = context;
  mbedtls_x509_time now;
  (void)depth;
  /* HAL没有启用HAVE_TIME_DATE，在验证回调中检查整条链的有效期；
   * 只增加错误标志，绝不清除库的签名、信任链或主机名错误。 */
  if (!current_date(&now)) {
    tls->clock_invalid = true;
    *flags |= MBEDTLS_X509_BADCERT_OTHER;
  } else {
    if (compare_date(&now, &crt->valid_from) < 0)
      *flags |= MBEDTLS_X509_BADCERT_FUTURE;
    if (compare_date(&now, &crt->valid_to) > 0)
      *flags |= MBEDTLS_X509_BADCERT_EXPIRED;
  }
  return 0;
}

static int socket_send(void *context, const unsigned char *data, size_t length)
{
  struct px_tls *tls = context;
  int flags = 0;
#ifdef MSG_NOSIGNAL
  flags = MSG_NOSIGNAL;
#endif
  ssize_t result = send(tls->fd, data, length, flags);
  if (result >= 0) return (int)result;
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
    return MBEDTLS_ERR_SSL_WANT_WRITE;
  tls->io_error = errno ? errno : EIO;
  return MBEDTLS_ERR_NET_SEND_FAILED;
}

static int socket_recv(void *context, unsigned char *data, size_t length)
{
  struct px_tls *tls = context;
  ssize_t result = recv(tls->fd, data, length, 0);
  if (result == 0) tls->transport_eof = true;
  if (result >= 0) return (int)result;
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
    return MBEDTLS_ERR_SSL_WANT_READ;
  tls->io_error = errno ? errno : EIO;
  return MBEDTLS_ERR_NET_RECV_FAILED;
}

static int map_error(struct px_tls *tls, int result)
{
  if (result == MBEDTLS_ERR_SSL_WANT_READ || result == MBEDTLS_ERR_SSL_WANT_WRITE) {
    tls->want = result == MBEDTLS_ERR_SSL_WANT_READ ? POLLIN : POLLOUT;
    return -EAGAIN;
  }
  if (tls->clock_invalid) result = -ETIME;
  else if (tls->io_error) result = -tls->io_error;
  else if (tls->transport_eof || result == MBEDTLS_ERR_SSL_CONN_EOF)
    result = -ECONNRESET;
  else if (result == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED ||
           TLS_FN(ssl_get_verify_result)(&tls->ssl) != 0) result = -EACCES;
  else if (result == MBEDTLS_ERR_SSL_ALLOC_FAILED ||
           result == MBEDTLS_ERR_X509_ALLOC_FAILED) result = -ENOMEM;
  else result = -EPROTO;
  tls->error = result;
  tls->want = 0;
  return result;
}

bool px_tls_available(void) { return true; }

void px_tls_free(struct px_tls *tls)
{
  if (!tls) return;
  TLS_FN(ssl_free)(&tls->ssl);
  TLS_FN(ssl_config_free)(&tls->config);
  TLS_FN(x509_crt_free)(&tls->ca);
  TLS_FN(ctr_drbg_free)(&tls->drbg);
  TLS_FN(entropy_free)(&tls->entropy);
  /* 不等待close_notify，也不关闭fd：取消和descriptor生命周期由net拥有。 */
  TLS_FN(platform_zeroize)(tls, sizeof(*tls));
  free(tls);
  release_context();
}

int px_tls_create_with_ca(int fd, const char *hostname, const void *ca_pem,
                          size_t ca_length, struct px_tls **out)
{
  mbedtls_x509_time now;
  static const unsigned char personal[] = "pixelbox-nuttx-tls";
  if (!out) return -EINVAL;
  *out = NULL;
  if (fd < 0 || !hostname || !*hostname || strnlen(hostname, 254) > 253)
    return -EINVAL;
  if (!ca_pem || !ca_length) return -ENOTSUP;
  if (ca_length > PX_TLS_MAX_CA_BYTES) return -E2BIG;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -errno;
  if (!(flags & O_NONBLOCK)) return -EINVAL;
  if (!current_date(&now)) return -ETIME;
  int result = reserve_context();
  if (result) return result;
  struct px_tls *tls = calloc(1, sizeof(*tls));
  if (!tls) { release_context(); return -ENOMEM; }
  tls->fd = fd;
  tls->want = POLLIN | POLLOUT;
  TLS_FN(ssl_init)(&tls->ssl);
  TLS_FN(ssl_config_init)(&tls->config);
  TLS_FN(x509_crt_init)(&tls->ca);
  TLS_FN(entropy_init)(&tls->entropy);
  TLS_FN(ctr_drbg_init)(&tls->drbg);
#if defined(SO_NOSIGPIPE) && !defined(MSG_NOSIGNAL)
  int one = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) < 0) {
    result = -errno;
    goto fail;
  }
#endif
  unsigned char *pem = malloc(ca_length + 1);
  if (!pem) { result = -ENOMEM; goto fail; }
  memcpy(pem, ca_pem, ca_length);
  pem[ca_length] = 0;
  /* 不接受部分成功的CA解析，以免损坏的信任配置被默默忽略。 */
  result = strstr((char *)pem, "-----BEGIN CERTIFICATE-----") ?
    TLS_FN(x509_crt_parse)(&tls->ca, pem, ca_length + 1) : -1;
  free(pem);
  if (result != 0) { result = -EINVAL; goto fail; }
  if (TLS_FN(ctr_drbg_seed)(&tls->drbg, TLS_FN(entropy_func), &tls->entropy,
                            personal, sizeof(personal) - 1) != 0) {
    result = -EIO;
    goto fail;
  }
  if (TLS_FN(ssl_config_defaults)(&tls->config, MBEDTLS_SSL_IS_CLIENT,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    result = -ENOMEM;
    goto fail;
  }
  TLS_FN(ssl_conf_authmode)(&tls->config, MBEDTLS_SSL_VERIFY_REQUIRED);
  TLS_FN(ssl_conf_ca_chain)(&tls->config, &tls->ca, NULL);
  TLS_FN(ssl_conf_rng)(&tls->config, TLS_FN(ctr_drbg_random), &tls->drbg);
  TLS_FN(ssl_conf_verify)(&tls->config, verify_date, tls);
  TLS_FN(ssl_conf_min_tls_version)(&tls->config, MBEDTLS_SSL_VERSION_TLS1_2);
  TLS_FN(ssl_conf_max_tls_version)(&tls->config, MBEDTLS_SSL_VERSION_TLS1_2);
#ifdef MBEDTLS_SSL_RENEGOTIATION
  TLS_FN(ssl_conf_renegotiation)(&tls->config, MBEDTLS_SSL_RENEGOTIATION_DISABLED);
#endif
#ifdef MBEDTLS_SSL_SESSION_TICKETS
  TLS_FN(ssl_conf_session_tickets)(&tls->config, MBEDTLS_SSL_SESSION_TICKETS_DISABLED);
#endif
  if (TLS_FN(ssl_setup)(&tls->ssl, &tls->config) != 0 ||
      TLS_FN(ssl_set_hostname)(&tls->ssl, hostname) != 0) {
    result = -ENOMEM;
    goto fail;
  }
  TLS_FN(ssl_set_bio)(&tls->ssl, tls, socket_send, socket_recv, NULL);
  *out = tls;
  return 0;
fail:
  px_tls_free(tls);
  return result;
}

int px_tls_create(int fd, const char *hostname, struct px_tls **out)
{
  if (!out) return -EINVAL;
  *out = NULL;
  int ca_fd = open(PX_TLS_CA_FILE, O_RDONLY);
  if (ca_fd < 0) {
#ifdef PX_TLS_BUILTIN_CA
    /* 仅未配置覆盖文件时使用只读内置根证书；无效/损坏覆盖文件必须失败。 */
    if (errno == ENOENT)
      return px_tls_create_with_ca(fd, hostname, px_tls_ca_bundle,
                                   sizeof(px_tls_ca_bundle), out);
#endif
    return errno == ENOENT ? -ENOTSUP : -errno;
  }
  struct stat st;
  int result = 0;
  unsigned char *pem = NULL;
  if (fstat(ca_fd, &st) < 0) { result = -errno; goto done; }
  if (!S_ISREG(st.st_mode) || st.st_size <= 0) { result = -EINVAL; goto done; }
  if ((uintmax_t)st.st_size > PX_TLS_MAX_CA_BYTES) { result = -E2BIG; goto done; }
  size_t length = (size_t)st.st_size;
  pem = malloc(length);
  if (!pem) { result = -ENOMEM; goto done; }
  for (size_t offset = 0; offset < length;) {
    ssize_t received = read(ca_fd, pem + offset, length - offset);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) { result = received < 0 ? -errno : -EIO; goto done; }
    offset += (size_t)received;
  }
  result = px_tls_create_with_ca(fd, hostname, pem, length, out);
done:
  free(pem);
  close(ca_fd);
  return result;
}

int px_tls_handshake(struct px_tls *tls)
{
  if (!tls) return -EINVAL;
  if (tls->error) return tls->error;
  if (tls->closed) return -EPIPE;
  if (tls->ready) return 0;
  int result = TLS_FN(ssl_handshake)(&tls->ssl);
  if (result != 0) return map_error(tls, result);
  if (TLS_FN(ssl_get_verify_result)(&tls->ssl) != 0)
    return map_error(tls, MBEDTLS_ERR_X509_CERT_VERIFY_FAILED);
  tls->ready = true;
  tls->want = POLLIN;
  return 0;
}

short px_tls_poll_events(struct px_tls *tls)
{
  return tls && !tls->error && !tls->closed ? tls->want : 0;
}

int px_tls_rebind_fd(struct px_tls *tls, int fd)
{
  if (!tls || fd < 0) return -EINVAL;
  if (tls->error) return tls->error;
  if (!tls->ready) return -ENOTCONN;
  if (tls->closed) return -EPIPE;
  if (tls->write_length) return -EBUSY;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -errno;
  if (!(flags & O_NONBLOCK)) return -EINVAL;
  tls->fd = fd;
  return 0;
}

ssize_t px_tls_read(struct px_tls *tls, void *buffer, size_t length)
{
  if (!tls || (!buffer && length)) return -EINVAL;
  if (tls->error) return tls->error;
  if (!tls->ready) return -ENOTCONN;
  if (tls->closed || !length) return 0;
  if (tls->write_length) return -EAGAIN;
  if (length > INT_MAX) length = INT_MAX;
  int result = TLS_FN(ssl_read)(&tls->ssl, buffer, length);
  if (result > 0) { tls->want = POLLIN; return result; }
  if (result == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) {
    tls->closed = true;
    tls->want = 0;
    return 0;
  }
  /* mbedTLS把原始TCP EOF转成0；没有认证过的close_notify不能当作成功。 */
  if (result == 0) return map_error(tls, MBEDTLS_ERR_SSL_CONN_EOF);
  return map_error(tls, result);
}

ssize_t px_tls_write(struct px_tls *tls, const void *buffer, size_t length)
{
  if (!tls || (!buffer && length)) return -EINVAL;
  if (tls->error) return tls->error;
  if (!tls->ready) return -ENOTCONN;
  if (tls->closed) return -EPIPE;
  size_t chunk = length > PX_TLS_WRITE_BYTES ? PX_TLS_WRITE_BYTES : length;
  if (tls->write_length) {
    if (tls->write_length != chunk || memcmp(tls->write_buffer, buffer, chunk))
      return -EBUSY;
  } else {
    if (!chunk) return 0;
    memcpy(tls->write_buffer, buffer, chunk);
    tls->write_length = chunk;
  }
  /* 重试固定内部地址和长度，满足mbedTLS对WANT_READ/WRITE的约束。 */
  int result = TLS_FN(ssl_write)(&tls->ssl, tls->write_buffer, tls->write_length);
  if (result > 0) {
    tls->write_length = 0;
    tls->want = POLLIN;
    return result;
  }
  return map_error(tls, result ? result : MBEDTLS_ERR_SSL_INTERNAL_ERROR);
}

bool px_tls_pending(struct px_tls *tls)
{
  return tls && tls->ready && !tls->closed && !tls->error && !tls->write_length &&
         TLS_FN(ssl_get_bytes_avail)(&tls->ssl) > 0;
}

#else
/* 未集成HAL TLS时编译明确失败的占位入口，HTTPS/WSS绝不降级到明文。 */
bool px_tls_available(void) { return false; }
int px_tls_create_with_ca(int fd, const char *hostname, const void *ca_pem,
                          size_t ca_length, struct px_tls **out)
{
  (void)fd; (void)hostname; (void)ca_pem; (void)ca_length;
  if (out) *out = NULL;
  return -ENOTSUP;
}
int px_tls_create(int fd, const char *hostname, struct px_tls **out)
{ return px_tls_create_with_ca(fd, hostname, NULL, 0, out); }
int px_tls_handshake(struct px_tls *tls) { (void)tls; return -ENOTSUP; }
int px_tls_rebind_fd(struct px_tls *tls, int fd) { (void)tls; (void)fd; return -ENOTSUP; }
short px_tls_poll_events(struct px_tls *tls) { (void)tls; return 0; }
ssize_t px_tls_read(struct px_tls *tls, void *buffer, size_t length)
{ (void)tls; (void)buffer; (void)length; return -ENOTSUP; }
ssize_t px_tls_write(struct px_tls *tls, const void *buffer, size_t length)
{ (void)tls; (void)buffer; (void)length; return -ENOTSUP; }
bool px_tls_pending(struct px_tls *tls) { (void)tls; return false; }
void px_tls_free(struct px_tls *tls) { (void)tls; }
#endif
