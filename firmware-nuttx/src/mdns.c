/* IPv4 mDNS/DNS-SD：独立常驻worker、有限缓存、无JS跨线程对象。 */
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE 1
#endif
#if !defined(__NuttX__) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE 1
#endif
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_mdns.h"
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
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
#if defined(PX_MDNS_TEST_KTHREAD)
#include "mdns_test_platform.h"
#elif defined(__NuttX__)
#include <nuttx/kthread.h>
#if !defined(CONFIG_FDCLONE_STDIO) && !defined(CONFIG_FDCLONE_DISABLE)
#error "mDNS kernel worker requires CONFIG_FDCLONE_STDIO or CONFIG_FDCLONE_DISABLE"
#endif
#endif

#ifndef PX_MDNS_PORT
#define PX_MDNS_PORT 5353
#endif
#ifndef PX_MDNS_BIND_PORT
#define PX_MDNS_BIND_PORT PX_MDNS_PORT
#endif
#ifndef PX_MDNS_GROUP
#define PX_MDNS_GROUP "224.0.0.251"
#endif
#define PACKET_BYTES 4096u
#define OUTPUT_BYTES 1460u
#define MAX_RECORDS 64u
#define ADDRESS_SLOTS 32u
#define DNS_A 1u
#define DNS_PTR 12u
#define DNS_TXT 16u
#define DNS_SRV 33u
#define DNS_ANY 255u
#define TTL 120u

struct name { uint16_t size; uint8_t bytes[256]; };
struct record { struct name name, target; uint16_t type, klass, length, port; uint32_t ttl; const uint8_t *data; };
struct candidate {
  struct name instance, host;
  struct px_mdns_service value;
  uint64_t ptr_until, srv_until, txt_until;
};
struct query {
  uint32_t id;
  struct name service;
  uint64_t deadline, next_send;
  unsigned sends, followup;
  bool done;
  int error;
  struct candidate entries[PX_MDNS_MAX_RESULTS];
};
struct px_mdns { struct query *queries[PX_MDNS_MAX_QUERIES]; };
struct advertisement {
  bool used, retiring, announced;
  uint32_t id;
  struct px_mdns *owner;
  char base[64];
  struct name service, instance;
  uint16_t port, txt_length;
  uint8_t txt[PX_MDNS_TXT_BYTES];
  unsigned probes, announcements, conflicts, goodbyes;
  uint64_t next_send, last_reply;
};
struct address { struct name host; uint32_t ip; uint64_t until; };
static pthread_mutex_t mdns_lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  bool running, stopping;
  unsigned owners, generation, host_conflicts;
  uint32_t next_id;
  int error;
  char hostname[64], base_hostname[64];
  struct in_addr ip;
  struct px_mdns *owners_list[16];
  struct advertisement adverts[PX_MDNS_MAX_ADVERTISEMENTS];
  struct address addresses[ADDRESS_SLOTS];
} state = {.hostname = "pixelbox", .base_hostname = "pixelbox"};

