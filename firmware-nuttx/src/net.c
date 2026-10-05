/* POSIX网络核心：JS线程独占fd轮询，DNS/连接worker只交还C状态，不调用JS。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#include <nuttx/fs/fs.h>
#include <nuttx/kthread.h>
#include <malloc.h>
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
#include <arch/arch.h>
#endif
#if !defined(CONFIG_FDCLONE_STDIO) && !defined(CONFIG_FDCLONE_DISABLE)
#error "network kthreads require CONFIG_FDCLONE_STDIO or CONFIG_FDCLONE_DISABLE"
#endif
#endif
#include "pixelbox_net.h"
#include "pixelbox_tls.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

enum endpoint_kind { TCP, LISTENER, UDP };
struct packet {
  struct packet *next;
  uint8_t *data;
  size_t length, offset;
  struct sockaddr_in address;
  bool resolved;
  int error;
};
struct endpoint {
  pthread_mutex_t lock;
  unsigned refs;
  int fd;
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
  /* 独立任务的fd整数不可跨任务组使用；中转文件对象持有socket引用。 */
  struct file pending_file;
  bool pending_file_valid;
#endif
  enum endpoint_kind kind;
  bool ready, announced, cancelled, use_tls, read_paused;
  struct px_tls *tls;
  int error;
  uint64_t deadline;
  unsigned port;
  char host[PX_NET_HOST_BYTES];
  struct packet *first, *last;
  size_t queued_bytes;
  unsigned queued_count;
};
struct slot { uint32_t id; struct endpoint *endpoint; };
struct px_net { struct slot slots[PX_NET_MAX_SOCKETS]; uint32_t next_id; unsigned cursor; };
struct resolve_job { struct endpoint *endpoint; struct packet *packet; char host[PX_NET_HOST_BYTES]; unsigned port; };
static pthread_mutex_t worker_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned workers;

