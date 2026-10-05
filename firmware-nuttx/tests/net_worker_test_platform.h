#ifndef PIXELBOX_NET_WORKER_TEST_PLATFORM_H
#define PIXELBOX_NET_WORKER_TEST_PLATFORM_H

#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdbool.h>
#include <stddef.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

/* 每个任务组独立的逻辑 fd 表，真实 POSIX fd 只在替身内部流转。
 * 故意令 VM/worker 都从逻辑 fd=3 分配，以捕捉直接跨组传数字的错误。
 */
struct file { int raw_fd; };
int fs_getfilep(int fd, struct file **source);
void fs_putfilep(struct file *source);
int file_dup2(struct file *source, struct file *target);
int file_dup(struct file *source, int minimum, int flags);
int file_close(struct file *source);
int kthread_create(const char *, int, int, int (*)(int, char **), char *const []);

struct px_net_test_stats {
  unsigned fds, borrowed, pending, started, finished;
  unsigned getfilep, putfilep, published, adopted;
  unsigned dns_entered;
};
enum px_net_test_failure { NET_FAIL_NONE, NET_FAIL_TASK, NET_FAIL_TASK_RAW, NET_FAIL_GETFILEP,
                           NET_FAIL_DUP2, NET_FAIL_IMPORT };
void px_net_test_group(unsigned group);
void px_net_test_fail(enum px_net_test_failure failure);
void px_net_test_hold_dns(bool hold);
void px_net_test_small_send_buffer(bool enabled);
struct px_net_test_stats px_net_test_snapshot(void);

int px_net_test_socket(int domain, int type, int protocol);
int px_net_test_open(const char *path, int flags, ...);
ssize_t px_net_test_read(int fd, void *data, size_t length);
int px_net_test_fstat(int fd, struct stat *status);
int px_net_test_close(int fd);
int px_net_test_fcntl(int fd, int command, ...);
int px_net_test_connect(int fd, const struct sockaddr *address, socklen_t length);
int px_net_test_bind(int fd, const struct sockaddr *address, socklen_t length);
int px_net_test_listen(int fd, int backlog);
int px_net_test_accept(int fd, struct sockaddr *address, socklen_t *length);
int px_net_test_getsockname(int fd, struct sockaddr *address, socklen_t *length);
int px_net_test_getsockopt(int fd, int level, int option, void *value, socklen_t *length);
int px_net_test_setsockopt(int fd, int level, int option, const void *value, socklen_t length);
ssize_t px_net_test_send(int fd, const void *data, size_t length, int flags);
ssize_t px_net_test_recv(int fd, void *data, size_t length, int flags);
ssize_t px_net_test_sendto(int fd, const void *data, size_t length, int flags,
                          const struct sockaddr *address, socklen_t address_length);
ssize_t px_net_test_recvfrom(int fd, void *data, size_t length, int flags,
                            struct sockaddr *address, socklen_t *address_length);
int px_net_test_poll(struct pollfd *descriptors, nfds_t count, int timeout);
int px_net_test_getaddrinfo(const char *, const char *, const struct addrinfo *, struct addrinfo **);

#ifdef PX_NET_TEST_REDIRECT
#define socket px_net_test_socket
#define open px_net_test_open
#define read px_net_test_read
#define fstat px_net_test_fstat
#define close px_net_test_close
#define fcntl px_net_test_fcntl
#define connect px_net_test_connect
#define bind px_net_test_bind
#define listen px_net_test_listen
#define accept px_net_test_accept
#define getsockname px_net_test_getsockname
#define getsockopt px_net_test_getsockopt
#define setsockopt px_net_test_setsockopt
#define send px_net_test_send
#define recv px_net_test_recv
#define sendto px_net_test_sendto
#define recvfrom px_net_test_recvfrom
#define poll px_net_test_poll
#define getaddrinfo px_net_test_getaddrinfo
#endif
#endif
