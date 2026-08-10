/**
 * wifi_portal.cpp — 网页配网实现 (SoftAP + httpd 表单页 + 原生屏幕显示)
 *
 * 线程分工:
 *   - px_portal 任务: 全部重活 (停应用 / 开 AP / 起 httpd / 每 300ms 投递重绘 /
 *     收尾)。调用方 (按键回调) 只置标志, 不受其栈大小限制;
 *   - httpd 工作任务: 表单处理。scan 用信号量等 esp_event 回调结果;
 *   - esp_event 任务: WiFi 事件监听。只改状态 + 置标志, 绝不阻塞或调重活;
 *   - js_task: 唯一有权动帧缓冲/QSPI 的线程, 绘制经 jsvm::post 投递过去。
 */
#include "wifi_portal/wifi_portal.hpp"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "appmgr/appmgr.h"
#include "hal_display/fonts.h"
#include "hal_display/gfx.hpp"
#include "hal_display/hal_display.hpp"
#include "hal_net/wifi_manager.hpp"
#include "jsvm/jsvm.hpp"

/* 手机端表单页 (CMakeLists 的 EMBED_TXTFILES; 尾部已带 NUL) */
extern const char _binary_portal_html_start[];

namespace wifi_portal {

namespace {

constexpr const char* TAG = "px.portal";
constexpr const char* AP_IP = "192.168.4.1";
constexpr const char* PORTAL_URL = "http://192.168.4.1/";

/* 配色对齐 settings_app.js 的调色板 C */
constexpr uint32_t C_BG = 0x0b0e14;
constexpr uint32_t C_BORDER = 0x33445c;
constexpr uint32_t C_ACCENT = 0x3d9bff;
constexpr uint32_t C_TEXT = 0xe8eef6;
constexpr uint32_t C_DIM = 0x9db2c8;
constexpr uint32_t C_DIMMER = 0x7089a4;
constexpr uint32_t C_GREEN = 0x39c26d;
constexpr uint32_t C_RED = 0xff5a5a;

/* 配网成功后停留多久再自动回应用 */
constexpr int64_t SUCCESS_HOLD_US = 3000000;
/* /scan 等待 SCAN_DONE 的上限 (APSTA 下全信道扫描约 2-4s) */
constexpr uint32_t SCAN_WAIT_MS = 9000;
constexpr size_t SCAN_MAX_APS = 24;

enum class Phase { Waiting, Connecting, Success, Failed };

struct PortalState {
    std::string ap_ssid;
    std::string ap_pass;
    Phase phase = Phase::Waiting;
    std::string try_ssid;  ///< 正在尝试/已连上的目标网络
    std::string sta_ip;
    std::string message;  ///< 失败原因文案
};

std::mutex s_mtx;
PortalState s_st;

std::atomic<bool> s_active{false};
std::atomic<bool> s_stop_req{false};
std::atomic<bool> s_restart_on_stop{true};
/** 曾发起过 connect(): 决定退出时是否需要 reconnect_saved() 复原 */
std::atomic<bool> s_attempted{false};
/** 连接失败: 请 px_portal 任务去 disconnect() 止住退避重试 (不在事件上下文做) */
std::atomic<bool> s_need_stop_retry{false};

httpd_handle_t s_httpd = nullptr;
int s_listener_id = -1;
int64_t s_success_at_us = 0;

/* 扫描同步: 静态存储 + 二值信号量。忙标志由回调清 (而非超时路径清),
 * 这样迟到的回调写的仍是这块永不释放的静态存储, 不存在 use-after-free。 */
SemaphoreHandle_t s_scan_sem = nullptr;
std::atomic<bool> s_scan_busy{false};
std::vector<hal_net::WifiApInfo> s_scan_aps;
esp_err_t s_scan_err = ESP_OK;

/* esp_netif 的 CAPTIVEPORTAL_URI 只存指针不拷贝内容, 必须用静态缓冲 */
char s_cp_uri[48];

// ------------------------------------------------------------- 文本工具

int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::string url_decode(const char* s, size_t n)
{
    std::string out;
    out.reserve(n);
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '+') {
            out.push_back(' ');
        } else if (s[i] == '%' && i + 2 < n) {
            const int h = hexval(s[i + 1]), l = hexval(s[i + 2]);
            if (h >= 0 && l >= 0) {
                out.push_back(static_cast<char>(h * 16 + l));
                i += 2;
            } else {
                out.push_back(s[i]);
            }
        } else {
            out.push_back(s[i]);
        }
    }
    return out;
}

