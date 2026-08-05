/**
 * mod_fetch.cpp — 全局 fetch(对齐 d.ts PxRequestInit / PxResponse)
 *
 * 实现要点:
 *   - esp_http_client + esp_crt_bundle(https);手动重定向循环(≤5 次,303/301/302
 *     POST 语义降级为 GET)
 *   - 阻塞执行在 net_worker;完成后经 jsvm 事件循环回 JS 线程 settle Promise
 *   - 响应体收入 PSRAM,上限 2MB,超限整个请求报错
 *   - 响应对象:status/ok/statusText/headers/url + text()/json()/arrayBuffer()
 *     (三个方法返回已 settle 的 Promise;body 挂在不可枚举内部属性上)
 */
#include <cctype>
#include <cstring>
#include <memory>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "http_util.hpp"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"
#include "net_worker.hpp"

static const char* TAG = "px_fetch";

namespace pxjs {

// ============================================================ 阻塞 HTTP 执行器

const char* http_status_text(int status) {
  switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    default: return "";
  }
}

static esp_http_client_method_t map_method(const std::string& m) {
  if (m == "GET") return HTTP_METHOD_GET;
  if (m == "POST") return HTTP_METHOD_POST;
  if (m == "PUT") return HTTP_METHOD_PUT;
  if (m == "DELETE") return HTTP_METHOD_DELETE;
  if (m == "PATCH") return HTTP_METHOD_PATCH;
  if (m == "HEAD") return HTTP_METHOD_HEAD;
  if (m == "OPTIONS") return HTTP_METHOD_OPTIONS;
  return HTTP_METHOD_GET;
}

/** 事件回调收集器:抓取响应头 */
struct HeaderCollector {
  std::vector<std::pair<std::string, std::string>>* out;
};

static esp_err_t http_event_cb(esp_http_client_event_t* evt) {
  if (evt->event_id == HTTP_EVENT_ON_HEADER && evt->user_data) {
    auto* col = static_cast<HeaderCollector*>(evt->user_data);
    std::string key = evt->header_key ? evt->header_key : "";
    for (auto& c : key) c = (char)std::tolower((unsigned char)c);
    col->out->emplace_back(std::move(key), evt->header_value ? evt->header_value : "");
  }
  return ESP_OK;
}

