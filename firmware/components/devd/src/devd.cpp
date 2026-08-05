/**
 * devd.cpp — 开发服务: WebSocket :8765/devd + mDNS 广播 + 日志订阅广播
 *
 * 协议 (architecture.md §5):
 *   请求 {id, method, params} → 响应 {id, result} / {id, error:{code,message}}
 *   事件 {event, data}: log / app.state
 *
 * 线程模型:
 *   - 请求处理在 httpd 任务内串行执行;
 *   - js.eval 异步: 结果经 jsvm 回调 → httpd_queue_work → 异步发送;
 *   - 日志/状态广播统一经 httpd_queue_work 调度到 httpd 上下文发送。
 */
#include "devd/devd.h"

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include <unistd.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "mbedtls/base64.h"
#include "mdns.h"
#include "sdkconfig.h"

#include "appmgr/appmgr.h"
#include "hal_common/board.h"
#include "jsvm/jsvm.hpp"

#include "devd_log.hpp"

static const char *TAG = "devd";

namespace {

/* ------------------------------------------------------------
 * 状态
 * ------------------------------------------------------------ */

httpd_handle_t s_server;

std::mutex s_client_mutex;
std::vector<int> s_clients;  /* 所有已握手 ws 客户端 fd */
std::vector<int> s_log_subs; /* 日志订阅 fd */

std::atomic<bool> s_flush_pending{false};
uint32_t s_flushed_seq = 0; /* 仅 httpd 上下文访问 */

/* push 会话 (httpd 任务串行访问) */
struct FileDecl {
    std::string path;
    uint32_t size;
    uint8_t sha[32];
};
struct Session {
    bool active = false;
    char id[20] = {};
    std::vector<FileDecl> files;
};
Session s_session;

/* ------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------ */

void remove_fd(std::vector<int> &v, int fd)
{
    for (auto it = v.begin(); it != v.end(); ++it) {
        if (*it == fd) {
            v.erase(it);
            return;
        }
    }
}

bool hex_decode32(const char *hex, uint8_t out[32])
{
    if (!hex || strlen(hex) != 64) {
        return false;
    }
    for (int i = 0; i < 32; i++) {
        unsigned v = 0;
        if (sscanf(hex + i * 2, "%02x", &v) != 1) {
            return false;
        }
        out[i] = (uint8_t)v;
    }
    return true;
}

void device_hostname(char *out, size_t len)
{
    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, len, "pixelbox-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

/* ------------------------------------------------------------
 * 发送 (同步/异步/广播)
 * ------------------------------------------------------------ */

esp_err_t send_text(httpd_req_t *req, const char *text)
{
    httpd_ws_frame_t f = {};
    f.type = HTTPD_WS_TYPE_TEXT;
    f.payload = (uint8_t *)text;
    f.len = strlen(text);
    f.final = true;
    return httpd_ws_send_frame(req, &f);
}

struct AsyncSend {
    httpd_handle_t hd;
    int fd;           /* -1 = 广播 */
    bool subs_only;   /* 广播时仅发日志订阅者 */
    char *text;
};

void async_send_work(void *arg)
{
    auto *as = (AsyncSend *)arg;
    httpd_ws_frame_t f = {};
    f.type = HTTPD_WS_TYPE_TEXT;
    f.payload = (uint8_t *)as->text;
    f.len = strlen(as->text);
    f.final = true;

    if (as->fd >= 0) {
        httpd_ws_send_frame_async(as->hd, as->fd, &f);
    } else {
        std::vector<int> fds;
        {
            std::lock_guard<std::mutex> lk(s_client_mutex);
            fds = as->subs_only ? s_log_subs : s_clients;
        }
        for (int fd : fds) {
            httpd_ws_send_frame_async(as->hd, fd, &f);
        }
    }
    free(as->text);
    delete as;
}

/** 从任意线程投递一次发送 (fd=-1 广播) */
void queue_send(int fd, bool subs_only, const char *text)
{
    if (!s_server) {
        return;
    }
    auto *as = new AsyncSend{s_server, fd, subs_only, strdup(text)};
    if (!as->text || httpd_queue_work(s_server, async_send_work, as) != ESP_OK) {
        free(as->text);
        delete as;
    }
}

/* ------------------------------------------------------------
 * 日志广播
 * ------------------------------------------------------------ */

void log_flush_work(void *arg)
{
    (void)arg;
    s_flush_pending.store(false);
    std::vector<int> subs;
    {
        std::lock_guard<std::mutex> lk(s_client_mutex);
        subs = s_log_subs;
    }
    std::vector<std::string> lines;
    uint32_t last = devd_log::collect_json(s_flushed_seq, lines);
    s_flushed_seq = last;
    if (subs.empty()) {
        return;
    }
    for (auto &line : lines) {
        httpd_ws_frame_t f = {};
        f.type = HTTPD_WS_TYPE_TEXT;
        f.payload = (uint8_t *)line.c_str();
        f.len = line.size();
        f.final = true;
        for (int fd : subs) {
            httpd_ws_send_frame_async(s_server, fd, &f);
        }
    }
}

/** devd_log 新日志通知 (任意任务, 非阻塞) */
void on_new_log()
{
    if (!s_server) {
        return;
    }
    {
        std::lock_guard<std::mutex> lk(s_client_mutex);
        if (s_log_subs.empty()) {
            return;
        }
    }
    if (!s_flush_pending.exchange(true)) {
        if (httpd_queue_work(s_server, log_flush_work, nullptr) != ESP_OK) {
            s_flush_pending.store(false);
        }
    }
}

/** jsvm console LogSink */
void console_log_sink(int level, const char *tag, const char *msg)
{
    devd_log::push(level, tag, msg);
}

/* ------------------------------------------------------------
 * app.state 事件 + mDNS TXT 更新
 * ------------------------------------------------------------ */

void on_app_state(appmgr_state_t st, const char *error)
{
    if (st == APPMGR_STATE_RUNNING) {
        appmgr_manifest_t mf;
        appmgr_current_manifest(&mf);
        mdns_service_txt_item_set("_pixelbox", "_tcp", "app", mf.id);
    }
    if (!s_server) {
        return;
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "event", "app.state");
    cJSON *data = cJSON_AddObjectToObject(root, "data");
    cJSON_AddStringToObject(data, "state", appmgr_state_name(st));
    if (error) {
        cJSON_AddStringToObject(data, "error", error);
    }
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (out) {
        queue_send(-1, false, out);
        cJSON_free(out);
    }
}

/* ------------------------------------------------------------
 * 响应工具
 * ------------------------------------------------------------ */

/** 发送 {id, result} (result 所有权转移) */
void reply_result(httpd_req_t *req, const cJSON *id, cJSON *result)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddItemToObject(root, "id",
                          id ? cJSON_Duplicate(id, 1) : cJSON_CreateNull());
    cJSON_AddItemToObject(root, "result", result);
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (out) {
        send_text(req, out);
        cJSON_free(out);
    }
}

void reply_error(httpd_req_t *req, const cJSON *id, int code, const char *message)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddItemToObject(root, "id",
                          id ? cJSON_Duplicate(id, 1) : cJSON_CreateNull());
    cJSON *err = cJSON_AddObjectToObject(root, "error");
    cJSON_AddNumberToObject(err, "code", code);
    cJSON_AddStringToObject(err, "message", message);
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (out) {
        send_text(req, out);
        cJSON_free(out);
    }
}