/** 取 application/x-www-form-urlencoded 字段值; 字段缺失返回空串 */
std::string form_field(const std::string& body, const char* key)
{
    const size_t klen = std::strlen(key);
    size_t pos = 0;
    while (pos <= body.size()) {
        const size_t amp = body.find('&', pos);
        const size_t end = (amp == std::string::npos) ? body.size() : amp;
        const size_t eq = body.find('=', pos);
        if (eq != std::string::npos && eq < end && eq - pos == klen &&
            body.compare(pos, klen, key) == 0) {
            return url_decode(body.data() + eq + 1, end - eq - 1);
        }
        if (amp == std::string::npos) break;
        pos = amp + 1;
    }
    return std::string();
}

/** 按像素宽度截断 UTF-8 文本 (超出补 ".."), 防用户 SSID 撑破屏幕 */
std::string fit_text(const std::string& in, const gfx::TextStyle& style, int max_w)
{
    int w = 0, h = 0;
    gfx::measure_text(in.c_str(), style, &w, &h);
    if (w <= max_w) return in;

    /* 码点边界表 */
    std::vector<size_t> bounds;
    const char* p = in.c_str();
    while (*p) {
        gfx::utf8_next(&p);
        bounds.push_back(static_cast<size_t>(p - in.c_str()));
    }
    for (size_t i = bounds.size(); i-- > 0;) {
        std::string cand = in.substr(0, bounds[i]) + "..";
        gfx::measure_text(cand.c_str(), style, &w, &h);
        if (w <= max_w) return cand;
    }
    return std::string("..");
}

/** wifi_err_reason_t → 用户能看懂的中文 */
const char* reason_text(int reason)
{
    switch (reason) {
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            return "密码错误";
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return "找不到该网络";
        case WIFI_REASON_ASSOC_FAIL:
        case WIFI_REASON_NOT_AUTHED:
            return "被路由器拒绝";
        case WIFI_REASON_CONNECTION_FAIL:
            return "连接失败, 请重试";
        default:
            return "连接失败";
    }
}

// ------------------------------------------------------------- 屏幕绘制

