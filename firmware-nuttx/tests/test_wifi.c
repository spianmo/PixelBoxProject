#include "pixelbox_wifi.h"
#include "wifi_test_platform.h"

#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_mutex_t fake_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned connect_delay;
static unsigned dhcp_delay;
static unsigned scan_delay;
static int dhcp_error;
static int dhcp_open_error;
static int connect_error;
static unsigned lease_seconds = 600;
static bool associated;
static bool missing_interface;
static bool drop_after_dhcp;
static char connected_ssid[33];
static struct in_addr assigned_ip;
static uint8_t scan_bytes[32768];
static size_t scan_length;
static int key_algorithm;
static size_t key_length;
static atomic_uint dhcp_requests;
static atomic_uint scan_reads;
static atomic_bool connect_entered;
static atomic_bool dhcp_entered;
static atomic_bool scan_entered;

static void delay(unsigned ms)
{
  struct timespec ts = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000};
  nanosleep(&ts, NULL);
}

static uint64_t milliseconds(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int px_test_socket(int domain, int type, int protocol)
{ assert(domain == AF_INET && type == SOCK_DGRAM && protocol == 0); return 123; }
int px_test_close(int fd) { assert(fd == 123); return 0; }

int netlib_getmacaddr(const char *ifname, uint8_t *mac)
{
  if (missing_interface || strcmp(ifname, "wlan0")) { errno = ENODEV; return -1; }
  static const uint8_t address[] = {2, 0, 1, 2, 3, 4};
  memcpy(mac, address, sizeof(address));
  return 0;
}
int netlib_ifup(const char *ifname) { assert(!strcmp(ifname, "wlan0")); return 0; }
int netlib_get_ipv4addr(const char *ifname, struct in_addr *address)
{
  (void)ifname;
  pthread_mutex_lock(&fake_lock);
  *address = assigned_ip;
  pthread_mutex_unlock(&fake_lock);
  return 0;
}
int netlib_set_ipv4addr(const char *ifname, const struct in_addr *address)
{
  (void)ifname;
  pthread_mutex_lock(&fake_lock);
  assigned_ip = *address;
  pthread_mutex_unlock(&fake_lock);
  return 0;
}
int netlib_set_ipv4netmask(const char *name, const struct in_addr *address)
{ (void)name; (void)address; return 0; }
int netlib_set_dripv4addr(const char *name, const struct in_addr *address)
{ (void)name; (void)address; return 0; }
int netlib_set_ipv4dnsaddr(const struct in_addr *address)
{ (void)address; return 0; }

int px_test_ioctl(int fd, int command, unsigned long argument)
{
  assert(fd == 123);
  struct iwreq *request = (struct iwreq *)argument;
  assert(!strcmp(request->ifr_name, "wlan0"));
  if (command == SIOCSIWESSID && request->u.essid.flags == IW_ESSID_ON) {
    atomic_store(&connect_entered, true);
    delay(connect_delay);
    if (connect_error) { errno = connect_error; return -1; }
    pthread_mutex_lock(&fake_lock);
    associated = true;
    memset(connected_ssid, 0, sizeof(connected_ssid));
    memcpy(connected_ssid, request->u.essid.pointer, request->u.essid.length);
    pthread_mutex_unlock(&fake_lock);
    return 0;
  }
  if (command == SIOCGIWSCAN) {
    atomic_store(&scan_entered, true);
    ++scan_reads;
    delay(scan_delay);
    if (request->u.data.length < scan_length) {
      request->u.data.length = scan_length;
      errno = E2BIG;
      return -1;
    }
    memcpy(request->u.data.pointer, scan_bytes, scan_length);
    request->u.data.length = scan_length;
    return 0;
  }
  pthread_mutex_lock(&fake_lock);
  switch (command) {
  case SIOCGIWESSID:
    memcpy(request->u.essid.pointer, connected_ssid,
           strnlen(connected_ssid, request->u.essid.length));
    request->u.essid.flags = associated ? IW_ESSID_ON : IW_ESSID_OFF;
    break;
  case SIOCGIWSENS:
    request->u.sens.value = associated ? 47 : 128;
    break;
  case SIOCSIWESSID:
    associated = false;
    break;
  case SIOCSIWENCODEEXT: {
    struct iw_encode_ext *key = request->u.encoding.pointer;
    key_algorithm = key->alg;
    key_length = key->key_len;
    assert(request->u.encoding.length == sizeof(*key) + key_length);
    break;
  }
  case SIOCSIWAUTH:
    assert(request->u.param.flags == IW_AUTH_WPA_VERSION ||
           request->u.param.flags == IW_AUTH_CIPHER_PAIRWISE);
    break;
  case SIOCSIWMODE:
    assert(request->u.mode == IW_MODE_INFRA);
    break;
  case SIOCSIWSCAN: break;
  default: assert(false);
  }
  pthread_mutex_unlock(&fake_lock);
  return 0;
}

struct fake_dhcp { atomic_bool canceled; };
void *dhcpc_open(const char *interface, const void *mac, int length)
{
  assert(!strcmp(interface, "wlan0") && mac && length == 6);
  if (dhcp_open_error) { errno = dhcp_open_error; return NULL; }
  return calloc(1, sizeof(struct fake_dhcp));
}
void dhcpc_cancel(void *handle)
{ atomic_store(&((struct fake_dhcp *)handle)->canceled, true); }
void dhcpc_close(void *handle) { free(handle); }
int dhcpc_request(void *handle, struct dhcpc_state *lease)
{
  (void)handle;
  atomic_store(&dhcp_entered, true);
  ++dhcp_requests;
  delay(dhcp_delay);
  memset(lease, 0, sizeof(*lease));
  inet_pton(AF_INET, "192.0.2.18", &lease->ipaddr);
  inet_pton(AF_INET, "255.255.255.0", &lease->netmask);
  inet_pton(AF_INET, "192.0.2.1", &lease->default_router);
  inet_pton(AF_INET, "192.0.2.53", &lease->dnsaddr);
  lease->lease_time = lease_seconds;
  /* 模拟取消后仍迟到成功，以及 DHCP 失败留下临时 OFFER IP。 */
  netlib_set_ipv4addr("wlan0", &lease->ipaddr);
  if (drop_after_dhcp) {
    pthread_mutex_lock(&fake_lock);
    associated = false;
    pthread_mutex_unlock(&fake_lock);
  }
  if (dhcp_error) { errno = dhcp_error; return -1; }
  return 0;
}

static void reset(void)
{
  px_wifi_shutdown();
  connect_delay = dhcp_delay = scan_delay = 0;
  dhcp_error = dhcp_open_error = connect_error = 0;
  lease_seconds = 600;
  associated = missing_interface = drop_after_dhcp = false;
  memset(connected_ssid, 0, sizeof(connected_ssid));
  assigned_ip.s_addr = 0;
  scan_length = 0;
  key_algorithm = -1;
  key_length = 999;
  dhcp_requests = scan_reads = 0;
  atomic_store(&connect_entered, false);
  atomic_store(&dhcp_entered, false);
  atomic_store(&scan_entered, false);
}

static void wait_entered(atomic_bool *entered)
{
  uint64_t deadline = milliseconds() + 500;
  while (!atomic_load(entered) && milliseconds() < deadline) delay(1);
  assert(atomic_load(entered));
}

static struct px_wifi_result await_job(uint32_t job)
{
  struct px_wifi_result result;
  uint64_t deadline = milliseconds() + 1200;
  while (milliseconds() < deadline) {
    int available = px_wifi_poll(&result);
    assert(available >= 0);
    if (available && result.operation != PX_WIFI_OP_NONE) {
      assert(result.job_id == job);
      return result;
    }
    delay(1);
  }
  assert(!"Wi-Fi 作业超时未结算");
  memset(&result, 0, sizeof(result));
  return result;
}

static void assert_disconnected(void)
{
  struct px_wifi_status status;
  assert(px_wifi_get_status(&status) == 0);
  assert(!status.associated && !status.connected && !*status.ip);
  struct in_addr address;
  netlib_get_ipv4addr("wlan0", &address);
  assert(address.s_addr == 0);
}

static void append_event(struct iw_event *event, size_t size)
{
  event->len = size;
  assert(scan_length + size < sizeof(scan_bytes));
  memcpy(scan_bytes + scan_length, event, size);
  scan_length += size;
}

static void append_ap(const char *ssid, bool secure)
{
  const size_t header = offsetof(struct iw_event, u);
  struct iw_event event = {0};
  event.cmd = SIOCGIWAP;
  append_event(&event, header + sizeof(event.u.ap_addr));
  uint8_t bytes[256] = {0};
  event.cmd = SIOCGIWESSID;
  event.u.essid.pointer = (void *)sizeof(struct iw_point);
  event.u.essid.length = strlen(ssid);
  event.len = header + sizeof(struct iw_point) + strlen(ssid);
  memcpy(bytes, &event, header + sizeof(struct iw_point));
  memcpy(bytes + header + sizeof(struct iw_point), ssid, strlen(ssid));
  memcpy(scan_bytes + scan_length, bytes, event.len);
  scan_length += event.len;
  memset(&event, 0, sizeof(event));
  event.cmd = IWEVQUAL;
  event.u.qual.updated = IW_QUAL_DBM;
  event.u.qual.level = (uint8_t)-61;
  append_event(&event, header + sizeof(event.u.qual));
  event.cmd = SIOCGIWENCODE;
  event.u.data.flags = secure ? IW_ENCODE_ENABLED | IW_ENCODE_NOKEY : IW_ENCODE_DISABLED;
  append_event(&event, header + sizeof(event.u.data));
  event.cmd = SIOCGIWFREQ;
  event.u.freq.m = 11;
  event.u.freq.e = 0;
  append_event(&event, header + sizeof(event.u.freq));
}

static void test_init_validation(void)
{
  reset();
  assert(px_wifi_init(NULL) == -EINVAL);
  assert(px_wifi_init("") == -EINVAL);
  missing_interface = true;
  assert(px_wifi_init("wlan0") == -ENODEV);
  missing_interface = false;
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_init("wlan1") == -EBUSY);
  uint32_t job;
  assert(px_wifi_connect_start("", NULL, 0, &job) == -EINVAL);
  assert(px_wifi_connect_start("123456789012345678901234567890123", NULL, 0, &job) == -EINVAL);
  assert(px_wifi_scan_start(120001, &job) == -EINVAL);
  assert(px_wifi_scan_start(10, NULL) == -EINVAL);
  assert(px_wifi_poll(NULL) == -EINVAL);
}

