/* 真实UDP回环、公有生命周期API与协议解析器边界；不会访问开发板。 */
#define _DARWIN_C_SOURCE 1
#define _DEFAULT_SOURCE 1
#include <sys/socket.h>
static int delayed_bind(int fd, const struct sockaddr *address, socklen_t length);
#define bind delayed_bind
#include "../src/mdns.c"
#undef bind
#include <assert.h>
#include <dirent.h>

static int peer;
static pthread_mutex_t delay_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t delay_condition = PTHREAD_COND_INITIALIZER;
static bool block_bind, bind_entered;
static int delayed_bind(int fd, const struct sockaddr *address, socklen_t length)
{
  pthread_mutex_lock(&delay_lock);
  if (block_bind) {
    bind_entered = true;
    while (block_bind) pthread_cond_wait(&delay_condition, &delay_lock);
  }
  pthread_mutex_unlock(&delay_lock); return bind(fd, address, length);
}
#ifdef PX_MDNS_TEST_KTHREAD
static bool fail_create;
static void *run_task(void *argument)
{
  int (*entry)(int, char **) = *(int (**)(int, char **))argument;
  free(argument); char *argv[] = {"pixelbox-mdns", NULL}; entry(1, argv); return NULL;
}
int px_test_kthread_create(const char *name, int priority, int stack_size,
                           int (*entry)(int, char **), char *const arguments[])
{
  assert(!strcmp(name, "pixelbox-mdns") && priority == 100 && stack_size == 8192 && arguments == NULL);
  if (fail_create) { errno = EACCES; return -EAGAIN; }
  int (**copy)(int, char **) = malloc(sizeof(*copy)); assert(copy); *copy = entry;
  pthread_t thread; assert(!pthread_create(&thread, NULL, run_task, copy)); assert(!pthread_detach(thread)); return 71;
}
#endif
static void pause_ms(unsigned millis)
{ struct timespec delay = {.tv_sec = millis / 1000, .tv_nsec = (long)(millis % 1000) * 1000000}; nanosleep(&delay, NULL); }
static unsigned fd_count(void)
{
  DIR *directory = opendir("/dev/fd"); assert(directory); unsigned count = 0; struct dirent *entry;
  while ((entry = readdir(directory))) if (entry->d_name[0] != '.') ++count;
  closedir(directory); return count;
}
static int receive(uint8_t *data, size_t size, unsigned timeout)
{
  struct pollfd item = {.fd = peer, .events = POLLIN};
  int ready = poll(&item, 1, (int)timeout); assert(ready >= 0);
  return ready ? (int)recv(peer, data, size, 0) : 0;
}
static void drain(void) { uint8_t packet[4096]; while (receive(packet, sizeof(packet), 1)) {} }
static void send_peer(const uint8_t *data, size_t size, int socket_fd)
{
  struct sockaddr_in destination = {.sin_family = AF_INET, .sin_port = htons(PX_MDNS_BIND_PORT)};
  inet_pton(AF_INET, "127.0.0.1", &destination.sin_addr);
  assert(sendto(socket_fd, data, size, 0, (struct sockaddr *)&destination, sizeof(destination)) == (ssize_t)size);
}
/* 独立的测试报文编码器：保留线上的压缩指针，结果直接检查公有结构。 */
struct wire { uint8_t bytes[4096]; size_t size; unsigned records; };
static void wire16(struct wire *wire, unsigned value)
{ wire->bytes[wire->size++] = (uint8_t)(value >> 8); wire->bytes[wire->size++] = (uint8_t)value; }
static void wire32(struct wire *wire, uint32_t value)
{ wire16(wire, value >> 16); wire16(wire, value & 65535); }
static void wire_name(struct wire *wire, const char *name)
{
  while (*name) {
    const char *end = strchr(name, '.'); size_t length = end ? (size_t)(end - name) : strlen(name);
    assert(length && length <= 63); wire->bytes[wire->size++] = (uint8_t)length;
    memcpy(wire->bytes + wire->size, name, length); wire->size += length;
    if (!end) break; name = end + 1;
  }
  wire->bytes[wire->size++] = 0;
}
static void rr(struct wire *wire, const char *owner, unsigned type, unsigned ttl,
                const void *bytes, size_t length)
{
  wire_name(wire, owner); wire16(wire, type); wire16(wire, type == 12 ? 1 : 0x8001);
  wire32(wire, ttl); wire16(wire, (unsigned)length);
  memcpy(wire->bytes + wire->size, bytes, length); wire->size += length;
  ++wire->records;
}
static void finish(struct wire *wire)
{ wire->bytes[2] = 0x84; wire->bytes[6] = (uint8_t)(wire->records >> 8); wire->bytes[7] = (uint8_t)wire->records; }
static struct wire service_response(const char *instance, unsigned number, unsigned ttl, unsigned mask)
{
  struct wire wire = {.size = 12}, data = {0}; char name[160], host[80];
  snprintf(name, sizeof(name), "%s._http._tcp.local", instance); snprintf(host, sizeof(host), "camera-%u.local", number);
  if (mask & 1) {
    wire_name(&data, name); rr(&wire, "_http._tcp.local", 12, ttl, data.bytes, data.size); data.size = 0;
  }
  if (mask & 2) {
    wire16(&data, 0); wire16(&data, 0); wire16(&data, 8080 + number); wire_name(&data, host);
    rr(&wire, name, 33, ttl, data.bytes, data.size); data.size = 0;
  }
  if (mask & 4) {
    const uint8_t txt[] = {7,'p','a','t','h','=','/','x', 6,'f','l','a','g','=','1'};
    rr(&wire, name, 16, ttl, txt, sizeof(txt));
  }
  if (mask & 8) { uint8_t ip[] = {10, 2, 3, (uint8_t)(number + 1)}; rr(&wire, host, 1, ttl, ip, 4); }
  finish(&wire); return wire;
}
static struct wire compressed_response(void)
{
  struct wire wire = {.size = 12};
  wire_name(&wire, "_http._tcp.local"); wire16(&wire, 12); wire16(&wire, 1); wire32(&wire, 120); wire16(&wire, 9);
  size_t instance = wire.size; wire.bytes[wire.size++] = 6; memcpy(wire.bytes + wire.size, "Camera", 6); wire.size += 6; wire16(&wire, 0xc00c);
  wire16(&wire, 0xc000 | (unsigned)instance); wire16(&wire, 33); wire16(&wire, 0x8001); wire32(&wire, 120); wire16(&wire, 22);
  wire16(&wire, 0); wire16(&wire, 0); wire16(&wire, 8081); size_t host = wire.size; wire_name(&wire, "camera-1.local");
  /* camera-1.local的wire长度为16，所以SRV长度22。 */
  wire16(&wire, 0xc000 | (unsigned)instance); wire16(&wire, 16); wire16(&wire, 0x8001); wire32(&wire, 120); wire16(&wire, 4);
  wire.bytes[wire.size++] = 3; memcpy(wire.bytes + wire.size, "x=y", 3); wire.size += 3;
  wire16(&wire, 0xc000 | (unsigned)host); wire16(&wire, 1); wire16(&wire, 0x8001); wire32(&wire, 120); wire16(&wire, 4);
  memcpy(wire.bytes + wire.size, (uint8_t[]){10, 2, 3, 2}, 4); wire.size += 4; wire.records = 4; finish(&wire); return wire;
}
static struct px_mdns_result wait_result(struct px_mdns *owner, uint32_t id)
{
  struct px_mdns_result result; uint64_t deadline = now_ms() + 3000;
  while (now_ms() < deadline) {
    int available = px_mdns_poll(owner, &result); assert(available >= 0);
    if (available) { assert(result.id == id); return result; }
    pause_ms(5);
  }
  assert(!"mDNS result timed out"); return (struct px_mdns_result){0};
}
static void start_query(struct px_mdns *owner, uint32_t *id, unsigned timeout)
{
  assert(!px_mdns_discover(owner, "_http._tcp", timeout, id));
  uint8_t packet[4096]; int length = receive(packet, sizeof(packet), 500); assert(length > 12 && !(packet[2] & 0x80));
}
static void protocol_validation(void)
{
  struct wire valid = compressed_response(); size_t records; assert(!validate_packet(valid.bytes, valid.size, &records));
  for (size_t length = 0; length < valid.size; ++length) assert(validate_packet(valid.bytes, length, &records));
  uint8_t bad[4096] = {0}; bad[5] = 1; bad[12] = 0xc0; bad[13] = 12;
  assert(validate_packet(bad, 18, &records));
  bad[13] = 15; assert(validate_packet(bad, 18, &records));
  bad[13] = 255; assert(validate_packet(bad, 18, &records));
  memset(bad, 0, sizeof(bad)); bad[5] = 33; assert(validate_packet(bad, 12, &records));
  bad[5] = 0; bad[7] = 65; assert(validate_packet(bad, 12, &records));
  struct wire oversized = {.size = 12}; oversized.bytes[5] = 1;
  for (unsigned i = 0; i < 4; ++i) { oversized.bytes[oversized.size++] = 63; memset(oversized.bytes + oversized.size, 'a', 63); oversized.size += 63; }
  oversized.bytes[oversized.size++] = 0; wire16(&oversized, 12); wire16(&oversized, 1);
  assert(validate_packet(oversized.bytes, oversized.size, &records));
  assert(!valid_txt((uint8_t[]){4, 'a', '=', 'b'}, 4));
  assert(!valid_txt((uint8_t[]){2, '=', 'b'}, 3));
  uint32_t random = 13;
  for (unsigned n = 0; n < 20000; ++n) {
    size_t length = n % 512;
    for (size_t i = 0; i < length; ++i) { random = random * 1664525u + 1013904223u; bad[i] = (uint8_t)(random >> 24); }
    if (length >= 12) { memset(bad, 0, 12); bad[5] = n % 3; bad[7] = n % 5; }
    (void)validate_packet(bad, length, &records);
  }
  puts("通过：DNS压缩/截断/指针环/长度/TXT/20000组有界模糊报文");
}
static void test_discovery(void)
{
  struct px_mdns *owner = px_mdns_create(); assert(owner); uint32_t id;
  assert(!px_mdns_configure("pixelbox-test", "127.0.0.1"));
  start_query(owner, &id, 150); struct wire wire = compressed_response(); send_peer(wire.bytes, wire.size, peer);
  struct px_mdns_result result = wait_result(owner, id);
  assert(!result.error && result.count == 1 && !strcmp(result.services[0].name, "Camera") && !strcmp(result.services[0].host, "camera-1.local"));
  assert(!strcmp(result.services[0].ip, "10.2.3.2") && result.services[0].port == 8081 && result.services[0].txt_length == 4);
  px_mdns_result_free(&result); drain();
  start_query(owner, &id, 160);
  for (unsigned mask = 8; mask; mask >>= 1) { wire = service_response("Split", 2, 120, mask); send_peer(wire.bytes, wire.size, peer); }
  result = wait_result(owner, id); assert(!result.error && result.count == 1 && !strcmp(result.services[0].name, "Split")); px_mdns_result_free(&result); drain();
  start_query(owner, &id, 150); wire = service_response("Gone", 3, 120, 15); send_peer(wire.bytes, wire.size, peer);
  pause_ms(20); wire = service_response("Gone", 3, 0, 1); send_peer(wire.bytes, wire.size, peer);
  result = wait_result(owner, id); assert(!result.error && !result.count); px_mdns_result_free(&result); drain();
  start_query(owner, &id, 150); wire = service_response("Spoof", 4, 120, 15);
  int other = socket(AF_INET, SOCK_DGRAM, 0); assert(other >= 0); send_peer(wire.bytes, wire.size, other); close(other);
  result = wait_result(owner, id); assert(!result.error && !result.count); px_mdns_result_free(&result); drain();
  start_query(owner, &id, 200);
  for (unsigned i = 0; i < 25; ++i) { char label[16]; snprintf(label, sizeof(label), "Many%u", i); wire = service_response(label, i + 20, 120, 15); send_peer(wire.bytes, wire.size, peer); }
  result = wait_result(owner, id); assert(!result.error && result.count == 20); px_mdns_result_free(&result);
  px_mdns_destroy(owner); assert(!px_mdns_shutdown()); drain();
  puts("通过：真实UDP压缩与拆包发现、乱序合并、goodbye、源端口校验、20条结果上限");
}
static struct wire question(const char *name, unsigned type, bool qu)
{
  struct wire wire = {.size = 12}; wire.bytes[0] = 0x12; wire.bytes[1] = 0x34; wire.bytes[5] = 1;
  wire_name(&wire, name); wire16(&wire, type); wire16(&wire, qu ? 0x8001 : 1); return wire;
}
static bool record_ttl(const uint8_t *packet, size_t length, unsigned ttl, const char *instance)
{
  size_t at; if (validate_packet(packet, length, &at) || !(packet[2] & 0x80)) return false;
  for (unsigned i = 0; i < be16(packet + 6); ++i) {
    struct record record; assert(!read_record(packet, length, &at, &record));
    if (record.type == 12 && record.ttl == ttl && record.target.bytes[0] == strlen(instance) &&
        !memcmp(record.target.bytes + 1, instance, strlen(instance))) return true;
  }
  return false;
}
static void wait_advert(const char *name, unsigned ttl)
{
  uint64_t deadline = now_ms() + 2500; uint8_t packet[4096];
  while (now_ms() < deadline) { int size = receive(packet, sizeof(packet), 100); if (size && record_ttl(packet, (size_t)size, ttl, name)) return; }
  assert(!"advertisement missing");
}
static void test_advertisement(void)
{
  assert(!px_mdns_configure("pixelbox-test", "127.0.0.1"));
  struct px_mdns *owner = px_mdns_create(); assert(owner); uint32_t id;
  const uint8_t txt[] = {3, 'x', '=', 'y'};
  assert(!px_mdns_advertise(owner, "Board", "_http._tcp", 8765, txt, sizeof(txt), &id));
  assert(px_mdns_advertise(owner, "Board", "_http._tcp", 8765, NULL, 0, &id) == -EEXIST);
  unsigned probes = 0; uint64_t deadline = now_ms() + 2500; uint8_t packet[4096]; bool announced = false;
  while (now_ms() < deadline && !announced) {
    int size = receive(packet, sizeof(packet), 100); if (!size) continue;
    if (!(packet[2] & 0x80)) { assert(be16(packet + 4) == 2 && be16(packet + 8) == 3); ++probes; }
    else announced = record_ttl(packet, (size_t)size, 120, "Board");
  }
  assert(announced && probes == 3);
  /* 对已知PTR答案的组播查询不重复应答；QU查询仍单播返回。 */
  struct wire known = question("_http._tcp.local", 12, false), target = {0};
  wire_name(&target, "Board._http._tcp.local"); rr(&known, "_http._tcp.local", 12, 120, target.bytes, target.size);
  known.bytes[7] = 1; send_peer(known.bytes, known.size, peer); assert(receive(packet, sizeof(packet), 150) == 0);
  struct wire qu = question("_http._tcp.local", 12, true); send_peer(qu.bytes, qu.size, peer);
  int unicast_size = receive(packet, sizeof(packet), 500); assert(unicast_size > 12 && record_ttl(packet, (size_t)unicast_size, 120, "Board"));
  pause_ms(110);
  int client = socket(AF_INET, SOCK_DGRAM, 0); assert(client >= 0);
  struct wire query = question("_http._tcp.local", 12, false); send_peer(query.bytes, query.size, client);
  struct pollfd request = {.fd = client, .events = POLLIN}; assert(poll(&request, 1, 500) == 1);
  ssize_t size = recv(client, packet, sizeof(packet), 0); assert(size > 12);
  assert(packet[0] == 0x12 && packet[1] == 0x34 && be16(packet + 4) == 1 && record_ttl(packet, (size_t)size, 10, "Board")); close(client);
  struct wire conflict = service_response("Board", 9, 120, 2); send_peer(conflict.bytes, conflict.size, peer);
  wait_advert("Board (2)", 120);
  assert(!px_mdns_unadvertise(owner, id)); wait_advert("Board (2)", 0);
  px_mdns_destroy(owner); assert(!px_mdns_shutdown()); drain();
  /* 系统广播不会随应用owner销毁；新建owner也不能删除系统句柄。 */
  owner = px_mdns_create(); assert(owner);
  assert(!px_mdns_publish_devd("PixelBox", 8765, "ESP32-S3-Touch-AMOLED-2.16", "P11", "demo.app"));
  px_mdns_destroy(owner); wait_advert("PixelBox", 120);
  assert(!px_mdns_shutdown()); wait_advert("PixelBox", 0); drain();
  puts("通过：3次探测、PTR/SRV/TXT/A、已知答案抑制、QU/legacy单播、冲突改名、goodbye、devd生命周期");
}
struct starter { struct px_mdns *owner; uint32_t id; };
static void *start_from_short_task(void *arg)
{
  struct starter *starter = arg; starter->owner = px_mdns_create(); assert(starter->owner);
  assert(!px_mdns_discover(starter->owner, "_http._tcp", 150, &starter->id)); return NULL;
}
static void test_lifecycle(void)
{
  struct px_mdns *owner = px_mdns_create(); assert(owner); uint32_t ids[5];
  for (unsigned i = 0; i < 4; ++i) assert(!px_mdns_discover(owner, "_http._tcp", 1000, &ids[i]));
  assert(px_mdns_discover(owner, "_http._tcp", 1000, &ids[4]) == -EBUSY);
  assert(px_mdns_shutdown() == -EBUSY);
  for (unsigned i = 0; i < 4; ++i) { assert(!px_mdns_cancel(owner, ids[i])); struct px_mdns_result result = wait_result(owner, ids[i]); assert(result.error == -ECANCELED); px_mdns_result_free(&result); }
  const char *invalid[] = {"", "http._tcp", "_http.tcp", "_http._sctp", "_123._tcp", "_-bad._tcp", "_bad--name._tcp"};
  for (unsigned i = 0; i < sizeof(invalid) / sizeof(*invalid); ++i) assert(px_mdns_discover(owner, invalid[i], 100, &ids[0]) == -EINVAL);
  assert(px_mdns_advertise(owner, "", "_http._tcp", 80, NULL, 0, &ids[0]) == -EINVAL);
  assert(px_mdns_advertise(owner, "\xc0\x80", "_http._tcp", 80, NULL, 0, &ids[0]) == -EINVAL);
  px_mdns_destroy(owner); assert(!px_mdns_shutdown()); drain();
#ifdef PX_MDNS_TEST_KTHREAD
  owner = px_mdns_create(); fail_create = true;
  for (unsigned i = 0; i < 8; ++i) assert(px_mdns_discover(owner, "_http._tcp", 100, &ids[0]) == -EAGAIN);
  fail_create = false; px_mdns_destroy(owner); assert(!px_mdns_shutdown());
#endif
  struct starter starter = {0}; pthread_t thread; assert(!pthread_create(&thread, NULL, start_from_short_task, &starter)); assert(!pthread_join(thread, NULL));
  uint8_t packet[4096]; assert(receive(packet, sizeof(packet), 500) > 12);
  struct wire response = service_response("AfterTask", 1, 120, 15); send_peer(response.bytes, response.size, peer);
  struct px_mdns_result result = wait_result(starter.owner, starter.id); assert(!result.error && result.count == 1); px_mdns_result_free(&result);
  px_mdns_destroy(starter.owner); assert(!px_mdns_shutdown()); drain();
  for (unsigned i = 0; i < 20; ++i) {
    owner = px_mdns_create(); assert(owner); assert(!px_mdns_discover(owner, "_http._tcp", 1000, &ids[0]));
    px_mdns_destroy(owner); assert(!px_mdns_shutdown());
  }
  puts("通过：查询并发上限、取消、参数校验、短命发起线程退出、20轮关闭与重启");
}
static void test_blocked_network(void)
{
  pthread_mutex_lock(&delay_lock); block_bind = true; bind_entered = false; pthread_mutex_unlock(&delay_lock);
  struct px_mdns *owner = px_mdns_create(); assert(owner); uint32_t id;
  assert(!px_mdns_discover(owner, "_http._tcp", 120, &id));
  uint64_t deadline = now_ms() + 500; bool entered = false;
  while (now_ms() < deadline) {
    pthread_mutex_lock(&delay_lock); entered = bind_entered; pthread_mutex_unlock(&delay_lock);
    if (entered) break; pause_ms(2);
  }
  assert(entered);
  struct px_mdns_result result = wait_result(owner, id); assert(!result.error && !result.count); px_mdns_result_free(&result);
  uint64_t started = now_ms(); px_mdns_destroy(owner); assert(now_ms() - started < 100);
  assert(px_mdns_shutdown() == -ETIMEDOUT); assert(px_mdns_create() == NULL);
  pthread_mutex_lock(&delay_lock); block_bind = false; pthread_cond_signal(&delay_condition); pthread_mutex_unlock(&delay_lock);
  assert(!px_mdns_shutdown()); drain();
  puts("通过：网络系统调用阻塞时查询独立到期、owner立即释放、shutdown明确2秒超时与迟到worker回收");
}
int main(void)
{
  unsigned before = fd_count();
  peer = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP); assert(peer >= 0);
  struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(PX_MDNS_PORT)};
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr); assert(!bind(peer, (struct sockaddr *)&address, sizeof(address)));
  protocol_validation(); test_discovery(); test_advertisement(); test_lifecycle(); test_blocked_network();
  close(peer); assert(fd_count() == before);
  puts("mDNS真实UDP与生命周期测试通过，fd全部归还"); return 0;
}