static int fail(void) { return -(errno ? errno : EIO); }
static uint64_t now_ms(void)
{
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
  return (uint64_t)value.tv_sec * 1000 + (unsigned)value.tv_nsec / 1000000;
}
static uint16_t be16(const uint8_t *p) { return (uint16_t)((unsigned)p[0] << 8 | p[1]); }
static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static void put16(uint8_t *p, unsigned value) { p[0] = (uint8_t)(value >> 8); p[1] = (uint8_t)value; }
static void put32(uint8_t *p, uint32_t value) { p[0] = (uint8_t)(value >> 24); p[1] = (uint8_t)(value >> 16); p[2] = (uint8_t)(value >> 8); p[3] = (uint8_t)value; }
static bool equal_name(const struct name *a, const struct name *b)
{
  if (a->size != b->size) return false;
  for (unsigned i = 0; i < a->size; ++i) {
    unsigned ac = a->bytes[i], bc = b->bytes[i];
    if (ac >= 'A' && ac <= 'Z') ac += 'a' - 'A';
    if (bc >= 'A' && bc <= 'Z') bc += 'a' - 'A';
    if (ac != bc) return false;
  }
  return true;
}
static bool valid_label(const char *text, bool instance)
{
  if (!text) return false;
  size_t length = strlen(text);
  if (!length || length > 63) return false;
  for (size_t i = 0; i < length; ++i) {
    unsigned char c = (unsigned char)text[i];
    if (c < 32 || c == 127) return false;
    if (!instance && !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) return false;
    if (instance && c >= 128) {
      unsigned extra = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
      if (!extra || i + extra >= length) return false;
      unsigned next = (unsigned char)text[i + 1];
      if ((c == 0xe0 && next < 0xa0) || (c == 0xed && next >= 0xa0) ||
          (c == 0xf0 && next < 0x90) || (c == 0xf4 && next >= 0x90)) return false;
      for (unsigned j = 1; j <= extra; ++j) if (((unsigned char)text[i + j] & 0xc0) != 0x80) return false;
      i += extra;
    }
  }
  return instance || (text[0] != '-' && text[length - 1] != '-');
}
static bool append_label(struct name *name, const char *label, size_t length)
{
  if (!length || length > 63 || name->size + length + 2 > 255) return false;
  name->bytes[name->size++] = (uint8_t)length;
  memcpy(name->bytes + name->size, label, length); name->size += (uint16_t)length;
  name->bytes[name->size] = 0; return true;
}
static int service_name(const char *text, struct name *name)
{
  if (!text || text[0] != '_') return -EINVAL;
  const char *dot = strchr(text, '.');
  if (!dot || dot - text < 2 || dot - text > 16 ||
      (strcmp(dot, "._tcp") && strcmp(dot, "._udp"))) return -EINVAL;
  bool alpha = false;
  for (const char *p = text + 1; p < dot; ++p) {
    unsigned c = (unsigned char)*p;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) return -EINVAL;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) alpha = true;
    if (*p == '-' && (p == text + 1 || p + 1 == dot || p[-1] == '-')) return -EINVAL;
  }
  if (!alpha) return -EINVAL;
  memset(name, 0, sizeof(*name));
  append_label(name, text, (size_t)(dot - text)); append_label(name, dot + 1, 4);
  append_label(name, "local", 5); ++name->size; return 0;
}
static void instance_name(struct name *out, const char *label, const struct name *service)
{
  memset(out, 0, sizeof(*out)); append_label(out, label, strlen(label));
  memcpy(out->bytes + out->size, service->bytes, service->size); out->size += service->size;
}
static void host_name(struct name *out)
{
  memset(out, 0, sizeof(*out)); append_label(out, state.hostname, strlen(state.hostname));
  append_label(out, "local", 5); ++out->size;
}
static bool has_service(const struct name *instance, const struct name *service)
{
  unsigned first = instance->bytes[0];
  if (!first || first > 63 || instance->size != first + 1 + service->size) return false;
  struct name suffix = {.size = service->size};
  memcpy(suffix.bytes, instance->bytes + first + 1, service->size);
  return equal_name(&suffix, service);
}
static void name_text(const struct name *name, char output[256])
{
  size_t pos = 0, at = 0;
  while (pos < name->size && name->bytes[pos]) {
    unsigned length = name->bytes[pos++];
    if (at) output[at++] = '.';
    memcpy(output + at, name->bytes + pos, length); at += length; pos += length;
  }
  output[at] = 0;
}
/* 压缩指针必须回指先前字节，每条名字最多128跳，消除自环/前向环和越界。 */
static int decode_name(const uint8_t *packet, size_t length, size_t *offset, struct name *out)
{
  size_t cursor = *offset, consumed = 0; bool jumped = false;
  memset(out, 0, sizeof(*out));
  for (unsigned hops = 0; hops < 128; ++hops) {
    if (cursor >= length) return -EBADMSG;
    unsigned label = packet[cursor];
    if ((label & 0xc0) == 0xc0) {
      if (cursor + 1 >= length) return -EBADMSG;
      size_t target = ((label & 63) << 8) | packet[cursor + 1];
      if (target >= cursor) return -EBADMSG;
      if (!jumped) consumed += 2;
      jumped = true; cursor = target; continue;
    }
    if (label > 63 || cursor + 1 + label > length || out->size + label + 1 > 255) return -EBADMSG;
    memcpy(out->bytes + out->size, packet + cursor, label + 1); out->size += (uint16_t)(label + 1);
    if (!jumped) consumed += label + 1;
    cursor += label + 1;
    if (!label) { *offset += consumed; return 0; }
  }
  return -EBADMSG;
}
static bool valid_txt(const uint8_t *txt, size_t length)
{
  if (length > PX_MDNS_TXT_BYTES || (length && !txt)) return false;
  for (size_t at = 0; at < length;) {
    unsigned count = txt[at++];
    if (at + count > length) return false;
    if (count) {
      unsigned key = 0;
      while (key < count && txt[at + key] != '=') {
        if (txt[at + key] < 32 || txt[at + key] > 126) return false;
        ++key;
      }
      if (!key) return false;
    }
    at += count;
  }
  return true;
}
static int read_record(const uint8_t *packet, size_t length, size_t *offset, struct record *out)
{
  memset(out, 0, sizeof(*out));
  if (decode_name(packet, length, offset, &out->name) || *offset + 10 > length) return -EBADMSG;
  const uint8_t *header = packet + *offset;
  out->type = be16(header); out->klass = be16(header + 2); out->ttl = be32(header + 4); out->length = be16(header + 8);
  *offset += 10;
  if (*offset + out->length > length) return -EBADMSG;
  out->data = packet + *offset;
  size_t target = *offset, end = *offset + out->length;
  if (out->type == DNS_PTR || out->type == DNS_SRV) {
    if (out->type == DNS_SRV) {
      if (out->length < 7) return -EBADMSG;
      out->port = be16(out->data + 4); target += 6;
    }
    if (decode_name(packet, length, &target, &out->target) || target != end) return -EBADMSG;
  } else if (out->type == DNS_A && out->length != 4) return -EBADMSG;
  else if (out->type == DNS_TXT && !valid_txt(out->data, out->length)) return -EBADMSG;
  *offset = end; return 0;
}
static int validate_packet(const uint8_t *packet, size_t length, size_t *records)
{
  if (length < 12 || length > PACKET_BYTES || (be16(packet + 2) & 0x780f)) return -EBADMSG;
  unsigned questions = be16(packet + 4), count = be16(packet + 6) + be16(packet + 8) + be16(packet + 10);
  if (questions > 32 || count > MAX_RECORDS) return -EBADMSG;
  size_t at = 12;
  for (unsigned i = 0; i < questions; ++i) {
    struct name name;
    if (decode_name(packet, length, &at, &name) || at + 4 > length) return -EBADMSG;
    at += 4;
  }
  *records = at;
  for (unsigned i = 0; i < count; ++i) {
    struct record record;
    if (read_record(packet, length, &at, &record)) return -EBADMSG;
  }
  return at == length ? 0 : -EBADMSG;
}
struct writer { uint8_t bytes[OUTPUT_BYTES]; size_t size; bool failed; };
static void write_bytes(struct writer *w, const void *bytes, size_t size)
{
  if (w->size + size > sizeof(w->bytes)) { w->failed = true; return; }
  memcpy(w->bytes + w->size, bytes, size); w->size += size;
}
static void write_question(struct writer *w, const struct name *name, unsigned type, unsigned klass)
{
  write_bytes(w, name->bytes, name->size);
  uint8_t header[4]; put16(header, type); put16(header + 2, klass); write_bytes(w, header, sizeof(header));
}
static void write_record(struct writer *w, const struct name *name, unsigned type, bool unique,
                          unsigned ttl, const void *data, size_t length)
{
  write_bytes(w, name->bytes, name->size);
  uint8_t header[10]; put16(header, type); put16(header + 2, unique ? 0x8001 : 1);
  put32(header + 4, ttl); put16(header + 8, (unsigned)length);
  write_bytes(w, header, sizeof(header)); write_bytes(w, data, length);
}
static void service_records(struct writer *w, const struct advertisement *advert, unsigned ttl, bool probe, bool legacy)
{
  struct name host; host_name(&host);
  if (!probe) write_record(w, &advert->service, DNS_PTR, false, ttl, advert->instance.bytes, advert->instance.size);
  uint8_t srv[262] = {0}; put16(srv + 4, advert->port); memcpy(srv + 6, host.bytes, host.size);
  write_record(w, &advert->instance, DNS_SRV, !probe && !legacy, ttl, srv, host.size + 6);
  uint8_t empty = 0;
  write_record(w, &advert->instance, DNS_TXT, !probe && !legacy, ttl,
    advert->txt_length ? advert->txt : &empty, advert->txt_length ? advert->txt_length : 1);
  write_record(w, &host, DNS_A, !probe && !legacy, ttl, &state.ip.s_addr, 4);
}
static struct sockaddr_in multicast_address(void)
{
  struct sockaddr_in destination = {.sin_family = AF_INET, .sin_port = htons(PX_MDNS_PORT)};
  inet_pton(AF_INET, PX_MDNS_GROUP, &destination.sin_addr); return destination;
}
static void send_packet(int fd, const struct writer *writer, const struct sockaddr_in *destination)
{
  if (!writer->failed) sendto(fd, writer->bytes, writer->size, 0, (const struct sockaddr *)destination, sizeof(*destination));
}
static void send_service(int fd, struct advertisement *advert, unsigned ttl, bool probe,
                          const struct sockaddr_in *destination, const uint8_t *request, size_t questions_end)
{
  struct writer writer = {.size = 12};
  bool legacy = request && ntohs(destination->sin_port) != PX_MDNS_PORT;
  if (probe) {
    struct name host; host_name(&host);
    put16(writer.bytes + 4, 2); put16(writer.bytes + 8, 3);
    write_question(&writer, &advert->instance, DNS_ANY, 0x8001); write_question(&writer, &host, DNS_ANY, 0x8001);
  } else {
    put16(writer.bytes + 2, 0x8400); put16(writer.bytes + 6, 4);
    if (legacy) {
      memcpy(writer.bytes, request, 2); put16(writer.bytes + 4, be16(request + 4));
      /* 原问题可能有压缩指针；位置仍从12开始，原样复制保持偏移有效。 */
      write_bytes(&writer, request + 12, questions_end - 12); if (ttl > 10) ttl = 10;
    }
  }
  service_records(&writer, advert, ttl, probe, legacy); send_packet(fd, &writer, destination);
}
static uint64_t expires(uint64_t now, unsigned ttl) { return ttl ? now + (uint64_t)(ttl > 3600 ? 3600 : ttl) * 1000 : 0; }
static struct candidate *candidate(struct query *query, const struct name *instance)
{
  struct candidate *empty = NULL;
  if (!has_service(instance, &query->service)) return NULL;
  for (unsigned i = 0; i < PX_MDNS_MAX_RESULTS; ++i) {
    struct candidate *entry = &query->entries[i];
    if (entry->instance.size && equal_name(&entry->instance, instance)) return entry;
    if (!entry->instance.size && !empty) empty = entry;
  }
  if (empty) {
    char label[64] = {0}; memcpy(label, instance->bytes + 1, instance->bytes[0]);
    if (memchr(instance->bytes + 1, 0, instance->bytes[0]) || !valid_label(label, true)) return NULL;
    empty->instance = *instance; memcpy(empty->value.name, label, sizeof(label));
  }
  return empty;
}
static void cache_record(const struct record *record, uint64_t now)
{
  if ((record->klass & 0x7fff) != 1) return;
  if (record->type == DNS_A) {
    struct address *slot = NULL;
    for (unsigned i = 0; i < ADDRESS_SLOTS; ++i) {
      struct address *address = &state.addresses[i];
      if (equal_name(&address->host, &record->name)) { slot = address; break; }
      if (address->until <= now && !slot) slot = address;
    }
    if (slot) { slot->host = record->name; memcpy(&slot->ip, record->data, 4); slot->until = expires(now, record->ttl); }
  }
  for (unsigned owner = 0; owner < 16; ++owner) if (state.owners_list[owner])
    for (unsigned j = 0; j < PX_MDNS_MAX_QUERIES; ++j) {
      struct query *query = state.owners_list[owner]->queries[j];
      if (!query || query->done) continue;
      struct candidate *entry = NULL;
      if (record->type == DNS_PTR && equal_name(&query->service, &record->name)) {
        entry = candidate(query, &record->target);
        if (entry) entry->ptr_until = expires(now, record->ttl);
      } else if (record->type == DNS_SRV) {
        entry = candidate(query, &record->name);
        if (entry) {
          entry->host = record->target; name_text(&entry->host, entry->value.host);
          entry->value.port = record->port; entry->srv_until = expires(now, record->ttl);
        }
      } else if (record->type == DNS_TXT) {
        entry = candidate(query, &record->name);
        if (entry) {
          entry->value.txt_length = record->length; memcpy(entry->value.txt, record->data, record->length);
          entry->txt_until = expires(now, record->ttl);
        }
      }
    }
}
static void restart_probes(struct advertisement *advert, uint64_t now)
{
  advert->announced = false; advert->probes = advert->announcements = 0;
  advert->next_send = now + (advert->id * 37 + now) % 251;
}
static void conflict_record(const struct record *record, bool response, uint64_t now)
{
  if (!record->ttl || (record->klass & 0x7fff) != 1) return;
  struct name host; host_name(&host);
  if (record->type == DNS_A && equal_name(&record->name, &host) && state.ip.s_addr &&
      memcmp(record->data, &state.ip.s_addr, 4) && (response || memcmp(&state.ip.s_addr, record->data, 4) < 0)) {
    if (++state.host_conflicts > 99) { state.error = -EADDRINUSE; return; }
    snprintf(state.hostname, sizeof(state.hostname), "%.56s-%u", state.base_hostname, state.host_conflicts + 1);
    for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i)
      if (state.adverts[i].used && !state.adverts[i].retiring) restart_probes(&state.adverts[i], now);
    return;
  }
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i) {
    struct advertisement *advert = &state.adverts[i];
    if (!advert->used || advert->retiring || !equal_name(&advert->instance, &record->name)) continue;
    bool mismatch = false, lose = false;
    if (record->type == DNS_SRV) {
      mismatch = record->port != advert->port || !equal_name(&record->target, &host);
      lose = advert->port < record->port || (advert->port == record->port &&
        memcmp(host.bytes, record->target.bytes, host.size < record->target.size ? host.size : record->target.size) < 0);
    } else if (record->type == DNS_TXT) {
      size_t local_size = advert->txt_length ? advert->txt_length : 1; uint8_t empty = 0;
      const uint8_t *local = advert->txt_length ? advert->txt : &empty;
      int order = memcmp(local, record->data, local_size < record->length ? local_size : record->length);
      mismatch = local_size != record->length || order;
      lose = order < 0 || (!order && local_size < record->length);
    }
    if (mismatch && (response || lose)) {
      if (++advert->conflicts > 99) { advert->retiring = true; state.error = -EADDRINUSE; continue; }
      size_t prefix = strlen(advert->base); if (prefix > 55) prefix = 55;
      while (prefix && ((unsigned char)advert->base[prefix] & 0xc0) == 0x80) --prefix;
      char label[64]; snprintf(label, sizeof(label), "%.*s (%u)", (int)prefix, advert->base, advert->conflicts + 1);
      instance_name(&advert->instance, label, &advert->service); restart_probes(advert, now);
    }
  }
}
static void handle_packet(int fd, const uint8_t *packet, size_t length, const struct sockaddr_in *source, uint64_t now)
{
  size_t records;
  if (validate_packet(packet, length, &records)) return;
  bool response = (be16(packet + 2) & 0x8000) != 0;
  if (response && ntohs(source->sin_port) != PX_MDNS_PORT) return;
  unsigned answers = be16(packet + 6), authorities = be16(packet + 8), count = answers + authorities + be16(packet + 10);
  size_t at = records;
  for (unsigned i = 0; i < count; ++i) {
    struct record record; if (read_record(packet, length, &at, &record)) return;
    if (response) cache_record(&record, now);
    if (response || (i >= answers && i < answers + authorities)) conflict_record(&record, response, now);
  }
  if (response || !state.ip.s_addr || state.host_conflicts > 99) return;
  struct name host; host_name(&host);
  for (unsigned a = 0; a < PX_MDNS_MAX_ADVERTISEMENTS; ++a) {
    struct advertisement *advert = &state.adverts[a];
    if (!advert->used || advert->retiring || !advert->announced) continue;
    bool matched = false, unicast = false, known = false, only_ptr = true; at = 12;
    for (unsigned i = 0; i < be16(packet + 4); ++i) {
      struct name name; if (decode_name(packet, length, &at, &name)) return;
      unsigned type = be16(packet + at), klass = be16(packet + at + 2); at += 4;
      if ((klass & 0x7fff) != 1) continue;
      bool match = ((type == DNS_PTR || type == DNS_ANY) && equal_name(&name, &advert->service)) ||
        ((type == DNS_SRV || type == DNS_TXT || type == DNS_ANY) && equal_name(&name, &advert->instance)) ||
        ((type == DNS_A || type == DNS_ANY) && equal_name(&name, &host));
      if (match) { matched = true; unicast |= (klass & 0x8000) != 0; if (type != DNS_PTR || !equal_name(&name, &advert->service)) only_ptr = false; }
    }
    if (!matched) continue;
    /* PTR已知答案仍有至少半个TTL时抑制重复组播。 */
    at = records;
    for (unsigned i = 0; i < answers; ++i) {
      struct record record; if (read_record(packet, length, &at, &record)) return;
      if (record.type == DNS_PTR && record.ttl >= TTL / 2 && equal_name(&record.name, &advert->service) && equal_name(&record.target, &advert->instance)) known = true;
    }
    bool legacy = ntohs(source->sin_port) != PX_MDNS_PORT;
    if ((known && only_ptr && !unicast && !legacy) || now - advert->last_reply < (legacy || unicast ? 100u : 1000u)) continue;
    struct sockaddr_in destination = unicast || legacy ? *source : multicast_address();
    send_service(fd, advert, TTL, false, &destination, legacy ? packet : NULL, records); advert->last_reply = now;
  }
}
static int open_socket(struct in_addr interface)
{
  /* Wi-Fi尚未取得地址时不让IGMP在down接口上等待报告发送。 */
  if (!interface.s_addr) return -ENETDOWN;
  int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) return fail();
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK)) goto error;
  int one = 1, ttl = 255;
  if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one))) goto error;