static void test_connection_dhcp_and_open_key(void)
{
  reset();
  dhcp_delay = 60;
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_connect_start("12345678901234567890123456789012", "password", 1000, &job) == 0);
  wait_entered(&dhcp_entered);
  struct px_wifi_status status;
  assert(px_wifi_get_status(&status) == 0);
  assert(status.associated && !status.connected && !*status.ip);
  struct px_wifi_result result = await_job(job);
  assert(result.error == 0 && result.status.connected && result.status.rssi == -47);
  assert(strlen(result.status.ssid) == 32 && !strcmp(result.status.ip, "192.0.2.18"));
  assert(!strcmp(result.status.mac, "02:00:01:02:03:04"));
  assert(key_algorithm == IW_ENCODE_ALG_CCMP && key_length == 8);
  assert(result.events & PX_WIFI_EVENT_GOT_IP);
  assert(px_wifi_connect_start("open", NULL, 1000, &job) == 0);
  result = await_job(job);
  assert(result.error == 0 && result.status.connected);
  assert(key_algorithm == IW_ENCODE_ALG_NONE && key_length == 0);
  assert(px_wifi_disconnect() == 0);
  delay(20);
  assert_disconnected();
}

static void test_connect_deadline_and_late_success(void)
{
  reset();
  connect_delay = 180;
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job, second;
  uint64_t start = milliseconds();
  assert(px_wifi_connect_start("slow", "password", 30, &job) == 0);
  wait_entered(&connect_entered);
  assert(px_wifi_scan_start(100, &second) == -EBUSY);
  struct px_wifi_result result = await_job(job);
  assert(result.error == -ETIMEDOUT && milliseconds() - start < 130);
  assert(px_wifi_scan_start(100, &second) == -EBUSY);
  delay(200);
  assert_disconnected();
  assert(dhcp_requests == 0);
  assert(px_wifi_scan_start(100, &second) == 0);
  assert(await_job(second).error == 0);
}

