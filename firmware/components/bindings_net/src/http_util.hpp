/**
 * http_util.hpp — 阻塞式 HTTP 执行器(esp_http_client 封装)
 *
 * 供 mod_fetch(全局 fetch)与 mod_system_net(otaCheck)共用。
 * 必须在 worker 线程调用,禁止在 JS 线程调用。
 */
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace pxjs {

/** 响应体大小上限:2MB(收入 PSRAM) */
constexpr size_t HTTP_BODY_LIMIT = 2 * 1024 * 1024;

struct HttpParams {
  std::string url;
  std::string method = "GET";  ///< GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS
  std::vector<std::pair<std::string, std::string>> headers;
  std::vector<uint8_t> body;  ///< 空表示无 body
  int timeout_ms = 15000;
};

void psram_free(void* p);  // 见 js_helpers.hpp

struct HttpResult {
  bool ok = false;          ///< 传输层是否成功(与 HTTP 状态码无关)
  std::string error;        ///< ok=false 时的中文错误描述
  int status = 0;
  std::string final_url;    ///< 重定向后的最终 URL
  std::vector<std::pair<std::string, std::string>> headers;  ///< 键已小写
  uint8_t* body = nullptr;  ///< psram_alloc 分配;移交 ArrayBuffer 后置 nullptr
  size_t body_len = 0;

  HttpResult() = default;
  HttpResult(const HttpResult&) = delete;
  HttpResult& operator=(const HttpResult&) = delete;
  HttpResult(HttpResult&& o) noexcept { *this = std::move(o); }
  HttpResult& operator=(HttpResult&& o) noexcept {
    if (this != &o) {
      psram_free(body);
      ok = o.ok; error = std::move(o.error); status = o.status;
      final_url = std::move(o.final_url); headers = std::move(o.headers);
      body = o.body; body_len = o.body_len;
      o.body = nullptr; o.body_len = 0;
    }
    return *this;
  }
  ~HttpResult() { psram_free(body); }
};

/** 阻塞执行一次 HTTP(S) 请求;自动跟随最多 5 次重定向;https 用 esp_crt_bundle */
void http_perform_blocking(const HttpParams& p, HttpResult& out);

/** HTTP 状态码 → 原因短语(未知返回空串) */
const char* http_status_text(int status);

}  // namespace pxjs
