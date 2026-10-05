#include "net_worker_test_platform.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define GROUPS 4
#define DESCRIPTORS 128
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t dns_wake = PTHREAD_COND_INITIALIZER;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static _Thread_local unsigned current_group;
static int table[GROUPS][DESCRIPTORS];
static bool hold_dns, small_send_buffer;
static enum px_net_test_failure failure;
static struct px_net_test_stats stats;

static void initialize(void) { memset(table, -1, sizeof(table)); }
void px_net_test_group(unsigned group) { assert(group < GROUPS); current_group = group; }
void px_net_test_fail(enum px_net_test_failure value)
{ pthread_mutex_lock(&lock); failure = value; pthread_mutex_unlock(&lock); }
void px_net_test_small_send_buffer(bool enabled) { small_send_buffer = enabled; }
void px_net_test_hold_dns(bool hold)
{
  pthread_mutex_lock(&lock); hold_dns = hold;
  pthread_cond_broadcast(&dns_wake); pthread_mutex_unlock(&lock);
}
struct px_net_test_stats px_net_test_snapshot(void)
{
  pthread_mutex_lock(&lock); struct px_net_test_stats result = stats;
  pthread_mutex_unlock(&lock); return result;
}
static bool failing(enum px_net_test_failure value)
{
  pthread_mutex_lock(&lock); bool result = failure == value;
  pthread_mutex_unlock(&lock); return result;
}
static int raw(int fd)
{
  pthread_once(&once, initialize);
  pthread_mutex_lock(&lock);
  int result = fd >= 3 && fd < DESCRIPTORS ? table[current_group][fd] : -1;
  pthread_mutex_unlock(&lock);
  if (result < 0) errno = EBADF;
  return result;
}
static int allocate(int fd, int minimum)
{
  if (fd < 0) return -1;
  pthread_once(&once, initialize);
  pthread_mutex_lock(&lock);
  for (int logical = minimum < 3 ? 3 : minimum; logical < DESCRIPTORS; ++logical) {
    if (table[current_group][logical] >= 0) continue;
    table[current_group][logical] = fd; ++stats.fds;
    pthread_mutex_unlock(&lock); return logical;
  }
  pthread_mutex_unlock(&lock); close(fd); errno = EMFILE; return -1;
}
int px_net_test_socket(int domain, int type, int protocol)
{
  int fd = socket(domain, type, protocol);
  if (fd >= 0 && small_send_buffer && type == SOCK_STREAM) {
    int bytes = 1024; assert(setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &bytes, sizeof(bytes)) == 0);
  }
  return allocate(fd, 3);
}
int px_net_test_open(const char *path, int flags, ...)
{
  if (!(flags & O_CREAT)) return allocate(open(path, flags), 3);
  va_list arguments; va_start(arguments, flags); int mode = va_arg(arguments, int); va_end(arguments);
  return allocate(open(path, flags, mode), 3);
}
ssize_t px_net_test_read(int fd, void *data, size_t length)
{ int real = raw(fd); return real < 0 ? -1 : read(real, data, length); }
int px_net_test_fstat(int fd, struct stat *status)
{ int real = raw(fd); return real < 0 ? -1 : fstat(real, status); }
int px_net_test_close(int fd)
{
  int real = raw(fd);
  if (real < 0) return -1;
  pthread_mutex_lock(&lock); table[current_group][fd] = -1; --stats.fds;
  pthread_mutex_unlock(&lock); return close(real);
}
int px_net_test_fcntl(int fd, int command, ...)
{
  int real = raw(fd);
  if (real < 0) return -1;
  if (command == F_GETFL || command == F_GETFD) return fcntl(real, command);
  va_list arguments; va_start(arguments, command); int argument = va_arg(arguments, int); va_end(arguments);
  return fcntl(real, command, argument);
}
int px_net_test_connect(int fd, const struct sockaddr *address, socklen_t length)
{ int real = raw(fd); return real < 0 ? -1 : connect(real, address, length); }
int px_net_test_bind(int fd, const struct sockaddr *address, socklen_t length)
{ int real = raw(fd); return real < 0 ? -1 : bind(real, address, length); }
int px_net_test_listen(int fd, int backlog)
{ int real = raw(fd); return real < 0 ? -1 : listen(real, backlog); }
int px_net_test_accept(int fd, struct sockaddr *address, socklen_t *length)
{ int real = raw(fd); return real < 0 ? -1 : allocate(accept(real, address, length), 3); }
int px_net_test_getsockname(int fd, struct sockaddr *address, socklen_t *length)
{ int real = raw(fd); return real < 0 ? -1 : getsockname(real, address, length); }
int px_net_test_getsockopt(int fd, int level, int option, void *value, socklen_t *length)
{ int real = raw(fd); return real < 0 ? -1 : getsockopt(real, level, option, value, length); }
int px_net_test_setsockopt(int fd, int level, int option, const void *value, socklen_t length)
{ int real = raw(fd); return real < 0 ? -1 : setsockopt(real, level, option, value, length); }
ssize_t px_net_test_send(int fd, const void *data, size_t length, int flags)
{ int real = raw(fd); return real < 0 ? -1 : send(real, data, length, flags); }
ssize_t px_net_test_recv(int fd, void *data, size_t length, int flags)
{ int real = raw(fd); return real < 0 ? -1 : recv(real, data, length, flags); }
ssize_t px_net_test_sendto(int fd, const void *data, size_t length, int flags,
                          const struct sockaddr *address, socklen_t address_length)
{ int real = raw(fd); return real < 0 ? -1 : sendto(real, data, length, flags, address, address_length); }
ssize_t px_net_test_recvfrom(int fd, void *data, size_t length, int flags,
                            struct sockaddr *address, socklen_t *address_length)
{ int real = raw(fd); return real < 0 ? -1 : recvfrom(real, data, length, flags, address, address_length); }
int px_net_test_poll(struct pollfd *descriptors, nfds_t count, int timeout)
{
  struct pollfd *translated = calloc(count ? count : 1, sizeof(*translated));
  assert(translated);
  for (nfds_t i = 0; i < count; ++i) {
    translated[i] = descriptors[i]; translated[i].fd = raw(descriptors[i].fd);
    if (translated[i].fd < 0) { descriptors[i].revents = POLLNVAL; free(translated); return 1; }
  }
  int result = poll(translated, count, timeout);
  for (nfds_t i = 0; i < count; ++i) descriptors[i].revents = translated[i].revents;
  free(translated); return result;
}
int px_net_test_getaddrinfo(const char *host, const char *service,
                            const struct addrinfo *hints, struct addrinfo **addresses)
{
  assert(current_group == 1); /* DNS 从独立 kernel group 执行。 */
  if (!strcmp(host, "held.invalid")) {
    pthread_mutex_lock(&lock); ++stats.dns_entered;
    while (hold_dns) pthread_cond_wait(&dns_wake, &lock);
    pthread_mutex_unlock(&lock); return EAI_NONAME;
  }
  if (!strcmp(host, "slow.invalid")) {
    struct timespec delay = {0, 350000000}; nanosleep(&delay, NULL); return EAI_NONAME;
  }
  return getaddrinfo(host, service, hints, addresses);
}

