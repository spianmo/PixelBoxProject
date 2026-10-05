#ifndef PIXELBOX_WIFI_H
#define PIXELBOX_WIFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PX_WIFI_MAX_APS 32
#define PX_WIFI_SSID_SIZE 33

enum px_wifi_operation {
  PX_WIFI_OP_NONE = 0,
  PX_WIFI_OP_SCAN,
  PX_WIFI_OP_CONNECT
};

enum px_wifi_event {
  PX_WIFI_EVENT_CONNECTED = 1u << 0,
  PX_WIFI_EVENT_DISCONNECTED = 1u << 1,
  PX_WIFI_EVENT_GOT_IP = 1u << 2
};

struct px_wifi_ap {
  char ssid[PX_WIFI_SSID_SIZE];
  int rssi;
  bool secure;
  unsigned channel;
};

struct px_wifi_status {
  /* associated 仅表示已关联；connected 必须同时取得有效 IPv4。 */
  bool associated;
  bool connected;
  char ssid[PX_WIFI_SSID_SIZE];
  char ip[16];
  int rssi;
  char mac[18];
};

struct px_wifi_result {
  uint32_t job_id;
  enum px_wifi_operation operation;
  int error; /* 0 成功，其他值为负 errno。 */
  unsigned events;
  struct px_wifi_status status;
  size_t ap_count;
  struct px_wifi_ap aps[PX_WIFI_MAX_APS];
};

/* 生命周期和下面的调用由 JS 主线程持有；后台线程不访问 JS。
 * 板级 bringup 必须先注册 wlan0。主机没有 WLAN 时返回 -ENOTSUP。
 * init 幂等；shutdown 等待驱动当前有限阻塞退出后再回收资源。
 */
int px_wifi_init(const char *ifname);
void px_wifi_shutdown(void);

/* 同时最多一个作业。默认扫描 10 秒、连接 15 秒；显式上限 120 秒。
 * -EBUSY 表示已有作业、结果尚未消费，或取消后的驱动清理尚未完成。
 * 取消/超时结果由下一次 poll 及时返回；迟到成功会被撤销。
 */
int px_wifi_scan_start(unsigned timeout_ms, uint32_t *job_id);
int px_wifi_connect_start(const char *ssid, const char *password,
                          unsigned timeout_ms, uint32_t *job_id);
int px_wifi_disconnect(void);

/* poll：1=一个结果或状态事件，0=暂无，负值=模块错误。
 * operation==NONE 为纯状态事件；否则用于结算对应 job_id 的 Promise。
 * events 是可合并的状态提示；status 是消费时最新缓存，不能当事件历史。
 * status 在空闲时每秒刷新，DHCP 租约在半期续租。
 */
int px_wifi_poll(struct px_wifi_result *result);
int px_wifi_get_status(struct px_wifi_status *status);

#endif
