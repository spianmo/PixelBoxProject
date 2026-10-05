/* 门户独占 Wi-Fi 结果，所有 fd/JSON 对象仅由会话控制 worker 持有。 */
#include "pixelbox_portal.h"
#include "pixelbox_softap.h"
#include "pixelbox_wifi.h"
#include "quickjs.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "portal_html.inc"
#ifndef PX_PORTAL_BIND_ADDRESS
#define PX_PORTAL_BIND_ADDRESS PX_SOFTAP_ADDRESS
#endif
#ifndef PX_PORTAL_SCAN_MS
#define PX_PORTAL_SCAN_MS 9000u
#endif
#ifndef PX_PORTAL_CONNECT_MS
#define PX_PORTAL_CONNECT_MS 15000u
#endif
#ifndef PX_PORTAL_SUCCESS_MS
#define PX_PORTAL_SUCCESS_MS 3000u
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define CLIENTS 4
#define HEADER_LIMIT 2048u
#define BODY_LIMIT 512u
#define PATH_LIMIT 384u
struct portal_client {
  int fd;
  char input[HEADER_LIMIT + BODY_LIMIT + 1];
  size_t used, header_size, body_size, output_size, sent;
  bool parsed, scan;
  uint64_t deadline;
  char *output;
};
struct credentials { char ssid[33], password[65]; };
struct portal_session {
  JSRuntime *runtime;
  JSContext *json;
  struct px_portal_status status;
  struct portal_client clients[CLIENTS];
  struct credentials previous, candidate;
  struct px_wifi_status original;
  bool have_previous, ap_started, attempted, saved;
  uint32_t job;
  enum px_wifi_operation operation;
  uint64_t success_at, deadline;
  int listener;
};
static struct {
  pthread_mutex_t mutex;
  pthread_cond_t wake;
  pthread_t controller, dhcp;
  bool initialized, terminate, stop, grant;
  bool controller_started, dhcp_started, controller_done, dhcp_done, reaping;
  enum px_portal_request request;
  unsigned stop_revision, port;
  unsigned session_ms;
  uint64_t deadline;
  char path[PATH_LIMIT];
  struct px_portal_status status;
  bool dhcp_wanted, dhcp_active, dhcp_busy;
  unsigned dhcp_revision, dhcp_processed;
  int dhcp_error;
} g = {.mutex = PTHREAD_MUTEX_INITIALIZER, .wake = PTHREAD_COND_INITIALIZER};

