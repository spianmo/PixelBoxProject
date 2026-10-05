#include "pixelbox_softap.h"
#include "softap_test_platform.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <net/if.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

static bool safe = true, ap_running, ap_up, sta_link = true;
static int open_fds, writes, ifups, ifdowns, operations, fail_at, stop_error;
static struct in_addr ap_address, ap_mask, sta_address, sta_mask;
static char ap_ssid[33], ap_password[64];
static int auth_mode;

static int step(void)
{
  ++operations;
  if (operations == fail_at) { errno = EIO; return -1; }
  return 0;
}
static void only_ap(const char *name) { assert(!strcmp(name, "wlan1")); }
int pixelbox_wifi_apsta_safe(void) { return safe; }
int pixelbox_wifi_softap_running(void) { return ap_running; }
int pixelbox_wifi_softap_sync(void) { return step() < 0 ? -EIO : 0; }
int px_test_socket(int domain, int type, int protocol)
{
  assert(domain == AF_INET && type == SOCK_DGRAM && protocol == 0);
  if (step()) return -1;
  ++open_fds; return 42;
}
int px_test_close(int fd) { assert(fd == 42 && open_fds == 1); --open_fds; return 0; }
int netlib_getifstatus(const char *name, uint8_t *flags)
{
  only_ap(name); if (step()) return -1; *flags = ap_up ? IFF_UP : 0; return 0;
}
int netlib_ifup(const char *name)
{
  only_ap(name); ++ifups; if (step()) return -1; ap_up = ap_running = true; return 0;
}
int netlib_ifdown(const char *name)
{
  only_ap(name); ++ifdowns; if (step()) return -1;
  if (ap_up) { ap_up = false; if (!stop_error) ap_running = false; }
  return 0; /* 重现上游吞掉 stop 错误。 */
}
int netlib_get_ipv4addr(const char *name, struct in_addr *address)
{
  if (step()) return -1;
  assert(!strcmp(name, "wlan0") || !strcmp(name, "wlan1"));
  *address = !strcmp(name, "wlan0") ? sta_address : ap_address; return 0;
}
int netlib_get_ipv4netmask(const char *name, struct in_addr *mask)
{
  if (step()) return -1;
  assert(!strcmp(name, "wlan0") || !strcmp(name, "wlan1"));
  *mask = !strcmp(name, "wlan0") ? sta_mask : ap_mask; return 0;
}
int netlib_set_ipv4addr(const char *name, const struct in_addr *address)
{
  only_ap(name); ++writes; if (step()) return -1; ap_address = *address; return 0;
}
int netlib_set_ipv4netmask(const char *name, const struct in_addr *mask)
{
  only_ap(name); ++writes; if (step()) return -1; ap_mask = *mask; return 0;
}
int px_test_ioctl(int fd, int command, unsigned long argument)
{
  assert(fd == 42 && open_fds == 1);
  struct iwreq *request = (struct iwreq *)argument;
  only_ap(request->ifr_name); ++writes;
  if (step()) return -1;
  if (command == SIOCSIWENCODEEXT) {
    struct iw_encode_ext *key = request->u.encoding.pointer;
    assert(key->key_len <= 63);
    memset(ap_password, 0, sizeof(ap_password));
    memcpy(ap_password, key->key, key->key_len);
    assert(key->alg == (key->key_len ? IW_ENCODE_ALG_CCMP : IW_ENCODE_ALG_NONE));
  } else if (command == SIOCSIWAUTH) {
    assert(request->u.param.flags == IW_AUTH_WPA_VERSION);
    auth_mode = request->u.param.value;
  } else if (command == SIOCSIWESSID) {
    assert(request->u.essid.flags == IW_ESSID_ON && request->u.essid.length <= 32);
    memset(ap_ssid, 0, sizeof(ap_ssid));
    memcpy(ap_ssid, request->u.essid.pointer, request->u.essid.length);
  } else { assert(!"unexpected AP ioctl"); }
  return 0;
}
static void reset(void)
{
  fail_at = stop_error = 0;
  assert(px_softap_stop() == 0);
  assert(open_fds == 0 && !ap_running && !ap_up && sta_link);
  operations = writes = ifups = ifdowns = 0;
  safe = true;
  ap_address.s_addr = ap_mask.s_addr = 0;
  inet_pton(AF_INET, "192.168.31.100", &sta_address);
  inet_pton(AF_INET, "255.255.255.0", &sta_mask);
}
static void *thread_start(void *unused)
{ (void)unused; assert(px_softap_start("PixelBox-中文", "12345678") == 0); return NULL; }

