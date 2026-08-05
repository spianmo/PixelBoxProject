/**
 * mod_system_net.cpp — px.system 的网络子功能(对齐 d.ts PxSystem 网络部分)
 *
 *   ntpSync(server?): Promise<void>          — esp_sntp,同步完成 resolve,15s 超时 reject
 *   otaCheck(manifestUrl): Promise<{version,url,notes?} | null>
 *                                             — fetch manifest JSON,semver 对比当前固件
 *   otaApply(firmwareUrl, onProgress?): Promise<void>
 *                                             — esp_https_ota;download/write/verify 进度
 *                                               回调经事件循环投递;成功后自动重启
 *
 * 模块 priority 20:在 fw-core 的 system 模块(priority 0/10)之后初始化,
 * 向既有 px.system 对象追加方法(不存在时创建,保证组件可独立测试)。
 */
#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"  // ESP_ERR_OTA_VALIDATE_FAILED
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "http_util.hpp"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"
#include "net_worker.hpp"

static const char* TAG = "px_sysnet";

using pxjs::JsFuncPtr;
using pxjs::PromisePtr;

// ============================================================ Promise 超时工具

struct TimeoutWait {
  PromisePtr promise;
  esp_timer_handle_t timer = nullptr;
  std::string msg;
};

static void timeout_timer_cb(void* arg) {
  // esp_timer 任务上下文
  auto* wp = static_cast<std::shared_ptr<TimeoutWait>*>(arg);
  std::shared_ptr<TimeoutWait> w = *wp;
  delete wp;
  pxjs::run_on_js([w]() {
    if (w->timer) {
      // JS 线程,已脱离 esp_timer 回调上下文,可安全删除
      esp_timer_delete(w->timer);
      w->timer = nullptr;
    }
    w->promise->reject_msg(w->msg);  // 已 settle 则为空操作
  });
}

/** 给 promise 挂一个超时 reject(promise 先 settle 则超时为空操作) */
static void arm_timeout(PromisePtr prom, int timeout_ms, const char* msg) {
  auto w = std::make_shared<TimeoutWait>();
  w->promise = std::move(prom);
  w->msg = msg;
  auto* arg = new std::shared_ptr<TimeoutWait>(w);
  esp_timer_create_args_t targs = {};
  targs.callback = &timeout_timer_cb;
  targs.arg = arg;
  targs.name = "px_net_tmo";
  if (esp_timer_create(&targs, &w->timer) == ESP_OK) {
    esp_timer_start_once(w->timer, (uint64_t)timeout_ms * 1000);
  } else {
    delete arg;
  }
}

// ============================================================ ntpSync

static std::mutex g_sntp_mtx;  // JS 线程与 lwip tcpip 线程(同步回调)共用
static std::vector<PromisePtr>* g_sntp_waiters = nullptr;
static std::string g_sntp_server;  // esp_sntp_setservername 持有其指针,必须常驻

static void sntp_synced_cb(struct timeval*) {
  // lwip tcpip 线程上下文
  std::vector<PromisePtr> waiters;
  {
    std::lock_guard<std::mutex> lk(g_sntp_mtx);
    if (g_sntp_waiters) waiters = std::move(*g_sntp_waiters);
    if (g_sntp_waiters) g_sntp_waiters->clear();
  }
  ESP_LOGI(TAG, "NTP 时间已同步");
  for (auto& p : waiters) {
    p->resolve_on_js([](JSContext*) { return JS_UNDEFINED; });
  }
}

static JSValue js_ntp_sync(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  std::string server = "pool.ntp.org";
  if (argc >= 1 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0]))
    server = pxjs::to_std_string(ctx, argv[0]);

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  {
    std::lock_guard<std::mutex> lk(g_sntp_mtx);
    if (!g_sntp_waiters) g_sntp_waiters = new std::vector<PromisePtr>();
    g_sntp_waiters->push_back(prom);
    // (重新)启动 SNTP:换服务器 / 重复调用都统一 stop → init
    esp_sntp_stop();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    g_sntp_server = server;
    esp_sntp_setservername(0, g_sntp_server.c_str());
    sntp_set_time_sync_notification_cb(sntp_synced_cb);
    esp_sntp_init();
  }

  arm_timeout(prom, 15000, "NTP 同步超时");
  return promv;
}

// ============================================================ otaCheck

