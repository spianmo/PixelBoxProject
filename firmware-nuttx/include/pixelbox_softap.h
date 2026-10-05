#ifndef PIXELBOX_SOFTAP_H
#define PIXELBOX_SOFTAP_H

#include <stdbool.h>

#define PX_SOFTAP_INTERFACE "wlan1"
#define PX_SOFTAP_ADDRESS "192.168.4.1"
#define PX_SOFTAP_NETMASK "255.255.255.0"

struct px_softap_status {
  bool active;
  bool owned; /* 启动回滚失败时仍需 stop 收尾，不能因 active=false 丢失所有权。 */
  char ssid[33];
  char ip[16];
};

/* 只管理 AP 网卡。调用者另行启动绑定 wlan1 的 DHCP 与 HTTP 服务。
 * 必须从常驻控制线程调用；不保留调用者任务组的 fd，不修改 wlan0/默认路由。
 * 已存在的外部 AP、地址段重叠及未应用安全驱动补丁均在启动前拒绝。
 * 空密码表示开放网络；非空密码要求 8..63 字节，避免上游 64 字节 strlen 越界。
 * 同一参数重复 start 幂等；更换参数须先 stop，避免悄悄踢走正在配网的手机。
 */
int px_softap_start(const char *ssid, const char *password);
int px_softap_stop(void);
int px_softap_get_status(struct px_softap_status *status);

#endif
