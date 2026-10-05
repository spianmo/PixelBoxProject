#include "pixelbox_wifi.h"

#include <errno.h>
#include <string.h>

#if defined(PX_WIFI_TEST)
#  include "wifi_test_platform.h"
#  define PX_WIFI_PLATFORM 1
#elif defined(__NuttX__)
#  include <nuttx/config.h>
#  if defined(CONFIG_NETDEV_WIRELESS_IOCTL) && defined(CONFIG_NETUTILS_DHCPC)
#    include <nuttx/wireless/wireless.h>
#    include <netutils/dhcpc.h>
#    include <netutils/netlib.h>
#    define PX_WIFI_PLATFORM 1
#  endif
#endif

#ifdef PX_WIFI_PLATFORM

#include <arpa/inet.h>
#include <limits.h>
#include <net/if.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define PX_WIFI_SCAN_BYTES 4096
#define PX_WIFI_SCAN_MAX_BYTES 65535
#define PX_WIFI_TIMEOUT_MAX_MS 120000u

struct wifi_state {
  pthread_mutex_t lock;
  pthread_cond_t wake;
  pthread_t thread;
  bool initialized;
  bool stopping;
  bool busy;
  bool resolved;
  bool result_ready;
  bool disconnect_requested;
  bool want_connection;
  int socket_fd;
  char ifname[IFNAMSIZ];
  uint8_t mac[6];
  uint32_t next_job;
  uint32_t job_id;
  enum px_wifi_operation operation;
  uint64_t deadline_ms;
  int cancel_error;
  char ssid[PX_WIFI_SSID_SIZE];
  char password[65];
  void *dhcp;
  uint64_t renew_ms;
  uint64_t lease_expiry_ms;
  struct px_wifi_status status;
  unsigned events;
  struct px_wifi_result result;
};

static struct wifi_state g_wifi = {
  .lock = PTHREAD_MUTEX_INITIALIZER,
  .wake = PTHREAD_COND_INITIALIZER,
  .socket_fd = -1
};

static uint64_t now_ms(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (unsigned long)ts.tv_nsec / 1000000;
}

static int failed_call(int result)
{
  return result < 0 ? -(errno ? errno : EIO) : 0;
}

static int connection_step(const char *stage, int result)
{
  /* 只记录阶段和返回码；关联/DHCP 失败不能把 SSID、密码或密钥写入日志。 */
  fprintf(stderr, "[wifi] stage=%s result=%d\n", stage, result);
  return result;
}

static void request_init(struct iwreq *request)
{
  memset(request, 0, sizeof(*request));
  memcpy(request->ifr_name, g_wifi.ifname, strlen(g_wifi.ifname) + 1);
}

static int wireless_ioctl(int command, struct iwreq *request)
{
  errno = 0;
  return failed_call(ioctl(g_wifi.socket_fd, command,
                           (unsigned long)request));
}

static int clear_ipv4(void)
{
  struct in_addr zero = {0};
  errno = 0;
  int result = failed_call(netlib_set_ipv4addr(g_wifi.ifname, &zero));
  netlib_set_dripv4addr(g_wifi.ifname, &zero);
  netlib_set_ipv4netmask(g_wifi.ifname, &zero);
  return result;
}

static int native_disconnect(void)
{
  struct iwreq request;
  request_init(&request);
  request.u.essid.flags = IW_ESSID_OFF;
  int result = wireless_ioctl(SIOCSIWESSID, &request);
  int cleared = clear_ipv4();
  return result < 0 ? result : cleared;
}