/* ------------------------------------------------------------
 * 各 method 实现
 * ------------------------------------------------------------ */

void handle_hello(httpd_req_t *req, const cJSON *id)
{
    cJSON *r = cJSON_CreateObject();

    char host[32];
    device_hostname(host, sizeof(host));
    cJSON_AddStringToObject(r, "name", host);
    cJSON_AddStringToObject(r, "model", board_model());
    cJSON_AddStringToObject(r, "fw", esp_app_get_description()->version);

    appmgr_manifest_t mf;
    appmgr_current_manifest(&mf);
    cJSON_AddStringToObject(r, "app", mf.id);
    cJSON_AddStringToObject(r, "appVersion", mf.version);

    char ip[16] = "0.0.0.0";
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK) {
            snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
        }
    }
    cJSON_AddStringToObject(r, "ip", ip);

    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char macs[18];
    snprintf(macs, sizeof(macs), "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    cJSON_AddStringToObject(r, "mac", macs);

    cJSON_AddNumberToObject(r, "heapFree", (double)esp_get_free_heap_size());
    reply_result(req, id, r);
}

void handle_push_begin(httpd_req_t *req, const cJSON *id, const cJSON *params)
{
    const cJSON *manifest = params ? cJSON_GetObjectItem(params, "manifest") : nullptr;
    const cJSON *files = params ? cJSON_GetObjectItem(params, "files") : nullptr;
    if (!cJSON_IsObject(manifest) || !cJSON_IsArray(files)) {
        reply_error(req, id, -32602, "参数需要 manifest 对象与 files 数组");
        return;
    }

    char *mjson = cJSON_PrintUnformatted(manifest);
    if (!mjson) {
        reply_error(req, id, 500, "manifest 序列化失败");
        return;
    }
    esp_err_t err = appmgr_staging_begin(mjson);
    cJSON_free(mjson);
    if (err != ESP_OK) {
        reply_error(req, id, 500, "staging 初始化失败");
        return;
    }

    s_session.files.clear();
    const cJSON *it = nullptr;
    cJSON_ArrayForEach(it, files)
    {
        const cJSON *path = cJSON_GetObjectItem(it, "path");
        const cJSON *size = cJSON_GetObjectItem(it, "size");
        const cJSON *sha = cJSON_GetObjectItem(it, "sha256");
        FileDecl fdl;
        if (!cJSON_IsString(path) || !cJSON_IsNumber(size) || !cJSON_IsString(sha) ||
            !hex_decode32(sha->valuestring, fdl.sha)) {
            appmgr_staging_abort();
            reply_error(req, id, -32602, "files 条目非法 (需要 path/size/sha256)");
            return;
        }
        fdl.path = path->valuestring;
        fdl.size = (uint32_t)size->valuedouble;
        s_session.files.push_back(std::move(fdl));
    }

    snprintf(s_session.id, sizeof(s_session.id), "%08lx%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random());
    s_session.active = true;

    ESP_LOGI(TAG, "push 开始: %d 个文件, session=%s",
             (int)s_session.files.size(), s_session.id);

    cJSON *r = cJSON_CreateObject();
    cJSON_AddStringToObject(r, "session", s_session.id);
    reply_result(req, id, r);
}

bool check_session(httpd_req_t *req, const cJSON *id, const cJSON *params)
{
    const cJSON *session = params ? cJSON_GetObjectItem(params, "session") : nullptr;
    if (!s_session.active || !cJSON_IsString(session) ||
        strcmp(session->valuestring, s_session.id) != 0) {
        reply_error(req, id, 400, "session 无效或已过期");
        return false;
    }
    return true;
}

void handle_push_chunk(httpd_req_t *req, const cJSON *id, const cJSON *params)
{
    if (!check_session(req, id, params)) {
        return;
    }
    const cJSON *path = cJSON_GetObjectItem(params, "path");
    const cJSON *offset = cJSON_GetObjectItem(params, "offset");
    const cJSON *data_b64 = cJSON_GetObjectItem(params, "dataB64");
    if (!cJSON_IsString(path) || !cJSON_IsNumber(offset) || !cJSON_IsString(data_b64)) {
        reply_error(req, id, -32602, "参数需要 path/offset/dataB64");
        return;
    }

    size_t b64_len = strlen(data_b64->valuestring);
    size_t cap = b64_len / 4 * 3 + 8;
    uint8_t *buf = (uint8_t *)heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) {
        buf = (uint8_t *)malloc(cap);
    }
    if (!buf) {
        reply_error(req, id, 500, "内存不足");
        return;
    }
    size_t olen = 0;
    int rc = mbedtls_base64_decode(buf, cap, &olen,
                                   (const unsigned char *)data_b64->valuestring, b64_len);
    if (rc != 0) {
        free(buf);
        reply_error(req, id, -32602, "base64 解码失败");
        return;
    }

    esp_err_t err = appmgr_staging_write(path->valuestring,
                                         (uint32_t)offset->valuedouble, buf, olen);
    free(buf);
    if (err != ESP_OK) {
        reply_error(req, id, 500, "写入失败");
        return;
    }
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "received", (double)olen);
    reply_result(req, id, r);
}

