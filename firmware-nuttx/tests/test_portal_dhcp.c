/* 提取并编译真实补丁后的 DHCPD 三个函数；socket/task/信号故障可控。 */
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { pthread_mutex_t mutex; pthread_cond_t wake; unsigned count; } sem_t;
#define SEM_INITIALIZER(n) {PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, n}
static bool interrupt_wait;
static int sem_wait(sem_t *semaphore)
{
  if (interrupt_wait) { interrupt_wait = false; errno = EINTR; return -1; }
  pthread_mutex_lock(&semaphore->mutex);
  while (!semaphore->count) pthread_cond_wait(&semaphore->wake, &semaphore->mutex);
  --semaphore->count; pthread_mutex_unlock(&semaphore->mutex); return 0;
}
static int sem_post(sem_t *semaphore)
{
  pthread_mutex_lock(&semaphore->mutex); ++semaphore->count;
  pthread_cond_signal(&semaphore->wake); pthread_mutex_unlock(&semaphore->mutex); return 0;
}
enum dhcpd_daemon_e {DHCPD_NOT_RUNNING, DHCPD_STARTED, DHCPD_RUNNING, DHCPD_STOP_REQUESTED, DHCPD_STOPPED};
struct dhcpmsg_s { unsigned char bytes[32]; };
struct dhcpd_state_s { struct dhcpmsg_s ds_inpacket, ds_outpacket; unsigned ds_optmsgtype; };
typedef _Atomic int32_t atomic_t;
#define atomic_read_acquire(p) atomic_load_explicit(p, memory_order_acquire)
#define atomic_set_release(p, v) atomic_store_explicit(p, v, memory_order_release)
struct daemon_state { atomic_t ds_state; sem_t ds_lock, ds_sync; int ds_pid; struct dhcpd_state_s *ds_data; };
static struct daemon_state g_dhcpd_daemon = {DHCPD_NOT_RUNNING, SEM_INITIALIZER(1), SEM_INITIALIZER(0), -1, NULL};
#define g_state (*g_dhcpd_daemon.ds_data)
#define FAR
#define OK 0
#define ERROR -1
#define ninfo(...) ((void)0)
#define nerr(...) ((void)0)
#define CONFIG_NETUTILS_DHCPD_PRIORITY 100
#define CONFIG_NETUTILS_DHCPD_STACKSIZE 8192
#define CONFIG_NETUTILS_DHCPD_SIGWAKEUP 22
#define DHCPDISCOVER 1
#define DHCPREQUEST 3
#define DHCPDECLINE 4
#define DHCPRELEASE 7
#define DHCPINFORM 8
static pthread_mutex_t network_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t network_wake = PTHREAD_COND_INITIALIZER;
static pthread_t daemon_thread;
static bool started_thread, signalled;
static atomic_bool fail_allocate, fail_listen, fail_task, fail_kill, fail_recv;
static atomic_uint descriptors, closes, allocations;
int dhcpd_run(const char *interface);
static void *task_entry(void *unused) { (void)unused; dhcpd_run("wlan1"); return NULL; }
static int dhcpd_task_run(int argc, char **argv) { (void)argc; return dhcpd_run(argv[1]); }
static int task_create(const char *name, int priority, int stack, int (*entry)(int, char **), char **args)
{
  assert(name && priority && stack && entry == dhcpd_task_run && !strcmp(args[0], "wlan1"));
  if (fail_task) { errno = EAGAIN; return -1; }
  assert(!started_thread); started_thread = true;
  assert(!pthread_create(&daemon_thread, NULL, task_entry, NULL)); return 123;
}
static void *allocate(size_t size)
{ if (fail_allocate) return NULL; void *value = malloc(size); if (value) ++allocations; return value; }
static void release(void *value) { if (value) --allocations; free(value); }
static int dhcpd_openlistener(const char *interface)
{
  assert(!strcmp(interface, "wlan1"));
  if (fail_listen) { errno = EADDRINUSE; return -1; }
  assert(descriptors == 0); ++descriptors; return 15;
}
static int socket_close(int fd) { assert(fd == 15 && descriptors == 1); --descriptors; ++closes; return 0; }
static int fake_getpid(void) { return 123; }
static int fake_kill(int pid, int signal)
{
  assert(pid == 123 && signal == 22);
  if (fail_kill) { errno = EPERM; return -1; }
  pthread_mutex_lock(&network_mutex); signalled = true;
  pthread_cond_signal(&network_wake); pthread_mutex_unlock(&network_mutex); return 0;
}
static int receive_packet(int fd, void *buffer, size_t size, int flags)
{
  assert(fd == 15 && buffer && size && !flags);
  pthread_mutex_lock(&network_mutex);
  while (!signalled) pthread_cond_wait(&network_wake, &network_mutex);
  signalled = false; pthread_mutex_unlock(&network_mutex);
  errno = fail_recv ? EIO : EINTR; return -1;
}
static bool dhcpd_parseoptions(void) { return false; }
static void dhcpd_discover(int fd) { (void)fd; }
static void dhcpd_request(int fd) { (void)fd; }
static void dhcpd_decline(void) {}
static void dhcpd_release(void) {}
#define malloc allocate
#define free release
#define close socket_close
#define getpid fake_getpid
#define kill fake_kill
#define recv receive_packet

/* PATCHED_FUNCTIONS */

#undef malloc
#undef free
static void join_daemon(void)
{ if (started_thread) { pthread_join(daemon_thread, NULL); started_thread = false; } }
static void clean(void)
{ join_daemon(); assert(!descriptors && !allocations && !g_dhcpd_daemon.ds_data); assert(pixelbox_dhcpd_status() == 0); }
int main(void)
{
  assert(pixelbox_dhcpd_safe() == 1);
  fail_allocate = true; assert(dhcpd_start("wlan1") == -EIO); clean(); fail_allocate = false;
  fail_listen = true; assert(dhcpd_start("wlan1") == -EIO); clean(); fail_listen = false;
  fail_task = true; assert(dhcpd_start("wlan1") == -EAGAIN); clean(); fail_task = false;
  interrupt_wait = true; assert(!dhcpd_start("wlan1")); assert(pixelbox_dhcpd_status() == 1 && descriptors == 1);
  assert(dhcpd_start("wlan1") == -EBUSY);
  assert(!dhcpd_stop()); clean(); assert(closes == 1);
  assert(!dhcpd_start("wlan1")); fail_kill = true;
  assert(dhcpd_stop() == -EPERM && pixelbox_dhcpd_status() == -EINPROGRESS && descriptors == 1);
  fail_kill = false; assert(!dhcpd_stop()); clean(); assert(closes == 2);
  assert(!dhcpd_start("wlan1")); fail_recv = fail_listen = true;
  assert(!fake_kill(123, 22)); join_daemon(); clean(); assert(closes == 3);
  fail_recv = fail_listen = false; assert(!dhcpd_stop());
  for (unsigned i = 0; i < 25; ++i) { assert(!dhcpd_start("wlan1")); assert(!dhcpd_stop()); clean(); }
  puts("DHCPD lifecycle: bind readiness, malloc/listen/task failure, stop retry, unexpected exit and fd cleanup passed");
  return 0;
}