static uint64_t now_ms(void)
{
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static int last_error(void) { return -(errno ? errno : EIO); }
static bool again(void) { return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR; }
static bool valid_host(const char *host)
{
  if (!host || !*host || strlen(host) >= PX_NET_HOST_BYTES) return false;
  for (const unsigned char *p = (const unsigned char *)host; *p; ++p)
    if (*p <= 32 || *p >= 127 || strchr("/:\\@?#[]", *p)) return false;
  return true;
}
static void free_packet(struct packet *packet) { if (packet) { free(packet->data); free(packet); } }
static void close_transport(struct endpoint *endpoint)
{
  px_tls_free(endpoint->tls);endpoint->tls=NULL;
  if(endpoint->fd>=0){close(endpoint->fd);endpoint->fd=-1;}
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
  if (endpoint->pending_file_valid) {
    file_close(&endpoint->pending_file);
    endpoint->pending_file_valid = false;
  }
#endif
}
/* 调用者持锁。worker发布独立引用，只有VM轮询时才导入VM自己的fd表。 */
static int publish_transport(struct endpoint *endpoint, int fd)
{
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
  struct file *source = NULL;
  int result = fs_getfilep(fd, &source);
  if (result < 0) return result;
  result = file_dup2(source, &endpoint->pending_file);
  fs_putfilep(source);
  if (!result) endpoint->pending_file_valid = true;
  return result;
#else
  endpoint->fd = fd;
  return 0;
#endif
}
static int adopt_transport(struct endpoint *endpoint)
{
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
  if (endpoint->pending_file_valid) {
    int fd = file_dup(&endpoint->pending_file, 3, 0);
    if (fd < 0) return fd;
    int result = endpoint->tls ? px_tls_rebind_fd(endpoint->tls, fd) : 0;
    if (result) { close(fd); return result; }
    endpoint->fd = fd;
    file_close(&endpoint->pending_file);
    endpoint->pending_file_valid = false;
  }
#else
  (void)endpoint;
#endif
  return 0;
}
static struct endpoint *new_endpoint(enum endpoint_kind kind)
{
  struct endpoint *endpoint = calloc(1, sizeof(*endpoint));
  if (!endpoint) return NULL;
  int result = pthread_mutex_init(&endpoint->lock, NULL);
  if (result) { free(endpoint); errno = result; return NULL; }
  endpoint->refs = 1; endpoint->fd = -1; endpoint->kind = kind;
  return endpoint;
}
static void release_endpoint(struct endpoint *endpoint)
{
  pthread_mutex_lock(&endpoint->lock);
  bool destroy = --endpoint->refs == 0;
  pthread_mutex_unlock(&endpoint->lock);
  if (!destroy) return;
  close_transport(endpoint);
  while (endpoint->first) {
    struct packet *packet = endpoint->first;
    endpoint->first = packet->next; free_packet(packet);
  }
  pthread_mutex_destroy(&endpoint->lock); free(endpoint);
}
static void cancel_endpoint(struct endpoint *endpoint)
{
  pthread_mutex_lock(&endpoint->lock);
  endpoint->cancelled = true;
  close_transport(endpoint);
  pthread_mutex_unlock(&endpoint->lock);
}
static bool cancelled(struct endpoint *endpoint)
{
  pthread_mutex_lock(&endpoint->lock);
  bool value = endpoint->cancelled;
  pthread_mutex_unlock(&endpoint->lock);
  return value;
}
static int nonblocking(int fd, bool tcp)
{
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return last_error();
  int one = 1;
#ifdef SO_NOSIGPIPE
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) < 0) return last_error();
#endif
  /* NuttX裁剪配置可没有TCP选项；NODELAY只是延迟优化，不能使合法连接失败。 */
  if (tcp && setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) < 0 &&
      errno != ENOPROTOOPT) return last_error();
  return 0;
}
static int connect_address(struct endpoint *endpoint, const struct addrinfo *address,
                           uint64_t deadline)
{
  int fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
  if (fd < 0) return last_error();
  int result = nonblocking(fd, true);
  if (!result && connect(fd, address->ai_addr, address->ai_addrlen) < 0) {
    result = last_error();
    if (errno == EINPROGRESS || errno == EWOULDBLOCK || errno == EAGAIN) {
      result = -ETIMEDOUT;
      while (now_ms() < deadline && !cancelled(endpoint)) {
        struct pollfd descriptor = {fd, POLLOUT, 0};
        const uint64_t current=now_ms();
        uint64_t remaining = current<deadline ? deadline-current : 0;
        int polled = poll(&descriptor, 1, remaining > 25 ? 25 : (int)remaining);
        if (polled < 0 && errno != EINTR) { result = last_error(); break; }
        if (polled <= 0) continue;
        int error = 0; socklen_t length = sizeof(error);
        result = getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0 ? last_error() : -error;
        break;
      }
    }
  }
  if (cancelled(endpoint)) result = -ECANCELED;
  if (!result && now_ms() >= deadline) result = -ETIMEDOUT;
  if (result) { close(fd); return result; }
  return fd;
}
/* 握手与DNS/连接共用一个截止时间；移交后只有主线程能访问TLS上下文。 */
static int connect_tls(struct endpoint *endpoint,int fd,struct px_tls **tls)
{
  int result=px_tls_create(fd,endpoint->host,tls);
  if(result)return result;
  while(!cancelled(endpoint)) {
    const uint64_t current=now_ms();
    if(current>=endpoint->deadline)return -ETIMEDOUT;
    result=px_tls_handshake(*tls);
    /* 证书校验可能在一次非阻塞握手调用中耗时；成功返回后也不能越过总期限。 */
    if(cancelled(endpoint))return -ECANCELED;
    const uint64_t after=now_ms();
    if(after>=endpoint->deadline)return -ETIMEDOUT;
    if(result!=-EAGAIN)return result;
    struct pollfd descriptor={fd,px_tls_poll_events(*tls),0};
    uint64_t remaining=endpoint->deadline-after;
    int polled=poll(&descriptor,1,remaining>25?25:(int)remaining);
    if(polled<0&&errno!=EINTR)return last_error();
  }
  return -ECANCELED;
}
static void *resolve_worker(void *opaque)
{
  struct resolve_job *job = opaque;
  struct endpoint *endpoint = job->endpoint;
  struct addrinfo hints = {0}, *addresses = NULL;
  char service[6]; snprintf(service, sizeof(service), "%u", job->port);
  hints.ai_family = AF_INET;
  hints.ai_socktype = job->packet ? SOCK_DGRAM : SOCK_STREAM;
  hints.ai_protocol = job->packet ? IPPROTO_UDP : IPPROTO_TCP;
  int result = getaddrinfo(job->host, service, &hints, &addresses) == 0 ? 0 : -EHOSTUNREACH;
  int fd = -1;
  struct px_tls *tls=NULL;
  struct sockaddr_in destination = {0};
  if (!result && cancelled(endpoint)) result = -ECANCELED;
  if (!result && job->packet) {
    if (!addresses || addresses->ai_addrlen != sizeof(destination)) result = -EHOSTUNREACH;
    else memcpy(&destination, addresses->ai_addr, sizeof(destination));
  } else if (!result) {
    result = -EHOSTUNREACH;
    for (struct addrinfo *address = addresses; address && !cancelled(endpoint); address = address->ai_next) {
      if (now_ms() >= endpoint->deadline) { result = -ETIMEDOUT; break; }
      /* 一个失联的 A 记录不能耗尽全部地址的连接预算；TLS 仍使用原总截止时间。
       * 余下地址均分剩余时间，非末项最多等待 3 秒，末项使用剩余全部时间。
       */
      uint64_t deadline = endpoint->deadline;
      if (address->ai_next) {
        unsigned candidates = 0;
        for (struct addrinfo *next = address; next; next = next->ai_next) ++candidates;
        uint64_t current = now_ms();
        if (current >= deadline) { result = -ETIMEDOUT; break; }
        uint64_t budget = (deadline - current) / candidates;
        deadline = current + (budget > 3000 ? 3000 : budget);
      }
      int connected = connect_address(endpoint, address, deadline);
      if (connected >= 0) { fd = connected; result = 0; break; }
      result = connected;
    }
  }
  if (addresses) freeaddrinfo(addresses);
  if(!result&&!job->packet&&endpoint->use_tls)result=connect_tls(endpoint,fd,&tls);
  if(result){px_tls_free(tls);tls=NULL;if(fd>=0){close(fd);fd=-1;}}
  pthread_mutex_lock(&endpoint->lock);
  if (job->packet) {
    job->packet->address = destination; job->packet->error = result; job->packet->resolved = true;
  } else if (!endpoint->cancelled) {
    if (!result) result = publish_transport(endpoint, fd);
    if (!result) {
#if !defined(__NuttX__) && !defined(PX_NET_TEST_KTHREAD)
      fd = -1;
#endif
      endpoint->tls = tls; tls = NULL;
    }
    endpoint->error = result; endpoint->ready = true;
  }
  pthread_mutex_unlock(&endpoint->lock);
  px_tls_free(tls);
  if (fd >= 0) close(fd);
  free(job); release_endpoint(endpoint);
  pthread_mutex_lock(&worker_lock); --workers; pthread_mutex_unlock(&worker_lock);
  return NULL;
}
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
static int resolve_task(int argc, char **argv)
{
  void *argument = NULL;
  if (argc != 2 || sscanf(argv[1], "%p", &argument) != 1 || !argument) return 1;
  (void)resolve_worker(argument);
  return 0;
}
#endif
static int start_resolve(struct endpoint *endpoint, struct packet *packet, const char *host, unsigned port)
{
  struct resolve_job *job = calloc(1, sizeof(*job));
  if (!job) return -ENOMEM;
  job->endpoint = endpoint; job->packet = packet; job->port = port; strcpy(job->host, host);
  /* libc DNS可能晚于截止时间返回；最多4个worker，全程不持有VM或JS值。 */
  pthread_mutex_lock(&worker_lock);
  if (workers >= 4) { pthread_mutex_unlock(&worker_lock); free(job); return -EBUSY; }
  ++workers; pthread_mutex_unlock(&worker_lock);
  pthread_mutex_lock(&endpoint->lock); ++endpoint->refs; pthread_mutex_unlock(&endpoint->lock);
#if defined(__NuttX__) || defined(PX_NET_TEST_KTHREAD)
  /* VM退出不会杀死内核组worker，迟到DNS仍会释放引用和全局并发名额。 */
  char pointer[2 + sizeof(void *) * 2 + 1];
  snprintf(pointer, sizeof(pointer), "%p", (void *)job);
  char *arguments[] = {pointer, NULL};
  unsigned stack = endpoint->use_tls ? 32768 : 16384;
  int task = kthread_create("pixelbox-net", 100, stack, resolve_task, arguments);
  /* kthread直接返回负errno；Xtensa栈分配失败也会返回原始-1。
   * 保留原值，不用调用者残留的errno改写；失败阶段与两类堆分别记录。 */
  int result = task < 0 ? -task : 0;
  if (task < 0) {
    fprintf(stderr, "[pixelbox.net] stage=worker-create error=%d stack=%u tls=%u udp=%u\n",
            task, stack, (unsigned)endpoint->use_tls, (unsigned)(packet != NULL));
#ifdef __NuttX__
    struct mallinfo heap = mallinfo();
    fprintf(stderr, "[pixelbox.net] heap free=%d largest=%d\n", heap.fordblks, heap.mxordblk);
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
    struct mallinfo internal = xtensa_imm_mallinfo();
    fprintf(stderr, "[pixelbox.net] imem free=%d largest=%d\n", internal.fordblks, internal.mxordblk);
#endif
#endif
  }
#else
  pthread_attr_t attributes;
  int result = pthread_attr_init(&attributes);
  if (!result) {
    size_t stack = endpoint->use_tls ? 32768 : 16384;
#ifdef PTHREAD_STACK_MIN
    if (stack < (size_t)PTHREAD_STACK_MIN) stack = PTHREAD_STACK_MIN;
#endif
    result = pthread_attr_setstacksize(&attributes, stack);
    if (!result) result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    if (!result) result = pthread_create(&thread, &attributes, resolve_worker, job);
    pthread_attr_destroy(&attributes);
  }
#endif
  if (result) {
    pthread_mutex_lock(&worker_lock); --workers; pthread_mutex_unlock(&worker_lock);
    free(job); release_endpoint(endpoint); return -result;
  }
  return 0;
}
static struct slot *find_slot(struct px_net *net, uint32_t id)
{
  if (net) for (unsigned i = 0; i < PX_NET_MAX_SOCKETS; ++i)
    if (net->slots[i].endpoint && net->slots[i].id == id) return &net->slots[i];
  return NULL;
}
static struct slot *attach(struct px_net *net, struct endpoint *endpoint)
{
  if (net) for (unsigned i = 0; i < PX_NET_MAX_SOCKETS; ++i) if (!net->slots[i].endpoint) {
    do { ++net->next_id; } while (!net->next_id || find_slot(net, net->next_id));
    net->slots[i] = (struct slot){net->next_id, endpoint}; return &net->slots[i];
  }
  return NULL;
}
struct px_net *px_net_create(void) { return calloc(1, sizeof(struct px_net)); }
void px_net_destroy(struct px_net *net)
{
  if (!net) return;
  for (unsigned i = 0; i < PX_NET_MAX_SOCKETS; ++i) if (net->slots[i].endpoint) {
    cancel_endpoint(net->slots[i].endpoint); release_endpoint(net->slots[i].endpoint);
  }
  free(net);
}
int px_net_connect(struct px_net *net, const char *host, unsigned port,
                   bool tls, unsigned timeout_ms, uint32_t *id)
{
  if (!net || !id || !valid_host(host) || !port || port > 65535 || !timeout_ms || timeout_ms > 120000) return -EINVAL;
  if (tls&&!px_tls_available()) return -ENOTSUP;
  struct endpoint *endpoint = new_endpoint(TCP);
  if (!endpoint) return -ENOMEM;
  strcpy(endpoint->host, host); endpoint->port = port;endpoint->use_tls=tls;endpoint->deadline = now_ms() + timeout_ms;
  struct slot *slot = attach(net, endpoint);
  if (!slot) { release_endpoint(endpoint); return -EMFILE; }
  int result = start_resolve(endpoint, NULL, host, port);
  if (result) { slot->endpoint = NULL; release_endpoint(endpoint); return result; }
  *id = slot->id; return 0;
}
static int bound_socket(struct px_net *net, unsigned port, bool udp, uint32_t *id, unsigned *bound_port)
{
  if (!net || !id || !bound_port || port > 65535) return -EINVAL;
  struct endpoint *endpoint = new_endpoint(udp ? UDP : LISTENER);
  if (!endpoint) return -ENOMEM;
  endpoint->fd = socket(AF_INET, udp ? SOCK_DGRAM : SOCK_STREAM, udp ? IPPROTO_UDP : IPPROTO_TCP);
  int result = endpoint->fd < 0 ? last_error() : nonblocking(endpoint->fd, false);
  struct sockaddr_in address = {0}; address.sin_family = AF_INET; address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  if (!result && bind(endpoint->fd, (struct sockaddr *)&address, sizeof(address)) < 0) result = last_error();
  if (!result && !udp && listen(endpoint->fd, 4) < 0) result = last_error();
  socklen_t length = sizeof(address);
  if (!result && getsockname(endpoint->fd, (struct sockaddr *)&address, &length) < 0) result = last_error();
  struct slot *slot = result ? NULL : attach(net, endpoint);
  if (!result && !slot) result = -EMFILE;
  if (result) { release_endpoint(endpoint); return result; }
  endpoint->ready = endpoint->announced = true; endpoint->port = ntohs(address.sin_port);
  *id = slot->id; *bound_port = endpoint->port; return 0;
}
int px_net_listen(struct px_net *net, unsigned port, uint32_t *id, unsigned *bound_port)
{ return bound_socket(net, port, false, id, bound_port); }
int px_net_udp(struct px_net *net, unsigned port, uint32_t *id, unsigned *bound_port)
{ return bound_socket(net, port, true, id, bound_port); }