void handle_push_end(httpd_req_t *req, const cJSON *id, const cJSON *params)
{
    if (!check_session(req, id, params)) {
        return;
    }
    for (const auto &f : s_session.files) {
        if (appmgr_staging_verify_file(f.path.c_str(), f.size, f.sha) != ESP_OK) {
            appmgr_staging_abort();
            s_session.active = false;
            std::string msg = "文件校验失败: " + f.path;
            reply_error(req, id, 500, msg.c_str());
            return;
        }
    }
    s_session.active = false;

    /* 先回响应再切换 (VM 重启是异步的, 客户端会收到 app.state 事件流) */
    cJSON *r = cJSON_CreateObject();
    cJSON_AddBoolToObject(r, "ok", true);
    reply_result(req, id, r);

    if (appmgr_staging_commit() != ESP_OK) {
        ESP_LOGE(TAG, "热更新提交失败");
    }
}

void handle_js_eval(httpd_req_t *req, const cJSON *id, const cJSON *params)
{
    const cJSON *code = params ? cJSON_GetObjectItem(params, "code") : nullptr;
    if (!cJSON_IsString(code)) {
        reply_error(req, id, -32602, "参数需要 code 字符串");
        return;
    }

    struct EvalCtx {
        int fd;
        std::string id_json;
    };
    auto *ectx = new EvalCtx;
    ectx->fd = httpd_req_to_sockfd(req);
    if (id) {
        char *ids = cJSON_PrintUnformatted(id);
        ectx->id_json = ids ? ids : "null";
        if (ids) {
            cJSON_free(ids);
        }
    } else {
        ectx->id_json = "null";
    }

    jsvm::eval(code->valuestring, [ectx](bool ok, std::string result) {
        /* JS 线程: 组装响应并投递到 httpd 上下文异步发送 */
        cJSON *root = cJSON_CreateObject();
        cJSON *idv = cJSON_Parse(ectx->id_json.c_str());
        cJSON_AddItemToObject(root, "id", idv ? idv : cJSON_CreateNull());
        if (ok) {
            cJSON *r = cJSON_CreateObject();
            cJSON_AddStringToObject(r, "result", result.c_str());
            cJSON_AddItemToObject(root, "result", r);
        } else {
            cJSON *e = cJSON_AddObjectToObject(root, "error");
            cJSON_AddNumberToObject(e, "code", 500);
            cJSON_AddStringToObject(e, "message", result.c_str());
        }
        char *out = cJSON_PrintUnformatted(root);
        cJSON_Delete(root);
        if (out) {
            queue_send(ectx->fd, false, out);
            cJSON_free(out);
        }
        delete ectx;
    });
    /* 响应异步返回, 此处不回包 */
}

