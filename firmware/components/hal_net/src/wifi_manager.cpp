/**
 * wifi_manager.cpp — WiFi 管理 HAL 实现
 *
 * 设计要点:
 *   - 所有 esp_wifi/esp_netif 调用集中在此,bindings 层不直接触碰 IDF WiFi API
 *   - 断线重连:esp_timer 单次定时器 + 指数退避(1s 起,封顶 30s),GotIp 复位
 *   - 凭据存 NVS 命名空间 "px_wifi"(键 ssid/pass),ensure_init 时自动连接
 */
#include "hal_net/wifi_manager.hpp"

#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"

namespace hal_net {

static const char* TAG = "px_wifi";
static const char* NVS_NS = "px_wifi";
static const uint32_t BACKOFF_MAX_MS = 30000;

WifiManager& WifiManager::instance() {
  static WifiManager inst;
  return inst;
}

// ---------------------------------------------------------------- 初始化

esp_err_t WifiManager::ensure_init() {
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  if (inited_) return ESP_OK;

  // NVS 可能已由 main 初始化;容忍重复与需要擦除的情况
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    ESP_LOGE(TAG, "nvs_flash_init 失败: %s", esp_err_to_name(err));
    return err;
  }

  // netif / 默认事件循环:可能已由其他组件创建,容忍 ESP_ERR_INVALID_STATE
  err = esp_netif_init();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
  err = esp_event_loop_create_default();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

  if (esp_netif_get_handle_from_ifkey("WIFI_STA_DEF") == nullptr) {
    esp_netif_create_default_wifi_sta();
  }

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  err = esp_wifi_init(&cfg);
  if (err != ESP_OK && err != ESP_ERR_WIFI_INIT_STATE) return err;

  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                             &WifiManager::wifi_event_trampoline, this));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                             &WifiManager::ip_event_trampoline, this));

  // 重连定时器
  esp_timer_create_args_t targs = {};
  targs.callback = &WifiManager::reconnect_timer_cb;
  targs.arg = this;
  targs.name = "px_wifi_rc";
  esp_timer_handle_t th = nullptr;
  ESP_ERROR_CHECK(esp_timer_create(&targs, &th));
  reconnect_timer_ = th;

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));  // 凭据由我们自己管
  ESP_ERROR_CHECK(esp_wifi_start());

  inited_ = true;
  load_and_autoconnect();
  return ESP_OK;
}

esp_err_t WifiManager::load_and_autoconnect() {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return ESP_ERR_NOT_FOUND;
  char ssid[33] = {0};
  char pass[65] = {0};
  size_t sl = sizeof(ssid), pl = sizeof(pass);
  bool ok = nvs_get_str(h, "ssid", ssid, &sl) == ESP_OK;
  if (nvs_get_str(h, "pass", pass, &pl) != ESP_OK) pass[0] = '\0';
  nvs_close(h);
  if (!ok || !ssid[0]) return ESP_ERR_NOT_FOUND;
  ESP_LOGI(TAG, "自动连接已保存的 WiFi: %s", ssid);
  return connect(ssid, pass, /*save=*/false);
}

esp_err_t WifiManager::reconnect_saved() {
  esp_err_t err = ensure_init();
  if (err != ESP_OK) return err;
  return load_and_autoconnect();
}

// ---------------------------------------------------------------- 连接/断开

esp_err_t WifiManager::connect(const std::string& ssid, const std::string& password, bool save) {
  esp_err_t err = ensure_init();
  if (err != ESP_OK) return err;
  if (ssid.empty() || ssid.size() > 32 || password.size() > 64) return ESP_ERR_INVALID_ARG;

  ScanDone aborted_scan;
  {
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    wifi_config_t wc = {};
    // ssid/password 为定长字节数组而非 C 字符串 (长度已在上方校验 ≤ 字段宽度,
    // wc={} 已整体清零), 用 memcpy 避免 RISC-V GCC 的 stringop-truncation 告警
    std::memcpy(wc.sta.ssid, ssid.data(), ssid.size());
    std::memcpy(wc.sta.password, password.data(), password.size());
    wc.sta.threshold.authmode = password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK;
    wc.sta.pmf_cfg.capable = true;
    wc.sta.pmf_cfg.required = false;

    err = esp_wifi_set_config(WIFI_IF_STA, &wc);
    if (err != ESP_OK) return err;

    // 凭据不在此处落盘:等 GOT_IP 验证成功后再写 NVS,
    // 否则一次误输密码会覆盖掉原本可用的凭据
    pending_save_ = save;
    pending_save_ssid_ = save ? ssid : std::string();
    pending_save_pass_ = save ? password : std::string();

    // disconnect/connect 会中止在途扫描且 SCAN_DONE 不再可靠送达 —— 摘出回调
    // 由本函数结算,防上层扫描 Promise 永久悬挂 (事件真来了 done 为空,无害)
    if (scanning_) {
      aborted_scan = std::move(scan_done_);
      scan_done_ = nullptr;
      scanning_ = false;
      esp_wifi_scan_stop();
    }

    cur_ssid_ = ssid;
    want_connected_ = true;
    backoff_ms_ = 1000;
    has_ip_ = false;
    associated_ = false;
    esp_wifi_disconnect();  // 若正连着别的 AP 先断开;失败可忽略
    err = esp_wifi_connect();
    if (err == ESP_ERR_WIFI_CONN || err == ESP_ERR_WIFI_STATE) {
      // 正在连接过程中,由 DISCONNECTED 事件驱动重试
      err = ESP_OK;
    }
  }
  // 锁外结算,避免回调再入
  if (aborted_scan) aborted_scan(ESP_ERR_INVALID_STATE, {});
  return err;
}