static void test_dhcp_deadline_and_failure_cleanup(void)
{
  reset();
  dhcp_delay = 180;
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_connect_start("slow-dhcp", "password", 30, &job) == 0);
  wait_entered(&dhcp_entered);
  assert(await_job(job).error == -ETIMEDOUT);
  delay(200);
  assert_disconnected();
  reset();
  dhcp_error = EHOSTUNREACH;
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_connect_start("failed-dhcp", "password", 1000, &job) == 0);
  assert(await_job(job).error == -EHOSTUNREACH);
  assert_disconnected();
}

static void test_cancellation_and_shutdown(void)
{
  reset();
  dhcp_delay = 100;
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_connect_start("cancel", "password", 1000, &job) == 0);
  wait_entered(&dhcp_entered);
  assert(px_wifi_disconnect() == 0);
  assert(await_job(job).error == -ECANCELED);
  delay(130);
  assert_disconnected();
  assert(px_wifi_connect_start("shutdown", "password", 1000, &job) == 0);
  px_wifi_shutdown();
  struct px_wifi_status status;
  assert(px_wifi_get_status(&status) == -ENODEV);
  assert(assigned_ip.s_addr == 0 && !associated);
  assert(px_wifi_init("wlan0") == 0);
}

static void test_network_unreachable_stages(void)
{
  /* 同一 ENETUNREACH 可来自不同阶段；全部必须结算并撤销临时地址。 */
  for (unsigned stage = 0; stage < 4; ++stage) {
    reset();
    if (stage == 0) connect_error = ENETUNREACH;
    if (stage == 1) dhcp_open_error = ENETUNREACH;
    if (stage == 2) dhcp_error = ENETUNREACH;
    if (stage == 3) drop_after_dhcp = true;
    assert(px_wifi_init("wlan0") == 0);
    uint32_t job;
    assert(px_wifi_connect_start("diagnostic-ssid", "diagnostic-secret-123", 1000, &job) == 0);
    assert(await_job(job).error == -ENETUNREACH);
    assert_disconnected();
    assert(dhcp_requests == (stage >= 2 ? 1u : 0u));
  }
}

