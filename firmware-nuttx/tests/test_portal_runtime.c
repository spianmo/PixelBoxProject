#include "pixelbox_portal.h"
#include "pixelbox_softap.h"
#include "pixelbox_wifi.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef PX_PORTAL_STACK_PROBE
#include "portal_stack_probe.h"
#endif

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static unsigned ap_starts, ap_stops, disconnects, connects, scans, polls, dhcp_starts, dhcp_stops;
static bool ap_active, dhcp_active, hold_start, hold_stop, fail_stop;
static unsigned worker_creates, worker_joins, workers_unjoined, fail_create;
static bool fail_join;

int px_test_pthread_create(pthread_t *thread, const pthread_attr_t *attributes,
                          void *(*entry)(void *), void *argument)
{
#ifdef PX_PORTAL_TEST_CHECK_NO_VM
  PX_PORTAL_TEST_CHECK_NO_VM();
#endif
  pthread_mutex_lock(&mutex);
  ++worker_creates;
  bool failed = fail_create && --fail_create == 0;
  pthread_mutex_unlock(&mutex);
  if (failed) return EAGAIN;
#ifdef PX_PORTAL_STACK_PROBE
  int result = px_stack_probe_create(thread, attributes, entry, argument, px_test_portal_worker_stack(entry));
#else
  int result = pthread_create(thread, attributes, entry, argument);
#endif
  if (!result) { pthread_mutex_lock(&mutex); ++workers_unjoined; pthread_mutex_unlock(&mutex); }
  return result;
}
int px_test_pthread_join(pthread_t thread, void **value)
{
#ifdef PX_PORTAL_TEST_CHECK_NO_VM
  PX_PORTAL_TEST_CHECK_NO_VM();
#endif
  pthread_mutex_lock(&mutex); bool failed = fail_join; pthread_mutex_unlock(&mutex);
  if (failed) return EBUSY;
#ifdef PX_PORTAL_STACK_PROBE
  int result = px_stack_probe_join(thread, value);
#else
  int result = pthread_join(thread, value);
#endif
  if (!result) {
    pthread_mutex_lock(&mutex);
    assert(workers_unjoined); --workers_unjoined; ++worker_joins;
    pthread_mutex_unlock(&mutex);
  }
  return result;
}
static struct px_wifi_status wifi = {.associated = true, .connected = true, .ssid = "Finger", .ip = "192.168.31.100"};
static struct px_wifi_result pending;
static unsigned next_job, scan_ms = 100, connect_ms = 80;
static uint64_t due, busy_until;
#ifndef PX_PORTAL_TEST_CHECK_NO_VM
#define PX_PORTAL_TEST_CHECK_NO_VM() ((void)0)
#endif
static uint64_t now_ms(void)
{ struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
int px_portal_ap_identity(char ssid[33], char password[64])
{ strcpy(ssid, "PixelBox-ABCD"); strcpy(password, "38192047"); return 0; }
int px_softap_start(const char *ssid, const char *password)
{
  PX_PORTAL_TEST_CHECK_NO_VM();
  assert(!strcmp(ssid, "PixelBox-ABCD") && strlen(password) == 8);
  pthread_mutex_lock(&mutex); assert(!ap_active); ap_active = true; ++ap_starts; pthread_mutex_unlock(&mutex); return 0;
}
int px_softap_stop(void)
{ pthread_mutex_lock(&mutex); assert(!dhcp_active); ap_active = false; ++ap_stops; pthread_mutex_unlock(&mutex); return 0; }
int px_softap_get_status(struct px_softap_status *status)
{ memset(status, 0, sizeof(*status)); pthread_mutex_lock(&mutex); status->owned = status->active = ap_active; pthread_mutex_unlock(&mutex); return 0; }
int px_portal_dhcp_start(void)
{
  pthread_mutex_lock(&mutex); ++dhcp_starts;
  while (hold_start) pthread_cond_wait(&wake, &mutex);
  assert(ap_active); dhcp_active = true; pthread_mutex_unlock(&mutex); return 0;
}
int px_portal_dhcp_stop(void)
{
  pthread_mutex_lock(&mutex); ++dhcp_stops;
  while (hold_stop) pthread_cond_wait(&wake, &mutex);
  int error = fail_stop ? -EIO : 0; if (!error) dhcp_active = false;
  pthread_mutex_unlock(&mutex); return error;
}
int px_portal_dhcp_status(void)
{ pthread_mutex_lock(&mutex); int status = dhcp_active; pthread_mutex_unlock(&mutex); return status; }
int px_wifi_init(const char *name) { (void)name; return 0; }
void px_wifi_shutdown(void) { assert(0 && "门户不得关闭全局 Wi-Fi"); }
int px_wifi_get_status(struct px_wifi_status *status)
{ pthread_mutex_lock(&mutex); *status = wifi; pthread_mutex_unlock(&mutex); return 0; }
int px_wifi_scan_start(unsigned timeout, uint32_t *id)
{
  assert(timeout > 0); pthread_mutex_lock(&mutex);
  if (pending.job_id || now_ms() < busy_until) { pthread_mutex_unlock(&mutex); return -EBUSY; }
  ++scans; memset(&pending, 0, sizeof(pending)); pending.job_id = *id = ++next_job;
  pending.operation = PX_WIFI_OP_SCAN; pending.ap_count = 5;
#ifdef PX_PORTAL_STACK_PROBE
  pending.ap_count = 32;
  for (unsigned i = 4; i < 32; ++i) {
    snprintf(pending.aps[i].ssid, sizeof(pending.aps[i].ssid), "extra-%02u-abcdefghijklmnopqrstuv", i);
    pending.aps[i].rssi = -90;
  }
#endif
  strcpy(pending.aps[0].ssid, "weak"); pending.aps[0].rssi = -80;
  strcpy(pending.aps[1].ssid, "Finger"); pending.aps[1].rssi = -60;
  strcpy(pending.aps[2].ssid, "Finger"); pending.aps[2].rssi = -20; pending.aps[2].secure = true;
  strcpy(pending.aps[3].ssid, "中文\"\\\n"); pending.aps[3].rssi = -30;
  due = now_ms() + scan_ms; pthread_mutex_unlock(&mutex); return 0;
}
int px_wifi_connect_start(const char *ssid, const char *password, unsigned timeout, uint32_t *id)
{
  assert(timeout > 0 && password); pthread_mutex_lock(&mutex);
  if (pending.job_id || now_ms() < busy_until) { pthread_mutex_unlock(&mutex); return -EBUSY; }
  ++connects; memset(&pending, 0, sizeof(pending)); pending.job_id = *id = ++next_job;
  pending.operation = PX_WIFI_OP_CONNECT;
  if (!strcmp(ssid, "bad")) pending.error = -ETIMEDOUT;
  else { pending.status.connected = pending.status.associated = true; strcpy(pending.status.ssid, ssid); strcpy(pending.status.ip, "192.168.31.101"); }
  due = now_ms() + connect_ms; wifi.connected = false;
  pthread_mutex_unlock(&mutex); return 0;
}
int px_wifi_disconnect(void)
{
  pthread_mutex_lock(&mutex); ++disconnects; wifi.connected = false;
  if (pending.job_id) { pending.error = -ECANCELED; due = now_ms(); busy_until = now_ms() + 100; }
  pthread_mutex_unlock(&mutex); return 0;
}
int px_wifi_poll(struct px_wifi_result *result)
{
  PX_PORTAL_TEST_CHECK_NO_VM();
  pthread_mutex_lock(&mutex); ++polls;
  int ready = pending.job_id && now_ms() >= due;
  if (ready) {
    *result = pending;
    if (pending.operation == PX_WIFI_OP_CONNECT && !pending.error) wifi = pending.status;
    result->status = wifi; memset(&pending, 0, sizeof(pending));
  }
  pthread_mutex_unlock(&mutex); return ready;
}
#ifndef PX_PORTAL_PLATFORM_ONLY
static bool auto_reap = true;
static void status_line(int result)
{
  /* 独立 fixture 充当 service 生命周期消费者，快照本身始终只读。 */
  if (auto_reap) (void)px_portal_reap();
  struct px_portal_status status = {0}; px_portal_get_status(&status);
  pthread_mutex_lock(&mutex);
  printf("{\"result\":%d,\"phase\":\"%s\",\"owned\":%s,\"port\":%u,\"generation\":%u,\"error\":%d,"
    "\"apStarts\":%u,\"apStops\":%u,\"dhcpStarts\":%u,\"dhcpStops\":%u,\"connects\":%u,\"scans\":%u,"
    "\"disconnects\":%u,\"polls\":%u,\"connected\":%s,\"ssid\":\"%s\","
    "\"workerCreates\":%u,\"workerJoins\":%u,\"workersUnjoined\":%u}\n",
    result, px_portal_phase_name(status.phase), status.wifi_owned ? "true" : "false", status.http_port,
    status.generation, status.error, ap_starts, ap_stops, dhcp_starts, dhcp_stops, connects, scans,
    disconnects, polls, wifi.connected ? "true" : "false", wifi.ssid,
    worker_creates, worker_joins, workers_unjoined);
  pthread_mutex_unlock(&mutex);
}
int main(int argc, char **argv)
{
  assert(argc == 2); setvbuf(stdout, NULL, _IOLBF, 0);
  struct px_portal_config config = {.credentials_path = argv[1]}; assert(!px_portal_init(&config));
  assert(!worker_creates && !workers_unjoined);
  char *line = NULL; size_t capacity = 0;
  while (getline(&line, &capacity, stdin) > 0) {
    char command[32]; unsigned value = 0; sscanf(line, "%31s %u", command, &value); int result = 0;
    if (!strcmp(command, "start")) {
      result = px_portal_request_start();
      if (!result) { enum px_portal_request request; assert(px_portal_take_request(&request) == 1); result = px_portal_begin(); }
    }
    else if (!strcmp(command, "begin")) result = px_portal_begin();
    else if (!strcmp(command, "request")) result = px_portal_request_start();
    else if (!strcmp(command, "take")) { enum px_portal_request request; result = px_portal_take_request(&request); }
    else if (!strcmp(command, "stop")) result = px_portal_stop();
    else if (!strcmp(command, "reap")) result = px_portal_reap();
    else if (!strcmp(command, "autoreap")) auto_reap = value != 0;
    else if (!strcmp(command, "shutdown")) result = px_portal_shutdown();
    else if (!strcmp(command, "init")) result = px_portal_init(&config);
    else if (!strcmp(command, "holdstart") || !strcmp(command, "holdstop") || !strcmp(command, "failstop") ||
             !strcmp(command, "scanms") || !strcmp(command, "connectms") ||
             !strcmp(command, "failcreate") || !strcmp(command, "failjoin")) {
      pthread_mutex_lock(&mutex);
      if (!strcmp(command, "holdstart")) hold_start = value != 0;
      else if (!strcmp(command, "holdstop")) hold_stop = value != 0;
      else if (!strcmp(command, "failstop")) fail_stop = value != 0;
      else if (!strcmp(command, "scanms")) scan_ms = value;
      else if (!strcmp(command, "failcreate")) fail_create = value;
      else if (!strcmp(command, "failjoin")) fail_join = value != 0;
      else connect_ms = value;
      pthread_cond_broadcast(&wake); pthread_mutex_unlock(&mutex);
    } else if (!strcmp(command, "quit")) { assert(!px_portal_shutdown()); break; }
    else assert(!strcmp(command, "status"));
    status_line(result);
  }
  assert(!workers_unjoined);
  free(line); return 0;
}
#endif