int px_net_send(struct px_net *net, uint32_t id, const uint8_t *data, size_t length,
                const char *udp_host, unsigned udp_port)
{
  struct slot *slot = find_slot(net, id);
  if (!slot) return -EBADF;
  struct endpoint *endpoint = slot->endpoint;
  if ((!data && length) || endpoint->kind == LISTENER) return -EINVAL;
  const bool udp = endpoint->kind == UDP;
  if (udp && (!valid_host(udp_host) || !udp_port || udp_port > 65535)) return -EINVAL;
  if (length > (udp ? PX_NET_UDP_BYTES : PX_NET_SEND_BYTES)) return -EMSGSIZE;
  pthread_mutex_lock(&endpoint->lock);
  bool open = endpoint->ready && !endpoint->cancelled && !endpoint->error && endpoint->fd >= 0;
  bool full = endpoint->queued_count >= PX_NET_SEND_MESSAGES || length > PX_NET_SEND_BYTES - endpoint->queued_bytes;
  pthread_mutex_unlock(&endpoint->lock);
  if (!open) return -ENOTCONN;
  if (!udp && !length) return 0;
  if (full) return -ENOBUFS;
  struct packet *packet = calloc(1, sizeof(*packet));
  if (!packet) return -ENOMEM;
  packet->data = malloc(length ? length : 1);
  if (!packet->data) { free(packet); return -ENOMEM; }
  if (length) memcpy(packet->data, data, length);
  packet->length = length; packet->resolved = true;
  if (udp) {
    packet->address.sin_family = AF_INET; packet->address.sin_port = htons(udp_port);
    if (inet_pton(AF_INET, udp_host, &packet->address.sin_addr) != 1) {
      packet->resolved = false;
      int result = start_resolve(endpoint, packet, udp_host, udp_port);
      if (result) { free_packet(packet); return result; }
    }
  }
  pthread_mutex_lock(&endpoint->lock);
  if (endpoint->last) endpoint->last->next = packet;
  else endpoint->first = packet;
  endpoint->last = packet; endpoint->queued_bytes += length; ++endpoint->queued_count;
  pthread_mutex_unlock(&endpoint->lock);
  return 0;
}
int px_net_close(struct px_net *net, uint32_t id)
{
  struct slot *slot = find_slot(net, id);
  if (slot) cancel_endpoint(slot->endpoint);
  return 0;
}
int px_net_queued(struct px_net *net,uint32_t id,size_t *bytes)
{
  struct slot *slot=find_slot(net,id);if(!slot||!bytes)return -EINVAL;
  pthread_mutex_lock(&slot->endpoint->lock);*bytes=slot->endpoint->queued_bytes;
  pthread_mutex_unlock(&slot->endpoint->lock);return 0;
}
int px_net_read_pause(struct px_net *net,uint32_t id,bool paused)
{
  struct slot *slot=find_slot(net,id);if(!slot)return -EBADF;
  if(slot->endpoint->kind!=TCP)return -EINVAL;
  pthread_mutex_lock(&slot->endpoint->lock);slot->endpoint->read_paused=paused;
  pthread_mutex_unlock(&slot->endpoint->lock);return 0;
}
static int flush_queue(struct endpoint *endpoint)
{
  while (endpoint->first) {
    struct packet *packet = endpoint->first;
    if (!packet->resolved) return 0;
    if (packet->error) return packet->error;
    int flags = 0;
#ifdef MSG_NOSIGNAL
    flags = MSG_NOSIGNAL;
#endif
    ssize_t sent = endpoint->kind == UDP ? sendto(endpoint->fd, packet->data, packet->length, flags,
                     (struct sockaddr *)&packet->address, sizeof(packet->address)) :
                   endpoint->tls ? px_tls_write(endpoint->tls,packet->data+packet->offset,packet->length-packet->offset) :
                   send(endpoint->fd, packet->data + packet->offset, packet->length - packet->offset, flags);
    if (sent < 0) return endpoint->tls ? (sent==-EAGAIN?0:(int)sent) : (again() ? 0 : last_error());
    if (endpoint->kind == UDP && (size_t)sent != packet->length) return -EIO;
    if (endpoint->kind == TCP && !sent) return -EPIPE;
    packet->offset += (size_t)sent;
    if (packet->offset < packet->length) return 0;
    endpoint->queued_bytes -= packet->length; --endpoint->queued_count;
    endpoint->first = packet->next; if (!endpoint->first) endpoint->last = NULL;
    free_packet(packet);
  }
  return 0;
}
static int endpoint_event(struct px_net *net, struct slot *slot, struct px_net_event *event)
{
  struct endpoint *endpoint = slot->endpoint;
  pthread_mutex_lock(&endpoint->lock);
  event->id = slot->id;
  if (!endpoint->ready && now_ms() >= endpoint->deadline) endpoint->error = -ETIMEDOUT;
  if (endpoint->ready && !endpoint->cancelled && !endpoint->error)
    endpoint->error = adopt_transport(endpoint);
  if (endpoint->cancelled || endpoint->error) {
    event->type = PX_NET_CLOSED; event->error = endpoint->error;
    endpoint->cancelled = true;
    close_transport(endpoint);
    pthread_mutex_unlock(&endpoint->lock);
    slot->endpoint = NULL; release_endpoint(endpoint); return 1;
  }
  if (!endpoint->ready) { pthread_mutex_unlock(&endpoint->lock); return 0; }
  if (!endpoint->announced) {
    endpoint->announced = true; event->type = PX_NET_CONNECTED;
    strcpy(event->host, endpoint->host); event->port = endpoint->port;
    pthread_mutex_unlock(&endpoint->lock); return 1;
  }
  endpoint->error = flush_queue(endpoint);
  if (endpoint->error) { pthread_mutex_unlock(&endpoint->lock); return 0; }
  if(endpoint->read_paused){pthread_mutex_unlock(&endpoint->lock);return 0;}
  struct pollfd descriptor = {endpoint->fd, endpoint->tls?px_tls_poll_events(endpoint->tls):POLLIN, 0};
  int ready = endpoint->tls&&px_tls_pending(endpoint->tls) ? 1 : poll(&descriptor, 1, 0);
  if (ready < 0 && !again()) endpoint->error = last_error();
  if (ready <= 0) { pthread_mutex_unlock(&endpoint->lock); return 0; }
  if (descriptor.revents & POLLNVAL) { endpoint->error = -EBADF; pthread_mutex_unlock(&endpoint->lock); return 0; }
  struct sockaddr_in address = {0}; socklen_t size = sizeof(address);
  if (endpoint->kind == LISTENER) {
    int fd = accept(endpoint->fd, (struct sockaddr *)&address, &size);
    if (fd < 0) { if (!again()) endpoint->error = last_error(); pthread_mutex_unlock(&endpoint->lock); return 0; }
    struct endpoint *accepted = new_endpoint(TCP);
    int failure = nonblocking(fd, true);
    struct slot *child = accepted && !failure ? attach(net, accepted) : NULL;
    if (!child) { close(fd); if (accepted) release_endpoint(accepted); pthread_mutex_unlock(&endpoint->lock); return 0; }
    accepted->fd = fd; accepted->ready = accepted->announced = true;
    inet_ntop(AF_INET, &address.sin_addr, accepted->host, sizeof(accepted->host)); accepted->port = ntohs(address.sin_port);
    event->type = PX_NET_ACCEPTED; event->accepted_id = child->id;
    strcpy(event->host, accepted->host); event->port = accepted->port;
  } else {
    /* Azure 音频和识别结果常超过单个 TCP segment；扩大应用层读取块，
     * 减少 QuickJS 事件分发和 TLS 解密调用次数，同时仍保持非阻塞。 */
    size_t capacity = endpoint->kind == UDP ? PX_NET_UDP_BYTES : 16384;
    event->data = malloc(capacity);
    if (!event->data) { pthread_mutex_unlock(&endpoint->lock); return -ENOMEM; }
    ssize_t count = endpoint->kind == UDP ? recvfrom(endpoint->fd, event->data, capacity, 0, (struct sockaddr *)&address, &size) :
                                         endpoint->tls ? px_tls_read(endpoint->tls,event->data,capacity) :
                                         recv(endpoint->fd, event->data, capacity, 0);
    if (count < 0 || (!count && endpoint->kind == TCP)) {
      free(event->data); event->data = NULL;
      if (!count) endpoint->cancelled = true;
      else if(endpoint->tls){if(count!=-EAGAIN)endpoint->error=(int)count;}
      else if (!again()) endpoint->error = last_error();
      pthread_mutex_unlock(&endpoint->lock); return 0;
    }
    event->length = (size_t)count;
    event->type = endpoint->kind == UDP ? PX_NET_DATAGRAM : PX_NET_DATA;
    if (endpoint->kind == UDP) {
      inet_ntop(AF_INET, &address.sin_addr, event->host, sizeof(event->host)); event->port = ntohs(address.sin_port);
    }
  }
  pthread_mutex_unlock(&endpoint->lock); return 1;
}
int px_net_poll(struct px_net *net, struct px_net_event *event)
{
  if (!net || !event) return -EINVAL;
  memset(event, 0, sizeof(*event));
  for (unsigned i = 0; i < PX_NET_MAX_SOCKETS; ++i) {
    unsigned index = net->cursor++ % PX_NET_MAX_SOCKETS;
    if (!net->slots[index].endpoint) continue;
    int result = endpoint_event(net, &net->slots[index], event);
    if (result) return result;
  }
  return 0;
}
void px_net_event_free(struct px_net_event *event)
{ if (event) { free(event->data); memset(event, 0, sizeof(*event)); } }