static uint64_t now_ms(void)
{
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000u + (unsigned long)now.tv_nsec / 1000000u;
}
static void pause_tick(void)
{
  struct timespec delay = {0, 20000000};
  while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {}
}
const char *px_portal_phase_name(enum px_portal_phase phase)
{
  static const char *const names[] = {"inactive", "starting", "waiting", "connecting", "success", "failed", "stopping"};
  return (unsigned)phase < sizeof(names) / sizeof(*names) ? names[phase] : "failed";
}
static bool stopping(void)
{
  pthread_mutex_lock(&g.mutex); bool value = g.stop || g.terminate;
  pthread_mutex_unlock(&g.mutex); return value;
}
static void publish(struct portal_session *session)
{
  pthread_mutex_lock(&g.mutex);
  g.status = session->status; g.status.stop_requested = g.stop;
  pthread_mutex_unlock(&g.mutex);
}
static void set_error(struct portal_session *session, int error, const char *message)
{
  session->status.error = error;
  snprintf(session->status.message, sizeof(session->status.message), "%s", message);
  publish(session);
}
static bool session_stopping(struct portal_session *session)
{
  if (stopping()) return true;
  if (session->saved || now_ms() < session->deadline) return false;
  /* 总会话期限不被 HTTP 轮询续期；成功已保存则按原 3 秒成功展示结束。 */
  set_error(session, -ETIMEDOUT, "配网超时，正在恢复原状态");
  (void)px_portal_stop();
  return true;
}
static void *dhcp_worker(void *unused)
{
  (void)unused;
  pthread_mutex_lock(&g.mutex);
  for (;;) {
    while (!g.terminate && g.dhcp_revision == g.dhcp_processed)
      pthread_cond_wait(&g.wake, &g.mutex);
    if (g.terminate) break;
    unsigned revision = g.dhcp_revision;
    bool wanted = g.dhcp_wanted, active = g.dhcp_active;
    g.dhcp_busy = true;
    pthread_mutex_unlock(&g.mutex);
    /* 上游 start/stop 可能阻塞于 sem_wait；不要持状态锁，也不要阻塞 service。 */
    int error = wanted == active ? 0 : wanted ? px_portal_dhcp_start() : px_portal_dhcp_stop();
    pthread_mutex_lock(&g.mutex);
    if (!error) g.dhcp_active = wanted;
    g.dhcp_error = error; g.dhcp_busy = false; g.dhcp_processed = revision;
    pthread_cond_broadcast(&g.wake);
  }
  g.dhcp_done = true;
  pthread_mutex_unlock(&g.mutex); return NULL;
}
static void dhcp_request(bool wanted)
{
  pthread_mutex_lock(&g.mutex);
  g.dhcp_wanted = wanted; ++g.dhcp_revision; g.dhcp_error = 0;
  pthread_cond_broadcast(&g.wake); pthread_mutex_unlock(&g.mutex);
}
static int dhcp_state(bool wanted)
{
  pthread_mutex_lock(&g.mutex);
  int result = g.dhcp_busy || g.dhcp_processed != g.dhcp_revision ? 0 :
    g.dhcp_error ? g.dhcp_error : g.dhcp_active == wanted ? 1 : -EIO;
  pthread_mutex_unlock(&g.mutex); return result;
}
static bool valid_utf8(const char *text)
{
  const unsigned char *bytes = (const unsigned char *)text;
  while (*bytes) {
    unsigned char first = *bytes++;
    if (first < 0x80) continue;
    unsigned count = first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 :
      first >= 0xf0 && first <= 0xf4 ? 3 : 0;
    if (!count) return false;
    if ((first == 0xe0 && bytes[0] < 0xa0) || (first == 0xed && bytes[0] >= 0xa0) ||
        (first == 0xf0 && bytes[0] < 0x90) || (first == 0xf4 && bytes[0] >= 0x90)) return false;
    for (unsigned i = 0; i < count; ++i) {
      if (*bytes < 0x80 || *bytes > 0xbf) return false;
      ++bytes;
    }
  }
  return true;
}
static bool valid_credentials(const struct credentials *credentials)
{
  size_t ssid = strlen(credentials->ssid), password = strlen(credentials->password);
  if (!ssid || ssid > 32 || password > 64 || (password && password < 8)) return false;
  if (!valid_utf8(credentials->ssid) || !valid_utf8(credentials->password)) return false;
  if (password == 64 && strspn(credentials->password, "0123456789abcdefABCDEF") != 64) return false;
  return true;
}
static int get_string(JSContext *ctx, JSValue object, const char *name, char *output, size_t capacity)
{
  JSValue value = JS_GetPropertyStr(ctx, object, name);
  size_t length = 0;
  const char *text = JS_IsString(value) ? JS_ToCStringLen(ctx, &length, value) : NULL;
  int error = !text || length >= capacity || memchr(text, 0, length) ? -EINVAL : 0;
  if (!error) { memcpy(output, text, length); output[length] = 0; }
  JS_FreeCString(ctx, text); JS_FreeValue(ctx, value); return error;
}
static int load_credentials(struct portal_session *session)
{
  int fd = open(g.path, O_RDONLY); if (fd < 0) return -errno;
  char bytes[1025]; size_t used = 0; int error = 0;
  while (used < sizeof(bytes)) {
    ssize_t got = read(fd, bytes + used, sizeof(bytes) - used);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) { error = -errno; break; }
    if (!got) break;
    used += (size_t)got;
  }
  close(fd);
  if (error) return error;
  if (used == sizeof(bytes)) return -EFBIG;
  bytes[used] = 0;
  JSValue value = JS_ParseJSON(session->json, bytes, used, "wifi-credentials");
  if (JS_IsException(value)) { JS_FreeValue(session->json, JS_GetException(session->json)); return -EINVAL; }
  error = get_string(session->json, value, "ssid", session->previous.ssid, sizeof(session->previous.ssid));
  if (!error) error = get_string(session->json, value, "password", session->previous.password, sizeof(session->previous.password));
  JS_FreeValue(session->json, value);
  return error ? error : valid_credentials(&session->previous) ? 0 : -EINVAL;
}
static int json_field(JSContext *ctx, JSValue object, const char *name, JSValue value)
{
  return JS_IsException(value) ? -1 : JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E);
}
static char *json_text(JSContext *ctx, JSValue object)
{
  JSValue value = JS_JSONStringify(ctx, object, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(ctx, object);
  const char *text = JS_IsException(value) ? NULL : JS_ToCString(ctx, value);
  char *copy = text ? strdup(text) : NULL;
  JS_FreeCString(ctx, text); JS_FreeValue(ctx, value);
  if (!copy) JS_FreeValue(ctx, JS_GetException(ctx));
  return copy;
}
static int save_credentials(struct portal_session *session)
{
  JSContext *ctx = session->json;
  JSValue value = JS_NewObject(ctx);
  if (JS_IsException(value)) return -ENOMEM;
  if (json_field(ctx, value, "ssid", JS_NewString(ctx, session->candidate.ssid)) < 0 ||
      json_field(ctx, value, "password", JS_NewString(ctx, session->candidate.password)) < 0) {
    JS_FreeValue(ctx, value); return -ENOMEM;
  }
  char *text = json_text(ctx, value); if (!text) return -ENOMEM;
  char temporary[PATH_LIMIT + 24];
  snprintf(temporary, sizeof(temporary), "%s.portal.XXXXXX", g.path);
  int fd = mkstemp(temporary), error = 0;
  if (fd < 0) { error = -errno; free(text); return error; }
  size_t size = strlen(text), at = 0;
  while (at < size) {
    ssize_t sent = write(fd, text + at, size - at);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) { error = -(sent ? errno : EIO); break; }
    at += (size_t)sent;
  }
  free(text);
  if (!error && fsync(fd) < 0) error = -errno;
  if (close(fd) < 0 && !error) error = -errno;
  if (!error && rename(temporary, g.path) < 0) error = -errno;
  if (error) unlink(temporary);
  return error;
}
static void close_client(struct portal_client *client)
{
  if (client->fd >= 0) close(client->fd);
  free(client->output); memset(client, 0, sizeof(*client)); client->fd = -1;
}
static int nonblocking(int fd)
{
  int flags = fcntl(fd, F_GETFL, 0);
  return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ? -errno : 0;
}
static void response(struct portal_client *client, unsigned status, const char *type, const char *body)
{
  if (client->fd < 0) return;
  const char *reason = status == 200 ? "OK" : status == 302 ? "Found" : status == 400 ? "Bad Request" :
    status == 409 ? "Conflict" : status == 429 ? "Too Many Requests" : status == 503 ? "Service Unavailable" :
    status == 504 ? "Gateway Timeout" : "Internal Server Error";
  size_t length = strlen(body), capacity = length + 320;
  char *output = malloc(capacity);
  if (!output) { close_client(client); return; }
  int header = snprintf(output, capacity,
    "HTTP/1.1 %u %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n",
    status, reason, type, length, status == 302 ? "Location: http://192.168.4.1/\r\n" : "");
  if (header < 0 || (size_t)header + length >= capacity) { free(output); close_client(client); return; }
  memcpy(output + header, body, length);
  free(client->output); client->output = output; client->output_size = (size_t)header + length;
  client->sent = 0; client->scan = false; client->deadline = now_ms() + 3000;
}
static void json_response(struct portal_session *session, struct portal_client *client, unsigned status, JSValue value)
{
  char *text = json_text(session->json, value);
  response(client, text ? status : 500, "application/json; charset=utf-8", text ? text : "{\"ok\":false,\"message\":\"out of memory\"}");
  free(text);
}
static void error_response(struct portal_session *session, struct portal_client *client, unsigned status, const char *message)
{
  JSValue object = JS_NewObject(session->json);
  json_field(session->json, object, "ok", JS_FALSE);
  json_field(session->json, object, "message", JS_NewString(session->json, message));
  json_response(session, client, status, object);
}
static int hex_digit(unsigned char c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static int decode_form(const char *source, size_t size, char *out, size_t capacity)
{
  size_t count = 0;
  for (size_t i = 0; i < size; ++i) {
    unsigned char value = (unsigned char)source[i];
    if (value == '+') value = ' ';
    else if (value == '%') {
      if (i + 2 >= size || hex_digit(source[i + 1]) < 0 || hex_digit(source[i + 2]) < 0) return -EINVAL;
      value = (unsigned char)((hex_digit(source[i + 1]) << 4) | hex_digit(source[i + 2])); i += 2;
    }
    if (!value || count + 1 >= capacity) return -EINVAL;
    out[count++] = (char)value;
  }
  out[count] = 0; return 0;
}
static int parse_form(const char *body, size_t size, struct credentials *out)
{
  bool ssid = false, password = false;
  memset(out, 0, sizeof(*out));
  for (size_t at = 0; at < size;) {
    size_t end = at; while (end < size && body[end] != '&') ++end;
    const char *equal = memchr(body + at, '=', end - at);
    if (!equal) return -EINVAL;
    size_t key = (size_t)(equal - body - at), value = end - (size_t)(equal - body) - 1;
    if (key == 4 && !memcmp(body + at, "ssid", 4) && !ssid) {
      if (decode_form(equal + 1, value, out->ssid, sizeof(out->ssid))) return -EINVAL;
      ssid = true;
    } else if (key == 4 && !memcmp(body + at, "pass", 4) && !password) {
      if (decode_form(equal + 1, value, out->password, sizeof(out->password))) return -EINVAL;
      password = true;
    } else return -EINVAL;
    at = end + 1;
  }
  return ssid && valid_credentials(out) ? 0 : -EINVAL;
}
static void scan_response(struct portal_session *session, const struct px_wifi_result *result)
{
  struct px_wifi_ap unique[24]; size_t count = 0;
  for (size_t i = 0; i < result->ap_count && i < PX_WIFI_MAX_APS; ++i) {
    struct px_wifi_ap item = result->aps[i]; item.ssid[32] = 0;
    if (!item.ssid[0]) continue;
    size_t slot = 0; while (slot < count && strcmp(unique[slot].ssid, item.ssid)) ++slot;
    if (slot < count) { if (item.rssi > unique[slot].rssi) unique[slot] = item; }
    else if (count < 24) unique[count++] = item;
    else if (item.rssi > unique[count - 1].rssi) unique[count - 1] = item;
    for (size_t a = 1; a < count; ++a) for (size_t b = a; b && unique[b].rssi > unique[b - 1].rssi; --b) {
      struct px_wifi_ap swap = unique[b]; unique[b] = unique[b - 1]; unique[b - 1] = swap;
    }
  }
  for (size_t i = 0; i < CLIENTS; ++i) {
    struct portal_client *client = &session->clients[i]; if (!client->scan || client->fd < 0) continue;
    if (result->error) { error_response(session, client, result->error == -ETIMEDOUT ? 504 : 503, "扫描失败，请重试"); continue; }
    JSContext *ctx = session->json; JSValue value = JS_NewObject(ctx), list = JS_NewArray(ctx);
    for (size_t a = 0; a < count; ++a) {
      JSValue item = JS_NewObject(ctx);
      json_field(ctx, item, "ssid", JS_NewString(ctx, unique[a].ssid));
      json_field(ctx, item, "rssi", JS_NewInt32(ctx, unique[a].rssi));
      json_field(ctx, item, "secure", JS_NewBool(ctx, unique[a].secure));
      JS_DefinePropertyValueUint32(ctx, list, (uint32_t)a, item, JS_PROP_C_W_E);
    }
    json_field(ctx, value, "ok", JS_TRUE); json_field(ctx, value, "aps", list);
    json_response(session, client, 200, value);
  }
}
static void poll_wifi(struct portal_session *session, bool cleanup)
{
  struct px_wifi_result result;
  int available = px_wifi_poll(&result);
  if (available <= 0 || result.operation == PX_WIFI_OP_NONE || !session->job || result.job_id != session->job) return;
  enum px_wifi_operation operation = session->operation;
  session->job = 0; session->operation = PX_WIFI_OP_NONE;
  if (cleanup || session_stopping(session)) return;
  if (operation == PX_WIFI_OP_SCAN) { scan_response(session, &result); return; }
  /* 取消/会话超时已排队时不提交迟到成功，清理流程会恢复旧凭据。 */
  int error = result.error;
  if (!error && (!result.status.connected || strcmp(result.status.ssid, session->candidate.ssid))) error = -ENOTCONN;
  if (!error) error = save_credentials(session);
  if (error) {
    session->status.phase = PX_PORTAL_FAILED;
    set_error(session, error, result.error ? "连接失败，请检查密码后重试" : "连接结果或凭据保存失败");
  } else {
    session->saved = true; session->success_at = now_ms();
    session->status.phase = PX_PORTAL_SUCCESS; session->status.error = 0; session->status.message[0] = 0;
    snprintf(session->status.ip, sizeof(session->status.ip), "%s", result.status.ip); publish(session);
  }
}
static void route(struct portal_session *session, struct portal_client *client)
{
  if (session_stopping(session)) return;
  char method[8], path[128], version[16], extra;
  const char *line_end = strstr(client->input, "\r\n");
  if (!line_end) { error_response(session, client, 400, "请求行不合法"); return; }
  size_t length = (size_t)(line_end - client->input);
  if (length >= 180) { error_response(session, client, 400, "请求行过长"); return; }
  char line[181]; memcpy(line, client->input, length); line[length] = 0;
  if (sscanf(line, "%7s %127s %15s %c", method, path, version, &extra) != 3 ||
      (strcmp(version, "HTTP/1.1") && strcmp(version, "HTTP/1.0"))) {
    error_response(session, client, 400, "请求行不合法"); return;
  }
  if (!strcmp(method, "GET") && !client->body_size) {
    if (!strcmp(path, "/")) { response(client, 200, "text/html; charset=utf-8", portal_html); return; }
    if (!strcmp(path, "/status")) {
      JSContext *ctx = session->json; JSValue value = JS_NewObject(ctx);
      json_field(ctx, value, "ok", JS_TRUE);
      json_field(ctx, value, "phase", JS_NewString(ctx, px_portal_phase_name(session->status.phase)));
      json_field(ctx, value, "ssid", JS_NewString(ctx, session->status.ssid));
      json_field(ctx, value, "ip", JS_NewString(ctx, session->status.ip));
      json_field(ctx, value, "message", JS_NewString(ctx, session->status.message));
      json_response(session, client, 200, value); return;
    }
    if (!strcmp(path, "/scan")) {
      if (session->job) { error_response(session, client, 429, "Wi-Fi 忙，请稍后再试"); return; }
      int error = px_wifi_scan_start(PX_PORTAL_SCAN_MS, &session->job);
      if (error) { session->job = 0; error_response(session, client, 503, "扫描启动失败"); return; }
      session->operation = PX_WIFI_OP_SCAN; client->scan = true; client->deadline = now_ms() + PX_PORTAL_SCAN_MS + 1000;
      return;
    }
    response(client, 302, "text/plain", ""); return;
  }
  if (strcmp(method, "POST") || strcmp(path, "/connect") || !client->body_size) {
    error_response(session, client, 400, "请求不合法"); return;
  }
  if (session->job || session->saved) { error_response(session, client, 409, "Wi-Fi 忙，请稍后再试"); return; }
  /* 当前连接没有可恢复凭据时拒绝切网，防止误操作永久丢失已有远程入口。 */
  if (session->original.connected && (!session->have_previous || strcmp(session->original.ssid, session->previous.ssid))) {
    error_response(session, client, 409, "当前网络缺少可恢复凭据，暂不能切换网络"); return;
  }
  struct credentials candidate;
  if (parse_form(client->input + client->header_size, client->body_size, &candidate)) {
    error_response(session, client, 400, "网络名称或密码不合法"); return;
  }
  int error = px_wifi_connect_start(candidate.ssid, candidate.password, PX_PORTAL_CONNECT_MS, &session->job);
  if (error) { session->job = 0; error_response(session, client, 503, "连接启动失败"); return; }
  session->candidate = candidate; session->attempted = true; session->operation = PX_WIFI_OP_CONNECT;
  session->status.phase = PX_PORTAL_CONNECTING; session->status.error = 0;
  session->status.ip[0] = session->status.message[0] = 0;
  snprintf(session->status.ssid, sizeof(session->status.ssid), "%s", candidate.ssid); publish(session);
  response(client, 200, "application/json", "{\"ok\":true}");
}
static int parse_headers(struct portal_client *client)
{
  char *end = strstr(client->input, "\r\n\r\n");
  if (!end) return client->used >= HEADER_LIMIT ? -E2BIG : 0;
  client->header_size = (size_t)(end - client->input) + 4;
  if (client->header_size > HEADER_LIMIT) return -E2BIG;
  char *at = strstr(client->input, "\r\n") + 2;
  bool have_length = false;
  while (at < end) {
    char *next = strstr(at, "\r\n"), *colon = memchr(at, ':', (size_t)(next - at));
    if (!colon || at[0] == ' ' || at[0] == '\t') return -EINVAL;
    size_t name = (size_t)(colon - at);
    if (name == 17 && !strncasecmp(at, "Transfer-Encoding", name)) return -EINVAL;
    if (name == 14 && !strncasecmp(at, "Content-Length", name)) {
      if (have_length) return -EINVAL;
      have_length = true; const char *number = colon + 1;
      while (number < next && (*number == ' ' || *number == '\t')) ++number;
      if (number == next || *number < '0' || *number > '9') return -EINVAL;
      size_t value = 0;
      while (number < next && *number >= '0' && *number <= '9') {
        value = value * 10 + (unsigned)(*number++ - '0'); if (value > BODY_LIMIT) return -E2BIG;
      }
      while (number < next && (*number == ' ' || *number == '\t')) ++number;
      if (number != next) return -EINVAL;
      client->body_size = value;
    }
    at = next + 2;
  }
  client->parsed = true; return 1;
}
static int listen_http(struct portal_session *session)
{
  int fd = socket(AF_INET, SOCK_STREAM, 0); if (fd < 0) return -errno;
  int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((uint16_t)g.port)};
  if (inet_pton(AF_INET, PX_PORTAL_BIND_ADDRESS, &address.sin_addr) != 1) { close(fd); return -EINVAL; }
  if (nonblocking(fd) || bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(fd, CLIENTS) < 0) {
    int error = -errno; close(fd); return error;
  }
  socklen_t length = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &length) < 0) { int error = -errno; close(fd); return error; }
  session->listener = fd; session->status.http_port = ntohs(address.sin_port); return 0;
}
static void serve_tick(struct portal_session *session)
{
  struct pollfd descriptors[CLIENTS + 1] = {{session->listener, POLLIN, 0}};
  for (size_t i = 0; i < CLIENTS; ++i) {
    struct portal_client *client = &session->clients[i];
    descriptors[i + 1].fd = client->fd;
    descriptors[i + 1].events = client->output ? POLLOUT : client->scan ? 0 : POLLIN;
  }
  int ready = poll(descriptors, CLIENTS + 1, 20);
  if (ready < 0 && errno != EINTR) { set_error(session, -errno, "HTTP 服务失败"); px_portal_stop(); return; }
  if (descriptors[0].revents & POLLIN) {
    int fd = accept(session->listener, NULL, NULL);
    if (fd >= 0) {
      size_t slot = 0; while (slot < CLIENTS && session->clients[slot].fd >= 0) ++slot;
      if (slot == CLIENTS || nonblocking(fd)) close(fd);
      else {
#ifdef SO_NOSIGPIPE
        int one = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
        session->clients[slot].fd = fd; session->clients[slot].deadline = now_ms() + 3000;
      }
    }
  }
  for (size_t i = 0; i < CLIENTS; ++i) {
    struct portal_client *client = &session->clients[i]; short events = descriptors[i + 1].revents;
    if (client->fd < 0) continue;
    if ((events & (POLLERR | POLLNVAL)) || now_ms() >= client->deadline) { close_client(client); continue; }
    if (client->output && (events & POLLOUT)) {
      ssize_t sent = send(client->fd, client->output + client->sent, client->output_size - client->sent, MSG_NOSIGNAL);
      if (sent > 0) client->sent += (size_t)sent;
      else if (sent == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) { close_client(client); continue; }
      if (client->sent == client->output_size) close_client(client);
    } else if (!client->output && !client->scan && (events & POLLIN)) {
      ssize_t got = recv(client->fd, client->input + client->used, sizeof(client->input) - client->used - 1, 0);
      if (got <= 0) {
        if (!got || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) close_client(client);
        continue;
      }
      if (memchr(client->input + client->used, 0, (size_t)got)) { error_response(session, client, 400, "请求包含 NUL"); continue; }
      client->used += (size_t)got; client->input[client->used] = 0;
      if (!client->parsed && parse_headers(client) < 0) { error_response(session, client, 400, "请求头或长度不合法"); continue; }
      if (client->parsed && client->used >= client->header_size + client->body_size) {
        if (client->used != client->header_size + client->body_size) error_response(session, client, 400, "请求长度不匹配");
        else route(session, client);
      }
    } else if ((events & POLLHUP) && !client->output) close_client(client);
  }
}
static void drain_job(struct portal_session *session)
{
  uint64_t deadline = now_ms() + PX_PORTAL_CONNECT_MS + 2000;
  while (session->job) {
    poll_wifi(session, true);
    if (session->job && now_ms() >= deadline) set_error(session, -ETIMEDOUT, "等待无线作业退出，暂不恢复应用");
    if (session->job) pause_tick();
  }
}
static void restore_previous(struct portal_session *session)
{
  if (!session->attempted || session->saved || !session->have_previous) return;
  uint64_t deadline = now_ms() + PX_PORTAL_CONNECT_MS + 2000;
  int error;
  do {
    error = px_wifi_connect_start(session->previous.ssid, session->previous.password, PX_PORTAL_CONNECT_MS, &session->job);
    if (error != -EBUSY) break;
    /* 取消结果已可见时底层驱动仍可能正在清理，保留消费权直到恢复作业被接收。 */
    struct px_wifi_result discarded; px_wifi_poll(&discarded);
    if (now_ms() >= deadline) set_error(session, -ETIMEDOUT, "等待恢复原网络，暂不恢复应用");
    pause_tick();
  } while (error == -EBUSY);
  if (error) { session->job = 0; set_error(session, error, "原网络恢复启动失败"); return; }
  session->operation = PX_WIFI_OP_CONNECT;
  for (;;) {
    struct px_wifi_result result;
    int available = px_wifi_poll(&result);
    if (available > 0 && result.operation == PX_WIFI_OP_CONNECT && result.job_id == session->job) {
      if (result.error || !result.status.connected) set_error(session, result.error ? result.error : -ENOTCONN, "原网络恢复失败，凭据已保留");
      session->job = 0; session->operation = PX_WIFI_OP_NONE; break;
    }
    pause_tick();
  }
}
static void cleanup(struct portal_session *session)
{
  session->status.phase = PX_PORTAL_STOPPING; publish(session);
  if (session->listener >= 0) { close(session->listener); session->listener = -1; }
  for (size_t i = 0; i < CLIENTS; ++i) close_client(&session->clients[i]);
  dhcp_request(false);
  /* 扫描取消不能调用 disconnect：它会断开原有 STA。继续独占消费到扫描超时。
   * 只有本次门户已经发起切网时，才取消本次连接并恢复原凭据。 */
  if (session->job && session->operation == PX_WIFI_OP_CONNECT) px_wifi_disconnect();
  drain_job(session); restore_previous(session);
  uint64_t deadline = now_ms() + 2000;
  unsigned retry;
  pthread_mutex_lock(&g.mutex); retry = g.stop_revision; pthread_mutex_unlock(&g.mutex);
  for (;;) {
    int state = dhcp_state(false);
    if (state == 1) break;
    if (state < 0) set_error(session, state, "DHCP 停止失败，请重试停止");
    else if (now_ms() >= deadline) set_error(session, -ETIMEDOUT, "等待 DHCP 退出，暂不恢复应用");
    pthread_mutex_lock(&g.mutex); unsigned revision = g.stop_revision; pthread_mutex_unlock(&g.mutex);
    if (revision != retry) { retry = revision; if (state < 0) dhcp_request(false); }
    pause_tick();
  }
  while (session->ap_started) {
    int error = px_softap_stop();
    if (!error) { session->ap_started = false; break; }
    set_error(session, error, "热点停止失败，请重试停止");
    for (;;) {
      pthread_mutex_lock(&g.mutex); unsigned revision = g.stop_revision; pthread_mutex_unlock(&g.mutex);
      if (revision != retry) { retry = revision; break; }
      pause_tick();
    }
  }
  /* 资源已关闭，但线程栈尚未回收；保持 ownership 到 service 完成两次 join。 */
  session->status.active = false; session->status.http_port = 0;
  memset(session->status.ap_password, 0, sizeof(session->status.ap_password)); publish(session);
}
static void run_session(struct portal_session *session)
{
  session->runtime = JS_NewRuntime();
  if (!session->runtime) { set_error(session, -ENOMEM, "JSON 初始化失败"); goto done; }
  JS_SetMemoryLimit(session->runtime, 512 * 1024);
  /* 凭据 JSON 最多 1024 字节，但深嵌套仍需限制递归；给错误回溯、
   * HTTP/驱动及清理调用保留栈余量，不能把整个 OS 栈都交给 QuickJS。 */
  JS_SetMaxStackSize(session->runtime, PX_PORTAL_JSON_STACK_BYTES);
  session->json = JS_NewContextRaw(session->runtime);
  if (!session->json) { set_error(session, -ENOMEM, "JSON 初始化失败"); goto done; }
  JS_AddIntrinsicBaseObjects(session->json); JS_AddIntrinsicJSON(session->json);
  session->have_previous = load_credentials(session) == 0;
  int error = px_wifi_get_status(&session->original);
  if (error) { set_error(session, error, "Wi-Fi 服务尚未初始化"); goto done; }
  if (session_stopping(session)) goto done;
  error = px_portal_ap_identity(session->status.ap_ssid, session->status.ap_password);
  if (error) { set_error(session, error, "热点身份初始化失败"); goto done; }
  publish(session);
  if (session_stopping(session)) goto done;
  error = px_softap_start(session->status.ap_ssid, session->status.ap_password);
  if (error) {
    struct px_softap_status status = {0};
    px_softap_get_status(&status); session->ap_started = status.owned;
    set_error(session, error, "热点启动失败"); goto done;
  }
  session->ap_started = true;
  dhcp_request(true);
  while (!session_stopping(session)) {
    int state = dhcp_state(true);
    if (state == 1) break;
    if (state < 0) { set_error(session, state, "DHCP 启动失败"); goto done; }
    pause_tick();
  }
  if (session_stopping(session)) goto done;
  error = listen_http(session);
  if (error) { set_error(session, error, "HTTP 启动失败"); goto done; }
  session->status.phase = PX_PORTAL_WAITING; session->status.active = true; publish(session);
  while (!session_stopping(session)) {
    if (px_portal_dhcp_status() == 0) { set_error(session, -ENETDOWN, "DHCP 服务意外退出"); break; }
    poll_wifi(session, false);
    if (session->saved && now_ms() - session->success_at >= PX_PORTAL_SUCCESS_MS) break;
    serve_tick(session);
  }
done:
  cleanup(session);
  if (session->json) JS_FreeContext(session->json);
  if (session->runtime) JS_FreeRuntime(session->runtime);
  memset(&session->previous, 0, sizeof(session->previous));
  memset(&session->candidate, 0, sizeof(session->candidate));
}
static void *controller_worker(void *unused)
{
  (void)unused;
  pthread_mutex_lock(&g.mutex);
  struct portal_session *session = calloc(1, sizeof(*session));
  if (session) {
    session->status = g.status; session->listener = -1; session->deadline = g.deadline;
    for (size_t i = 0; i < CLIENTS; ++i) session->clients[i].fd = -1;
    pthread_mutex_unlock(&g.mutex);
    run_session(session); free(session);
    pthread_mutex_lock(&g.mutex);
  } else { g.status.error = -ENOMEM; g.status.phase = PX_PORTAL_STOPPING; }
  /* 本会话所有清理结束才终止 DHCP 包装线程，不能打断迟到的 start/stop。 */
  g.terminate = true; g.controller_done = true; pthread_cond_broadcast(&g.wake);
  pthread_mutex_unlock(&g.mutex); return NULL;
}
int px_portal_init(const struct px_portal_config *config)
{
  const char *path = config && config->credentials_path ? config->credentials_path : "/data/.pixelbox-wifi.json";
  if (!*path || strlen(path) >= PATH_LIMIT || (config && config->http_port > 65535)) return -EINVAL;
  pthread_mutex_lock(&g.mutex);
  if (g.initialized) { pthread_mutex_unlock(&g.mutex); return -EALREADY; }
  strcpy(g.path, path); g.port = config ? config->http_port : 0;
  g.session_ms = config && config->timeout_ms ? config->timeout_ms : PX_PORTAL_DEFAULT_SESSION_MS;
#ifndef PX_PORTAL_HOST_TEST
  if (!g.port) g.port = 80;
#endif
  g.terminate = g.stop = g.grant = false; g.request = PX_PORTAL_REQUEST_NONE;
  g.controller_started = g.dhcp_started = g.controller_done = g.dhcp_done = g.reaping = false;
  g.dhcp_wanted = g.dhcp_active = g.dhcp_busy = false;
  g.dhcp_revision = g.dhcp_processed = g.stop_revision = 0; g.dhcp_error = 0;
  memset(&g.status, 0, sizeof(g.status));
  /* init 只保存轻状态；VM 完全退出前不能预留 40 KiB 内部线程栈。 */
  g.initialized = true;
  pthread_mutex_unlock(&g.mutex); return 0;
}
/* 调用者持 g.mutex，worker 要等状态及线程句柄全部发布后才能执行。 */
static int start_workers(void)
{
  pthread_attr_t attributes; int error = pthread_attr_init(&attributes);
  if (!error) {
#ifdef __NuttX__
    error = pthread_attr_setstacksize(&attributes, PX_PORTAL_DHCP_STACK_BYTES);
#else
    error = pthread_attr_setstacksize(&attributes, 1024 * 1024);
#endif
    if (!error) {
      error = pthread_create(&g.dhcp, &attributes, dhcp_worker, NULL);
      g.dhcp_started = error == 0;
    }
    if (!error) {
#ifdef __NuttX__
      error = pthread_attr_setstacksize(&attributes, PX_PORTAL_CONTROLLER_STACK_BYTES);
#endif
      if (!error) {
        error = pthread_create(&g.controller, &attributes, controller_worker, NULL);
        g.controller_started = error == 0;
      }
    }
    pthread_attr_destroy(&attributes);
  }
  if (error) {
    /* 第二线程创建失败时异步收回第一线程，监督器仍保持响应且不抢先恢复 VM。 */
    g.terminate = true; g.stop = true; g.status.error = -error;
    g.status.wifi_owned = g.dhcp_started || g.controller_started;
    g.status.phase = g.status.wifi_owned ? PX_PORTAL_STOPPING : PX_PORTAL_INACTIVE;
    pthread_cond_broadcast(&g.wake);
  }
  return -error;
}
int px_portal_request_start(void)
{
  pthread_mutex_lock(&g.mutex);
  int error = !g.initialized ? -ENODEV : g.status.wifi_owned || g.grant ? -EBUSY : 0;
  if (!error) { g.request = PX_PORTAL_REQUEST_START; g.grant = true; g.stop = false; }
  pthread_mutex_unlock(&g.mutex); return error;
}
int px_portal_take_request(enum px_portal_request *request)
{
  if (!request) return -EINVAL;
  pthread_mutex_lock(&g.mutex); *request = g.request; g.request = PX_PORTAL_REQUEST_NONE;
  int result = g.initialized ? *request != PX_PORTAL_REQUEST_NONE : -ENODEV;
  pthread_mutex_unlock(&g.mutex); return result;
}
int px_portal_begin(void)
{
  pthread_mutex_lock(&g.mutex);
  int error = !g.initialized ? -ENODEV : g.status.wifi_owned ? -EBUSY : !g.grant || g.stop ? -ECANCELED : 0;
  if (!error) {
    uint32_t generation = g.status.generation + 1;
    memset(&g.status, 0, sizeof(g.status)); g.status.generation = generation ? generation : 1;
    g.status.wifi_owned = true; g.status.phase = PX_PORTAL_STARTING;
    g.deadline = now_ms() + g.session_ms;
    g.request = PX_PORTAL_REQUEST_NONE; g.grant = g.stop = g.terminate = false;
    g.controller_done = g.dhcp_done = false;
    g.dhcp_wanted = g.dhcp_active = g.dhcp_busy = false;
    g.dhcp_revision = g.dhcp_processed = 0; g.dhcp_error = 0;
    error = start_workers();
  }
  pthread_mutex_unlock(&g.mutex); return error;
}
int px_portal_stop(void)
{
  pthread_mutex_lock(&g.mutex);
  int error = g.initialized ? 0 : -ENODEV;
  g.request = PX_PORTAL_REQUEST_NONE; g.grant = false; g.stop = true; ++g.stop_revision;
  pthread_cond_broadcast(&g.wake); pthread_mutex_unlock(&g.mutex); return error;
}
int px_portal_get_status(struct px_portal_status *status)
{
  if (!status) return -EINVAL;
  pthread_mutex_lock(&g.mutex); *status = g.status; status->stop_requested = g.stop;
  int error = g.initialized ? 0 : -ENODEV;
  pthread_mutex_unlock(&g.mutex); return error;
}
int px_portal_reap(void)
{
  pthread_mutex_lock(&g.mutex);
  if (!g.initialized) { pthread_mutex_unlock(&g.mutex); return -ENODEV; }
  /* DHCP 阻塞/JSON 收尾未完时仅查看标志，不 join，也不阻塞 service。 */
  if (g.reaping || (g.controller_started && !g.controller_done) ||
      (g.dhcp_started && !g.dhcp_done) || (!g.controller_started && !g.dhcp_started)) {
    pthread_mutex_unlock(&g.mutex); return 0;
  }
  bool controller = g.controller_started, dhcp = g.dhcp_started;
  pthread_t controller_thread = g.controller, dhcp_thread = g.dhcp;
  g.reaping = true;
  pthread_mutex_unlock(&g.mutex);
  /* 两个 worker 已越过所有可能阻塞的应用清理，只剩 pthread 退出收尾。 */
  int controller_error = controller ? pthread_join(controller_thread, NULL) : 0;
  int dhcp_error = dhcp ? pthread_join(dhcp_thread, NULL) : 0;
  pthread_mutex_lock(&g.mutex);
  if (!controller_error) g.controller_started = false;
  if (!dhcp_error) g.dhcp_started = false;
  int error = controller_error ? controller_error : dhcp_error;
  if (error) g.status.error = -error;
  else { g.status.wifi_owned = false; g.status.phase = PX_PORTAL_INACTIVE; }
  g.reaping = false;
  pthread_mutex_unlock(&g.mutex); return -error;
}
int px_portal_shutdown(void)
{
  pthread_mutex_lock(&g.mutex);
  if (!g.initialized) { pthread_mutex_unlock(&g.mutex); return 0; }
  if (g.status.wifi_owned || g.controller_started || g.dhcp_started || g.reaping ||
      g.dhcp_busy || g.dhcp_active) { pthread_mutex_unlock(&g.mutex); return -EBUSY; }
  g.terminate = true; g.initialized = false; g.grant = false; g.request = PX_PORTAL_REQUEST_NONE;
  pthread_cond_broadcast(&g.wake); pthread_mutex_unlock(&g.mutex);
  return 0;
}