void handle_logs_subscribe(httpd_req_t *req, const cJSON *id, bool subscribe)
{
    int fd = httpd_req_to_sockfd(req);
    {
        std::lock_guard<std::mutex> lk(s_client_mutex);
        remove_fd(s_log_subs, fd);
        if (subscribe) {
            s_log_subs.push_back(fd);
        }
    }
    cJSON *r = cJSON_CreateObject();
    cJSON_AddBoolToObject(r, "ok", true);
    reply_result(req, id, r);

    if (subscribe) {
        /* 回放环形缓冲中的历史日志 */
        std::vector<std::string> lines;
        uint32_t last = devd_log::collect_json(0, lines);
        for (auto &line : lines) {
            send_text(req, line.c_str());
        }
        if (last > s_flushed_seq) {
            s_flushed_seq = last;
        }
    }
}

/* ------------------------------------------------------------
 * 消息分发
 * ------------------------------------------------------------ */

void handle_message(httpd_req_t *req, char *text)
{
    cJSON *root = cJSON_Parse(text);
    if (!root) {
        reply_error(req, nullptr, -32700, "JSON 解析失败");
        return;
    }
    const cJSON *id = cJSON_GetObjectItem(root, "id");
    const cJSON *method = cJSON_GetObjectItem(root, "method");
    const cJSON *params = cJSON_GetObjectItem(root, "params");

    if (!cJSON_IsString(method)) {
        reply_error(req, id, -32600, "缺少 method 字段");
        cJSON_Delete(root);
        return;
    }
    const char *m = method->valuestring;

    if (strcmp(m, "hello") == 0) {
        handle_hello(req, id);
    } else if (strcmp(m, "app.push_begin") == 0) {
        handle_push_begin(req, id, params);
    } else if (strcmp(m, "app.push_chunk") == 0) {
        handle_push_chunk(req, id, params);
    } else if (strcmp(m, "app.push_end") == 0) {
        handle_push_end(req, id, params);
    } else if (strcmp(m, "app.restart") == 0) {
        appmgr_restart_app();
        cJSON *r = cJSON_CreateObject();
        cJSON_AddBoolToObject(r, "ok", true);
        reply_result(req, id, r);
    } else if (strcmp(m, "app.stop") == 0) {
        appmgr_stop_app();
        cJSON *r = cJSON_CreateObject();
        cJSON_AddBoolToObject(r, "ok", true);
        reply_result(req, id, r);
    } else if (strcmp(m, "js.eval") == 0) {
        handle_js_eval(req, id, params);
    } else if (strcmp(m, "logs.subscribe") == 0) {
        handle_logs_subscribe(req, id, true);
    } else if (strcmp(m, "logs.unsubscribe") == 0) {
        handle_logs_subscribe(req, id, false);
    } else {
        reply_error(req, id, -32601, "未知 method");
    }
    cJSON_Delete(root);
}