void WifiManager::disconnect() {
  ScanDone aborted_scan;
  {
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    want_connected_ = false;
    pending_save_ = false;  // 放弃未验证的待存凭据
    pending_save_ssid_.clear();
    pending_save_pass_.clear();
    if (scanning_) {  // 同 connect(): 主动断开也会打断扫描
      aborted_scan = std::move(scan_done_);
      scan_done_ = nullptr;
      scanning_ = false;
      esp_wifi_scan_stop();
    }
    if (reconnect_timer_) esp_timer_stop((esp_timer_handle_t)reconnect_timer_);
    esp_wifi_disconnect();
  }
  if (aborted_scan) aborted_scan(ESP_ERR_INVALID_STATE, {});
}

// ---------------------------------------------------------------- 扫描

esp_err_t WifiManager::scan(ScanDone done) {
  esp_err_t err = ensure_init();
  if (err != ESP_OK) return err;
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  if (scanning_) return ESP_ERR_INVALID_STATE;
  err = esp_wifi_scan_start(nullptr, /*block=*/false);
  if (err != ESP_OK) return err;
  scanning_ = true;
  scan_done_ = std::move(done);
  return ESP_OK;
}

// ---------------------------------------------------------------- 状态

WifiStatus WifiManager::status() {
  WifiStatus st;
  {
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    st.connected = has_ip_;
    st.ssid = associated_ ? cur_ssid_ : std::string();
    st.ip = has_ip_ ? cur_ip_ : std::string();
  }
  uint8_t mac[6] = {0};
  if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
    char buf[18];
    snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3],
             mac[4], mac[5]);
    st.mac = buf;
  }
  if (st.connected) {
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) st.rssi = ap.rssi;
  }
  return st;
}

// ---------------------------------------------------------------- 监听

int WifiManager::add_listener(WifiListener cb) {
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  int id = next_listener_id_++;
  listeners_[id] = std::move(cb);
  return id;
}

void WifiManager::remove_listener(int id) {
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  listeners_.erase(id);
}

void WifiManager::fire(WifiEvent ev, int reason) {
  std::vector<WifiListener> copy;
  {
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    copy.reserve(listeners_.size());
    for (auto& kv : listeners_) copy.push_back(kv.second);
  }
  WifiStatus st = status();
  for (auto& cb : copy) cb(ev, st, reason);
}

// ---------------------------------------------------------------- SoftAP

esp_err_t WifiManager::start_ap(const std::string& ssid, const std::string& password) {
  esp_err_t err = ensure_init();
  if (err != ESP_OK) return err;
  if (ssid.empty() || ssid.size() > 32 || password.size() > 64) return ESP_ERR_INVALID_ARG;

  std::lock_guard<std::recursive_mutex> lk(mtx_);
  if (esp_netif_get_handle_from_ifkey("WIFI_AP_DEF") == nullptr) {
    esp_netif_create_default_wifi_ap();
  }
  wifi_config_t wc = {};
  // 同 connect(): 定长字节数组用 memcpy (长度已校验, wc={} 已清零)
  std::memcpy(wc.ap.ssid, ssid.data(), ssid.size());
  wc.ap.ssid_len = ssid.size();
  wc.ap.channel = 1;
  wc.ap.max_connection = 4;
  if (password.size() >= 8) {
    std::memcpy(wc.ap.password, password.data(), password.size());
    wc.ap.authmode = WIFI_AUTH_WPA2_PSK;
  } else {
    wc.ap.authmode = WIFI_AUTH_OPEN;
  }
  err = esp_wifi_set_mode(WIFI_MODE_APSTA);
  if (err != ESP_OK) return err;
  err = esp_wifi_set_config(WIFI_IF_AP, &wc);
  if (err != ESP_OK) return err;
  ap_on_ = true;
  return ESP_OK;
}

void WifiManager::stop_ap() {
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  if (!ap_on_) return;
  ap_on_ = false;
  esp_wifi_set_mode(WIFI_MODE_STA);
}