/** semver 比较:a > b 返回 1,相等 0,小于 -1(容忍前缀 v,忽略预发布标签) */
static int semver_cmp(const std::string& a, const std::string& b) {
  auto parse = [](const std::string& s, int out[3]) {
    out[0] = out[1] = out[2] = 0;
    size_t i = (!s.empty() && (s[0] == 'v' || s[0] == 'V')) ? 1 : 0;
    for (int part = 0; part < 3 && i < s.size(); part++) {
      int v = 0;
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') v = v * 10 + (s[i++] - '0');
      out[part] = v;
      if (i < s.size() && s[i] == '.') i++;
      else break;
    }
  };
  int va[3], vb[3];
  parse(a, va);
  parse(b, vb);
  for (int i = 0; i < 3; i++) {
    if (va[i] != vb[i]) return va[i] > vb[i] ? 1 : -1;
  }
  return 0;
}

static JSValue js_ota_check(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "otaCheck(manifestUrl) 缺少 URL");
  auto url = std::make_shared<std::string>(pxjs::to_std_string(ctx, argv[0]));

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  pxjs::worker_submit([url, prom]() {
    pxjs::HttpParams p;
    p.url = *url;
    p.timeout_ms = 10000;
    auto result = std::make_shared<pxjs::HttpResult>();
    pxjs::http_perform_blocking(p, *result);
    if (!result->ok || result->status != 200) {
      prom->reject_msg("OTA manifest 获取失败: " + (result->ok
                           ? "HTTP " + std::to_string(result->status)
                           : result->error));
      return;
    }
    pxjs::run_on_js([prom, result]() {
      if (prom->settled || prom->ctx != pxjs::g_ctx) return;
      JSContext* c = prom->ctx;
      std::string text(reinterpret_cast<const char*>(result->body), result->body_len);
      JSValue v = JS_ParseJSON(c, text.c_str(), text.size(), "<ota:manifest>");
      if (JS_IsException(v)) {
        prom->reject_now(JS_GetException(c));
        return;
      }
      std::string version = pxjs::opt_str_prop(c, v, "version", "");
      std::string fw_url = pxjs::opt_str_prop(c, v, "url", "");
      std::string notes = pxjs::opt_str_prop(c, v, "notes", "");
      JS_FreeValue(c, v);
      if (version.empty() || fw_url.empty()) {
        JSValue err = JS_NewError(c);
        JS_DefinePropertyValueStr(c, err, "message",
                                  JS_NewString(c, "manifest 缺少 version/url 字段"),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        prom->reject_now(err);
        return;
      }
      const esp_app_desc_t* desc = esp_app_get_description();
      if (semver_cmp(version, desc->version) <= 0) {
        prom->resolve_now(JS_NULL);  // 无可用更新
        return;
      }
      JSValue o = JS_NewObject(c);
      JS_SetPropertyStr(c, o, "version", JS_NewString(c, version.c_str()));
      JS_SetPropertyStr(c, o, "url", JS_NewString(c, fw_url.c_str()));
      if (!notes.empty()) JS_SetPropertyStr(c, o, "notes", JS_NewString(c, notes.c_str()));
      prom->resolve_now(o);
    });
  });
  return promv;
}

// ============================================================ otaApply

static std::atomic<bool> g_ota_busy{false};

struct OtaJob {
  std::string url;
  PromisePtr prom;
  JsFuncPtr progress;  // 可空
};

/** 进度回调经事件循环投递 JS(整数百分比去重由调用方保证) */
static void ota_report(const OtaJob* job, const char* phase, int percent) {
  if (!job->progress) return;
  std::string ph = phase;
  pxjs::call_func_on_js(job->progress, 1, [ph, percent](JSContext* c, JSValue* argv) {
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "phase", JS_NewString(c, ph.c_str()));
    JS_SetPropertyStr(c, o, "percent", JS_NewInt32(c, percent));
    argv[0] = o;
  });
}