void http_perform_blocking(const HttpParams& p, HttpResult& out) {
  out = HttpResult{};
  HeaderCollector col{&out.headers};

  esp_http_client_config_t cfg = {};
  cfg.url = p.url.c_str();
  cfg.timeout_ms = p.timeout_ms > 0 ? p.timeout_ms : 15000;
  cfg.event_handler = http_event_cb;
  cfg.user_data = &col;
  cfg.crt_bundle_attach = esp_crt_bundle_attach;
  cfg.disable_auto_redirect = true;  // 手动处理重定向,便于清空 headers/改方法
  cfg.buffer_size = 4096;
  cfg.buffer_size_tx = 2048;
  cfg.method = map_method(p.method);

  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (!client) {
    out.error = "HTTP 客户端初始化失败(URL 非法?)";
    return;
  }

  for (const auto& [k, v] : p.headers) esp_http_client_set_header(client, k.c_str(), v.c_str());

  const uint8_t* body = p.body.data();
  size_t body_len = p.body.size();
  std::string method = p.method;
  int status = 0;
  bool transport_ok = false;

  for (int redirects = 0; redirects <= 5; redirects++) {
    esp_err_t err = esp_http_client_open(client, (int)body_len);
    if (err != ESP_OK) {
      out.error = std::string("连接失败: ") + esp_err_to_name(err);
      break;
    }
    if (body_len > 0) {
      int w = esp_http_client_write(client, reinterpret_cast<const char*>(body), (int)body_len);
      if (w < 0 || (size_t)w != body_len) {
        out.error = "请求体发送失败";
        break;
      }
    }
    int64_t clen = esp_http_client_fetch_headers(client);
    if (clen < 0) {
      out.error = "读取响应头失败";
      break;
    }
    status = esp_http_client_get_status_code(client);
    if ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308) &&
        redirects < 5) {
      // 303 一律转 GET;301/302 对 POST 按惯例也转 GET
      if (status == 303 || ((status == 301 || status == 302) && method == "POST")) {
        method = "GET";
        body = nullptr;
        body_len = 0;
        esp_http_client_set_method(client, HTTP_METHOD_GET);
      }
      out.headers.clear();
      esp_http_client_set_redirection(client);
      esp_http_client_close(client);
      continue;
    }
    transport_ok = true;
    break;
  }

  if (transport_ok) {
    out.status = status;
    // 收响应体(HEAD / 204 / 304 无 body)
    bool has_body = !(method == "HEAD" || status == 204 || status == 304);
    if (has_body) {
      int64_t clen = esp_http_client_get_content_length(client);
      size_t cap = HTTP_BODY_LIMIT;
      size_t alloc = (clen > 0 && (size_t)clen <= cap) ? (size_t)clen : 16384;
      uint8_t* buf = psram_alloc(alloc);
      size_t used = 0;
      bool overflow = false;
      if (!buf) {
        out.error = "响应缓冲分配失败";
        transport_ok = false;
      } else {
        for (;;) {
          if (used == alloc) {
            if (alloc >= cap) {
              // 已到上限还有数据吗?试读 1 字节确认
              char probe;
              int r = esp_http_client_read(client, &probe, 1);
              if (r > 0) overflow = true;
              break;
            }
            size_t next = alloc * 2 > cap ? cap : alloc * 2;
            uint8_t* nb = psram_alloc(next);
            if (!nb) {
              out.error = "响应缓冲扩容失败";
              transport_ok = false;
              break;
            }
            std::memcpy(nb, buf, used);
            psram_free(buf);
            buf = nb;
            alloc = next;
          }
          int r = esp_http_client_read(client, reinterpret_cast<char*>(buf) + used,
                                       (int)(alloc - used));
          if (r < 0) {
            out.error = "响应体读取失败";
            transport_ok = false;
            break;
          }
          if (r == 0) break;  // 读完
          used += (size_t)r;
        }
        if (overflow) {
          out.error = "响应体超过 2MB 上限";
          transport_ok = false;
        }
        if (!transport_ok) {
          psram_free(buf);
        } else {
          out.body = buf;
          out.body_len = used;
        }
      }
    }
  }

  if (transport_ok) {
    char urlbuf[512] = {0};
    if (esp_http_client_get_url(client, urlbuf, sizeof(urlbuf)) == ESP_OK && urlbuf[0]) {
      out.final_url = urlbuf;
    } else {
      out.final_url = p.url;
    }
    out.ok = true;
  } else if (out.error.empty()) {
    out.error = "HTTP 请求失败";
  }

  esp_http_client_close(client);
  esp_http_client_cleanup(client);
}

}  // namespace pxjs

// ============================================================ JS 绑定

using pxjs::HttpParams;
using pxjs::HttpResult;

/** 已 settle 的 Promise 工具 */
static JSValue resolved_promise(JSContext* ctx, JSValue v) {
  JSValue funcs[2];
  JSValue prom = JS_NewPromiseCapability(ctx, funcs);
  JSValue r = JS_Call(ctx, funcs[0], JS_UNDEFINED, 1, &v);
  JS_FreeValue(ctx, r);
  JS_FreeValue(ctx, v);
  JS_FreeValue(ctx, funcs[0]);
  JS_FreeValue(ctx, funcs[1]);
  return prom;
}
static JSValue rejected_promise(JSContext* ctx, JSValue err) {
  JSValue funcs[2];
  JSValue prom = JS_NewPromiseCapability(ctx, funcs);
  JSValue r = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &err);
  JS_FreeValue(ctx, r);
  JS_FreeValue(ctx, err);
  JS_FreeValue(ctx, funcs[0]);
  JS_FreeValue(ctx, funcs[1]);
  return prom;
}

