/* SNTP单次同步：后台DNS/UDP有总截止时间，只有仍存活VM的主线程能提交时间。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_system_net.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#if defined(PX_SYSTEM_NET_TEST_KTHREAD)
#include "system_net_test_platform.h"
#elif defined(__NuttX__)
#include <nuttx/kthread.h>
/* 所有kthread共享文件表：跨VM创建时只继承stdio，不能覆盖内核组已开的socket/watchdog。 */
#if !defined(CONFIG_FDCLONE_STDIO) && !defined(CONFIG_FDCLONE_DISABLE)
#error "NTP kernel workers require CONFIG_FDCLONE_STDIO or CONFIG_FDCLONE_DISABLE"
#endif
#endif

#define NS_PER_SECOND INT64_C(1000000000)
#define NTP_UNIX_OFFSET INT64_C(2208988800)
#define NTP_ERA_SECONDS INT64_C(4294967296)
#define EARLIEST_UNIX INT64_C(1704067200) /* 2024-01-01 */
#define LATEST_UNIX INT64_C(4102444800)   /* 2100-01-01，不含 */
#define NTP_ADDRESS_SLICE_NS (INT64_C(3) * NS_PER_SECOND)

struct ntp_job {
  unsigned refs;
  bool cancelled, ready;
  int error;
  uint32_t id;
  int64_t deadline, sample_ns, received_ns;
  char server[PX_SYSTEM_NTP_HOST_BYTES];
};
struct px_system_net {
  struct ntp_job *jobs[PX_SYSTEM_NTP_MAX_JOBS];
  uint32_t next_id;
};
static pthread_mutex_t ntp_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned ntp_workers;