static int native_status(struct px_wifi_status *status)
{
  struct iwreq request;
  struct in_addr address = {0};
  memset(status, 0, sizeof(*status));
  snprintf(status->mac, sizeof(status->mac), "%02x:%02x:%02x:%02x:%02x:%02x",
           g_wifi.mac[0], g_wifi.mac[1], g_wifi.mac[2],
           g_wifi.mac[3], g_wifi.mac[4], g_wifi.mac[5]);
  request_init(&request);
  request.u.essid.pointer = status->ssid;
  request.u.essid.length = PX_WIFI_SSID_SIZE - 1;
  int result = wireless_ioctl(SIOCGIWESSID, &request);
  if (result < 0) return result;
  status->associated = request.u.essid.flags == IW_ESSID_ON;
  if (!status->associated) {
    status->ssid[0] = '\0';
    return 0;
  }
  request_init(&request);
  result = wireless_ioctl(SIOCGIWSENS, &request);
  /* ESP32-S3 驱动返回正的绝对值，128 专指未连接。 */
  if (result == 0 && request.u.sens.value != 128)
    status->rssi = request.u.sens.value > 0 ? -request.u.sens.value : request.u.sens.value;
  errno = 0;
  result = failed_call(netlib_get_ipv4addr(g_wifi.ifname, &address));
  if (result < 0) return result;
  if (address.s_addr != INADDR_ANY && address.s_addr != INADDR_NONE) {
    if (inet_ntop(AF_INET, &address, status->ip, sizeof(status->ip)))
      status->connected = true;
  }
  return 0;
}

static void publish_status_locked(const struct px_wifi_status *status)
{
  if (!g_wifi.status.associated && status->associated)
    g_wifi.events |= PX_WIFI_EVENT_CONNECTED;
  if ((g_wifi.status.associated && !status->associated) ||
      (g_wifi.status.connected && !status->connected))
    g_wifi.events |= PX_WIFI_EVENT_DISCONNECTED;
  if (status->connected && (!g_wifi.status.connected ||
      strcmp(status->ip, g_wifi.status.ip) != 0))
    g_wifi.events |= PX_WIFI_EVENT_GOT_IP;
  g_wifi.status = *status;
}

static void publish_disconnected_locked(void)
{
  struct px_wifi_status status = {0};
  memcpy(status.mac, g_wifi.status.mac, sizeof(status.mac));
  publish_status_locked(&status);
  g_wifi.renew_ms = 0;
  g_wifi.lease_expiry_ms = 0;
}

static int cancellation_locked(void)
{
  if (g_wifi.stopping || g_wifi.disconnect_requested) return -ECANCELED;
  if (g_wifi.cancel_error) return g_wifi.cancel_error;
  if (g_wifi.operation != PX_WIFI_OP_NONE && now_ms() >= g_wifi.deadline_ms)
    return -ETIMEDOUT;
  return 0;
}

static int cancellation(void)
{
  pthread_mutex_lock(&g_wifi.lock);
  int result = cancellation_locked();
  pthread_mutex_unlock(&g_wifi.lock);
  return result;
}

static int set_auth(unsigned flag, int value)
{
  struct iwreq request;
  request_init(&request);
  request.u.param.flags = flag & IW_AUTH_INDEX;
  request.u.param.value = value;
  return wireless_ioctl(SIOCSIWAUTH, &request);
}

static int native_connect(const char *ssid, const char *password)
{
  struct iwreq request;
  size_t password_length = strlen(password);
  int result = connection_step("disconnect", native_disconnect());
  if (result < 0) return result;
  request_init(&request);
  request.u.mode = IW_MODE_INFRA;
  result = connection_step("mode", wireless_ioctl(SIOCSIWMODE, &request));
  if (result < 0) return result;
  result = connection_step("auth-version", set_auth(IW_AUTH_WPA_VERSION, password_length ?
                   IW_AUTH_WPA_VERSION_WPA : IW_AUTH_WPA_VERSION_DISABLED));
  if (result < 0) return result;
  result = connection_step("auth-cipher", set_auth(IW_AUTH_CIPHER_PAIRWISE, password_length ?
                   IW_AUTH_CIPHER_CCMP : IW_AUTH_CIPHER_NONE));
  if (result < 0) return result;

  struct iw_encode_ext *key = calloc(1, sizeof(*key) + password_length);
  if (!key) return -ENOMEM;
  key->alg = password_length ? IW_ENCODE_ALG_CCMP : IW_ENCODE_ALG_NONE;
  key->key_len = password_length;
  memcpy(key->key, password, password_length);
  request_init(&request);
  request.u.encoding.pointer = key;
  request.u.encoding.length = sizeof(*key) + password_length;
  /* 开放网络也显式清除旧密码，避免从加密 AP 切换后残留密钥。 */
  result = connection_step("auth-key", wireless_ioctl(SIOCSIWENCODEEXT, &request));
  memset(key, 0, sizeof(*key) + password_length);
  free(key);
  if (result < 0) return result;
  if ((result = cancellation()) < 0) return result;
  request_init(&request);
  request.u.essid.pointer = (void *)ssid;
  request.u.essid.length = strlen(ssid);
  request.u.essid.flags = IW_ESSID_ON;
  return connection_step("associate", wireless_ioctl(SIOCSIWESSID, &request));
}

