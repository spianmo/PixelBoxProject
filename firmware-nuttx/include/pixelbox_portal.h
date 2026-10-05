#ifndef PIXELBOX_PORTAL_H
#define PIXELBOX_PORTAL_H

#include <stdbool.h>
#include <stdint.h>

#define PX_PORTAL_DEFAULT_SESSION_MS 180000u
#define PX_PORTAL_CONTROLLER_STACK_BYTES (32u * 1024u)
#define PX_PORTAL_JSON_STACK_BYTES (12u * 1024u)
#define PX_PORTAL_DHCP_STACK_BYTES (8u * 1024u)

enum px_portal_phase {
  PX_PORTAL_INACTIVE, PX_PORTAL_STARTING, PX_PORTAL_WAITING,
  PX_PORTAL_CONNECTING, PX_PORTAL_SUCCESS, PX_PORTAL_FAILED, PX_PORTAL_STOPPING
};
enum px_portal_request { PX_PORTAL_REQUEST_NONE, PX_PORTAL_REQUEST_START };
struct px_portal_config {
  const char *credentials_path; /* 默认 /data/.pixelbox-wifi.json；init 复制路径。 */
  unsigned http_port; /* 0 使用 80；仅 host 测试构建将 0 解释为临时端口。 */
  unsigned timeout_ms; /* 0 使用 3 分钟总会话上限；到期收尾/恢复，绝不强杀阻塞 worker。 */
};
struct px_portal_status {
  enum px_portal_phase phase;
  bool active, wifi_owned, stop_requested;
  uint32_t generation;
  unsigned http_port;
  int error;
  char ap_ssid[33], ap_password[64], ssid[33], ip[16], message[128];
};

/* 必须由常驻 boot/service 任务初始化；init 不创建线程，begin 才按需创建。
 * 所有 socket/文件/worker 同属该任务组。
 * service 是唯一生命周期协调者：收到 request_start 后先完全停 VM、交接
 * px_wifi_poll 的独占权，再调用 begin；每轮调用 reap 回收已完成的两线程。
 * 直到 reap 完成且 status.wifi_owned==false 才恢复 VM。
 * 模块不会启动/停止 JS、操作屏幕、关闭 wlan0 或修改默认路由。
 */
int px_portal_init(const struct px_portal_config *config);
int px_portal_request_start(void); /* JS/按键只排队，不创建线程，不抢 Wi-Fi。 */
int px_portal_take_request(enum px_portal_request *request); /* service 单消费者。 */
int px_portal_begin(void); /* service 消费 start 请求并停 VM 后调用；请求已被 stop 取消则 -ECANCELED。 */
int px_portal_stop(void); /* 只请求；取消排队进入，关闭 HTTP，异步收尾/恢复原凭据。 */
int px_portal_get_status(struct px_portal_status *status);
int px_portal_reap(void); /* service 单调用者；未完成的 worker 不等待，join 后才释放 ownership。 */
int px_portal_shutdown(void); /* 仅已 reap/inactive 才释放轻状态；未完成收尾返回 -EBUSY。 */
const char *px_portal_phase_name(enum px_portal_phase phase);

/* 独立平台层：DHCP 函数只由专用 worker 调用，其无界 sem_wait 不阻塞 service。
 * 测试使用独立桩；真机实现依赖 DHCPD + NET_BINDTODEVICE，绑定 wlan1。
 */
int px_portal_ap_identity(char ssid[33], char password[64]);
int px_portal_dhcp_start(void);
int px_portal_dhcp_stop(void);
int px_portal_dhcp_status(void); /* 1=监听已启动，0=已退出，负值=转换中/不可用；禁止阻塞。 */

#endif