static const char* BODY_PROP = "__pxBody";

/** PxResponse.text() */
static JSValue js_resp_text(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  JSValue ab = JS_GetPropertyStr(ctx, this_val, BODY_PROP);
  size_t len = 0;
  uint8_t* p = JS_GetArrayBuffer(ctx, &len, ab);
  if (!p) {
    JS_FreeValue(ctx, ab);
    JS_FreeValue(ctx, JS_GetException(ctx));
    return resolved_promise(ctx, JS_NewString(ctx, ""));
  }
  JSValue s = JS_NewStringLen(ctx, reinterpret_cast<const char*>(p), len);
  JS_FreeValue(ctx, ab);
  if (JS_IsException(s)) return rejected_promise(ctx, JS_GetException(ctx));
  return resolved_promise(ctx, s);
}

/** PxResponse.json() */
static JSValue js_resp_json(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  JSValue ab = JS_GetPropertyStr(ctx, this_val, BODY_PROP);
  size_t len = 0;
  uint8_t* p = JS_GetArrayBuffer(ctx, &len, ab);
  std::string text;
  if (p) text.assign(reinterpret_cast<const char*>(p), len);
  JS_FreeValue(ctx, ab);
  if (!p) JS_FreeValue(ctx, JS_GetException(ctx));
  JSValue v = JS_ParseJSON(ctx, text.c_str(), text.size(), "<fetch:json>");
  if (JS_IsException(v)) return rejected_promise(ctx, JS_GetException(ctx));
  return resolved_promise(ctx, v);
}

/** PxResponse.arrayBuffer() —— 返回内部缓冲的引用(不复制,节省 PSRAM) */
static JSValue js_resp_array_buffer(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  JSValue ab = JS_GetPropertyStr(ctx, this_val, BODY_PROP);
  return resolved_promise(ctx, ab);
}

/** HttpResult → PxResponse 对象(JS 线程;接管 r.body 所有权) */
static JSValue build_response(JSContext* ctx, HttpResult& r) {
  JSValue o = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, o, "status", JS_NewInt32(ctx, r.status));
  JS_SetPropertyStr(ctx, o, "ok", JS_NewBool(ctx, r.status >= 200 && r.status < 300));
  JS_SetPropertyStr(ctx, o, "statusText", JS_NewString(ctx, pxjs::http_status_text(r.status)));
  JS_SetPropertyStr(ctx, o, "url", JS_NewString(ctx, r.final_url.c_str()));

  JSValue hdrs = JS_NewObject(ctx);
  for (const auto& [k, v] : r.headers) {
    JS_SetPropertyStr(ctx, hdrs, k.c_str(), JS_NewString(ctx, v.c_str()));
  }
  JS_SetPropertyStr(ctx, o, "headers", hdrs);

  JSValue body_ab;
  if (r.body) {
    body_ab = pxjs::new_ab_take(ctx, r.body, r.body_len);  // 零拷贝接管 PSRAM 缓冲
    r.body = nullptr;
  } else {
    body_ab = pxjs::new_ab_copy(ctx, "", 0);
  }
  // 不可枚举内部属性
  JS_DefinePropertyValueStr(ctx, o, BODY_PROP, body_ab, 0);

  pxjs::set_method(ctx, o, "text", js_resp_text, 0);
  pxjs::set_method(ctx, o, "json", js_resp_json, 0);
  pxjs::set_method(ctx, o, "arrayBuffer", js_resp_array_buffer, 0);
  return o;
}