/* iw_event 含本机指针对齐；从字节流复制，禁止直接解引用未对齐的结构。 */
static int decode_scan(const uint8_t *bytes, size_t length,
                       struct px_wifi_result *result)
{
  const size_t header = offsetof(struct iw_event, u);
  struct px_wifi_ap *ap = NULL;
  size_t offset = 0;
  while (offset < length) {
    struct iw_event event;
    if (length - offset < header) return -EPROTO;
    memset(&event, 0, sizeof(event));
    memcpy(&event, bytes + offset, header);
    if (event.len < header || event.len > length - offset) return -EPROTO;
    size_t copy_size = event.len < sizeof(event) ? event.len : sizeof(event);
    memcpy(&event, bytes + offset, copy_size);
    size_t payload = event.len - header;
    if (event.cmd == SIOCGIWAP) {
      if (payload < sizeof(event.u.ap_addr)) return -EPROTO;
      ap = result->ap_count < PX_WIFI_MAX_APS ?
           &result->aps[result->ap_count++] : NULL;
    } else if (ap && event.cmd == SIOCGIWESSID) {
      if (payload < sizeof(event.u.essid)) return -EPROTO;
      uintptr_t start = (uintptr_t)event.u.essid.pointer;
      size_t size = event.u.essid.length;
      /* NuttX 驱动的 pointer 是相对 union 的偏移，不是真实地址。 */
      if (start < sizeof(event.u.essid) || start > payload ||
          size > payload - start || size >= sizeof(ap->ssid)) return -EPROTO;
      memcpy(ap->ssid, bytes + offset + header + start, size);
      ap->ssid[size] = '\0';
    } else if (ap && event.cmd == IWEVQUAL) {
      if (payload < sizeof(event.u.qual)) return -EPROTO;
      ap->rssi = (event.u.qual.updated & IW_QUAL_DBM) ?
                 (int)(int8_t)event.u.qual.level : 0;
    } else if (ap && event.cmd == SIOCGIWENCODE) {
      if (payload < sizeof(event.u.data)) return -EPROTO;
      ap->secure = !(event.u.data.flags & IW_ENCODE_DISABLED);
    } else if (ap && event.cmd == SIOCGIWFREQ) {
      if (payload < sizeof(event.u.freq)) return -EPROTO;
      if (event.u.freq.e == 0 && event.u.freq.m >= 1 && event.u.freq.m <= 196)
        ap->channel = event.u.freq.m;
    }
    offset += event.len;
  }
  return 0;
}

static int native_scan(struct px_wifi_result *result)
{
  struct iwreq request;
  request_init(&request);
  int error = wireless_ioctl(SIOCSIWSCAN, &request);
  if (error < 0) return error;
  size_t capacity = PX_WIFI_SCAN_BYTES;
  uint8_t *bytes = malloc(capacity);
  if (!bytes) return -ENOMEM;
  for (unsigned attempt = 0; attempt < 4; ++attempt) {
    if ((error = cancellation()) < 0) break;
    request_init(&request);
    request.u.data.pointer = bytes;
    request.u.data.length = capacity;
    error = wireless_ioctl(SIOCGIWSCAN, &request);
    if (error == -E2BIG) {
      size_t needed = request.u.data.length;
      if (needed <= capacity || needed > PX_WIFI_SCAN_MAX_BYTES) break;
      uint8_t *expanded = realloc(bytes, needed);
      if (!expanded) { error = -ENOMEM; break; }
      bytes = expanded;
      capacity = needed;
      continue;
    }
    if (error == -EAGAIN) continue;
    if (error == 0) {
      error = cancellation();
      if (error == 0)
        error = request.u.data.length > capacity ? -EPROTO :
                decode_scan(bytes, request.u.data.length, result);
    }
    break;
  }
  free(bytes);
  return error;
}

