#ifndef PIXELBOX_SOFTAP_TEST_PLATFORM_H
#define PIXELBOX_SOFTAP_TEST_PLATFORM_H
#include <stdint.h>
#include <netinet/in.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#include <nuttx/wireless/wireless.h>

int px_test_socket(int domain, int type, int protocol);
int px_test_close(int fd);
int px_test_ioctl(int fd, int command, unsigned long request);
int netlib_getifstatus(const char *ifname, uint8_t *flags);
int netlib_ifup(const char *ifname);
int netlib_ifdown(const char *ifname);
int netlib_get_ipv4addr(const char *ifname, struct in_addr *address);
int netlib_get_ipv4netmask(const char *ifname, struct in_addr *address);
int netlib_set_ipv4addr(const char *ifname, const struct in_addr *address);
int netlib_set_ipv4netmask(const char *ifname, const struct in_addr *address);
#define socket px_test_socket
#define close px_test_close
#define ioctl px_test_ioctl
#endif