/** 解析 init.headers(普通对象) */
static void parse_headers(JSContext* ctx, JSValueConst init, HttpParams& p) {
  JSValue hv = JS_GetPropertyStr(ctx, init, "headers");
  if (JS_IsObject(hv)) {
    JSPropertyEnum* tab = nullptr;
    uint32_t n = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &n, hv, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
      for (uint32_t i = 0; i < n; i++) {
        const char* key = JS_AtomToCString(ctx, tab[i].atom);
        if (key) {
          JSValue val = JS_GetProperty(ctx, hv, tab[i].atom);
          p.headers.emplace_back(key, pxjs::to_std_string(ctx, val));
          JS_FreeValue(ctx, val);
          JS_FreeCString(ctx, key);
        }
        JS_FreeAtom(ctx, tab[i].atom);
      }
      js_free(ctx, tab);
    }
  }
  JS_FreeValue(ctx, hv);
}

/** 全局 fetch(url, init?) */
static JSValue js_fetch(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "fetch(url, init?) 缺少 url");
  auto p = std::make_shared<HttpParams>();
  p->url = pxjs::to_std_string(ctx, argv[0]);
  if (p->url.rfind("http://", 0) != 0 && p->url.rfind("https://", 0) != 0) {
    return pxjs::throw_msg(ctx, "fetch 仅支持 http(s) URL: %s", p->url.c_str());
  }

  JSValueConst init = argc >= 2 ? argv[1] : JS_UNDEFINED;
  if (JS_IsObject(init)) {
    p->method = pxjs::opt_str_prop(ctx, init, "method", "GET");
    for (auto& c : p->method) c = (char)std::toupper((unsigned char)c);
    static const char* kMethods[] = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"};
    bool valid = false;
    for (auto* m : kMethods) valid = valid || p->method == m;
    if (!valid) return pxjs::throw_msg(ctx, "不支持的 method: %s", p->method.c_str());
    p->timeout_ms = pxjs::opt_int_prop(ctx, init, "timeoutMs", 15000);
    parse_headers(ctx, init, *p);

    JSValue bv = JS_GetPropertyStr(ctx, init, "body");
    if (JS_IsString(bv)) {
      std::string s = pxjs::to_std_string(ctx, bv);
      p->body.assign(s.begin(), s.end());
      bool has_ct = false;
      for (auto& [k, v] : p->headers) {
        std::string lk = k;
        for (auto& c : lk) c = (char)std::tolower((unsigned char)c);
        if (lk == "content-type") has_ct = true;
      }
      if (!has_ct) p->headers.emplace_back("Content-Type", "text/plain;charset=UTF-8");
    } else if (!JS_IsUndefined(bv) && !JS_IsNull(bv)) {
      if (!pxjs::get_binary(ctx, bv, p->body)) {
        JS_FreeValue(ctx, bv);
        return pxjs::throw_msg(ctx, "body 仅支持 string / ArrayBuffer / Uint8Array");
      }
    }
    JS_FreeValue(ctx, bv);
  }

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  pxjs::worker_submit([p, prom]() {
    auto result = std::make_shared<HttpResult>();
    pxjs::http_perform_blocking(*p, *result);
    if (!result->ok) {
      prom->reject_msg("fetch 失败: " + result->error + " (" + p->url + ")");
      return;  // body(若有)由 HttpResult 析构释放
    }
    prom->resolve_on_js([result](JSContext* c) { return build_response(c, *result); });
    // 若 VM 在 settle 前重启,body 由 HttpResult 析构释放
  });
  return promv;
}

// ------------------------------------------------------------ 模块注册

static void fetch_module_init(JSContext* ctx, JSValue) {
  pxjs::set_ctx(ctx);
  JSValue global = JS_GetGlobalObject(ctx);
  pxjs::set_method(ctx, global, "fetch", js_fetch, 2);
  JS_FreeValue(ctx, global);
  ESP_LOGI(TAG, "全局 fetch 已注册");
}

static const jsvm::Module k_fetch_module = {
    .name = "fetch",
    .priority = 10,
    .init = fetch_module_init,
    .prelude = nullptr,
};
JSVM_REGISTER_MODULE(k_fetch_module);