static int obtain_lease(void)
{
  struct dhcpc_state lease;
  errno = 0;
  void *handle = dhcpc_open(g_wifi.ifname, g_wifi.mac, sizeof(g_wifi.mac));
  if (!handle) return connection_step("dhcp-open", -(errno ? errno : ENOMEM));
  pthread_mutex_lock(&g_wifi.lock);
  g_wifi.dhcp = handle;
  int result = cancellation_locked();
  pthread_mutex_unlock(&g_wifi.lock);
  if (result == 0) {
    errno = 0;
    result = connection_step("dhcp-request", failed_call(dhcpc_request(handle, &lease)));
  }
  pthread_mutex_lock(&g_wifi.lock);
  g_wifi.dhcp = NULL;
  int canceled = cancellation_locked();
  pthread_mutex_unlock(&g_wifi.lock);
  dhcpc_close(handle);
  if (canceled < 0) return canceled;
  if (result < 0) return result;
  if (lease.ipaddr.s_addr == INADDR_ANY || lease.ipaddr.s_addr == INADDR_NONE ||
      lease.lease_time == 0) return -EPROTO;
  errno = 0;
  result = failed_call(netlib_set_ipv4addr(g_wifi.ifname, &lease.ipaddr));
  if (result < 0) return result;
  errno = 0;
  result = failed_call(netlib_set_ipv4netmask(g_wifi.ifname, &lease.netmask));
  if (result < 0) return result;
  errno = 0;
  result = failed_call(netlib_set_dripv4addr(g_wifi.ifname, &lease.default_router));
  if (result < 0) return result;
#ifdef CONFIG_NETDB_DNSCLIENT
  if (lease.dnsaddr.s_addr != 0) {
    errno = 0;
    result = failed_call(netlib_set_ipv4dnsaddr(&lease.dnsaddr));
    if (result < 0) return result;
  }
#endif
  pthread_mutex_lock(&g_wifi.lock);
  uint64_t time = now_ms();
  g_wifi.renew_ms = time + (uint64_t)lease.lease_time * 500;
  g_wifi.lease_expiry_ms = time + (uint64_t)lease.lease_time * 1000;
  pthread_mutex_unlock(&g_wifi.lock);
  return cancellation();
}

static int connect_job(const char *ssid, const char *password)
{
  pthread_mutex_lock(&g_wifi.lock);
  publish_disconnected_locked();
  pthread_mutex_unlock(&g_wifi.lock);
  int result = native_connect(ssid, password);
  struct px_wifi_status status;
  if (result == 0) result = cancellation();
  if (result == 0) {
    result = native_status(&status);
    if (result == 0 && !status.associated) result = -ENOTCONN;
    connection_step("association-status", result);
  }
  if (result == 0) {
    status.connected = false;
    status.ip[0] = '\0';
    pthread_mutex_lock(&g_wifi.lock);
    publish_status_locked(&status);
    pthread_mutex_unlock(&g_wifi.lock);
    result = obtain_lease();
  }
  if (result == 0) {
    result = native_status(&status);
    if (result == 0 && !status.connected) result = -ENETUNREACH;
    connection_step("connected-status", result);
  }
  pthread_mutex_lock(&g_wifi.lock);
  int canceled = cancellation_locked();
  if (canceled < 0) result = canceled;
  if (result == 0) publish_status_locked(&status);
  pthread_mutex_unlock(&g_wifi.lock);
  if (result < 0) {
    /* DHCP 即使失败也可能临时写入 OFFER 地址；迟到成功一律撤销。 */
    native_disconnect();
    pthread_mutex_lock(&g_wifi.lock);
    g_wifi.want_connection = false;
    publish_disconnected_locked();
    pthread_mutex_unlock(&g_wifi.lock);
  }
  return result;
}