int fs_getfilep(int fd, struct file **source)
{
  assert(current_group == 1);
  pthread_mutex_lock(&lock); ++stats.getfilep; pthread_mutex_unlock(&lock);
  if (failing(NET_FAIL_GETFILEP)) { errno = ERANGE; return -EBADF; }
  int real = raw(fd);
  if (real < 0) return -EBADF;
  struct file *value = malloc(sizeof(*value)); assert(value);
  value->raw_fd = dup(real); assert(value->raw_fd >= 0); *source = value;
  pthread_mutex_lock(&lock); ++stats.borrowed; pthread_mutex_unlock(&lock); return 0;
}
void fs_putfilep(struct file *source)
{
  assert(source && source->raw_fd >= 0); close(source->raw_fd); free(source);
  pthread_mutex_lock(&lock); assert(stats.borrowed); --stats.borrowed; ++stats.putfilep;
  pthread_mutex_unlock(&lock);
}
int file_dup2(struct file *source, struct file *target)
{
  assert(current_group == 1 && source && target && source->raw_fd >= 0);
  if (failing(NET_FAIL_DUP2)) { errno = ERANGE; return -EMFILE; }
  target->raw_fd = dup(source->raw_fd); assert(target->raw_fd >= 0);
  pthread_mutex_lock(&lock); ++stats.pending; ++stats.published; pthread_mutex_unlock(&lock); return 0;
}
int file_dup(struct file *source, int minimum, int flags)
{
  assert(current_group != 1 && source && source->raw_fd >= 0 && minimum == 3 && flags == 0);
  if (failing(NET_FAIL_IMPORT)) { errno = ERANGE; return -ENFILE; }
  int fd = allocate(dup(source->raw_fd), minimum);
  if (fd < 0) return -errno;
  pthread_mutex_lock(&lock); ++stats.adopted; pthread_mutex_unlock(&lock); return fd;
}
int file_close(struct file *source)
{
  assert(source && source->raw_fd >= 0); close(source->raw_fd); source->raw_fd = -1;
  pthread_mutex_lock(&lock); assert(stats.pending); --stats.pending; pthread_mutex_unlock(&lock); return 0;
}

struct worker_start { int (*entry)(int, char **); char *name, *argument; };
static void *run_worker(void *opaque)
{
  struct worker_start *start = opaque;
  px_net_test_group(1);
  char *arguments[] = {start->name, start->argument, NULL};
  assert(start->entry(2, arguments) == 0);
  free(start->name); free(start->argument); free(start);
  pthread_mutex_lock(&lock); ++stats.finished; pthread_mutex_unlock(&lock); return NULL;
}
int kthread_create(const char *name, int priority, int stack,
                    int (*entry)(int, char **), char *const arguments[])
{
  assert(!strcmp(name, "pixelbox-net") && priority == 100 && (stack == 16384 || stack == 32768));
  assert(arguments && arguments[0] && !arguments[1]);
  if (failing(NET_FAIL_TASK)) { errno = EDOM; return -EAGAIN; }
  if (failing(NET_FAIL_TASK_RAW)) { errno = EDOM; return -1; }
  struct worker_start *start = malloc(sizeof(*start)); assert(start);
  start->entry = entry; start->name = strdup(name); start->argument = strdup(arguments[0]);
  assert(start->name && start->argument);
  pthread_attr_t attributes; pthread_attr_init(&attributes);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  pthread_t thread;
  int error = pthread_create(&thread, &attributes, run_worker, start);
  pthread_attr_destroy(&attributes);
  if (error) { free(start->name); free(start->argument); free(start); return -error; }
  pthread_mutex_lock(&lock); ++stats.started; pthread_mutex_unlock(&lock); return 100;
}
