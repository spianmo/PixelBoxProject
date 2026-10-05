#include "pixelbox_portal.h"
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <netinet/in.h>

static bool safe = true;
static int state, start_error, stop_error;
static unsigned starts, stops, writes;
int pixelbox_dhcpd_safe(void) { return safe; }
int pixelbox_dhcpd_status(void) { return state; }
int netlib_getmacaddr(const char *name, uint8_t *mac)
{ assert(!strcmp(name, "wlan1")); const uint8_t address[6] = {0x10,0x20,0x30,0x40,0xab,0xcd}; memcpy(mac, address, 6); return 0; }
int dhcpd_set_startip(in_addr_t value) { assert(value == 0xc0a80402u); ++writes; return 0; }
int dhcpd_set_netmask(in_addr_t value) { assert(value == 0xffffff00u); ++writes; return 0; }
int dhcpd_set_routerip(in_addr_t value) { assert(value == 0xc0a80401u); ++writes; return 0; }
int dhcpd_set_dnsip(in_addr_t value) { (void)value; assert(!"门户不应修改 DNS"); return 0; }
int dhcpd_start(const char *name)
{ assert(!strcmp(name, "wlan1")); ++starts; if (!start_error) state = 1; return start_error; }
int dhcpd_stop(void) { ++stops; if (!stop_error) state = 0; return stop_error; }
int main(void)
{
  char ssid[33], password[64]; assert(!px_portal_ap_identity(ssid, password));
  assert(!strcmp(ssid, "PixelBox-ABCD") && strlen(password) == 8 && strspn(password, "0123456789") == 8);
  safe = false; assert(px_portal_dhcp_start() == -ENOTSUP && writes == 0); safe = true;
  state = 1; assert(px_portal_dhcp_start() == -EBUSY && writes == 0); state = 0;
  start_error = -ENOMEM; errno = EIO;
  assert(px_portal_dhcp_start() == -ENOMEM && writes == 3 && starts == 1);
  start_error = 0; assert(!px_portal_dhcp_start() && px_portal_dhcp_status() == 1);
  stop_error = -EPERM; errno = EIO;
  assert(px_portal_dhcp_stop() == -EPERM && stops == 1 && px_portal_dhcp_status() == 1);
  stop_error = 0; assert(!px_portal_dhcp_stop() && px_portal_dhcp_status() == 0);
  puts("门户平台层通过：AP MAC/随机密码、DHCP 所有权、wlan1/主机序参数、真实负 errno 保留"); return 0;
}