static void test_scan_and_event_bounds(void)
{
  reset();
  append_ap("open-ap", false);
  append_ap("12345678901234567890123456789012", true);
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_scan_start(1000, &job) == 0);
  struct px_wifi_result result = await_job(job);
  assert(result.error == 0 && result.ap_count == 2);
  assert(!result.aps[0].secure && result.aps[1].secure);
  assert(result.aps[0].rssi == -61 && result.aps[0].channel == 11);
  assert(strlen(result.aps[1].ssid) == 32);
  reset();
  for (unsigned i = 0; i < 40; ++i) append_ap("overflow", true);
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_scan_start(1000, &job) == 0);
  result = await_job(job);
  assert(result.error == 0 && result.ap_count == PX_WIFI_MAX_APS && scan_reads == 2);
  reset();
  append_ap("corrupt", false);
  /* 篡改 ESSID 的相对指针，使其指向事件边界以外。 */
  size_t header = offsetof(struct iw_event, u);
  size_t ssid_start = header + sizeof(struct sockaddr);
  uintptr_t bad_pointer = UINTPTR_MAX;
  memcpy(scan_bytes + ssid_start + header, &bad_pointer, sizeof(bad_pointer));
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_scan_start(1000, &job) == 0);
  assert(await_job(job).error == -EPROTO);
  reset();
  scan_bytes[0] = 1;
  scan_length = 1;
  assert(px_wifi_init("wlan0") == 0);
  assert(px_wifi_scan_start(1000, &job) == 0);
  assert(await_job(job).error == -EPROTO);
}

static void test_scan_deadline_and_disconnect(void)
{
  reset();
  scan_delay = 100;
  append_ap("slow", true);
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_scan_start(20, &job) == 0);
  wait_entered(&scan_entered);
  assert(await_job(job).error == -ETIMEDOUT);
  delay(120);
  assert(px_wifi_scan_start(1000, &job) == 0);
  assert(px_wifi_disconnect() == 0);
  assert(await_job(job).error == -ECANCELED);
}

static void test_lease_renewal_and_link_loss(void)
{
  reset();
  lease_seconds = 2;
  assert(px_wifi_init("wlan0") == 0);
  uint32_t job;
  assert(px_wifi_connect_start("lease", NULL, 1000, &job) == 0);
  assert(await_job(job).error == 0);
  delay(1250);
  pthread_mutex_lock(&fake_lock);
  assert(dhcp_requests >= 2);
  associated = false;
  pthread_mutex_unlock(&fake_lock);
  delay(1050);
  assert_disconnected();
}

int main(void)
{
  test_init_validation();
  test_connection_dhcp_and_open_key();
  test_connect_deadline_and_late_success();
  test_dhcp_deadline_and_failure_cleanup();
  test_cancellation_and_shutdown();
  test_network_unreachable_stages();
  test_scan_and_event_bounds();
  test_scan_deadline_and_disconnect();
  test_lease_renewal_and_link_loss();
  reset();
  puts("Wi-Fi: 9 test groups passed (native ioctl/DHCP mocks, deadlines, parsing, cleanup, leases, failure stages)");
  return 0;
}