static void refresh_status(void)
{
  struct px_wifi_status status;
  int result = native_status(&status);
  pthread_mutex_lock(&g_wifi.lock);
  bool wanted = g_wifi.want_connection && !g_wifi.disconnect_requested;
  bool renew = status.associated && wanted &&
               (!g_wifi.renew_ms || now_ms() >= g_wifi.renew_ms);
  bool had_link = g_wifi.status.associated;
  if (result < 0 || !status.associated || !wanted) {
    publish_disconnected_locked();
    pthread_mutex_unlock(&g_wifi.lock);
    if (had_link) clear_ipv4();
    return;
  }
  if (!g_wifi.lease_expiry_ms || now_ms() >= g_wifi.lease_expiry_ms) {
    status.connected = false;
    status.ip[0] = '\0';
  }
  publish_status_locked(&status);
  pthread_mutex_unlock(&g_wifi.lock);
  if (renew) {
    result = obtain_lease();
    if (result == 0) result = native_status(&status);
    if (result < 0 || !status.connected) {
      /* 续租失败后清除地址，下一轮重新取得租约；不保留失效 IP。 */
      clear_ipv4();
      pthread_mutex_lock(&g_wifi.lock);
      g_wifi.renew_ms = 0;
      g_wifi.lease_expiry_ms = 0;
      status = g_wifi.status;
      status.connected = false;
      status.ip[0] = '\0';
      publish_status_locked(&status);
      pthread_mutex_unlock(&g_wifi.lock);
    } else {
      pthread_mutex_lock(&g_wifi.lock);
      if (!cancellation_locked()) publish_status_locked(&status);
      pthread_mutex_unlock(&g_wifi.lock);
    }
  }
}

static void resolve_locked(int error, const struct px_wifi_result *result)
{
  if (g_wifi.resolved) return;
  if (result) g_wifi.result = *result;
  else memset(&g_wifi.result, 0, sizeof(g_wifi.result));
  g_wifi.result.job_id = g_wifi.job_id;
  g_wifi.result.operation = g_wifi.operation;
  g_wifi.result.error = error;
  g_wifi.result.status = g_wifi.status;
  g_wifi.result_ready = true;
  g_wifi.resolved = true;
}

static void *wifi_worker(void *unused)
{
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&g_wifi.lock);
    if (!g_wifi.stopping && !g_wifi.disconnect_requested &&
        g_wifi.operation == PX_WIFI_OP_NONE) {
      struct timespec wake;
      clock_gettime(CLOCK_REALTIME, &wake);
      ++wake.tv_sec;
      pthread_cond_timedwait(&g_wifi.wake, &g_wifi.lock, &wake);
    }
    if (g_wifi.stopping) {
      pthread_mutex_unlock(&g_wifi.lock);
      break;
    }
    bool disconnect = g_wifi.disconnect_requested;
    enum px_wifi_operation operation = g_wifi.operation;
    char ssid[PX_WIFI_SSID_SIZE], password[65];
    memcpy(ssid, g_wifi.ssid, sizeof(ssid));
    memcpy(password, g_wifi.password, sizeof(password));
    g_wifi.busy = true;
    pthread_mutex_unlock(&g_wifi.lock);
    struct px_wifi_result result = {0};
    int error = 0;
    if (disconnect) {
      error = native_disconnect();
    } else if (operation == PX_WIFI_OP_SCAN) {
      error = native_scan(&result);
    } else if (operation == PX_WIFI_OP_CONNECT) {
      error = connect_job(ssid, password);
    } else {
      refresh_status();
    }
    memset(password, 0, sizeof(password));
    pthread_mutex_lock(&g_wifi.lock);
    /* 发布状态后到结算 Promise 之间仍可能刚好到期；必须一并撤销连接。 */
    int canceled = cancellation_locked();
    if (!disconnect && operation == PX_WIFI_OP_CONNECT &&
        error == 0 && canceled < 0) {
      pthread_mutex_unlock(&g_wifi.lock);
      native_disconnect();
      pthread_mutex_lock(&g_wifi.lock);
      g_wifi.want_connection = false;
      publish_disconnected_locked();
      error = canceled;
    }
    if (disconnect) {
      g_wifi.disconnect_requested = false;
      publish_disconnected_locked();
      if (operation != PX_WIFI_OP_NONE) error = -ECANCELED;
    }
    if (operation != PX_WIFI_OP_NONE) {
      canceled = cancellation_locked();
      resolve_locked(canceled < 0 ? canceled : error, &result);
      g_wifi.operation = PX_WIFI_OP_NONE;
      memset(g_wifi.password, 0, sizeof(g_wifi.password));
    }
    g_wifi.cancel_error = 0;
    g_wifi.busy = false;
    pthread_mutex_unlock(&g_wifi.lock);
  }
  native_disconnect();
  return NULL;
}

