#include "pixelbox_softap.h"

#include <errno.h>
#include <string.h>

#if defined(PX_SOFTAP_TEST)
#  include "softap_test_platform.h"
#  define PX_SOFTAP_PLATFORM 1
#elif defined(__NuttX__)
#  include <nuttx/config.h>
#  if defined(CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP) && defined(CONFIG_NETDEV_WIRELESS_IOCTL)
#    include <nuttx/wireless/wireless.h>
#    include <netutils/netlib.h>
#    define PX_SOFTAP_PLATFORM 1
#  endif
#endif

#ifdef PX_SOFTAP_PLATFORM
#include <arpa/inet.h>
#include <net/if.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

/* 只在工程快照应用模式切换补丁后出现；缺少时禁止走原驱动的全局 stop。 */
extern int pixelbox_wifi_apsta_safe(void) __attribute__((weak));
extern int pixelbox_wifi_softap_running(void) __attribute__((weak));
extern int pixelbox_wifi_softap_sync(void) __attribute__((weak));

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static bool owned, ready;
static char current_ssid[33], current_password[64];
static struct in_addr previous_address, previous_mask;

static int result_of(int value) { return value < 0 ? -(errno ? errno : EIO) : 0; }

static bool adapter_ready(void)
{
  return pixelbox_wifi_apsta_safe && pixelbox_wifi_softap_running &&
         pixelbox_wifi_softap_sync && pixelbox_wifi_apsta_safe() == 1;
}

static void request_init(struct iwreq *request)
{
  memset(request, 0, sizeof(*request));
  memcpy(request->ifr_name, PX_SOFTAP_INTERFACE, sizeof(PX_SOFTAP_INTERFACE));
}

static int request_ioctl(int fd, int command, struct iwreq *request)
{
  errno = 0;
  return result_of(ioctl(fd, command, (unsigned long)request));
}

static int configure_ap(int fd, const char *ssid, const char *password)
{
  struct iwreq request;
  size_t length = strlen(password);
  struct iw_encode_ext *key = calloc(1, sizeof(*key) + length);
  if (!key) return -ENOMEM;
  key->alg = length ? IW_ENCODE_ALG_CCMP : IW_ENCODE_ALG_NONE;
  key->key_len = length;
  memcpy(key->key, password, length);
  request_init(&request);
  request.u.encoding.pointer = key;
  request.u.encoding.length = sizeof(*key) + length;
  int result = request_ioctl(fd, SIOCSIWENCODEEXT, &request);
  memset(key, 0, sizeof(*key) + length);
  free(key);
  if (result < 0) return result;
  request_init(&request);
  request.u.param.flags = IW_AUTH_WPA_VERSION;
  request.u.param.value = length ? IW_AUTH_WPA_VERSION_WPA2 : IW_AUTH_WPA_VERSION_DISABLED;
  result = request_ioctl(fd, SIOCSIWAUTH, &request);
  if (result < 0) return result;
  request_init(&request);
  request.u.essid.pointer = (void *)ssid;
  request.u.essid.length = strlen(ssid);
  request.u.essid.flags = IW_ESSID_ON;
  return request_ioctl(fd, SIOCSIWESSID, &request);
}

static int stop_locked(void)
{
  if (!owned) return 0;
  if (!adapter_ready()) return -ENOTSUP;
  if (pixelbox_wifi_softap_running()) {
    /* 上游 ifdown 会吞掉下层 stop 错误且提前清 ifup。先幂等 ifup，
     * 使失败后的下一次 stop 能重新进入下层；安全补丁不会重启已有角色。 */
    errno = 0;
    int result = result_of(netlib_ifup(PX_SOFTAP_INTERFACE));
    if (result < 0) return result;
  }
  errno = 0;
  int result = result_of(netlib_ifdown(PX_SOFTAP_INTERFACE));
  if (result < 0) return result;
  if (pixelbox_wifi_softap_running()) return -EIO;
  ready = false;
  errno = 0;
  result = result_of(netlib_set_ipv4addr(PX_SOFTAP_INTERFACE, &previous_address));
  errno = 0;
  int mask_result = result_of(netlib_set_ipv4netmask(PX_SOFTAP_INTERFACE, &previous_mask));
  if (!result) result = mask_result;
  if (result < 0) return result; /* 保留所有权，允许再次 stop 完成恢复。 */
  owned = false;
  memset(current_ssid, 0, sizeof(current_ssid));
  memset(current_password, 0, sizeof(current_password));
  return 0;
}

