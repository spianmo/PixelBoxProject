/**
 * hal_net/wifi_manager.hpp — WiFi 管理 HAL(与 JS 无关的纯 C++ 层)
 *
 * 职责:
 *   - STA 模式连接管理:NVS 凭据持久化、开机自动连接、断线指数退避重连
 *   - 异步 scan、SoftAP(配网/调试)
 *   - 事件监听(Connected / Disconnected / GotIp),回调在 esp_event 任务上下文
 *     执行,上层(bindings_net)负责经 jsvm 事件循环转投 JS 线程
 *
 * 线程安全:所有公开方法可从任意任务调用。
 */
#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "esp_err.h"

namespace hal_net {

/** 单个 AP 扫描结果 */
struct WifiApInfo {
  std::string ssid;
  int rssi = 0;
  bool secure = false;  ///< authmode != OPEN
  int channel = 0;
};

/** 当前 STA 状态快照(与 d.ts PxWifiStatus 字段一一对应) */
struct WifiStatus {
  bool connected = false;
  std::string ssid;  ///< 未连接为空串
  std::string ip;    ///< 未拿到 IP 为空串
  int rssi = 0;
  std::string mac;   ///< "aa:bb:cc:dd:ee:ff"
};

enum class WifiEvent {
  Connected,     ///< STA 关联成功(尚未必有 IP)
  Disconnected,  ///< 断开(reason 为 wifi_err_reason_t)
  GotIp,         ///< 拿到 IPv4
};

/** 事件监听回调:在 esp_event 任务上下文执行,禁止阻塞 */
using WifiListener = std::function<void(WifiEvent ev, const WifiStatus& st, int reason)>;
/** 扫描完成回调:在 esp_event 任务上下文执行 */
using ScanDone = std::function<void(esp_err_t err, std::vector<WifiApInfo> aps)>;

class WifiManager {
 public:
  static WifiManager& instance();

  /**
   * 幂等初始化:netif/事件循环/esp_wifi 启动 + 注册事件处理。
   * 若 NVS 中存有凭据则自动发起连接(开机自动重连)。
   * 可安全地在 main 与模块 init 中重复调用。
   */
  esp_err_t ensure_init();

  /**
   * 连接指定 AP。save=true 时凭据写入 NVS。
   * 结果通过事件监听回报(GotIp = 成功;Disconnected + reason = 失败中间态)。
   */
  esp_err_t connect(const std::string& ssid, const std::string& password, bool save);

  /** 主动断开并停止自动重连(不清除 NVS 凭据) */
  void disconnect();

  /** 异步扫描;同一时刻仅允许一个扫描,忙时返回 ESP_ERR_INVALID_STATE */
  esp_err_t scan(ScanDone done);

  /** 状态快照 */
  WifiStatus status();

  /** 注册事件监听,返回 id */
  int add_listener(WifiListener cb);
  void remove_listener(int id);

  /** 开启 SoftAP(APSTA 共存);密码 <8 字符按开放网络处理 */
  esp_err_t start_ap(const std::string& ssid, const std::string& password);
  void stop_ap();

  WifiManager(const WifiManager&) = delete;
  WifiManager& operator=(const WifiManager&) = delete;

 private:
  WifiManager() = default;

  void on_wifi_event(int32_t event_id, void* data);
  void on_ip_event(int32_t event_id, void* data);
  void schedule_reconnect();
  void fire(WifiEvent ev, int reason);
  void load_and_autoconnect();

  static void wifi_event_trampoline(void* arg, const char* base, int32_t id, void* data);
  static void ip_event_trampoline(void* arg, const char* base, int32_t id, void* data);
  static void reconnect_timer_cb(void* arg);

  std::recursive_mutex mtx_;
  bool inited_ = false;
  bool want_connected_ = false;  ///< 期望保持连接(驱动自动重连)
  bool associated_ = false;
  bool has_ip_ = false;
  bool ap_on_ = false;
  std::string cur_ssid_;
  std::string cur_ip_;
  uint32_t backoff_ms_ = 1000;  ///< 指数退避:1s → 2s → … → 30s
  void* reconnect_timer_ = nullptr;  // esp_timer_handle_t
  ScanDone scan_done_;
  bool scanning_ = false;
  int next_listener_id_ = 1;
  std::unordered_map<int, WifiListener> listeners_;
};

}  // namespace hal_net
