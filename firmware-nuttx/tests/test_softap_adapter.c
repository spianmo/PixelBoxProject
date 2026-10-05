#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <errno.h>

#define OK 0
typedef enum { WIFI_MODE_NULL, WIFI_MODE_STA, WIFI_MODE_AP, WIFI_MODE_APSTA } wifi_mode_t;
#ifdef ESPRESSIF_WLAN_HAS_STA
static bool g_sta_started;
#endif
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
static bool g_softap_started;
static int g_softap_wifi_cfg;
#define WIFI_IF_AP 1
#endif
static bool sta_link;
static unsigned starts, stops, modes, locks;
static int fail_start, fail_stop, fail_mode;
static int fail_get;
static wifi_mode_t current_mode;

static void esp_wifi_lock(bool lock)
{
  if (lock) { assert(locks == 0); locks = 1; }
  else { assert(locks == 1); locks = 0; }
}
static int wifi_errno_trans(int code) { return -code; }
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
static int esp_wifi_get_config(int interface, int *config)
{ assert(interface == WIFI_IF_AP && locks == 1); *config = 42; return fail_get; }
#endif
static int esp_wifi_set_mode(wifi_mode_t mode)
{
  assert(locks == 1); ++modes;
  if (fail_mode) return fail_mode;
  current_mode = mode;
  if (mode != WIFI_MODE_STA && mode != WIFI_MODE_APSTA) sta_link = false;
  return 0;
}
static int esp_wifi_start(void) { assert(locks == 1); ++starts; return fail_start; }
static int esp_wifi_stop(void)
{
  assert(locks == 1); ++stops;
  if (fail_stop) return fail_stop;
  sta_link = false; current_mode = WIFI_MODE_NULL; return 0;
}

/* 测试编译的是经过版本校验的真实上游函数补丁，而非另一份算法副本。 */
#include "softap_adapter_under_test.h"

static void reset(bool sta, bool ap)
{
#ifdef ESPRESSIF_WLAN_HAS_STA
  g_sta_started = sta;
#else
  assert(!sta);
#endif
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  g_softap_started = ap;
#else
  assert(!ap);
#endif
  sta_link = sta;
  current_mode = sta ? (ap ? WIFI_MODE_APSTA : WIFI_MODE_STA) : (ap ? WIFI_MODE_AP : WIFI_MODE_NULL);
  starts = stops = modes = locks = 0;
  fail_start = fail_stop = fail_mode = fail_get = 0;
}

int main(void)
{
  assert(pixelbox_wifi_apsta_safe() == 1);
#ifdef ESPRESSIF_WLAN_HAS_STA
  reset(false, false);
  assert(esp_wifi_sta_start() == 0 && g_sta_started);
  assert(starts == 1 && modes == 1 && stops == 0 && locks == 0);
  assert(esp_wifi_sta_start() == 0 && starts == 1 && modes == 1);
  assert(esp_wifi_sta_stop() == 0 && !g_sta_started && stops == 1);
  assert(esp_wifi_sta_stop() == 0 && stops == 1 && locks == 0);
  reset(false, false); fail_start = 5;
  assert(esp_wifi_sta_start() == -5 && !g_sta_started && locks == 0);
  fail_start = 0;
  assert(esp_wifi_sta_start() == 0 && g_sta_started);
  reset(true, false); fail_stop = 6;
  assert(esp_wifi_sta_stop() == -6 && g_sta_started && sta_link && locks == 0);
#endif
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  reset(false, false);
  assert(esp_wifi_softap_start() == 0 && g_softap_started);
  assert(pixelbox_wifi_softap_sync() == 0 && g_softap_wifi_cfg == 42 && locks == 0);
  fail_get = 4;
  assert(pixelbox_wifi_softap_sync() == -4 && g_softap_started && locks == 0);
  fail_get = 0;
  assert(starts == 1 && modes == 1 && stops == 0 && locks == 0);
  assert(esp_wifi_softap_start() == 0 && starts == 1 && modes == 1);
  assert(esp_wifi_softap_stop() == 0 && !g_softap_started && stops == 1);
  assert(pixelbox_wifi_softap_sync() == -ENETDOWN && locks == 0);
  assert(esp_wifi_softap_stop() == 0 && stops == 1 && locks == 0);
  reset(false, false); fail_start = 5;
  assert(esp_wifi_softap_start() == -5 && !g_softap_started && locks == 0);
  reset(false, true); fail_stop = 6;
  assert(esp_wifi_softap_stop() == -6 && g_softap_started && locks == 0);
#endif
#if defined(ESPRESSIF_WLAN_HAS_STA) && defined(ESPRESSIF_WLAN_HAS_SOFTAP)
  /* Finger 的关联是已存在资源：反复开关 AP 不得 stop/start 全无线。 */
  reset(true, false);
  for (unsigned i = 0; i < 100; ++i) {
    assert(esp_wifi_softap_start() == 0);
    assert(g_sta_started && g_softap_started && sta_link && current_mode == WIFI_MODE_APSTA);
    assert(esp_wifi_softap_stop() == 0);
    assert(g_sta_started && !g_softap_started && sta_link && current_mode == WIFI_MODE_STA);
  }
  assert(starts == 0 && stops == 0 && modes == 200 && locks == 0);
  reset(true, false); fail_mode = 7;
  assert(esp_wifi_softap_start() == -7);
  assert(g_sta_started && !g_softap_started && sta_link && starts == 0 && stops == 0 && locks == 0);
  reset(true, true); fail_mode = 8;
  assert(esp_wifi_softap_stop() == -8);
  assert(g_sta_started && g_softap_started && sta_link && starts == 0 && stops == 0 && locks == 0);
  reset(false, true);
  assert(esp_wifi_sta_start() == 0 && g_sta_started && g_softap_started);
  assert(starts == 0 && stops == 0 && current_mode == WIFI_MODE_APSTA);
  assert(esp_wifi_sta_stop() == 0 && !g_sta_started && g_softap_started);
  assert(starts == 0 && stops == 0 && current_mode == WIFI_MODE_AP && locks == 0);
  reset(false, true); fail_mode = 7;
  assert(esp_wifi_sta_start() == -7 && !g_sta_started && g_softap_started && locks == 0);
  reset(true, true); fail_mode = 8;
  assert(esp_wifi_sta_stop() == -8 && g_sta_started && g_softap_started && sta_link && locks == 0);
#endif
  puts("SoftAP adapter role transitions passed");
  return 0;
}
