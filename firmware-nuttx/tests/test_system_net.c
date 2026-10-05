/* 所有时间设置都被mock；真实UDP回环只验证协议/生命周期，绝不修改宿主时钟。 */
#include "pixelbox_system_net.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#ifdef PX_SYSTEM_NET_TEST_KTHREAD
#include "system_net_test_platform.h"
#endif

enum mode { VALID, ERA, SHORT, LONG, VERSION, MODE, LEAP, STRATUM, KOD, NONCE,
            ZERO_RX, ZERO_TX, ORDER, PROCESS_TIME, OLD_TIME, FUTURE_TIME, SOURCE, BAD_THEN_GOOD,
            QUANTIZED_FAST, QUANTIZED_EXCESS };
struct responder { int fd; unsigned port; enum mode mode; pthread_t thread; };
static atomic_uint target_port, dns_calls, dns_active, clock_calls;
static atomic_uint fallback_port;
static atomic_llong frozen_clock_ns, freeze_until_ns;
static int clock_failure;
static struct timespec last_clock;
static char last_host[256];
static pthread_t main_thread;
#ifdef PX_SYSTEM_NET_TEST_KTHREAD
static atomic_int kthread_failure;
static atomic_uint kthread_active, kthread_calls;
struct launch { int (*entry)(int, char **); char *name, *argument; };
static void *kernel_entry(void *opaque)
{
  struct launch *launch = opaque;
  char *arguments[] = {launch->name, launch->argument, NULL};
  assert(!launch->entry(2, arguments));
  free(launch->name); free(launch->argument); free(launch);
  atomic_fetch_sub(&kthread_active, 1);
  return NULL;
}
int px_test_kthread_create(const char *name, int priority, int stack_size,
                           int (*entry)(int, char **), char *const arguments[])
{
  assert(!strcmp(name, "pixelbox-ntp") && priority == 100 && stack_size == 8192);
  assert(entry && arguments && arguments[0] && !arguments[1]);
  atomic_fetch_add(&kthread_calls, 1);
  int failure = atomic_exchange(&kthread_failure, 0);
  if (failure) { errno = EACCES; return -failure; }
  /* 模拟NuttX在创建时复制argv，调用者栈/线程退出后仍由独立worker消费。 */
  struct launch *launch = calloc(1, sizeof(*launch)); assert(launch);
  launch->entry = entry; launch->name = strdup(name); launch->argument = strdup(arguments[0]);
  assert(launch->name && launch->argument);
  pthread_attr_t attributes; pthread_t thread;
  assert(!pthread_attr_init(&attributes));
  assert(!pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED));
  atomic_fetch_add(&kthread_active, 1);
  assert(!pthread_create(&thread, &attributes, kernel_entry, launch));
  pthread_attr_destroy(&attributes);
  return 42;
}
#endif
static void pause_ms(unsigned milliseconds)
{
  struct timespec value = {milliseconds / 1000, (long)(milliseconds % 1000) * 1000000};
  while (nanosleep(&value, &value) && errno == EINTR) {}
}
static int64_t now_ms(void)
{
  struct timespec value; assert(!clock_gettime(CLOCK_MONOTONIC, &value));
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
int px_test_clock_gettime(clockid_t clock, struct timespec *value)
{
  int result = clock_gettime(clock, value);
  int64_t frozen = atomic_load(&frozen_clock_ns);
  if (!result && clock == CLOCK_MONOTONIC && frozen &&
      (int64_t)value->tv_sec * 1000000000 + value->tv_nsec < atomic_load(&freeze_until_ns)) {
    /* 固定两次采样在同一 tick；到期后恢复真实时钟，让错误响应仍能超时退出。 */
    value->tv_sec = (time_t)(frozen / 1000000000);
    value->tv_nsec = (long)(frozen % 1000000000);
  }
  return result;
}
int px_test_clock_getres(clockid_t clock, struct timespec *value)
{
  if (clock == CLOCK_MONOTONIC && atomic_load(&frozen_clock_ns)) {
    value->tv_sec = 0; value->tv_nsec = 10000000; return 0;
  }
  return clock_getres(clock, value);
}
int px_test_clock_settime(clockid_t clock, const struct timespec *value)
{
  assert(clock == CLOCK_REALTIME && pthread_equal(main_thread, pthread_self()));
  assert(value->tv_nsec >= 0 && value->tv_nsec < 1000000000);
  atomic_fetch_add(&clock_calls, 1); last_clock = *value;
  if (clock_failure) { errno = clock_failure; return -1; }
  return 0;
}
int px_test_getaddrinfo(const char *host, const char *service,
                         const struct addrinfo *hints, struct addrinfo **result)
{
  atomic_fetch_add(&dns_calls, 1); atomic_fetch_add(&dns_active, 1);
  assert(!strcmp(service, "123") && hints->ai_family == AF_INET && hints->ai_socktype == SOCK_DGRAM);
  if (!strcmp(host, "slow.test")) pause_ms(250);
  if (!strcmp(host, "bad.test")) { atomic_fetch_sub(&dns_active, 1); return EAI_NONAME; }
  if (strcmp(host, "slow.test")) strcpy(last_host, host);
  char port[12]; snprintf(port, sizeof(port), "%u", atomic_load(&target_port));
  int value = getaddrinfo("127.0.0.1", port, hints, result);
  if (!value && !strcmp(host, "fallback.test")) {
    struct addrinfo *tail = *result;
    while (tail->ai_next) tail = tail->ai_next;
    snprintf(port, sizeof(port), "%u", atomic_load(&fallback_port));
    value = getaddrinfo("127.0.0.1", port, hints, &tail->ai_next);
  }
  atomic_fetch_sub(&dns_active, 1); return value;
}
static void timestamp(unsigned char *bytes, uint64_t unix_seconds)
{
  uint32_t ntp = (uint32_t)(unix_seconds + UINT64_C(2208988800));
  bytes[0] = ntp >> 24; bytes[1] = ntp >> 16; bytes[2] = ntp >> 8; bytes[3] = ntp;
  bytes[4] = 128; bytes[5] = bytes[6] = bytes[7] = 0;
}
static void *reply(void *argument)
{
  struct responder *server = argument;
  struct pollfd descriptor = {server->fd, POLLIN, 0};
  if (poll(&descriptor, 1, 1000) <= 0) return NULL;
  unsigned char request[48], response[80] = {0};
  struct sockaddr_in client; socklen_t length = sizeof(client);
  ssize_t count = recvfrom(server->fd, request, sizeof(request), 0, (struct sockaddr *)&client, &length);
  assert(count == 48 && request[0] == 35);
  response[0] = 36; response[1] = 2;
  memcpy(response + 24, request + 40, 8);
  uint64_t seconds = server->mode == ERA ? UINT64_C(2208988900) : UINT64_C(1790812800);
  timestamp(response + 32, seconds); timestamp(response + 40, seconds);
  size_t bytes = 48; int outgoing = server->fd;
  switch (server->mode) {
    case SHORT: bytes = 47; break;
    case LONG: bytes = sizeof(response); break;
    case VERSION: response[0] = 20; break;
    case MODE: response[0] = 35; break;
    case LEAP: response[0] |= 192; break;
    case STRATUM: response[1] = 16; break;
    case KOD: response[1] = 0; break;
    case NONCE: case BAD_THEN_GOOD: response[24] ^= 1; break;
    case ZERO_RX: memset(response + 32, 0, 8); break;
    case ZERO_TX: memset(response + 40, 0, 8); break;
    case ORDER: timestamp(response + 32, seconds + 1); break;
    case PROCESS_TIME: timestamp(response + 40, seconds + 1); break;
    case OLD_TIME: timestamp(response + 32, 1672531200); timestamp(response + 40, 1672531200); break;
    case FUTURE_TIME: timestamp(response + 32, 4102444800); timestamp(response + 40, 4102444800); break;
    case SOURCE: outgoing = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP); assert(outgoing >= 0); break;
    case QUANTIZED_FAST: case QUANTIZED_EXCESS: {
      uint32_t fraction = UINT32_C(0x80000000) + (uint32_t)
        ((server->mode == QUANTIZED_FAST ? UINT64_C(5) : UINT64_C(20)) * (UINT64_C(1) << 32) / 1000);
      response[44] = fraction >> 24; response[45] = fraction >> 16;
      response[46] = fraction >> 8; response[47] = fraction;
      break;
    }
    default: break;
  }
  pause_ms(2);
  assert(sendto(outgoing, response, bytes, 0, (struct sockaddr *)&client, length) == (ssize_t)bytes);
  if (outgoing != server->fd) close(outgoing);
  if (server->mode == BAD_THEN_GOOD) {
    response[24] ^= 1; pause_ms(2);
    assert(sendto(outgoing, response, 48, 0, (struct sockaddr *)&client, length) == 48);
  }
  return NULL;
}
static void start_server(struct responder *server, enum mode mode)
{
  server->fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP); assert(server->fd >= 0);
  struct sockaddr_in address = {0}; address.sin_family = AF_INET;
  assert(inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1);
  assert(!bind(server->fd, (struct sockaddr *)&address, sizeof(address)));
  socklen_t length = sizeof(address); assert(!getsockname(server->fd, (struct sockaddr *)&address, &length));
  server->port = ntohs(address.sin_port); server->mode = mode;
  atomic_store(&target_port, server->port); assert(!pthread_create(&server->thread, NULL, reply, server));
}
static void stop_server(struct responder *server) { assert(!pthread_join(server->thread, NULL)); close(server->fd); }
static struct px_system_net_result wait_event(struct px_system_net *context)
{
  struct px_system_net_result result; int64_t deadline = now_ms() + 1000;
  while (now_ms() < deadline) { int value = px_system_net_poll(context, &result); assert(value >= 0); if (value) return result; pause_ms(1); }
  assert(!"missing event"); abort();
}
static unsigned fd_count(void)
{
  unsigned count = 0; for (int fd = 0; fd < 1024; ++fd) if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) ++count;
  return count;
}
static void check_mode(enum mode mode)
{
  struct responder server; start_server(&server, mode);
  struct px_system_net *context = px_system_net_create(); assert(context);
  unsigned before = atomic_load(&clock_calls); uint32_t id;
  assert(!px_system_ntp_start(context, NULL, 80, &id));
  struct px_system_net_result result = wait_event(context);
  assert(result.id == id);
  int successful = mode == VALID || mode == ERA || mode == BAD_THEN_GOOD;
  assert(result.error == (successful ? 0 : mode == KOD ? -EACCES : -ETIMEDOUT));
  assert(atomic_load(&clock_calls) == before + (unsigned)successful);
  if (successful) {
    assert(last_clock.tv_sec == (mode == ERA ? 2208988900 : 1790812800));
    assert(last_clock.tv_nsec >= 500000000 && last_clock.tv_nsec < 650000000);
  }
  assert(!px_system_net_poll(context, &result));
  px_system_net_destroy(context); stop_server(&server); pause_ms(5);
}
static void *departing_vm(void *unused)
{
  (void)unused;
  struct px_system_net *context = px_system_net_create(); assert(context);
  uint32_t id;
  unsigned calls = atomic_load(&dns_calls);
  assert(!px_system_ntp_start(context, "slow.test", 1000, &id));
  while (atomic_load(&dns_calls) == calls) pause_ms(1);
  /* DNS仍在进行就销毁owner并返回；任务只能在自己的生命周期中释放资源。 */
  px_system_net_destroy(context);
  return NULL;
}
static void check_clock_quantization(enum mode mode)
{
  struct responder server; start_server(&server, mode);
  struct px_system_net *context = px_system_net_create(); assert(context);
  struct timespec base; assert(!clock_gettime(CLOCK_MONOTONIC, &base));
  int64_t frozen = (int64_t)base.tv_sec * 1000000000 + base.tv_nsec;
  atomic_store(&freeze_until_ns, frozen + 250000000);
  atomic_store(&frozen_clock_ns, frozen);
  unsigned before = atomic_load(&clock_calls); uint32_t id;
  assert(!px_system_ntp_start(context, "quantized.test", 400, &id));
  struct px_system_net_result result = wait_event(context);
  assert(result.error == (mode == QUANTIZED_FAST ? 0 : -ETIMEDOUT));
  assert(atomic_load(&clock_calls) == before + (unsigned)(mode == QUANTIZED_FAST));
  if (mode == QUANTIZED_FAST) {
    /* measured RTT=0，服务端处理=5ms，10ms分辨率只允许钳零，不能倒扣发送时间。 */
    assert(last_clock.tv_sec == 1790812800);
    assert(last_clock.tv_nsec >= 504999999 && last_clock.tv_nsec <= 505000001);
  }
  atomic_store(&frozen_clock_ns, 0);
  stop_server(&server); px_system_net_destroy(context); pause_ms(5);
}
static void check_address_fallback(bool valid_second)
{
  struct responder second; start_server(&second, valid_second ? VALID : NONCE);
  atomic_store(&fallback_port, second.port);
  /* 首地址使用已bind且无人读取的UDP socket，确保等待到attempt期限而非ICMP快失败。 */
  int silent = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP); assert(silent >= 0);
  struct sockaddr_in address = {.sin_family = AF_INET};
  assert(inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1);
  assert(!bind(silent, (struct sockaddr *)&address, sizeof(address)));
  socklen_t size = sizeof(address); assert(!getsockname(silent, (struct sockaddr *)&address, &size));
  atomic_store(&target_port, ntohs(address.sin_port));
  struct px_system_net *context = px_system_net_create(); assert(context);
  unsigned before = atomic_load(&clock_calls); uint32_t id; int64_t began = now_ms();
  assert(!px_system_ntp_start(context, "fallback.test", 400, &id));
  struct px_system_net_result result = wait_event(context);
  int64_t elapsed = now_ms() - began;
  assert(result.error == (valid_second ? 0 : -ETIMEDOUT));
  assert(atomic_load(&clock_calls) == before + (unsigned)valid_second);
  assert(elapsed >= 150 && elapsed < 650);
  if (valid_second) assert(elapsed < 350);
  unsigned char request[48];
  assert(!fcntl(silent, F_SETFL, fcntl(silent, F_GETFL, 0) | O_NONBLOCK));
  assert(recv(silent, request, sizeof(request), 0) == 48);
  stop_server(&second); close(silent); px_system_net_destroy(context); pause_ms(5);
}
int main(void)
{
  main_thread = pthread_self(); unsigned baseline = fd_count();
  for (enum mode mode = VALID; mode <= BAD_THEN_GOOD; ++mode) check_mode(mode);
  assert(!strcmp(last_host, "pool.ntp.org"));
  check_clock_quantization(QUANTIZED_FAST);
  check_clock_quantization(QUANTIZED_EXCESS);
  check_address_fallback(true);
  check_address_fallback(false);
  struct px_system_net *context = px_system_net_create(); assert(context); uint32_t id;
#ifdef PX_SYSTEM_NET_TEST_KTHREAD
  unsigned launched = atomic_load(&kthread_calls);
  for (unsigned i = 0; i < 8; ++i) {
    atomic_store(&kthread_failure, EAGAIN);
    assert(px_system_ntp_start(context, "localhost", 100, &id) == -EAGAIN);
  }
  assert(atomic_load(&kthread_calls) == launched + 8);
#endif
  const char *bad_hosts[] = {"", "a b", "https://host", "host:123", "a/b", "a\n", "é"};
  for (unsigned i = 0; i < sizeof(bad_hosts) / sizeof(*bad_hosts); ++i)
    assert(px_system_ntp_start(context, bad_hosts[i], 100, &id) == -EINVAL);
  assert(px_system_ntp_start(context, "localhost", 0, &id) == -EINVAL);
  assert(px_system_ntp_start(context, "localhost", 120001, &id) == -EINVAL);
  assert(!px_system_ntp_start(context, "bad.test", 100, &id));
  assert(wait_event(context).error == -EHOSTUNREACH);
  /* clock_settime失败必须原样失败，不能报告同步成功。 */
  struct responder server; start_server(&server, VALID); clock_failure = EPERM;
  assert(!px_system_ntp_start(context, "clock.test", 100, &id));
  assert(wait_event(context).error == -EPERM); stop_server(&server); clock_failure = 0;
  /* 已收到样本但主线程尚未poll：取消或总超时均禁止设置时间。 */
  unsigned clocks = atomic_load(&clock_calls);
  start_server(&server, VALID); assert(!px_system_ntp_start(context, "localhost", 100, &id));
  stop_server(&server); pause_ms(10); assert(atomic_load(&clock_calls) == clocks);
  assert(!px_system_ntp_cancel(context, id)); assert(wait_event(context).error == -ECANCELED);
  start_server(&server, VALID); assert(!px_system_ntp_start(context, "localhost", 30, &id));
  stop_server(&server); pause_ms(40); assert(wait_event(context).error == -ETIMEDOUT);
  assert(atomic_load(&clock_calls) == clocks);
  /* 提交要补偿主循环延迟；时间只在poll发生变化。 */
  start_server(&server, VALID); assert(!px_system_ntp_start(context, "localhost", 300, &id));
  stop_server(&server); pause_ms(50); assert(atomic_load(&clock_calls) == clocks);
  assert(!wait_event(context).error); assert(last_clock.tv_nsec >= 550000000); ++clocks;
  px_system_net_destroy(context);
  /* 四个阻塞DNS占满全局worker；即便VM销毁，也不能无限派生新的阻塞线程。 */
  struct px_system_net *contexts[4]; unsigned calls = atomic_load(&dns_calls);
  for (unsigned i = 0; i < 4; ++i) {
    contexts[i] = px_system_net_create(); assert(contexts[i]);
    assert(!px_system_ntp_start(contexts[i], "slow.test", 40, &id));
  }
  while (atomic_load(&dns_calls) < calls + 4) pause_ms(1);
  int64_t began = now_ms();
  assert(wait_event(contexts[0]).error == -ETIMEDOUT);
  assert(!px_system_ntp_cancel(contexts[1], id)); assert(wait_event(contexts[1]).error == -ECANCELED);
  for (unsigned i = 0; i < 4; ++i) px_system_net_destroy(contexts[i]);
  assert(now_ms() - began < 150);
  context = px_system_net_create(); assert(context);
  assert(px_system_ntp_start(context, "localhost", 100, &id) == -EBUSY);
  while (atomic_load(&dns_active)) pause_ms(1);
  pause_ms(20); assert(atomic_load(&clock_calls) == clocks);
  px_system_net_destroy(context);
  pthread_t vm;
  assert(!pthread_create(&vm, NULL, departing_vm, NULL));
  assert(!pthread_join(vm, NULL));
  assert(atomic_load(&dns_active) == 1);
  while (atomic_load(&dns_active)) pause_ms(1);
  pause_ms(20);
  assert(atomic_load(&clock_calls) == clocks);
  for (unsigned i = 0; i < 12; ++i) check_mode(VALID);
#ifdef PX_SYSTEM_NET_TEST_KTHREAD
  while (atomic_load(&kthread_active)) pause_ms(1);
#endif
  assert(fd_count() == baseline);
  puts("NTP通过：18种真实UDP响应、10ms时钟量化容差与过量拒绝、多地址fallback与共享总期限、2036回绕、源/长度/报文校验、DNS总超时与全局上限、调用VM线程退出后的独立收尾、主线程时钟提交及fd回收");
  return 0;
}