int px_softap_start(const char *ssid, const char *password)
{
  if (!password) password = "";
  size_t ssid_length = ssid ? strlen(ssid) : 0;
  size_t password_length = strlen(password);
  if (!ssid_length || ssid_length > 32 || password_length > 63 ||
      (password_length && password_length < 8)) return -EINVAL;
  pthread_mutex_lock(&lock);
  int result = 0, fd = -1;
  uint8_t flags;
  struct in_addr address, mask, sta_address, sta_mask;
  if (!adapter_ready()) { result = -ENOTSUP; goto out; }
  if (owned) {
    result = ready && !strcmp(ssid, current_ssid) && !strcmp(password, current_password) ? 0 : -EBUSY;
    goto out;
  }
  errno = 0;
  result = result_of(netlib_getifstatus(PX_SOFTAP_INTERFACE, &flags));
  if (result < 0) goto out;
  if ((flags & IFF_UP) || pixelbox_wifi_softap_running()) { result = -EBUSY; goto out; }
  inet_pton(AF_INET, PX_SOFTAP_ADDRESS, &address);
  inet_pton(AF_INET, PX_SOFTAP_NETMASK, &mask);
  errno = 0;
  result = result_of(netlib_get_ipv4addr("wlan0", &sta_address));
  if (result < 0) goto out;
  errno = 0;
  result = result_of(netlib_get_ipv4netmask("wlan0", &sta_mask));
  if (result < 0) goto out;
  if (sta_address.s_addr &&
      (((sta_address.s_addr & mask.s_addr) == (address.s_addr & mask.s_addr)) ||
       ((sta_address.s_addr & sta_mask.s_addr) == (address.s_addr & sta_mask.s_addr)))) {
    result = -EADDRINUSE; goto out;
  }
  errno = 0;
  result = result_of(netlib_get_ipv4addr(PX_SOFTAP_INTERFACE, &previous_address));
  if (result < 0) goto out;
  errno = 0;
  result = result_of(netlib_get_ipv4netmask(PX_SOFTAP_INTERFACE, &previous_mask));
  if (result < 0) goto out;
  errno = 0;
  fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) { result = -(errno ? errno : EIO); goto out; }
  owned = true;
  errno = 0;
  result = result_of(netlib_set_ipv4addr(PX_SOFTAP_INTERFACE, &address));
  if (result < 0) goto rollback;
  errno = 0;
  result = result_of(netlib_set_ipv4netmask(PX_SOFTAP_INTERFACE, &mask));
  if (result < 0) goto rollback;
  errno = 0;
  result = result_of(netlib_ifup(PX_SOFTAP_INTERFACE));
  if (result < 0) goto rollback;
  result = pixelbox_wifi_softap_sync();
  if (result < 0) goto rollback;
  result = configure_ap(fd, ssid, password);
  if (result < 0) goto rollback;
  if (!pixelbox_wifi_softap_running()) { result = -EIO; goto rollback; }
  memcpy(current_ssid, ssid, ssid_length + 1);
  memcpy(current_password, password, password_length + 1);
  ready = true;
  goto out;
rollback:
  /* 只回收自己刚获得的 AP 网卡，失败不会断开 STA 或清空已保存 Wi-Fi 凭据。 */
  {
    int stopped = stop_locked();
    if (stopped < 0) result = stopped;
  }
out:
  if (fd >= 0) close(fd);
  pthread_mutex_unlock(&lock);
  return result;
}

int px_softap_stop(void)
{
  pthread_mutex_lock(&lock);
  int result = stop_locked();
  pthread_mutex_unlock(&lock);
  return result;
}

int px_softap_get_status(struct px_softap_status *status)
{
  if (!status) return -EINVAL;
  memset(status, 0, sizeof(*status));
  pthread_mutex_lock(&lock);
  status->owned = owned;
  if (ready && adapter_ready() && pixelbox_wifi_softap_running()) {
    status->active = true;
    memcpy(status->ssid, current_ssid, sizeof(status->ssid));
    memcpy(status->ip, PX_SOFTAP_ADDRESS, sizeof(PX_SOFTAP_ADDRESS));
  }
  pthread_mutex_unlock(&lock);
  return 0;
}
#else
int px_softap_start(const char *ssid, const char *password)
{ (void)ssid; (void)password; return -ENOTSUP; }
int px_softap_stop(void) { return -ENOTSUP; }
int px_softap_get_status(struct px_softap_status *status)
{ if (status) memset(status, 0, sizeof(*status)); return -ENOTSUP; }
#endif