int px_wifi_init(const char *ifname)
{
  if (!ifname || !*ifname || strlen(ifname) >= IFNAMSIZ) return -EINVAL;
  if (g_wifi.initialized) return strcmp(ifname, g_wifi.ifname) ? -EBUSY : 0;
  memcpy(g_wifi.ifname, ifname, strlen(ifname) + 1);
  errno = 0;
  if (netlib_getmacaddr(ifname, g_wifi.mac) < 0) return -(errno ? errno : ENODEV);
  errno = 0;
  if (netlib_ifup(ifname) < 0) return -(errno ? errno : EIO);
  g_wifi.socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (g_wifi.socket_fd < 0) return -(errno ? errno : EIO);
  struct px_wifi_status status;
  int error = native_status(&status);
  if (error < 0) { close(g_wifi.socket_fd); g_wifi.socket_fd = -1; return error; }
  g_wifi.status = status;
  g_wifi.want_connection = status.associated;
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  size_t stack_size = 8192;
#ifdef PTHREAD_STACK_MIN
  if (stack_size < PTHREAD_STACK_MIN) stack_size = PTHREAD_STACK_MIN;
#endif
  error = pthread_attr_setstacksize(&attributes, stack_size);
  if (error == 0) error = pthread_create(&g_wifi.thread, &attributes, wifi_worker, NULL);
  pthread_attr_destroy(&attributes);
  if (error) { close(g_wifi.socket_fd); g_wifi.socket_fd = -1; return -error; }
  g_wifi.initialized = true;
  return 0;
}

static int start_job(enum px_wifi_operation operation, const char *ssid,
                      const char *password, unsigned timeout_ms, uint32_t *job_id)
{
  if (!job_id || timeout_ms > PX_WIFI_TIMEOUT_MAX_MS) return -EINVAL;
  pthread_mutex_lock(&g_wifi.lock);
  if (!g_wifi.initialized) { pthread_mutex_unlock(&g_wifi.lock); return -ENODEV; }
  if (g_wifi.busy || g_wifi.operation != PX_WIFI_OP_NONE ||
      g_wifi.result_ready || g_wifi.disconnect_requested) {
    pthread_mutex_unlock(&g_wifi.lock);
    return -EBUSY;
  }
  if (++g_wifi.next_job == 0) ++g_wifi.next_job;
  g_wifi.job_id = g_wifi.next_job;
  g_wifi.operation = operation;
  g_wifi.cancel_error = 0;
  g_wifi.resolved = false;
  g_wifi.deadline_ms = now_ms() + timeout_ms;
  if (operation == PX_WIFI_OP_CONNECT) {
    memcpy(g_wifi.ssid, ssid, strlen(ssid) + 1);
    memcpy(g_wifi.password, password, strlen(password) + 1);
    g_wifi.want_connection = true;
  }
  *job_id = g_wifi.job_id;
  pthread_cond_signal(&g_wifi.wake);
  pthread_mutex_unlock(&g_wifi.lock);
  return 0;
}

int px_wifi_scan_start(unsigned timeout_ms, uint32_t *job_id)
{
  return start_job(PX_WIFI_OP_SCAN, NULL, NULL, timeout_ms ? timeout_ms : 10000, job_id);
}

int px_wifi_connect_start(const char *ssid, const char *password,
                          unsigned timeout_ms, uint32_t *job_id)
{
  if (!ssid || !*ssid || strlen(ssid) >= PX_WIFI_SSID_SIZE) return -EINVAL;
  if (!password) password = "";
  if (strlen(password) > 64) return -EINVAL;
  return start_job(PX_WIFI_OP_CONNECT, ssid, password,
                   timeout_ms ? timeout_ms : 15000, job_id);
}

int px_wifi_disconnect(void)
{
  pthread_mutex_lock(&g_wifi.lock);
  if (!g_wifi.initialized) { pthread_mutex_unlock(&g_wifi.lock); return -ENODEV; }
  g_wifi.want_connection = false;
  g_wifi.disconnect_requested = true;
  g_wifi.cancel_error = -ECANCELED;
  if (g_wifi.operation != PX_WIFI_OP_NONE) resolve_locked(-ECANCELED, NULL);
  if (g_wifi.dhcp) dhcpc_cancel(g_wifi.dhcp);
  publish_disconnected_locked();
  pthread_cond_signal(&g_wifi.wake);
  pthread_mutex_unlock(&g_wifi.lock);
  return 0;
}

