#include "pixelbox_portal.h"
#include "pixelbox_softap.h"
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

#ifdef __NuttX__
#include <nuttx/config.h>
#include <netutils/netlib.h>
#if defined(CONFIG_NETUTILS_DHCPD) && defined(CONFIG_NET_BINDTODEVICE)
#include <netutils/dhcpd.h>
#define PX_PORTAL_HAS_DHCP 1
extern int pixelbox_dhcpd_safe(void) __attribute__((weak));
extern int pixelbox_dhcpd_status(void) __attribute__((weak));
#endif
#endif

int px_portal_ap_identity(char ssid[33], char password[64])
{
#if defined(__NuttX__) && defined(CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP)
  uint8_t mac[6];
  if (netlib_getmacaddr(PX_SOFTAP_INTERFACE, mac) < 0) return -(errno ? errno : EIO);
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd < 0) return -errno;
  /* 每次会话重新生成密码，不以设备 MAC 派生秘密。 */
  uint32_t random; size_t at = 0;
  while (at < sizeof(random)) {
    ssize_t got = read(fd, (char *)&random + at, sizeof(random) - at);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { int error = got ? errno : EIO; close(fd); return -error; }
    at += (size_t)got;
  }
  close(fd);
  snprintf(ssid, 33, "PixelBox-%02X%02X", mac[4], mac[5]);
  snprintf(password, 64, "%08u", (unsigned)(random % 100000000u));
  return 0;
#else
  (void)ssid; (void)password; return -ENOTSUP;
#endif
}

int px_portal_dhcp_start(void)
{
#ifdef PX_PORTAL_HAS_DHCP
  if (!pixelbox_dhcpd_safe || !pixelbox_dhcpd_status || pixelbox_dhcpd_safe() != 1) return -ENOTSUP;
  int status = pixelbox_dhcpd_status();
  if (status) return status < 0 ? status : -EBUSY;
  /* DHCPD 这里接受主机字节序。只设置客户端租约配置，不改主机路由/DNS。
   * DHCPD 是上游全局单实例，必须由门户独占；不能与其它 DHCPD 用户并行。 */
  int result = dhcpd_set_startip(0xc0a80402u);
#if defined(CONFIG_NETUTILS_DHCPD_NETMASK) && CONFIG_NETUTILS_DHCPD_NETMASK
  if (!result) result = dhcpd_set_netmask(0xffffff00u);
#else
  return -ENOTSUP;
#endif
#if defined(CONFIG_NETUTILS_DHCPD_ROUTERIP) && CONFIG_NETUTILS_DHCPD_ROUTERIP
  if (!result) result = dhcpd_set_routerip(0xc0a80401u);
#endif
#if defined(CONFIG_NETUTILS_DHCPD_DNSIP) && CONFIG_NETUTILS_DHCPD_DNSIP
  /* 首版无 DNS 劫持服务，必须禁用上游默认 8.8.8.8 选项。 */
  return -ENOTSUP;
#endif
  if (!result) result = dhcpd_start(PX_SOFTAP_INTERFACE);
  return result < 0 ? result : 0;
#else
  return -ENOTSUP;
#endif
}

int px_portal_dhcp_stop(void)
{
#ifdef PX_PORTAL_HAS_DHCP
  if (!pixelbox_dhcpd_safe || pixelbox_dhcpd_safe() != 1) return -ENOTSUP;
  int result = dhcpd_stop();
  return result < 0 ? result : 0;
#else
  return -ENOTSUP;
#endif
}

int px_portal_dhcp_status(void)
{
#ifdef PX_PORTAL_HAS_DHCP
  return pixelbox_dhcpd_status ? pixelbox_dhcpd_status() : -ENOTSUP;
#else
  return -ENOTSUP;
#endif
}