/** 在 js_task 上执行 (帧缓冲与 QSPI IO 归它所有) */
void draw_screen()
{
    if (!hal_display::ready()) return; /* headless 板型 */

    PortalState st;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        st = s_st;
    }

    int clients = 0;
    wifi_sta_list_t sl = {};
    if (esp_wifi_ap_get_sta_list(&sl) == ESP_OK) clients = sl.num;

    const pxfont_t* f16 = pxfonts_get(PXFONT_PIXEL16);
    const pxfont_t* f12 = pxfonts_get(PXFONT_PIXEL12);
    if (!f16 || !f12) return;

    gfx::Surface& fb = hal_display::framebuffer();
    const int W = hal_display::width();
    const int H = hal_display::height();
    const int s = ((W < H ? W : H) >= 442) ? 2 : 1; /* 与 settings_app.js textScale 同档 */
    const int gap = 4 * s;
    const int max_w = W - W / 6;

    gfx::clear(fb, gfx::to565(C_BG));

    /* 大字 (SSID / 密码 / 地址): 比正文大一号, 举远也读得清 */
    gfx::TextStyle big{};
    big.font = f16;
    big.scale = s + 1;
    big.align = gfx::Align::Center;
    big.c565 = gfx::to565(C_TEXT);

    gfx::TextStyle hint{};
    hint.font = f12;
    hint.scale = s;
    hint.align = gfx::Align::Center;
    hint.c565 = gfx::to565(C_DIM);

    const int big_h = f16->height * big.scale;
    const int mid_h = f16->height * s;
    const int hint_h = f12->height * hint.scale;
    const int cx = W / 2;

    /* ---- 底部锚定: 状态区与页脚不随上方内容长度漂移 ---- */
    const int footer_y = H - hint_h - H / 28;
    const int detail_y = footer_y - hint_h - gap * 2;
    const int status_y = detail_y - mid_h - gap;
    const int divider_y = status_y - gap * 3;

    /* ---- 顶部向下排布 ---- */
    int y = H / 22;

    {
        gfx::TextStyle title = big;
        title.c565 = gfx::to565(0xffffff);
        gfx::draw_text(fb, "网页配网", cx, y, title);
        y += big_h + gap * 2;
    }

    gfx::draw_text(fb, "1. 手机连接这个热点", cx, y, hint);
    y += hint_h + gap;
    {
        gfx::TextStyle v = big;
        v.c565 = gfx::to565(C_ACCENT);
        gfx::draw_text(fb, fit_text(st.ap_ssid, v, max_w).c_str(), cx, y, v);
        y += big_h + gap / 2;
    }
    {
        std::string line = "密码 " + st.ap_pass;
        gfx::draw_text(fb, line.c_str(), cx, y, big);
        y += big_h + gap * 2;
    }

    gfx::draw_text(fb, "2. 浏览器打开", cx, y, hint);
    y += hint_h + gap;
    {
        gfx::TextStyle v = big;
        v.c565 = gfx::to565(C_GREEN);
        gfx::draw_text(fb, AP_IP, cx, y, v);
        y += big_h;
    }

    /* ---- 分隔线 + 状态 ---- */
    const int dy = divider_y > y + gap ? divider_y : y + gap;
    gfx::fill_rect(fb, W / 8, dy, W - W / 4, 1, gfx::to565(C_BORDER));

    const char* head = "";
    uint32_t head_col = C_DIM;
    std::string detail;
    switch (st.phase) {
        case Phase::Waiting:
            if (clients > 0) {
                head = "手机已连接";
                head_col = C_ACCENT;
                detail = "在浏览器打开上面的地址";
            } else {
                head = "等待手机连接热点";
                head_col = C_DIM;
            }
            break;
        case Phase::Connecting:
            head = "正在连接";
            head_col = C_ACCENT;
            detail = st.try_ssid;
            break;
        case Phase::Success:
            head = "配网成功";
            head_col = C_GREEN;
            detail = st.sta_ip;
            break;
        case Phase::Failed:
            head = "配网失败";
            head_col = C_RED;
            detail = st.message;
            break;
    }
    {
        gfx::TextStyle hs{};
        hs.font = f16;
        hs.scale = s;
        hs.align = gfx::Align::Center;
        hs.c565 = gfx::to565(head_col);
        gfx::draw_text(fb, head, cx, status_y, hs);
    }
    if (!detail.empty()) {
        gfx::TextStyle ds = hint;
        ds.c565 = gfx::to565(C_TEXT);
        gfx::draw_text(fb, fit_text(detail, ds, W - W / 10).c_str(), cx, detail_y, ds);
    }
    {
        gfx::TextStyle fs = hint;
        fs.c565 = gfx::to565(C_DIMMER);
        gfx::draw_text(fb, st.phase == Phase::Success ? "即将返回应用" : "键2 退出配网", cx,
                       footer_y, fs);
    }

    hal_display::mark_dirty(0, 0, W, H);
    hal_display::flush();
}

void request_redraw()
{
    jsvm::post(draw_screen);
}

// ------------------------------------------------------------- HTTP 处理

esp_err_t send_json(httpd_req_t* req, cJSON* root, const char* status = nullptr)
{
    char* body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!body) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"ok\":false}");
    }
    if (status) httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    /* 配网页状态变化频繁, 禁掉缓存免得 captive portal 内嵌浏览器拿旧值 */
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_sendstr(req, body);
    cJSON_free(body);
    return err;
}

esp_err_t send_json_err(httpd_req_t* req, const char* status, const char* message)
{
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", false);
    cJSON_AddStringToObject(root, "message", message);
    return send_json(req, root, status);
}

esp_err_t index_handler(httpd_req_t* req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req, _binary_portal_html_start);
}

/** captive portal 探测 (/hotspot-detect.html、/generate_204、/ncsi.txt …) 一律引到表单页 */
esp_err_t not_found_handler(httpd_req_t* req, httpd_err_code_t)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", PORTAL_URL);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_send(req, nullptr, 0);
    return ESP_OK; /* 返回 ESP_OK 才保持连接不被关掉 */
}

esp_err_t status_handler(httpd_req_t* req)
{
    PortalState st;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        st = s_st;
    }
    const char* phase = "waiting";
    switch (st.phase) {
        case Phase::Connecting: phase = "connecting"; break;
        case Phase::Success: phase = "success"; break;
        case Phase::Failed: phase = "failed"; break;
        case Phase::Waiting: break;
    }
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "phase", phase);
    cJSON_AddStringToObject(root, "ssid", st.try_ssid.c_str());
    cJSON_AddStringToObject(root, "ip", st.sta_ip.c_str());
    cJSON_AddStringToObject(root, "message", st.message.c_str());
    return send_json(req, root);
}