int px_wifi_poll(struct px_wifi_result *result)
{
  if (!result) return -EINVAL;
  pthread_mutex_lock(&g_wifi.lock);
  if (!g_wifi.initialized) { pthread_mutex_unlock(&g_wifi.lock); return -ENODEV; }
  if (g_wifi.operation != PX_WIFI_OP_NONE && !g_wifi.resolved &&
      now_ms() >= g_wifi.deadline_ms) {
    g_wifi.cancel_error = -ETIMEDOUT;
    if (g_wifi.dhcp) dhcpc_cancel(g_wifi.dhcp);
    resolve_locked(-ETIMEDOUT, NULL);
  }
  if (g_wifi.lease_expiry_ms && now_ms() >= g_wifi.lease_expiry_ms &&
      g_wifi.status.connected) {
    struct px_wifi_status status = g_wifi.status;
    status.connected = false;
    status.ip[0] = '\0';
    publish_status_locked(&status);
  }
  int ready = g_wifi.result_ready || g_wifi.events;
  if (ready) {
    if (g_wifi.result_ready) *result = g_wifi.result;
    else memset(result, 0, sizeof(*result));
    result->events = g_wifi.events;
    result->status = g_wifi.status;
    g_wifi.events = 0;
    g_wifi.result_ready = false;
  }
  pthread_mutex_unlock(&g_wifi.lock);
  return !!ready;
}

int px_wifi_get_status(struct px_wifi_status *status)
{
  if (!status) return -EINVAL;
  pthread_mutex_lock(&g_wifi.lock);
  int result = g_wifi.initialized ? 0 : -ENODEV;
  *status = g_wifi.status;
  pthread_mutex_unlock(&g_wifi.lock);
  return result;
}

void px_wifi_shutdown(void)
{
  pthread_mutex_lock(&g_wifi.lock);
  if (!g_wifi.initialized) { pthread_mutex_unlock(&g_wifi.lock); return; }
  g_wifi.stopping = true;
  if (g_wifi.dhcp) dhcpc_cancel(g_wifi.dhcp);
  pthread_cond_signal(&g_wifi.wake);
  pthread_mutex_unlock(&g_wifi.lock);
  pthread_join(g_wifi.thread, NULL);
  close(g_wifi.socket_fd);
  pthread_mutex_lock(&g_wifi.lock);
  g_wifi.socket_fd = -1;
  g_wifi.initialized = false;
  g_wifi.stopping = false;
  g_wifi.busy = false;
  g_wifi.result_ready = false;
  g_wifi.resolved = false;
  g_wifi.disconnect_requested = false;
  g_wifi.want_connection = false;
  g_wifi.operation = PX_WIFI_OP_NONE;
  g_wifi.cancel_error = 0;
  g_wifi.events = 0;
  g_wifi.renew_ms = g_wifi.lease_expiry_ms = 0;
  memset(g_wifi.password, 0, sizeof(g_wifi.password));
  memset(&g_wifi.status, 0, sizeof(g_wifi.status));
  pthread_mutex_unlock(&g_wifi.lock);
}

#else

int px_wifi_init(const char *ifname) { (void)ifname; return -ENOTSUP; }
void px_wifi_shutdown(void) {}
int px_wifi_scan_start(unsigned timeout_ms, uint32_t *job_id)
{ (void)timeout_ms; (void)job_id; return -ENOTSUP; }
int px_wifi_connect_start(const char *ssid, const char *password,
                          unsigned timeout_ms, uint32_t *job_id)
{ (void)ssid; (void)password; (void)timeout_ms; (void)job_id; return -ENOTSUP; }
int px_wifi_disconnect(void) { return -ENOTSUP; }
int px_wifi_poll(struct px_wifi_result *result)
{ (void)result; return -ENOTSUP; }
int px_wifi_get_status(struct px_wifi_status *status)
{ if (status) memset(status, 0, sizeof(*status)); return -ENOTSUP; }

#endif