static int last_error(void) { return -(errno ? errno : EIO); }
static int monotonic_ns(int64_t *out)
{
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return last_error();
  uint64_t seconds = (uint64_t)value.tv_sec, nanos = (uint64_t)value.tv_nsec;
  if (nanos >= (uint64_t)NS_PER_SECOND ||
      seconds > ((uint64_t)INT64_MAX - nanos) / (uint64_t)NS_PER_SECOND) return -EOVERFLOW;
  *out = (int64_t)(seconds * (uint64_t)NS_PER_SECOND + nanos);
  return 0;
}
static int monotonic_resolution_ns(int64_t *out)
{
  struct timespec value;
  if (clock_getres(CLOCK_MONOTONIC, &value)) return last_error();
  if (value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= NS_PER_SECOND ||
      (uint64_t)value.tv_sec > ((uint64_t)INT64_MAX - (uint64_t)value.tv_nsec) / NS_PER_SECOND)
    return -EOVERFLOW;
  *out = (int64_t)value.tv_sec * NS_PER_SECOND + value.tv_nsec;
  return *out > 0 ? 0 : -EINVAL;
}
static bool valid_server(const char *server)
{
  if (!server || !*server || strlen(server) >= PX_SYSTEM_NTP_HOST_BYTES) return false;
  for (const unsigned char *p = (const unsigned char *)server; *p; ++p)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '.' || *p == '-')) return false;
  return true;
}
/* 引用计数、取消标记、ready和全局worker上限只在这个锁内读写。 */
static void release_locked(struct ntp_job *job) { if (!--job->refs) free(job); }
static int job_state(struct ntp_job *job, int64_t *now)
{
  pthread_mutex_lock(&ntp_lock);
  bool cancelled = job->cancelled;
  pthread_mutex_unlock(&ntp_lock);
  if (cancelled) return -ECANCELED;
  int result = monotonic_ns(now);
  return result ? result : *now >= job->deadline ? -ETIMEDOUT : 0;
}
static uint32_t be32(const uint8_t *data)
{
  return (uint32_t)data[0] << 24 | (uint32_t)data[1] << 16 |
         (uint32_t)data[2] << 8 | (uint32_t)data[3];
}
static int timestamp_ns(const uint8_t *data, int64_t *out)
{
  uint32_t seconds = be32(data), fraction = be32(data + 4);
  if (!seconds && !fraction) return -EBADMSG;
  /* 固定有效窗口小于一个NTP era，能唯一处理2036年回绕，不依赖尚未校准的RTC。 */
  int64_t unix_seconds = (int64_t)seconds - NTP_UNIX_OFFSET;
  if (unix_seconds < EARLIEST_UNIX) unix_seconds += NTP_ERA_SECONDS;
  if (unix_seconds < EARLIEST_UNIX || unix_seconds >= LATEST_UNIX) return -ERANGE;
  *out = unix_seconds * NS_PER_SECOND +
         (int64_t)(((uint64_t)fraction * (uint64_t)NS_PER_SECOND) >> 32);
  return 0;
}
static int validate_packet(const uint8_t *packet, size_t length, const uint8_t nonce[8],
                           int64_t elapsed, int64_t resolution, int64_t *sample)
{
  if (length != 48 || (packet[0] & 7) != 4 ||
      ((packet[0] >> 3) & 7) < 3 || ((packet[0] >> 3) & 7) > 4 ||
      (packet[0] >> 6) == 3 || packet[1] > 15 ||
      memcmp(packet + 24, nonce, 8)) return -EBADMSG;
  if (!packet[1]) return -EACCES; /* KoD应停止向该服务器重试。 */
  int64_t received, transmitted;
  int result = timestamp_ns(packet + 32, &received);
  if (!result) result = timestamp_ns(packet + 40, &transmitted);
  if (result) return result;
  if (elapsed < 0 || transmitted < received) return -EBADMSG;
  int64_t transit = elapsed - (transmitted - received);
  /* 两次单调时钟采样的差有一个刻度的量化误差，允许同 tick 收到快速响应。
   * 仅在实际 clock_getres 范围内把负网络时延钳制为零，不放宽反向时间戳。
   */
  if (transit < -resolution) return -EBADMSG;
  if (transit < 0) transit = 0;
  /* 无需可信本地wall clock：服务器发出时间加上扣除服务端处理后的半程RTT。 */
  *sample = transmitted + transit / 2;
  return 0;
}
static int random_nonce(uint8_t nonce[8])
{
  int fd = open("/dev/urandom", O_RDONLY | O_NONBLOCK);
  if (fd < 0) return last_error();
  size_t offset = 0; int error = 0;
  while (offset < 8) {
    ssize_t count = read(fd, nonce + offset, 8 - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { error = count ? last_error() : -EIO; break; }
    offset += (size_t)count;
  }
  close(fd);
  uint8_t combined = 0;
  if (!error) { for (unsigned i = 0; i < 8; ++i) combined |= nonce[i]; if (!combined) error = -EIO; }
  return error;
}
static int query_address(struct ntp_job *job, const struct sockaddr_in *address,
                          int64_t deadline, int64_t resolution,
                          int64_t *sample, int64_t *received)
{
  int64_t now; int result = job_state(job, &now);
  if (result) return result;
  int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) return last_error();
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) { result = last_error(); goto done; }
  if (connect(fd, (const struct sockaddr *)address, sizeof(*address))) { result = last_error(); goto done; }
  uint8_t request[48] = {0};
  request[0] = (4u << 3) | 3u;
  result = random_nonce(request + 40);
  if (result) goto done;
  int64_t sent;
  result = job_state(job, &sent);
  if (result) goto done;
  ssize_t count = send(fd, request, sizeof(request), 0);
  if (count != (ssize_t)sizeof(request)) { result = count < 0 ? last_error() : -EIO; goto done; }
  while (!(result = job_state(job, &now))) {
    if (now >= deadline) { result = -ETIMEDOUT; break; }
    int64_t remaining = (deadline - now + 999999) / 1000000;
    struct pollfd descriptor = {.fd = fd, .events = POLLIN};
    int polled = poll(&descriptor, 1, remaining > 25 ? 25 : (int)remaining);
    if (polled < 0) { if (errno == EINTR) continue; result = last_error(); break; }
    if (!polled) continue;
    /* 多收一个字节，明确拒绝扩展/MAC与超长报文，避免48字节截断被误当合法响应。 */
    uint8_t response[49]; struct sockaddr_in source; socklen_t source_size = sizeof(source);
    count = recvfrom(fd, response, sizeof(response), 0, (struct sockaddr *)&source, &source_size);
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      result = last_error(); break;
    }
    result = job_state(job, received);
    if (result) break;
    if (*received >= deadline) { result = -ETIMEDOUT; break; }
    if (source_size < sizeof(source) || source.sin_family != AF_INET ||
        source.sin_port != address->sin_port || source.sin_addr.s_addr != address->sin_addr.s_addr) continue;
    result = validate_packet(response, (size_t)count, request + 40,
                              *received - sent, resolution, sample);
    if (!result || result == -EACCES) break;
    /* 错包/旧包不得改时钟，也不让一张伪包提前终止正常请求。 */
  }