esp_err_t connect_handler(httpd_req_t* req)
{
    if (req->content_len <= 0 || req->content_len > 512) {
        return send_json_err(req, "400 Bad Request", "表单内容不合法");
    }
    char buf[513];
    int got = 0;
    while (got < static_cast<int>(req->content_len)) {
        const int r = httpd_req_recv(req, buf + got, req->content_len - got);
        if (r <= 0) {
            if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
            return ESP_FAIL;
        }
        got += r;
    }
    buf[got] = '\0';

    const std::string body(buf, got);
    const std::string ssid = form_field(body, "ssid");
    const std::string pass = form_field(body, "pass");

    if (ssid.empty()) return send_json_err(req, "400 Bad Request", "网络名称不能为空");
    if (ssid.size() > 32) return send_json_err(req, "400 Bad Request", "网络名称过长");
    if (pass.size() > 64) return send_json_err(req, "400 Bad Request", "密码过长");
    if (!pass.empty() && pass.size() < 8) {
        return send_json_err(req, "400 Bad Request", "WPA 密码至少 8 位");
    }

    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_st.phase = Phase::Connecting;
        s_st.try_ssid = ssid;
        s_st.sta_ip.clear();
        s_st.message.clear();
    }
    s_attempted.store(true);
    request_redraw(); /* 屏幕立刻转"正在连接", 不等 300ms 轮询 */

    ESP_LOGI(TAG, "配网提交: %s (密码 %d 位)", ssid.c_str(), static_cast<int>(pass.size()));
    /* save=true 的既有语义正合所需: 凭据拿到 IP 后才写 NVS,
     * 填错密码不会覆盖原本可用的凭据 (wifi_manager.hpp) */
    const esp_err_t err = hal_net::WifiManager::instance().connect(ssid, pass, /*save=*/true);
    if (err != ESP_OK) {
        {
            std::lock_guard<std::mutex> lk(s_mtx);
            s_st.phase = Phase::Failed;
            s_st.message = "发起连接失败";
        }
        request_redraw();
        return send_json_err(req, "500 Internal Server Error", "发起连接失败");
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    return send_json(req, root);
}

esp_err_t scan_handler(httpd_req_t* req)
{
    if (s_scan_busy.exchange(true)) {
        return send_json_err(req, "429 Too Many Requests", "上一次扫描还没结束");
    }
    /* 清掉上一轮迟到回调可能留下的 give */
    xSemaphoreTake(s_scan_sem, 0);
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_scan_aps.clear();
        s_scan_err = ESP_OK;
    }

    esp_err_t err = hal_net::WifiManager::instance().scan(
        [](esp_err_t e, std::vector<hal_net::WifiApInfo> aps) {
            {
                std::lock_guard<std::mutex> lk(s_mtx);
                s_scan_err = e;
                s_scan_aps = std::move(aps);
            }
            s_scan_busy.store(false); /* 先落结果再放忙标志 */
            xSemaphoreGive(s_scan_sem);
        });
    if (err != ESP_OK) {
        s_scan_busy.store(false);
        return send_json_err(req, "503 Service Unavailable",
                             err == ESP_ERR_INVALID_STATE ? "WiFi 忙, 请稍后再试" : "扫描启动失败");
    }
    if (xSemaphoreTake(s_scan_sem, pdMS_TO_TICKS(SCAN_WAIT_MS)) != pdTRUE) {
        /* 不清忙标志: 交给迟到的回调清, 免得两次扫描的回调交叉 */
        return send_json_err(req, "504 Gateway Timeout", "扫描超时, 请重试");
    }

    std::vector<hal_net::WifiApInfo> aps;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        err = s_scan_err;
        aps = s_scan_aps;
    }
    if (err != ESP_OK) return send_json_err(req, "503 Service Unavailable", "扫描被中断, 请重试");

    /* 同名去重保留最强信号 (双频/中继会重复上报), 隐藏 SSID 跳过 */
    std::vector<hal_net::WifiApInfo> uniq;
    for (const auto& a : aps) {
        if (a.ssid.empty()) continue;
        auto it = std::find_if(uniq.begin(), uniq.end(),
                               [&](const hal_net::WifiApInfo& u) { return u.ssid == a.ssid; });
        if (it == uniq.end()) {
            uniq.push_back(a);
        } else if (a.rssi > it->rssi) {
            *it = a;
        }
    }
    std::sort(uniq.begin(), uniq.end(),
              [](const hal_net::WifiApInfo& a, const hal_net::WifiApInfo& b) {
                  return a.rssi > b.rssi;
              });
    if (uniq.size() > SCAN_MAX_APS) uniq.resize(SCAN_MAX_APS);

    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON* arr = cJSON_AddArrayToObject(root, "aps");
    for (const auto& a : uniq) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", a.ssid.c_str());
        cJSON_AddNumberToObject(o, "rssi", a.rssi);
        cJSON_AddBoolToObject(o, "secure", a.secure);
        cJSON_AddItemToArray(arr, o);
    }
    ESP_LOGI(TAG, "扫描完成: %d 个网络", static_cast<int>(uniq.size()));
    return send_json(req, root);
}