// ---------------------------------------------------------------- 重连退避

void WifiManager::schedule_reconnect() {
  std::lock_guard<std::recursive_mutex> lk(mtx_);
  if (!want_connected_ || !reconnect_timer_) return;
  uint32_t delay = backoff_ms_;
  backoff_ms_ = backoff_ms_ * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : backoff_ms_ * 2;
  esp_timer_stop((esp_timer_handle_t)reconnect_timer_);
  esp_timer_start_once((esp_timer_handle_t)reconnect_timer_, (uint64_t)delay * 1000);
  ESP_LOGI(TAG, "%" PRIu32 " ms 后重连 %s", delay, cur_ssid_.c_str());
}

void WifiManager::reconnect_timer_cb(void* arg) {
  auto* self = static_cast<WifiManager*>(arg);
  std::lock_guard<std::recursive_mutex> lk(self->mtx_);
  if (self->want_connected_) esp_wifi_connect();
}

// ---------------------------------------------------------------- 事件

void WifiManager::wifi_event_trampoline(void* arg, const char*, int32_t id, void* data) {
  static_cast<WifiManager*>(arg)->on_wifi_event(id, data);
}
void WifiManager::ip_event_trampoline(void* arg, const char*, int32_t id, void* data) {
  static_cast<WifiManager*>(arg)->on_ip_event(id, data);
}

void WifiManager::on_wifi_event(int32_t event_id, void* data) {
  switch (event_id) {
    case WIFI_EVENT_STA_CONNECTED: {
      {
        std::lock_guard<std::recursive_mutex> lk(mtx_);
        associated_ = true;
      }
      fire(WifiEvent::Connected, 0);
      break;
    }
    case WIFI_EVENT_STA_DISCONNECTED: {
      auto* ev = static_cast<wifi_event_sta_disconnected_t*>(data);
      bool was_up;
      {
        std::lock_guard<std::recursive_mutex> lk(mtx_);
        was_up = associated_ || has_ip_;
        associated_ = false;
        has_ip_ = false;
        cur_ip_.clear();
      }
      if (was_up || want_connected_) fire(WifiEvent::Disconnected, ev ? ev->reason : 0);
      schedule_reconnect();
      break;
    }
    case WIFI_EVENT_SCAN_DONE: {
      ScanDone done;
      {
        std::lock_guard<std::recursive_mutex> lk(mtx_);
        done = std::move(scan_done_);
        scan_done_ = nullptr;
        scanning_ = false;
      }
      if (!done) break;
      uint16_t n = 0;
      esp_wifi_scan_get_ap_num(&n);
      std::vector<wifi_ap_record_t> recs(n);
      std::vector<WifiApInfo> out;
      if (n > 0 && esp_wifi_scan_get_ap_records(&n, recs.data()) == ESP_OK) {
        out.reserve(n);
        for (uint16_t i = 0; i < n; i++) {
          WifiApInfo a;
          a.ssid = reinterpret_cast<const char*>(recs[i].ssid);
          a.rssi = recs[i].rssi;
          a.secure = recs[i].authmode != WIFI_AUTH_OPEN;
          a.channel = recs[i].primary;
          out.push_back(std::move(a));
        }
      }
      done(ESP_OK, std::move(out));
      break;
    }
    default:
      break;
  }
}

void WifiManager::on_ip_event(int32_t event_id, void* data) {
  if (event_id != IP_EVENT_STA_GOT_IP) return;
  auto* ev = static_cast<ip_event_got_ip_t*>(data);
  char ip[16] = {0};
  snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ev->ip_info.ip));
  std::string save_ssid, save_pass;
  {
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    has_ip_ = true;
    cur_ip_ = ip;
    backoff_ms_ = 1000;  // 成功后复位退避
    if (reconnect_timer_) esp_timer_stop((esp_timer_handle_t)reconnect_timer_);
    if (pending_save_ && pending_save_ssid_ == cur_ssid_) {
      save_ssid = pending_save_ssid_;
      save_pass = pending_save_pass_;
    }
    pending_save_ = false;
    pending_save_ssid_.clear();
    pending_save_pass_.clear();
  }
  if (!save_ssid.empty()) {
    // 凭据已被本次 GOT_IP 验证,此刻才落盘 (锁外做 flash 写)
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
      nvs_set_str(h, "ssid", save_ssid.c_str());
      nvs_set_str(h, "pass", save_pass.c_str());
      nvs_commit(h);
      nvs_close(h);
      ESP_LOGI(TAG, "WiFi 凭据已保存: %s", save_ssid.c_str());
    }
  }
  ESP_LOGI(TAG, "已获取 IP: %s", ip);
  fire(WifiEvent::GotIp, 0);
}

}  // namespace hal_net