#ifdef SO_REUSEPORT
  if (setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one))) goto error;
#endif
  struct sockaddr_in local = {.sin_family = AF_INET, .sin_port = htons(PX_MDNS_BIND_PORT), .sin_addr.s_addr = INADDR_ANY};
  if (bind(fd, (const struct sockaddr *)&local, sizeof(local))) goto error;
  struct sockaddr_in group = multicast_address();
  if (IN_MULTICAST(ntohl(group.sin_addr.s_addr))) {
    struct ip_mreq membership = {.imr_multiaddr = group.sin_addr, .imr_interface = interface};
    if (setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &membership, sizeof(membership)) ||
        setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl))) goto error;
    if (interface.s_addr && setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &interface, sizeof(interface))) goto error;
  }
  return fd;
error: { int result = fail(); close(fd); return result; }
}
static void send_query(int fd, struct query *query)
{
  struct writer writer = {.size = 12}; unsigned questions = 1;
  write_question(&writer, &query->service, DNS_PTR, 1);
  for (unsigned visited = 0; visited < PX_MDNS_MAX_RESULTS && questions < 5; ++visited) {
    struct candidate *entry = &query->entries[query->followup++ % PX_MDNS_MAX_RESULTS];
    if (!entry->instance.size) continue;
    write_question(&writer, &entry->instance, DNS_ANY, 1); ++questions;
    if (entry->host.size && questions < 5) { write_question(&writer, &entry->host, DNS_A, 1); ++questions; }
  }
  put16(writer.bytes + 4, questions); struct sockaddr_in destination = multicast_address();
  send_packet(fd, &writer, &destination);
}
static void tick(int fd, uint64_t now)
{
  struct sockaddr_in destination = multicast_address();
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i) {
    struct advertisement *advert = &state.adverts[i];
    if (!advert->used || now < advert->next_send) continue;
    if (advert->retiring) {
      if (fd >= 0 && advert->announced) send_service(fd, advert, 0, false, &destination, NULL, 0);
      if (++advert->goodbyes >= 2 || !advert->announced) memset(advert, 0, sizeof(*advert));
      else advert->next_send = now + 1000;
      continue;
    }
    if (fd < 0 || !state.ip.s_addr || state.host_conflicts > 99) continue;
    if (advert->probes < 3) {
      send_service(fd, advert, TTL, true, &destination, NULL, 0); ++advert->probes; advert->next_send = now + 250;
    } else {
      send_service(fd, advert, TTL, false, &destination, NULL, 0); advert->announced = true;
      advert->next_send = now + (++advert->announcements < 2 ? 1000 : 60000);
    }
  }
  for (unsigned owner = 0; owner < 16; ++owner) if (state.owners_list[owner])
    for (unsigned j = 0; j < PX_MDNS_MAX_QUERIES; ++j) {
      struct query *query = state.owners_list[owner]->queries[j];
      if (!query || query->done) continue;
      if (now >= query->deadline) { query->done = true; continue; }
      if (fd < 0 && state.error) { query->error = state.error; query->done = true; continue; }
      if (fd >= 0 && now >= query->next_send) {
        send_query(fd, query); query->next_send = now + (query->sends++ ? 1000 : 500);
      }
    }
}
static void *worker(void *unused)
{
  (void)unused;
  int fd = -1; unsigned generation = ~0u; uint64_t retry = 0;
  uint8_t *packet = malloc(PACKET_BYTES + 1);
  pthread_mutex_lock(&mdns_lock);
  if (!packet) {
    state.error = -ENOMEM; state.running = false;
    for (unsigned i = 0; i < 16; ++i) if (state.owners_list[i])
      for (unsigned j = 0; j < PX_MDNS_MAX_QUERIES; ++j) {
        struct query *query = state.owners_list[i]->queries[j];
        if (query) { query->error = -ENOMEM; query->done = true; }
      }
    pthread_mutex_unlock(&mdns_lock); return NULL;
  }
  pthread_mutex_unlock(&mdns_lock);
  for (;;) {
    uint64_t now = now_ms();
    pthread_mutex_lock(&mdns_lock);
    if (state.stopping) {
      struct sockaddr_in destination = multicast_address();
      if (fd >= 0) for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i)
        if (state.adverts[i].used && state.adverts[i].announced) send_service(fd, &state.adverts[i], 0, false, &destination, NULL, 0);
      pthread_mutex_unlock(&mdns_lock); break;
    }
    unsigned desired_generation = state.generation; struct in_addr interface = state.ip;
    bool changed = generation != desired_generation;
    if (changed) {
      for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i)
        if (state.adverts[i].used && !state.adverts[i].retiring) restart_probes(&state.adverts[i], now);
    }
    pthread_mutex_unlock(&mdns_lock);
    /* NuttX IGMP加入/离开会等待网络栈发送报告，不能持有owner锁。
     * 即使驱动不再推进，VM关闭/查询到期/全局shutdown超时仍能立即访问状态。
     */
    if (changed) {
      if (fd >= 0) close(fd);
      fd = -1; retry = 0; generation = desired_generation;
    }
    if (fd < 0 && now >= retry) {
      int opened = open_socket(interface);
      pthread_mutex_lock(&mdns_lock);
      bool stale = state.stopping || generation != state.generation;
      if (!stale) state.error = opened < 0 ? opened : 0;
      pthread_mutex_unlock(&mdns_lock);
      if (stale) { if (opened >= 0) close(opened); continue; }
      fd = opened < 0 ? -1 : opened; retry = now_ms() + 1000;
    }
    pthread_mutex_lock(&mdns_lock);
    if (!state.stopping && generation == state.generation) tick(fd, now_ms());
    pthread_mutex_unlock(&mdns_lock);
    struct pollfd descriptor = {.fd = fd, .events = POLLIN};
    int polled = poll(&descriptor, 1, 25);
    if (polled > 0 && (descriptor.revents & POLLIN)) {
      /* 每轮最多八报文，持续恶意数据不能饿死取消、到期和广播处理。 */
      for (unsigned batch = 0; batch < 8; ++batch) {
        struct sockaddr_in source; socklen_t size = sizeof(source);
        ssize_t length = recvfrom(fd, packet, PACKET_BYTES + 1, 0, (struct sockaddr *)&source, &size);
        if (length < 0) break;
        if (size < sizeof(source) || source.sin_family != AF_INET || length > PACKET_BYTES) continue;
        pthread_mutex_lock(&mdns_lock);
        handle_packet(fd, packet, (size_t)length, &source, now_ms());
        pthread_mutex_unlock(&mdns_lock);
      }
    }
  }
  if (fd >= 0) close(fd); free(packet);
  pthread_mutex_lock(&mdns_lock); state.running = false; pthread_mutex_unlock(&mdns_lock); return NULL;
}
#if defined(__NuttX__) || defined(PX_MDNS_TEST_KTHREAD)
static int worker_task(int argc, char **argv) { (void)argc; (void)argv; worker(NULL); return 0; }
#endif
/* 调用者持锁；新线程只能在这里释放锁后开始访问全局状态。 */
static int ensure_worker(void)
{
  if (state.stopping) return -ECANCELED;
  if (state.running) return 0;
  state.running = true; state.error = 0;
#if defined(__NuttX__) || defined(PX_MDNS_TEST_KTHREAD)
  /* 接收包在堆上，解析无递归；目标帧预算和压力测试见 docs/mdns.md。 */
  int task = kthread_create("pixelbox-mdns", 100, 8192, worker_task, NULL);
  int error = task < 0 ? task : 0;
#else
  pthread_t thread; pthread_attr_t attributes;
  int error = pthread_attr_init(&attributes);
  if (!error) {
    error = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    if (!error) error = pthread_create(&thread, &attributes, worker, NULL);
    pthread_attr_destroy(&attributes);
  }
  if (error) error = -error;
#endif
  if (error) { state.running = false; state.error = error; }
  return error;
}
static uint32_t next_id(void) { if (!++state.next_id) ++state.next_id; return state.next_id; }
struct px_mdns *px_mdns_create(void)
{
  struct px_mdns *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  pthread_mutex_lock(&mdns_lock);
  unsigned index = 0; while (index < 16 && state.owners_list[index]) ++index;
  if (index == 16 || state.stopping) { pthread_mutex_unlock(&mdns_lock); free(owner); return NULL; }
  state.owners_list[index] = owner; ++state.owners; pthread_mutex_unlock(&mdns_lock); return owner;
}
void px_mdns_destroy(struct px_mdns *owner)
{
  if (!owner) return;
  pthread_mutex_lock(&mdns_lock);
  for (unsigned i = 0; i < PX_MDNS_MAX_QUERIES; ++i) free(owner->queries[i]);
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i)
    if (state.adverts[i].used && state.adverts[i].owner == owner) {
      state.adverts[i].owner = NULL; state.adverts[i].retiring = true; state.adverts[i].next_send = 0;
    }
  for (unsigned i = 0; i < 16; ++i) if (state.owners_list[i] == owner) { state.owners_list[i] = NULL; --state.owners; break; }
  pthread_mutex_unlock(&mdns_lock); free(owner);
}
int px_mdns_discover(struct px_mdns *owner, const char *service, unsigned timeout_ms, uint32_t *id)
{
  if (!owner || !id || !timeout_ms || timeout_ms > 120000) return -EINVAL;
  struct name name; int error = service_name(service, &name); if (error) return error;
  struct query *query = calloc(1, sizeof(*query)); if (!query) return -ENOMEM;
  pthread_mutex_lock(&mdns_lock);
  unsigned slot = 0, total = 0;
  for (unsigned i = 0; i < 16; ++i) if (state.owners_list[i])
    for (unsigned j = 0; j < PX_MDNS_MAX_QUERIES; ++j) if (state.owners_list[i]->queries[j]) ++total;
  while (slot < PX_MDNS_MAX_QUERIES && owner->queries[slot]) ++slot;
  error = total >= PX_MDNS_MAX_QUERIES ? -EBUSY : ensure_worker();
  if (!error) {
    query->service = name; query->id = next_id(); query->deadline = now_ms() + timeout_ms;
    owner->queries[slot] = query; *id = query->id;
  }
  pthread_mutex_unlock(&mdns_lock); if (error) free(query); return error;
}
int px_mdns_cancel(struct px_mdns *owner, uint32_t id)
{
  if (!owner || !id) return -EINVAL;
  pthread_mutex_lock(&mdns_lock);
  for (unsigned i = 0; i < PX_MDNS_MAX_QUERIES; ++i) if (owner->queries[i] && owner->queries[i]->id == id) {
    owner->queries[i]->error = -ECANCELED; owner->queries[i]->done = true;
    pthread_mutex_unlock(&mdns_lock); return 0;
  }
  pthread_mutex_unlock(&mdns_lock); return -ENOENT;
}
int px_mdns_poll(struct px_mdns *owner, struct px_mdns_result *result)
{
  if (!owner || !result) return -EINVAL;
  memset(result, 0, sizeof(*result)); pthread_mutex_lock(&mdns_lock); uint64_t now = now_ms();
  for (unsigned i = 0; i < PX_MDNS_MAX_QUERIES; ++i) {
    struct query *query = owner->queries[i];
    if (query && !query->done && now >= query->deadline) query->done = true;
    if (!query || !query->done) continue;
    result->id = query->id; result->error = query->error;
    if (!query->error) {
      result->services = calloc(PX_MDNS_MAX_RESULTS, sizeof(*result->services));
      if (!result->services) { pthread_mutex_unlock(&mdns_lock); return -ENOMEM; }
      for (unsigned j = 0; j < PX_MDNS_MAX_RESULTS; ++j) {
        struct candidate *entry = &query->entries[j];
        if (entry->ptr_until <= now || entry->srv_until <= now || !entry->value.port) continue;
        for (unsigned a = 0; a < ADDRESS_SLOTS; ++a) {
          struct address *address = &state.addresses[a];
          if (address->until <= now || !address->ip || !equal_name(&address->host, &entry->host)) continue;
          struct px_mdns_service *service = &result->services[result->count++]; *service = entry->value;
          inet_ntop(AF_INET, &address->ip, service->ip, sizeof(service->ip));
          if (entry->txt_until <= now) service->txt_length = 0;
          break;
        }
      }
    }
    owner->queries[i] = NULL; free(query); pthread_mutex_unlock(&mdns_lock); return 1;
  }
  pthread_mutex_unlock(&mdns_lock); return 0;
}
void px_mdns_result_free(struct px_mdns_result *result)
{ if (result) { free(result->services); memset(result, 0, sizeof(*result)); } }
static int add_advert(struct px_mdns *owner, const char *name, const char *service, unsigned port,
                       const uint8_t *txt, size_t length, uint32_t *id)
{
  struct name parsed;
  if (!valid_label(name, true) || !port || port > 65535 || !valid_txt(txt, length) || !id || service_name(service, &parsed)) return -EINVAL;
  pthread_mutex_lock(&mdns_lock);
  struct advertisement *slot = NULL;
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i) {
    struct advertisement *advert = &state.adverts[i];
    if (advert->used && !advert->retiring && equal_name(&advert->service, &parsed) && !strcmp(advert->base, name)) {
      pthread_mutex_unlock(&mdns_lock); return -EEXIST;
    }
    if (!advert->used && !slot) slot = advert;
  }
  int error = slot ? ensure_worker() : -ENOSPC;
  if (!error) {
    memset(slot, 0, sizeof(*slot)); slot->used = true; slot->owner = owner; slot->id = next_id();
    strcpy(slot->base, name); slot->service = parsed; instance_name(&slot->instance, name, &parsed);
    slot->port = (uint16_t)port; slot->txt_length = (uint16_t)length;
    if (length) memcpy(slot->txt, txt, length);
    restart_probes(slot, now_ms()); *id = slot->id;
  }
  pthread_mutex_unlock(&mdns_lock); return error;
}
int px_mdns_advertise(struct px_mdns *owner, const char *name, const char *service, unsigned port,
                      const uint8_t *txt, size_t txt_length, uint32_t *id)
{ return owner ? add_advert(owner, name, service, port, txt, txt_length, id) : -EINVAL; }
int px_mdns_unadvertise(struct px_mdns *owner, uint32_t id)
{
  if (!owner || !id) return -EINVAL;
  pthread_mutex_lock(&mdns_lock);
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i) {
    struct advertisement *advert = &state.adverts[i];
    if (advert->used && advert->owner == owner && advert->id == id) {
      advert->retiring = true; advert->next_send = 0; pthread_mutex_unlock(&mdns_lock); return 0;
    }
  }
  pthread_mutex_unlock(&mdns_lock); return -ENOENT;
}
int px_mdns_configure(const char *hostname, const char *ipv4)
{
  struct in_addr address;
  if (!valid_label(hostname, false) || !ipv4 || inet_pton(AF_INET, ipv4, &address) != 1 ||
      IN_MULTICAST(ntohl(address.s_addr)) || address.s_addr == INADDR_BROADCAST) return -EINVAL;
  pthread_mutex_lock(&mdns_lock);
  if (strcmp(state.base_hostname, hostname) || state.ip.s_addr != address.s_addr) {
    strcpy(state.base_hostname, hostname); strcpy(state.hostname, hostname); state.host_conflicts = 0;
    state.ip = address; ++state.generation; memset(state.addresses, 0, sizeof(state.addresses));
  }
  pthread_mutex_unlock(&mdns_lock); return 0;
}
int px_mdns_publish_devd(const char *name, unsigned port, const char *model, const char *firmware, const char *app)
{
  const char *keys[] = {"model", "fw", "app"}, *values[] = {model, firmware, app};
  uint8_t txt[PX_MDNS_TXT_BYTES]; size_t length = 0;
  for (unsigned i = 0; i < 3; ++i) {
    if (!values[i]) values[i] = "";
    size_t key = strlen(keys[i]), value = strlen(values[i]), count = key + 1 + value;
    if (count > 255 || length + count + 1 > sizeof(txt)) return -E2BIG;
    txt[length++] = (uint8_t)count; memcpy(txt + length, keys[i], key); length += key;
    txt[length++] = '='; memcpy(txt + length, values[i], value); length += value;
  }
  /* 更新同一系统广播，旧VM无法删除此owner=NULL的注册项。 */
  pthread_mutex_lock(&mdns_lock);
  for (unsigned i = 0; i < PX_MDNS_MAX_ADVERTISEMENTS; ++i) {
    struct advertisement *advert = &state.adverts[i];
    if (!advert->used || advert->retiring || advert->owner) continue;
    if (!valid_label(name, true) || !port || port > 65535) { pthread_mutex_unlock(&mdns_lock); return -EINVAL; }
    if (!strcmp(advert->base, name) && advert->port == port && advert->txt_length == length && !memcmp(advert->txt, txt, length)) {
      pthread_mutex_unlock(&mdns_lock); return 0;
    }
    strcpy(advert->base, name); instance_name(&advert->instance, name, &advert->service);
    advert->port = (uint16_t)port; memcpy(advert->txt, txt, length); advert->txt_length = (uint16_t)length;
    advert->conflicts = 0; restart_probes(advert, now_ms()); pthread_mutex_unlock(&mdns_lock); return 0;
  }
  pthread_mutex_unlock(&mdns_lock); uint32_t id; return add_advert(NULL, name, "_pixelbox._tcp", port, txt, length, &id);
}
int px_mdns_status(void) { pthread_mutex_lock(&mdns_lock); int error = state.error; pthread_mutex_unlock(&mdns_lock); return error; }
int px_mdns_shutdown(void)
{
  pthread_mutex_lock(&mdns_lock);
  if (state.owners) { pthread_mutex_unlock(&mdns_lock); return -EBUSY; }
  state.stopping = true; pthread_mutex_unlock(&mdns_lock);
  uint64_t deadline = now_ms() + 2000;
  for (;;) {
    pthread_mutex_lock(&mdns_lock);
    if (!state.running) {
      memset(state.adverts, 0, sizeof(state.adverts)); memset(state.addresses, 0, sizeof(state.addresses));
      state.stopping = false; state.error = 0; pthread_mutex_unlock(&mdns_lock); return 0;
    }
    pthread_mutex_unlock(&mdns_lock);
    if (now_ms() >= deadline) return -ETIMEDOUT;
    struct timespec delay = {.tv_nsec = 5000000}; nanosleep(&delay, NULL);
  }
}