int main(void)
{
  struct px_softap_status status;
  reset(); safe = false;
  assert(px_softap_start("PixelBox", "12345678") == -ENOTSUP && operations == 0);
  reset();
  assert(px_softap_start(NULL, "12345678") == -EINVAL);
  assert(px_softap_start("", "12345678") == -EINVAL);
  assert(px_softap_start("PixelBox", "short") == -EINVAL);
  char long_password[65]; memset(long_password, 'a', 64); long_password[64] = 0;
  assert(px_softap_start("PixelBox", long_password) == -EINVAL);
  assert(operations == 0);
  ap_up = true;
  assert(px_softap_start("PixelBox", "12345678") == -EBUSY && writes == 0);
  ap_up = false;
  inet_pton(AF_INET, "192.168.4.88", &sta_address);
  assert(px_softap_start("PixelBox", "12345678") == -EADDRINUSE && writes == 0);
  reset();
  pthread_t thread;
  assert(pthread_create(&thread, NULL, thread_start, NULL) == 0);
  assert(pthread_join(thread, NULL) == 0);
  assert(open_fds == 0 && ap_running && sta_link);
  assert(!strcmp(ap_ssid, "PixelBox-中文") && !strcmp(ap_password, "12345678"));
  assert(auth_mode == IW_AUTH_WPA_VERSION_WPA2);
  assert(px_softap_get_status(&status) == 0 && status.active && status.owned);
  assert(!strcmp(status.ssid, "PixelBox-中文") && !strcmp(status.ip, "192.168.4.1"));
  int previous = operations;
  assert(px_softap_start("PixelBox-中文", "12345678") == 0 && operations == previous);
  assert(px_softap_start("Other", "12345678") == -EBUSY && operations == previous);
  assert(px_softap_stop() == 0 && open_fds == 0 && !ap_running && sta_link);
  assert(ap_address.s_addr == 0 && ap_mask.s_addr == 0);
  assert(px_softap_get_status(&status) == 0 && !status.active && !status.owned);
  reset();
  assert(px_softap_start("Open", "") == 0 && ap_password[0] == 0);
  assert(auth_mode == IW_AUTH_WPA_VERSION_DISABLED);
  int start_operations = operations;
  assert(px_softap_stop() == 0);
  /* 每一步本地失败必须释放本任务 fd、恢复 AP 地址，并保留 STA。 */
  for (int at = 1; at <= start_operations; ++at) {
    reset(); fail_at = at;
    assert(px_softap_start("PixelBox", "12345678") < 0);
    fail_at = 0;
    assert(px_softap_stop() == 0);
    assert(open_fds == 0 && !ap_running && !ap_up && sta_link);
    assert(ap_address.s_addr == 0 && ap_mask.s_addr == 0);
  }
  reset();
  assert(px_softap_start("PixelBox", "12345678") == 0);
  stop_error = 1;
  assert(px_softap_stop() == -EIO && ap_running && !ap_up && sta_link);
  assert(px_softap_get_status(&status) == 0 && status.owned);
  stop_error = 0;
  assert(px_softap_stop() == 0 && !ap_running && !ap_up && sta_link);
  reset();
  puts("SoftAP controller: guard, AP-only IO, overlap, lifetime and rollback passed");
  return 0;
}