/* ------------------------------------------------------------
 * WebSocket handler / 连接管理
 * ------------------------------------------------------------ */

esp_err_t ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        /* 握手完成 */
        int fd = httpd_req_to_sockfd(req);
        {
            std::lock_guard<std::mutex> lk(s_client_mutex);
            remove_fd(s_clients, fd);
            s_clients.push_back(fd);
        }
        ESP_LOGI(TAG, "客户端接入 (fd=%d)", fd);
        return ESP_OK;
    }

    httpd_ws_frame_t frame = {};
    frame.type = HTTPD_WS_TYPE_TEXT;
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        return err;
    }
    if (frame.len == 0) {
        return ESP_OK;
    }
    size_t max_frame = (size_t)CONFIG_DEVD_MAX_FRAME_KB * 1024;
    if (frame.len > max_frame) {
        ESP_LOGE(TAG, "帧过大: %u B", (unsigned)frame.len);
        return ESP_ERR_INVALID_SIZE;
    }

    uint8_t *buf = (uint8_t *)heap_caps_malloc(frame.len + 1,
                                               MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) {
        buf = (uint8_t *)malloc(frame.len + 1);
    }
    if (!buf) {
        return ESP_ERR_NO_MEM;
    }
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err == ESP_OK && frame.type == HTTPD_WS_TYPE_TEXT) {
        buf[frame.len] = '\0';
        handle_message(req, (char *)buf);
    }
    free(buf);
    return ESP_OK;
}

void on_close(httpd_handle_t hd, int sockfd)
{
    (void)hd;
    {
        std::lock_guard<std::mutex> lk(s_client_mutex);
        remove_fd(s_clients, sockfd);
        remove_fd(s_log_subs, sockfd);
    }
    ESP_LOGI(TAG, "客户端断开 (fd=%d)", sockfd);
    close(sockfd);
}

/* ------------------------------------------------------------
 * mDNS
 * ------------------------------------------------------------ */

void mdns_setup()
{
    esp_err_t err = mdns_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        /* 已被其他组件初始化时忽略 (ESP_ERR_INVALID_STATE) */
        ESP_LOGW(TAG, "mdns_init 失败: %s", esp_err_to_name(err));
        return;
    }

    char host[32];
    device_hostname(host, sizeof(host));
    mdns_hostname_set(host);
    mdns_instance_name_set("PixelBox 像素盒");

    appmgr_manifest_t mf;
    appmgr_current_manifest(&mf);

    mdns_txt_item_t txt[] = {
        {"model", board_model()},
        {"fw", esp_app_get_description()->version},
        {"app", mf.id},
    };
    err = mdns_service_add(host, "_pixelbox", "_tcp", CONFIG_DEVD_PORT, txt, 3);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mDNS 服务注册失败: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "mDNS: %s._pixelbox._tcp:%d (host=%s.local)",
                 host, CONFIG_DEVD_PORT, host);
    }
}

} // namespace

/* ------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------ */

extern "C" esp_err_t devd_start(void)
{
    if (s_server) {
        return ESP_OK;
    }

    /* 日志管道 */
    devd_log::init();
    devd_log::set_notify(on_new_log);
    devd_log::install_vprintf_hook();
    jsvm::add_log_sink(console_log_sink);

    /* 应用状态事件 */
    appmgr_on_state(on_app_state);

    /* HTTP 服务器 + WS 端点 */
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = CONFIG_DEVD_PORT;
    config.stack_size = CONFIG_DEVD_HTTPD_STACK;
    config.lru_purge_enable = true;
    config.close_fn = on_close;

    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP 服务器启动失败: %s", esp_err_to_name(err));
        s_server = nullptr;
        return err;
    }

    static const httpd_uri_t ws_uri = {
        .uri = "/devd",
        .method = HTTP_GET,
        .handler = ws_handler,
        .user_ctx = nullptr,
        .is_websocket = true,
        .handle_ws_control_frames = false,
        .supported_subprotocol = nullptr,
    };
    httpd_register_uri_handler(s_server, &ws_uri);

    mdns_setup();

    ESP_LOGI(TAG, "devd 已启动: ws://<ip>:%d/devd", CONFIG_DEVD_PORT);
    return ESP_OK;
}