esp_err_t start_httpd()
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 80; /* devd 占 8765, 不冲突 */
    /* 必须避开 devd 那个 httpd 实例的默认 ctrl_port (ESP_HTTPD_DEF_CTRL_PORT),
     * 两个实例共用同一 UDP 控制端口会导致后启动的绑定失败 */
    cfg.ctrl_port = 32801;
    cfg.max_open_sockets = 4;
    cfg.lru_purge_enable = true;
    cfg.stack_size = 5120; /* scan/JSON 组装 + TLS 无关, 5K 够用 */
    cfg.max_uri_handlers = 6;

    esp_err_t err = httpd_start(&s_httpd, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd 启动失败: %s", esp_err_to_name(err));
        s_httpd = nullptr;
        return err;
    }

    static const httpd_uri_t u_index = {"/", HTTP_GET, index_handler, nullptr, false, false,
                                        nullptr};
    static const httpd_uri_t u_status = {"/status",   HTTP_GET, status_handler,
                                         nullptr,     false,    false,
                                         nullptr};
    static const httpd_uri_t u_scan = {"/scan", HTTP_GET, scan_handler, nullptr, false, false,
                                       nullptr};
    static const httpd_uri_t u_connect = {"/connect",  HTTP_POST, connect_handler,
                                          nullptr,     false,     false,
                                          nullptr};
    httpd_register_uri_handler(s_httpd, &u_index);
    httpd_register_uri_handler(s_httpd, &u_status);
    httpd_register_uri_handler(s_httpd, &u_scan);
    httpd_register_uri_handler(s_httpd, &u_connect);
    httpd_register_err_handler(s_httpd, HTTPD_404_NOT_FOUND, not_found_handler);
    return ESP_OK;
}

// ------------------------------------------------------------- WiFi 事件

/** 在 esp_event 任务上下文执行: 只改状态 + 置标志, 不做阻塞调用 */
void on_wifi_event(hal_net::WifiEvent ev, const hal_net::WifiStatus& st, int reason)
{
    bool changed = false;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        if (s_st.phase != Phase::Connecting) return; /* 只关心本次配网尝试 */
        if (ev == hal_net::WifiEvent::GotIp) {
            s_st.phase = Phase::Success;
            s_st.sta_ip = st.ip;
            s_st.message.clear();
            s_success_at_us = esp_timer_get_time();
            changed = true;
        } else if (ev == hal_net::WifiEvent::Disconnected) {
            s_st.phase = Phase::Failed;
            s_st.message = reason_text(reason);
            /* 止住指数退避重试, 让 AP 留在信道 1 便于用户重填。
             * disconnect() 会拿 WifiManager 的锁, 不在事件上下文里调。 */
            s_need_stop_retry.store(true);
            changed = true;
        }
    }
    if (changed) request_redraw();
}

// ------------------------------------------------------------- 生命周期

void cleanup()
{
    if (s_httpd) {
        httpd_stop(s_httpd);
        s_httpd = nullptr;
    }
    auto& wm = hal_net::WifiManager::instance();
    if (s_listener_id >= 0) {
        wm.remove_listener(s_listener_id);
        s_listener_id = -1;
    }
    wm.stop_ap();

    bool ok;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        ok = (s_st.phase == Phase::Success);
    }
    /* 配网失败退出: 把设备放回进配网前的状态 (connect 失败已清 want_connected_) */
    if (!ok && s_attempted.load()) {
        ESP_LOGI(TAG, "配网未成功, 恢复原有凭据连接");
        wm.reconnect_saved();
    }
    ESP_LOGI(TAG, "退出网页配网");
}