done:
  close(fd); return result;
}
static void *ntp_worker(void *argument)
{
  struct ntp_job *job = argument;
  struct addrinfo hints = {0}, *addresses = NULL;
  hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM; hints.ai_protocol = IPPROTO_UDP;
  int64_t now, resolution, sample = 0, received = 0;
  int result = job_state(job, &now);
  if (!result) result = monotonic_resolution_ns(&resolution);
  if (!result) {
    /* libc DNS不能可靠取消；引用计数与全局上限约束迟到worker，API不用等它返回。 */
    int resolved = getaddrinfo(job->server, "123", &hints, &addresses);
    result = job_state(job, &now);
    if (!result && resolved) result = resolved == EAI_MEMORY ? -ENOMEM : -EHOSTUNREACH;
    if (!result) {
      size_t remaining_addresses = 0;
      for (struct addrinfo *address = addresses; address; address = address->ai_next)
        if (address->ai_family == AF_INET && address->ai_addrlen >= sizeof(struct sockaddr_in))
          ++remaining_addresses;
      result = -EHOSTUNREACH;
      for (struct addrinfo *address = addresses; address; address = address->ai_next) {
        if (address->ai_family != AF_INET || address->ai_addrlen < sizeof(struct sockaddr_in)) continue;
        result = job_state(job, &now);
        if (result) break;
        /* 预留后续地址的尝试预算；首个坏节点不能耗尽整个 15 秒期限。
         * 最后一个地址使用剩余预算，所有 DNS/UDP/结果提交仍共享总 deadline。
         */
        int64_t budget = (job->deadline - now) / (int64_t)remaining_addresses;
        if (remaining_addresses > 1 && budget > NTP_ADDRESS_SLICE_NS)
          budget = NTP_ADDRESS_SLICE_NS;
        --remaining_addresses;
        result = query_address(job, (const struct sockaddr_in *)address->ai_addr,
                                 now + budget, resolution, &sample, &received);
        if (!result || result == -ECANCELED || result == -EACCES) break;
      }
    }
  }
  if (addresses) freeaddrinfo(addresses);
  pthread_mutex_lock(&ntp_lock);
  job->error = result; job->sample_ns = sample; job->received_ns = received; job->ready = true;
  --ntp_workers; release_locked(job);
  pthread_mutex_unlock(&ntp_lock);
  return NULL;
}
#if defined(__NuttX__) || defined(PX_SYSTEM_NET_TEST_KTHREAD)
static int ntp_task(int argc, char **argv)
{
  void *argument = NULL;
  if (argc != 2 || sscanf(argv[1], "%p", &argument) != 1 || !argument) return 1;
  (void)ntp_worker(argument);
  return 0;
}
#endif
static int start_ntp_worker(struct ntp_job *job)
{
#if defined(__NuttX__) || defined(PX_SYSTEM_NET_TEST_KTHREAD)
  /* VM task退出会强杀同组pthread。独立内核组保留worker引用，DNS迟到后仍能完整收尾。
   * kthread_create复制argv，返回负errno而非-1/errno；worker的所有fd均自建自关。
   */
  char pointer[2 + sizeof(void *) * 2 + 1];
  snprintf(pointer, sizeof(pointer), "%p", (void *)job);
  char *arguments[] = {pointer, NULL};
  int task = kthread_create("pixelbox-ntp", 100, 8192, ntp_task, arguments);
  return task < 0 ? task : 0;
#else
  pthread_attr_t attributes; pthread_t thread;
  int result = pthread_attr_init(&attributes);
  if (!result) {
    result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    if (!result) result = pthread_create(&thread, &attributes, ntp_worker, job);
    pthread_attr_destroy(&attributes);
  }
  return -result;
#endif
}
struct px_system_net *px_system_net_create(void) { return calloc(1, sizeof(struct px_system_net)); }
void px_system_net_destroy(struct px_system_net *context)
{
  if (!context) return;
  pthread_mutex_lock(&ntp_lock);
  for (unsigned i = 0; i < PX_SYSTEM_NTP_MAX_JOBS; ++i) if (context->jobs[i]) {
    context->jobs[i]->cancelled = true; release_locked(context->jobs[i]);
  }
  pthread_mutex_unlock(&ntp_lock); free(context);
}
int px_system_ntp_start(struct px_system_net *context, const char *server,
                        unsigned timeout_ms, uint32_t *id)
{
  if (!server) server = "pool.ntp.org";
  if (!context || !id || !valid_server(server) || !timeout_ms || timeout_ms > 120000) return -EINVAL;
  int64_t now; int result = monotonic_ns(&now);
  if (result) return result;
  if (now > INT64_MAX - (int64_t)timeout_ms * 1000000) return -EOVERFLOW;
  struct ntp_job *job = calloc(1, sizeof(*job));
  if (!job) return -ENOMEM;
  job->deadline = now + (int64_t)timeout_ms * 1000000;
  memcpy(job->server, server, strlen(server) + 1); job->refs = 2;
  pthread_mutex_lock(&ntp_lock);
  unsigned slot = 0;
  while (slot < PX_SYSTEM_NTP_MAX_JOBS && context->jobs[slot]) ++slot;
  if (slot == PX_SYSTEM_NTP_MAX_JOBS || ntp_workers == PX_SYSTEM_NTP_MAX_JOBS) {
    pthread_mutex_unlock(&ntp_lock); free(job); return -EBUSY;
  }
  /* 在一次VM生命周期内不重用ID，防止迟到事件指向另一请求。 */
  if (context->next_id == UINT32_MAX) { pthread_mutex_unlock(&ntp_lock); free(job); return -EOVERFLOW; }
  job->id = ++context->next_id; context->jobs[slot] = job; ++ntp_workers;
  pthread_mutex_unlock(&ntp_lock);
  result = start_ntp_worker(job);
  if (result) {
    pthread_mutex_lock(&ntp_lock); context->jobs[slot] = NULL; --ntp_workers;
    pthread_mutex_unlock(&ntp_lock); free(job); return result;
  }
  *id = job->id; return 0;
}
int px_system_ntp_cancel(struct px_system_net *context, uint32_t id)
{
  if (!context || !id) return -EINVAL;
  pthread_mutex_lock(&ntp_lock);
  for (unsigned i = 0; i < PX_SYSTEM_NTP_MAX_JOBS; ++i)
    if (context->jobs[i] && context->jobs[i]->id == id) context->jobs[i]->cancelled = true;
  pthread_mutex_unlock(&ntp_lock); return 0;
}
int px_system_net_poll(struct px_system_net *context, struct px_system_net_result *result)
{
  if (!context || !result) return -EINVAL;
  int64_t now; int error = monotonic_ns(&now);
  if (error) return error;
  pthread_mutex_lock(&ntp_lock);
  for (unsigned i = 0; i < PX_SYSTEM_NTP_MAX_JOBS; ++i) {
    struct ntp_job *job = context->jobs[i];
    if (!job || (!job->cancelled && now < job->deadline && !job->ready)) continue;
    result->id = job->id;
    result->error = job->cancelled ? -ECANCELED : now >= job->deadline ? -ETIMEDOUT : job->error;
    if (!result->error) {
      /* 提交前再次检查有效性；补偿样本收到后到主循环消费之间的单调时间差。 */
      int64_t value = job->sample_ns + now - job->received_ns;
      struct timespec target = {(time_t)(value / NS_PER_SECOND), (long)(value % NS_PER_SECOND)};
      if ((int64_t)target.tv_sec != value / NS_PER_SECOND) result->error = -EOVERFLOW;
      else if (clock_settime(CLOCK_REALTIME, &target)) result->error = last_error();
    }
    context->jobs[i] = NULL; job->cancelled = true; release_locked(job);
    pthread_mutex_unlock(&ntp_lock); return 1;
  }
  pthread_mutex_unlock(&ntp_lock); return 0;
}