static void ota_task(void* arg) {
  std::unique_ptr<OtaJob> job(static_cast<OtaJob*>(arg));

  esp_http_client_config_t http_cfg = {};
  http_cfg.url = job->url.c_str();
  http_cfg.crt_bundle_attach = esp_crt_bundle_attach;
  http_cfg.timeout_ms = 15000;
  http_cfg.keep_alive_enable = true;
  http_cfg.buffer_size = 4096;

  esp_https_ota_config_t ota_cfg = {};
  ota_cfg.http_config = &http_cfg;

  esp_https_ota_handle_t handle = nullptr;
  esp_err_t err = esp_https_ota_begin(&ota_cfg, &handle);
  if (err != ESP_OK) {
    job->prom->reject_msg(std::string("OTA 启动失败: ") + esp_err_to_name(err));
    g_ota_busy.store(false);
    vTaskDelete(nullptr);
    return;
  }

  int total = esp_https_ota_get_image_size(handle);
  int last_pct = -1;
  ota_report(job.get(), "download", 0);

  for (;;) {
    err = esp_https_ota_perform(handle);
    if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) break;
    if (total > 0) {
      int read = esp_https_ota_get_image_len_read(handle);
      int pct = (int)((int64_t)read * 100 / total);
      if (pct != last_pct) {  // 整数百分比变化才投递,避免事件风暴
        last_pct = pct;
        ota_report(job.get(), "download", pct);
      }
    }
  }

  if (err != ESP_OK) {
    esp_https_ota_abort(handle);
    job->prom->reject_msg(std::string("OTA 下载/写入失败: ") + esp_err_to_name(err));
    g_ota_busy.store(false);
    vTaskDelete(nullptr);
    return;
  }
  if (!esp_https_ota_is_complete_data_received(handle)) {
    esp_https_ota_abort(handle);
    job->prom->reject_msg("OTA 数据不完整");
    g_ota_busy.store(false);
    vTaskDelete(nullptr);
    return;
  }

  ota_report(job.get(), "write", 100);
  ota_report(job.get(), "verify", 0);
  err = esp_https_ota_finish(handle);  // 校验镜像 + 设置启动分区
  if (err != ESP_OK) {
    job->prom->reject_msg(err == ESP_ERR_OTA_VALIDATE_FAILED
                              ? "OTA 镜像校验失败"
                              : std::string("OTA 完成失败: ") + esp_err_to_name(err));
    g_ota_busy.store(false);
    vTaskDelete(nullptr);
    return;
  }
  ota_report(job.get(), "verify", 100);
  job->prom->resolve_on_js([](JSContext*) { return JS_UNDEFINED; });

  ESP_LOGW(TAG, "OTA 完成,1 秒后重启");
  vTaskDelay(pdMS_TO_TICKS(1000));  // 给 JS 侧一点时间处理 resolve/收尾
  esp_restart();
}

static JSValue js_ota_apply(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "otaApply(firmwareUrl, onProgress?) 缺少 URL");

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  bool expected = false;
  if (!g_ota_busy.compare_exchange_strong(expected, true)) {
    prom->reject_msg("已有 OTA 任务进行中");
    return promv;
  }

  auto* job = new OtaJob();
  job->url = pxjs::to_std_string(ctx, argv[0]);
  job->prom = prom;
  if (argc >= 2 && JS_IsFunction(ctx, argv[1])) {
    job->progress = std::make_shared<pxjs::JsFunc>(ctx, argv[1]);
  }

  // 独立任务执行(OTA 持续数分钟,不占用 worker 池)
  if (xTaskCreatePinnedToCore(ota_task, "px_ota", 12288, job, 5, nullptr, 0) != pdPASS) {
    delete job;
    g_ota_busy.store(false);
    prom->reject_msg("OTA 任务创建失败");
  }
  return promv;
}

// ============================================================ 模块注册

static void system_net_module_init(JSContext* ctx, JSValue px) {
  pxjs::set_ctx(ctx);

  // 向既有 px.system 追加方法;system 模块缺席时创建(保证独立可测)
  JSValue sys = JS_GetPropertyStr(ctx, px, "system");
  if (!JS_IsObject(sys)) {
    JS_FreeValue(ctx, sys);
    sys = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, px, "system", JS_DupValue(ctx, sys));
  }
  pxjs::set_method(ctx, sys, "ntpSync", js_ntp_sync, 1);
  pxjs::set_method(ctx, sys, "otaCheck", js_ota_check, 1);
  pxjs::set_method(ctx, sys, "otaApply", js_ota_apply, 2);
  JS_FreeValue(ctx, sys);
  ESP_LOGI(TAG, "px.system 网络子功能已注册 (ntpSync/otaCheck/otaApply)");
}

static const jsvm::Module k_system_net_module = {
    .name = "system_net",
    .priority = 20,  // 在 system(fw-core)之后
    .init = system_net_module_init,
    .prelude = nullptr,
};
JSVM_REGISTER_MODULE(k_system_net_module);