void portal_task(void*)
{
    ESP_LOGI(TAG, "进入网页配网");
    /* 先停应用: 之后 AP/httpd 建立的几十毫秒正好等 VM 落地, 屏幕不会被应用帧盖掉 */
    appmgr_stop_app();

    /* SSID 取 SoftAP MAC 后两字节 (eFuse 读取, 不需 esp_wifi 已 init);
     * 密码每次重新随机, 不做 MAC 派生以免长期可推算 */
    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[33];
    char pass[9];
    snprintf(ssid, sizeof(ssid), "PixelBox-%02X%02X", mac[4], mac[5]);
    snprintf(pass, sizeof(pass), "%08u", static_cast<unsigned>(esp_random() % 100000000u));
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_st.ap_ssid = ssid;
        s_st.ap_pass = pass;
    }

    auto& wm = hal_net::WifiManager::instance();
    /* 不动 STA: 误触进配网时不掐断已有连接 */
    esp_err_t err = wm.start_ap(ssid, pass);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SoftAP 启动失败: %s", esp_err_to_name(err));
        appmgr_restart_app();
        s_active.store(false);
        vTaskDelete(nullptr);
        return;
    }
    ESP_LOGI(TAG, "热点已开: %s / %s → %s", ssid, pass, PORTAL_URL);

    /* captive portal: 手机连上后自动弹"登录网络"。DHCP server 已随 AP netif
     * 起来, 此时设选项可能被拒 —— 失败只降级为"手动开浏览器", 不算错误。 */
    if (esp_netif_t* ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF")) {
        std::snprintf(s_cp_uri, sizeof(s_cp_uri), "%s", PORTAL_URL);
        const esp_err_t cp = esp_netif_dhcps_option(
            ap, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI, s_cp_uri, std::strlen(s_cp_uri));
        if (cp != ESP_OK) {
            ESP_LOGW(TAG, "captive portal URI 未生效 (%s), 需手动打开 %s",
                     esp_err_to_name(cp), PORTAL_URL);
        }
    }

    if (start_httpd() != ESP_OK) {
        wm.stop_ap();
        appmgr_restart_app();
        s_active.store(false);
        vTaskDelete(nullptr);
        return;
    }

    s_listener_id = wm.add_listener(on_wifi_event);

    hal_display::set_power(true); /* 可能是息屏状态进来的 */

    while (!s_stop_req.load()) {
        if (s_need_stop_retry.exchange(false)) {
            wm.disconnect(); /* 事件上下文托付过来的活 */
        }
        request_redraw();

        /* 配网成功后停留 3s 让用户看到 IP, 再自动回应用 */
        if (s_success_at_us != 0 && esp_timer_get_time() - s_success_at_us >= SUCCESS_HOLD_US) {
            s_restart_on_stop.store(true);
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    cleanup();
    const bool restart = s_restart_on_stop.load();
    s_active.store(false); /* 先落状态: 重启应用后按键语义应立刻恢复 */
    if (restart) appmgr_restart_app();
    vTaskDelete(nullptr);
}

}  // namespace

// ------------------------------------------------------------- 公开接口

esp_err_t start()
{
    if (s_active.exchange(true)) return ESP_OK; /* 幂等 */

    s_stop_req.store(false);
    s_restart_on_stop.store(true);
    s_attempted.store(false);
    s_need_stop_retry.store(false);
    s_success_at_us = 0;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_st = PortalState();
    }
    if (!s_scan_sem) s_scan_sem = xSemaphoreCreateBinary();
    if (!s_scan_sem) {
        s_active.store(false);
        return ESP_ERR_NO_MEM;
    }

    if (xTaskCreate(portal_task, "px_portal", 4608, nullptr, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "px_portal 任务创建失败");
        s_active.store(false);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void stop(bool restart_app)
{
    if (!s_active.load()) return;
    s_restart_on_stop.store(restart_app);
    s_stop_req.store(true); /* px_portal 任务在 300ms 内收尾 */
}

bool active()
{
    return s_active.load();
}

}  // namespace wifi_portal
