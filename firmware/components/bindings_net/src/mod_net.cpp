/**
 * mod_net.cpp — px.net 绑定(对齐 d.ts PxNet / PxTcpSocket / PxTcpServer / PxUdpSocket)
 *
 * 实现要点:
 *   - lwip socket 全部非阻塞,统一挂到 hal_net::NetPoll 单一 select 循环;
 *     数据/关闭/错误事件经 jsvm 事件循环投递 JS 线程
 *   - connectTcp 支持 tls 选项(esp-tls + esp_crt_bundle),握手在 worker 阻塞执行
 *   - 发送走每 socket 发送队列,poll 线程在可写时排空(处理部分写)
 *   - close(fd) 一律经 NetPoll::post_task 在 poll 线程执行,避免 fd 复用竞态
 *   - mdns.discover/advertise 基于 espressif/mdns;mdns_init 已被 devd
 *     初始化时(ESP_ERR_INVALID_STATE)忽略重复错误
 */
#include <atomic>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_tls.h"
#include "hal_net/net_poll.hpp"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "net_worker.hpp"

static const char* TAG = "px_net";

using hal_net::NetPoll;
using pxjs::PromisePtr;

// ============================================================ TCP 客户端 socket

struct TcpSock {
  int fd = -1;
  esp_tls_t* tls = nullptr;
  std::atomic<bool> torn{false};  ///< 已进入拆除流程
  std::string remote_host;
  int remote_port = 0;
  JSContext* ctx = nullptr;
  uint32_t gen = 0;             ///< 创建时的 jsvm::vm_generation()(失效判定,勿比 ctx 指针)
  JSValue self = JS_UNDEFINED;  ///< 打开期间 dup 保活

  // 订阅注册表(仅 JS 线程)
  pxjs::SubRegistry on_data, on_close, on_error;

  // 发送队列(JS 线程写入 / poll 线程排空)
  std::mutex tx_mtx;
  std::deque<std::vector<uint8_t>> txq;
  size_t tx_off = 0;
};
using TcpPtr = std::shared_ptr<TcpSock>;

static JSClassID g_tcp_class_id;
static JSClassID g_server_class_id;
static JSClassID g_udp_class_id;

static TcpPtr tcp_from_this(JSValueConst this_val) {
  auto* sp = static_cast<TcpPtr*>(JS_GetOpaque(this_val, g_tcp_class_id));
  return sp ? *sp : nullptr;
}

/**
 * 统一拆除:幂等。任何线程可调。
 * native 资源在 poll 线程关闭;JS 事件(onError? → onClose)投递 JS 线程。
 */
static void tcp_teardown(TcpPtr s, std::string err_msg) {
  bool expected = false;
  if (!s->torn.compare_exchange_strong(expected, true)) return;

  int fd = s->fd;
  esp_tls_t* tls = s->tls;
  NetPoll::instance().remove(fd);
  NetPoll::instance().post_task([fd, tls]() {
    // poll 线程:此时本轮派发已结束,fd 不再被 select 使用
    if (tls) {
      esp_tls_conn_destroy(tls);  // 内部关闭底层 fd
    } else if (fd >= 0) {
      ::close(fd);
    }
  });

  pxjs::run_on_js([s, err_msg = std::move(err_msg)]() {
    if (!pxjs::vm_stale(s->gen)) {
      if (!err_msg.empty()) {
        JSValue m = JS_NewString(s->ctx, err_msg.c_str());
        s->on_error.dispatch(s->ctx, 1, &m);
        JS_FreeValue(s->ctx, m);
      }
      s->on_close.dispatch(s->ctx, 0, nullptr);
      if (!JS_IsUndefined(s->self)) JS_FreeValue(s->ctx, s->self);
    }
    s->self = JS_UNDEFINED;
    s->on_data.clear();
    s->on_close.clear();
    s->on_error.clear();
  });
}

/** poll 线程:排空发送队列;返回 false 表示出错已拆除 */
static void tcp_flush_tx(const TcpPtr& s) {
  if (s->torn.load()) return;
  std::unique_lock<std::mutex> lk(s->tx_mtx);
  while (!s->txq.empty()) {
    auto& chunk = s->txq.front();
    const uint8_t* p = chunk.data() + s->tx_off;
    size_t n = chunk.size() - s->tx_off;
    ssize_t w;
    if (s->tls) {
      w = esp_tls_conn_write(s->tls, p, n);
      if (w == ESP_TLS_ERR_SSL_WANT_READ || w == ESP_TLS_ERR_SSL_WANT_WRITE) return;  // 等下次可写
    } else {
      w = ::send(s->fd, p, n, 0);
      if (w < 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) return;
    }
    if (w <= 0) {
      lk.unlock();
      tcp_teardown(s, "连接发送错误");
      return;
    }
    s->tx_off += (size_t)w;
    if (s->tx_off == chunk.size()) {
      s->txq.pop_front();
      s->tx_off = 0;
    }
  }
  NetPoll::instance().set_want_write(s->fd, false);
}

/** poll 线程读缓冲(poll 是单线程,静态缓冲安全) */
static uint8_t g_rxbuf[2048];

/** 注册 poll 处理器(数据/可写/错误) */
static void tcp_register_poll(const TcpPtr& s) {
  std::weak_ptr<TcpSock> wk = s;
  hal_net::PollHandler h;
  h.on_readable = [wk](int) {
    TcpPtr s = wk.lock();
    if (!s || s->torn.load()) return;
    for (;;) {
      ssize_t r;
      if (s->tls) {
        r = esp_tls_conn_read(s->tls, g_rxbuf, sizeof(g_rxbuf));
        if (r == ESP_TLS_ERR_SSL_WANT_READ || r == ESP_TLS_ERR_SSL_WANT_WRITE) break;
      } else {
        r = ::recv(s->fd, g_rxbuf, sizeof(g_rxbuf), 0);
        if (r < 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) break;
      }
      if (r == 0) {  // 对端关闭
        tcp_teardown(s, "");
        return;
      }
      if (r < 0) {
        tcp_teardown(s, "连接读取错误");
        return;
      }
      auto bytes = std::make_shared<std::vector<uint8_t>>(g_rxbuf, g_rxbuf + r);
      pxjs::run_on_js([s, bytes]() {
        if (pxjs::vm_stale(s->gen) || s->on_data.empty()) return;
        JSValue ab = pxjs::new_ab_copy(s->ctx, bytes->data(), bytes->size());
        if (JS_IsException(ab)) {
          JS_FreeValue(s->ctx, JS_GetException(s->ctx));
          return;
        }
        s->on_data.dispatch(s->ctx, 1, &ab);
        JS_FreeValue(s->ctx, ab);
      });
      // TLS 可能在内部缓冲里还有已解密数据,继续读;明文读满说明可能还有
      if (s->tls) {
        if (esp_tls_get_bytes_avail(s->tls) <= 0) break;
      } else if ((size_t)r < sizeof(g_rxbuf)) {
        break;
      }
    }
  };
  h.on_writable = [wk](int) {
    TcpPtr s = wk.lock();
    if (s) tcp_flush_tx(s);
  };
  h.on_error = [wk](int) {
    TcpPtr s = wk.lock();
    if (s) tcp_teardown(s, "socket 异常");
  };
  NetPoll::instance().add(s->fd, std::move(h));
}

// ---------------- TcpSocket JS 方法

static JSValue js_tcp_send(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  TcpPtr s = tcp_from_this(this_val);
  if (!s) return pxjs::throw_msg(ctx, "非法的 TcpSocket 对象");
  if (s->torn.load()) return pxjs::throw_msg(ctx, "socket 已关闭");
  if (argc < 1) return pxjs::throw_msg(ctx, "send(data) 缺少参数");

  std::vector<uint8_t> bytes;
  if (JS_IsString(argv[0])) {
    std::string str = pxjs::to_std_string(ctx, argv[0]);
    bytes.assign(str.begin(), str.end());
  } else if (!pxjs::get_binary(ctx, argv[0], bytes)) {
    return pxjs::throw_msg(ctx, "send 仅支持 string / ArrayBuffer / Uint8Array");
  }
  if (bytes.empty()) return JS_UNDEFINED;
  {
    std::lock_guard<std::mutex> lk(s->tx_mtx);
    s->txq.push_back(std::move(bytes));
  }
  NetPoll::instance().set_want_write(s->fd, true);  // poll 线程负责真正发送
  return JS_UNDEFINED;
}

static JSValue js_tcp_close(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  TcpPtr s = tcp_from_this(this_val);
  if (s) tcp_teardown(s, "");
  return JS_UNDEFINED;
}

static JSValue js_tcp_get_connected(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  TcpPtr s = tcp_from_this(this_val);
  return JS_NewBool(ctx, s && !s->torn.load());
}

static JSValue js_tcp_on_data(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  TcpPtr s = tcp_from_this(this_val);
  if (!s) return pxjs::throw_msg(ctx, "非法的 TcpSocket 对象");
  if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return pxjs::throw_msg(ctx, "onData(cb) 需要函数");
  return s->on_data.add(ctx, argv[0], std::weak_ptr<void>(s));
}
static JSValue js_tcp_on_close(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  TcpPtr s = tcp_from_this(this_val);
  if (!s) return pxjs::throw_msg(ctx, "非法的 TcpSocket 对象");
  if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return pxjs::throw_msg(ctx, "onClose(cb) 需要函数");
  return s->on_close.add(ctx, argv[0], std::weak_ptr<void>(s));
}
static JSValue js_tcp_on_error(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  TcpPtr s = tcp_from_this(this_val);
  if (!s) return pxjs::throw_msg(ctx, "非法的 TcpSocket 对象");
  if (argc < 1 || !JS_IsFunction(ctx, argv[0])) return pxjs::throw_msg(ctx, "onError(cb) 需要函数");
  return s->on_error.add(ctx, argv[0], std::weak_ptr<void>(s));
}

static void js_tcp_finalizer(JSRuntime*, JSValue val) {
  auto* sp = static_cast<TcpPtr*>(JS_GetOpaque(val, g_tcp_class_id));
  if (!sp) return;
  TcpPtr s = *sp;
  delete sp;
  // 对象 GC(正常发生在 teardown 之后或 VM 销毁时):只做 native 兜底清理,不碰 JS
  bool expected = false;
  if (s->torn.compare_exchange_strong(expected, true)) {
    int fd = s->fd;
    esp_tls_t* tls = s->tls;
    NetPoll::instance().remove(fd);
    NetPoll::instance().post_task([fd, tls]() {
      if (tls) esp_tls_conn_destroy(tls);
      else if (fd >= 0) ::close(fd);
    });
  }
}

/** JS 线程:为已连接的 native socket 创建 JS 对象并挂 poll(调用方负责后续 resolve) */
static JSValue tcp_make_js(JSContext* ctx, const TcpPtr& s) {
  JSValue obj = JS_NewObjectClass(ctx, g_tcp_class_id);
  if (JS_IsException(obj)) return obj;
  JS_SetOpaque(obj, new TcpPtr(s));
  s->ctx = ctx;
  s->gen = jsvm::vm_generation();  // 绑定当前 VM,投递回 JS 线程时判失效
  JS_DefinePropertyValueStr(ctx, obj, "remoteHost", JS_NewString(ctx, s->remote_host.c_str()), 0);
  JS_DefinePropertyValueStr(ctx, obj, "remotePort", JS_NewInt32(ctx, s->remote_port), 0);
  s->self = JS_DupValue(ctx, obj);  // 打开期间保活
  tcp_register_poll(s);
  return obj;
}

// ---------------- connectTcp

static JSValue js_connect_tcp(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1 || !JS_IsObject(argv[0]))
    return pxjs::throw_msg(ctx, "connectTcp({host, port, tls?, timeoutMs?}) 参数错误");
  auto host = pxjs::opt_str_prop(ctx, argv[0], "host", "");
  int port = pxjs::opt_int_prop(ctx, argv[0], "port", 0);
  bool use_tls = pxjs::opt_bool_prop(ctx, argv[0], "tls", false);
  int timeout_ms = pxjs::opt_int_prop(ctx, argv[0], "timeoutMs", 10000);
  if (host.empty() || port <= 0 || port > 65535)
    return pxjs::throw_msg(ctx, "connectTcp: host/port 非法");

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  pxjs::worker_submit([host, port, use_tls, timeout_ms, prom]() {
    auto s = std::make_shared<TcpSock>();
    s->remote_host = host;
    s->remote_port = port;

    if (use_tls) {
      esp_tls_cfg_t cfg = {};
      cfg.crt_bundle_attach = esp_crt_bundle_attach;
      cfg.timeout_ms = timeout_ms;
      esp_tls_t* tls = esp_tls_init();
      if (!tls) {
        prom->reject_msg("esp-tls 初始化失败");
        return;
      }
      if (esp_tls_conn_new_sync(host.c_str(), (int)host.size(), port, &cfg, tls) != 1) {
        esp_tls_conn_destroy(tls);
        prom->reject_msg("TLS 连接失败: " + host);
        return;
      }
      int fd = -1;
      esp_tls_get_conn_sockfd(tls, &fd);
      int fl = fcntl(fd, F_GETFL, 0);
      fcntl(fd, F_SETFL, fl | O_NONBLOCK);
      s->tls = tls;
      s->fd = fd;
    } else {
      char portstr[8];
      snprintf(portstr, sizeof(portstr), "%d", port);
      struct addrinfo hints = {};
      hints.ai_family = AF_INET;
      hints.ai_socktype = SOCK_STREAM;
      struct addrinfo* res = nullptr;
      if (getaddrinfo(host.c_str(), portstr, &hints, &res) != 0 || !res) {
        prom->reject_msg("域名解析失败: " + host);
        return;
      }
      int fd = ::socket(res->ai_family, SOCK_STREAM, 0);
      if (fd < 0) {
        freeaddrinfo(res);
        prom->reject_msg("socket 创建失败");
        return;
      }
      int fl = fcntl(fd, F_GETFL, 0);
      fcntl(fd, F_SETFL, fl | O_NONBLOCK);
      int rc = ::connect(fd, res->ai_addr, res->ai_addrlen);
      freeaddrinfo(res);
      if (rc < 0 && errno == EINPROGRESS) {
        fd_set wset;
        FD_ZERO(&wset);
        FD_SET(fd, &wset);
        struct timeval tv = {.tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000};
        rc = ::select(fd + 1, nullptr, &wset, nullptr, &tv);
        int so_err = 0;
        socklen_t sl = sizeof(so_err);
        if (rc > 0) getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_err, &sl);
        if (rc <= 0 || so_err != 0) {
          ::close(fd);
          prom->reject_msg(rc <= 0 ? "TCP 连接超时: " + host : "TCP 连接被拒绝: " + host);
          return;
        }
      } else if (rc < 0) {
        ::close(fd);
        prom->reject_msg("TCP 连接失败: " + host);
        return;
      }
      int one = 1;
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
      s->fd = fd;
    }

    // 连接成功 → JS 线程建对象 + resolve
    prom->resolve_on_js([s](JSContext* c) { return tcp_make_js(c, s); });
  });
  return promv;
}

// ============================================================ TCP 服务器

struct TcpServer {
  int fd = -1;
  int port = 0;
  std::atomic<bool> torn{false};
  JSContext* ctx = nullptr;
  uint32_t gen = 0;  ///< 创建时的 jsvm::vm_generation()(失效判定,勿比 ctx 指针)
  JSValue self = JS_UNDEFINED;
  pxjs::JsFuncPtr on_conn;
};
using ServerPtr = std::shared_ptr<TcpServer>;

static ServerPtr server_from_this(JSValueConst this_val) {
  auto* sp = static_cast<ServerPtr*>(JS_GetOpaque(this_val, g_server_class_id));
  return sp ? *sp : nullptr;
}

static void server_teardown(ServerPtr sv) {
  bool expected = false;
  if (!sv->torn.compare_exchange_strong(expected, true)) return;
  int fd = sv->fd;
  NetPoll::instance().remove(fd);
  NetPoll::instance().post_task([fd]() {
    if (fd >= 0) ::close(fd);
  });
  pxjs::run_on_js([sv]() {
    if (!pxjs::vm_stale(sv->gen) && !JS_IsUndefined(sv->self)) JS_FreeValue(sv->ctx, sv->self);
    sv->self = JS_UNDEFINED;
    sv->on_conn.reset();
  });
}

static JSValue js_server_close(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  ServerPtr sv = server_from_this(this_val);
  if (sv) server_teardown(sv);
  return JS_UNDEFINED;
}

static void js_server_finalizer(JSRuntime*, JSValue val) {
  auto* sp = static_cast<ServerPtr*>(JS_GetOpaque(val, g_server_class_id));
  if (!sp) return;
  ServerPtr sv = *sp;
  delete sp;
  bool expected = false;
  if (sv->torn.compare_exchange_strong(expected, true)) {
    int fd = sv->fd;
    NetPoll::instance().remove(fd);
    NetPoll::instance().post_task([fd]() {
      if (fd >= 0) ::close(fd);
    });
  }
}

static JSValue js_listen_tcp(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1 || !JS_IsObject(argv[0]))
    return pxjs::throw_msg(ctx, "listenTcp({port, onConnection}) 参数错误");
  int port = pxjs::opt_int_prop(ctx, argv[0], "port", 0);
  JSValue cb = JS_GetPropertyStr(ctx, argv[0], "onConnection");
  if (port <= 0 || port > 65535 || !JS_IsFunction(ctx, cb)) {
    JS_FreeValue(ctx, cb);
    return pxjs::throw_msg(ctx, "listenTcp: port/onConnection 非法");
  }

  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    JS_FreeValue(ctx, cb);
    return pxjs::throw_msg(ctx, "socket 创建失败");
  }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons((uint16_t)port);
  if (::bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0 || ::listen(fd, 4) < 0) {
    ::close(fd);
    JS_FreeValue(ctx, cb);
    return pxjs::throw_msg(ctx, "端口 %d 监听失败", port);
  }
  int fl = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, fl | O_NONBLOCK);

  auto sv = std::make_shared<TcpServer>();
  sv->fd = fd;
  sv->port = port;
  sv->ctx = ctx;
  sv->gen = jsvm::vm_generation();  // 绑定当前 VM,投递回 JS 线程时判失效
  sv->on_conn = std::make_shared<pxjs::JsFunc>(ctx, cb);
  JS_FreeValue(ctx, cb);

  JSValue obj = JS_NewObjectClass(ctx, g_server_class_id);
  JS_SetOpaque(obj, new ServerPtr(sv));
  JS_DefinePropertyValueStr(ctx, obj, "port", JS_NewInt32(ctx, port), 0);
  sv->self = JS_DupValue(ctx, obj);  // 监听期间保活

  // accept 循环(poll 线程)
  std::weak_ptr<TcpServer> wk = sv;
  hal_net::PollHandler h;
  h.on_readable = [wk](int lfd) {
    ServerPtr sv = wk.lock();
    if (!sv || sv->torn.load()) return;
    for (;;) {
      struct sockaddr_in peer = {};
      socklen_t plen = sizeof(peer);
      int cfd = ::accept(lfd, (struct sockaddr*)&peer, &plen);
      if (cfd < 0) break;  // EWOULDBLOCK 等
      int cfl = fcntl(cfd, F_GETFL, 0);
      fcntl(cfd, F_SETFL, cfl | O_NONBLOCK);
      int one = 1;
      setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

      auto s = std::make_shared<TcpSock>();
      s->fd = cfd;
      char ipstr[16] = {0};
      inet_ntoa_r(peer.sin_addr, ipstr, sizeof(ipstr));
      s->remote_host = ipstr;
      s->remote_port = ntohs(peer.sin_port);

      pxjs::run_on_js([sv, s]() {
        if (!sv->on_conn || !sv->on_conn->alive() || sv->torn.load()) {
          // VM 已重启/服务器已关:直接丢弃连接
          int fd2 = s->fd;
          NetPoll::instance().post_task([fd2]() { ::close(fd2); });
          return;
        }
        JSContext* c = jsvm::context();  // alive() 已保证 VM 存活, context() 为权威来源
        JSValue sock_obj = tcp_make_js(c, s);
        if (JS_IsException(sock_obj)) {
          JS_FreeValue(c, JS_GetException(c));
          return;
        }
        JSValue args[1] = {sock_obj};
        sv->on_conn->call_now(1, args);  // call_now 消费 args
      });
    }
  };
  h.on_error = [wk](int) {
    ServerPtr sv = wk.lock();
    if (sv) server_teardown(sv);
  };
  NetPoll::instance().add(fd, std::move(h));
  return obj;
}

// ============================================================ UDP socket

struct UdpSock {
  int fd = -1;
  std::atomic<bool> torn{false};
  JSContext* ctx = nullptr;
  uint32_t gen = 0;  ///< 创建时的 jsvm::vm_generation()(失效判定,勿比 ctx 指针)
  JSValue self = JS_UNDEFINED;
  pxjs::SubRegistry on_msg;
};
using UdpPtr = std::shared_ptr<UdpSock>;

static UdpPtr udp_from_this(JSValueConst this_val) {
  auto* sp = static_cast<UdpPtr*>(JS_GetOpaque(this_val, g_udp_class_id));
  return sp ? *sp : nullptr;
}

static void udp_teardown(UdpPtr u) {
  bool expected = false;
  if (!u->torn.compare_exchange_strong(expected, true)) return;
  int fd = u->fd;
  NetPoll::instance().remove(fd);
  NetPoll::instance().post_task([fd]() {
    if (fd >= 0) ::close(fd);
  });
  pxjs::run_on_js([u]() {
    if (!pxjs::vm_stale(u->gen) && !JS_IsUndefined(u->self)) JS_FreeValue(u->ctx, u->self);
    u->self = JS_UNDEFINED;
    u->on_msg.clear();
  });
}

static JSValue js_udp_send(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  UdpPtr u = udp_from_this(this_val);
  if (!u) return pxjs::throw_msg(ctx, "非法的 UdpSocket 对象");
  if (u->torn.load()) return pxjs::throw_msg(ctx, "socket 已关闭");
  if (argc < 3) return pxjs::throw_msg(ctx, "send(data, host, port) 参数不足");

  auto bytes = std::make_shared<std::vector<uint8_t>>();
  if (JS_IsString(argv[0])) {
    std::string str = pxjs::to_std_string(ctx, argv[0]);
    bytes->assign(str.begin(), str.end());
  } else if (!pxjs::get_binary(ctx, argv[0], *bytes)) {
    return pxjs::throw_msg(ctx, "send 仅支持 string / ArrayBuffer / Uint8Array");
  }
  std::string host = pxjs::to_std_string(ctx, argv[1]);
  int32_t port32 = 0;
  JS_ToInt32(ctx, &port32, argv[2]);
  int port = (int)port32;
  if (port <= 0 || port > 65535) return pxjs::throw_msg(ctx, "端口非法: %d", port);

  struct sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) == 1) {
    // 直接是 IP:当场发(UDP 非阻塞几乎不会阻塞)
    ::sendto(u->fd, bytes->data(), bytes->size(), 0, (struct sockaddr*)&addr, sizeof(addr));
  } else {
    // 域名:worker 解析后发送
    int fd = u->fd;
    pxjs::worker_submit([fd, bytes, host, port]() {
      char portstr[8];
      snprintf(portstr, sizeof(portstr), "%d", port);
      struct addrinfo hints = {};
      hints.ai_family = AF_INET;
      hints.ai_socktype = SOCK_DGRAM;
      struct addrinfo* res = nullptr;
      if (getaddrinfo(host.c_str(), portstr, &hints, &res) == 0 && res) {
        ::sendto(fd, bytes->data(), bytes->size(), 0, res->ai_addr, res->ai_addrlen);
        freeaddrinfo(res);
      } else {
        ESP_LOGW(TAG, "UDP 目标解析失败: %s", host.c_str());
      }
    });
  }
  return JS_UNDEFINED;
}

static JSValue js_udp_on_message(JSContext* ctx, JSValueConst this_val, int argc,
                                 JSValueConst* argv) {
  UdpPtr u = udp_from_this(this_val);
  if (!u) return pxjs::throw_msg(ctx, "非法的 UdpSocket 对象");
  if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
    return pxjs::throw_msg(ctx, "onMessage(cb) 需要函数");
  return u->on_msg.add(ctx, argv[0], std::weak_ptr<void>(u));
}

static JSValue js_udp_close(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  UdpPtr u = udp_from_this(this_val);
  if (u) udp_teardown(u);
  return JS_UNDEFINED;
}

static void js_udp_finalizer(JSRuntime*, JSValue val) {
  auto* sp = static_cast<UdpPtr*>(JS_GetOpaque(val, g_udp_class_id));
  if (!sp) return;
  UdpPtr u = *sp;
  delete sp;
  bool expected = false;
  if (u->torn.compare_exchange_strong(expected, true)) {
    int fd = u->fd;
    NetPoll::instance().remove(fd);
    NetPoll::instance().post_task([fd]() {
      if (fd >= 0) ::close(fd);
    });
  }
}

static JSValue js_create_udp(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  int bind_port = 0;
  if (argc >= 1 && JS_IsObject(argv[0])) bind_port = pxjs::opt_int_prop(ctx, argv[0], "bindPort", 0);
  if (bind_port < 0 || bind_port > 65535) return pxjs::throw_msg(ctx, "bindPort 非法");

  int fd = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) return pxjs::throw_msg(ctx, "UDP socket 创建失败");
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons((uint16_t)bind_port);
  if (::bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    ::close(fd);
    return pxjs::throw_msg(ctx, "UDP 端口 %d 绑定失败", bind_port);
  }
  int fl = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, fl | O_NONBLOCK);

  auto u = std::make_shared<UdpSock>();
  u->fd = fd;
  u->ctx = ctx;
  u->gen = jsvm::vm_generation();  // 绑定当前 VM,投递回 JS 线程时判失效

  JSValue obj = JS_NewObjectClass(ctx, g_udp_class_id);
  JS_SetOpaque(obj, new UdpPtr(u));
  u->self = JS_DupValue(ctx, obj);

  std::weak_ptr<UdpSock> wk = u;
  hal_net::PollHandler h;
  h.on_readable = [wk](int rfd) {
    UdpPtr u = wk.lock();
    if (!u || u->torn.load()) return;
    for (;;) {
      struct sockaddr_in peer = {};
      socklen_t plen = sizeof(peer);
      ssize_t r = ::recvfrom(rfd, g_rxbuf, sizeof(g_rxbuf), 0, (struct sockaddr*)&peer, &plen);
      if (r < 0) break;  // EWOULDBLOCK
      char ipstr[16] = {0};
      inet_ntoa_r(peer.sin_addr, ipstr, sizeof(ipstr));
      auto bytes = std::make_shared<std::vector<uint8_t>>(g_rxbuf, g_rxbuf + r);
      std::string host = ipstr;
      int port = ntohs(peer.sin_port);
      pxjs::run_on_js([u, bytes, host, port]() {
        if (pxjs::vm_stale(u->gen) || u->on_msg.empty()) return;
        JSContext* c = u->ctx;
        JSValue msg = JS_NewObject(c);
        JSValue ab = pxjs::new_ab_copy(c, bytes->data(), bytes->size());
        if (JS_IsException(ab)) {
          JS_FreeValue(c, JS_GetException(c));
          JS_FreeValue(c, msg);
          return;
        }
        JS_SetPropertyStr(c, msg, "data", ab);
        JS_SetPropertyStr(c, msg, "host", JS_NewString(c, host.c_str()));
        JS_SetPropertyStr(c, msg, "port", JS_NewInt32(c, port));
        u->on_msg.dispatch(c, 1, &msg);
        JS_FreeValue(c, msg);
      });
    }
  };
  h.on_error = [wk](int) {
    UdpPtr u = wk.lock();
    if (u) udp_teardown(u);
  };
  NetPoll::instance().add(fd, std::move(h));
  return obj;
}

// ============================================================ mDNS

/** 幂等 mdns_init(devd 可能已初始化,忽略重复错误) */
static esp_err_t mdns_ensure() {
  static bool done = false;
  if (done) return ESP_OK;
  esp_err_t err = mdns_init();
  if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
    done = true;
    return ESP_OK;
  }
  return err;
}

/** "_pixelbox._tcp" → {"_pixelbox", "_tcp"};失败返回 false */
static bool parse_service(const std::string& full, std::string& srv, std::string& proto) {
  size_t pos = full.rfind('.');
  if (pos == std::string::npos || pos == 0 || pos + 1 >= full.size()) return false;
  srv = full.substr(0, pos);
  proto = full.substr(pos + 1);
  return !srv.empty() && (proto == "_tcp" || proto == "_udp");
}

struct MdnsSvcInfo {
  std::string name, host, ip;
  int port = 0;
  std::vector<std::pair<std::string, std::string>> txt;
};

static JSValue js_mdns_discover(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "discover(service, opts?) 缺少 service");
  std::string full = pxjs::to_std_string(ctx, argv[0]);
  std::string srv, proto;
  if (!parse_service(full, srv, proto))
    return pxjs::throw_msg(ctx, "service 格式应为 \"_name._tcp\": %s", full.c_str());
  int timeout_ms = 3000;
  if (argc >= 2) timeout_ms = pxjs::opt_int_prop(ctx, argv[1], "timeoutMs", 3000);

  if (mdns_ensure() != ESP_OK) return pxjs::throw_msg(ctx, "mDNS 初始化失败");

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  pxjs::worker_submit([srv, proto, timeout_ms, prom]() {
    mdns_result_t* results = nullptr;
    esp_err_t err = mdns_query_ptr(srv.c_str(), proto.c_str(), (uint32_t)timeout_ms, 20, &results);
    if (err != ESP_OK) {
      prom->reject_msg("mDNS 查询失败");
      return;
    }
    auto list = std::make_shared<std::vector<MdnsSvcInfo>>();
    for (mdns_result_t* r = results; r; r = r->next) {
      MdnsSvcInfo info;
      info.name = r->instance_name ? r->instance_name : "";
      info.host = r->hostname ? std::string(r->hostname) + ".local" : "";
      info.port = r->port;
      for (mdns_ip_addr_t* a = r->addr; a; a = a->next) {
        if (a->addr.type == ESP_IPADDR_TYPE_V4) {
          char buf[16];
          snprintf(buf, sizeof(buf), IPSTR, IP2STR(&a->addr.u_addr.ip4));
          info.ip = buf;
          break;
        }
      }
      for (size_t i = 0; i < r->txt_count; i++) {
        info.txt.emplace_back(r->txt[i].key ? r->txt[i].key : "",
                              r->txt[i].value ? r->txt[i].value : "");
      }
      list->push_back(std::move(info));
    }
    mdns_query_results_free(results);

    prom->resolve_on_js([list](JSContext* c) {
      JSValue arr = JS_NewArray(c);
      uint32_t i = 0;
      for (const auto& info : *list) {
        JSValue o = JS_NewObject(c);
        JS_SetPropertyStr(c, o, "name", JS_NewString(c, info.name.c_str()));
        JS_SetPropertyStr(c, o, "host", JS_NewString(c, info.host.c_str()));
        JS_SetPropertyStr(c, o, "ip", JS_NewString(c, info.ip.c_str()));
        JS_SetPropertyStr(c, o, "port", JS_NewInt32(c, info.port));
        JSValue txt = JS_NewObject(c);
        for (const auto& [k, v] : info.txt)
          JS_SetPropertyStr(c, txt, k.c_str(), JS_NewString(c, v.c_str()));
        JS_SetPropertyStr(c, o, "txt", txt);
        JS_SetPropertyUint32(c, arr, i++, o);
      }
      return arr;
    });
  });
  return promv;
}

/** advertise 的 Unsubscribe:data[0]=service, data[1]=proto */
static JSValue mdns_unadvertise(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                                JSValue* data) {
  std::string srv = pxjs::to_std_string(ctx, data[0]);
  std::string proto = pxjs::to_std_string(ctx, data[1]);
  mdns_service_remove(srv.c_str(), proto.c_str());
  return JS_UNDEFINED;
}

static JSValue js_mdns_advertise(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1 || !JS_IsObject(argv[0]))
    return pxjs::throw_msg(ctx, "advertise({name, service, port, txt?}) 参数错误");
  std::string name = pxjs::opt_str_prop(ctx, argv[0], "name", "pixelbox");
  std::string full = pxjs::opt_str_prop(ctx, argv[0], "service", "");
  int port = pxjs::opt_int_prop(ctx, argv[0], "port", 0);
  std::string srv, proto;
  if (!parse_service(full, srv, proto) || port <= 0 || port > 65535)
    return pxjs::throw_msg(ctx, "advertise: service/port 非法");

  if (mdns_ensure() != ESP_OK) return pxjs::throw_msg(ctx, "mDNS 初始化失败");

  // txt 记录(mdns_service_add 内部会拷贝字符串)
  std::vector<std::string> keys, vals;
  std::vector<mdns_txt_item_t> items;
  JSValue txtv = JS_GetPropertyStr(ctx, argv[0], "txt");
  if (JS_IsObject(txtv)) {
    JSPropertyEnum* tab = nullptr;
    uint32_t n = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &n, txtv, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
      for (uint32_t i = 0; i < n; i++) {
        const char* key = JS_AtomToCString(ctx, tab[i].atom);
        if (key) {
          JSValue val = JS_GetProperty(ctx, txtv, tab[i].atom);
          keys.push_back(key);
          vals.push_back(pxjs::to_std_string(ctx, val));
          JS_FreeValue(ctx, val);
          JS_FreeCString(ctx, key);
        }
        JS_FreeAtom(ctx, tab[i].atom);
      }
      js_free(ctx, tab);
    }
  }
  JS_FreeValue(ctx, txtv);
  for (size_t i = 0; i < keys.size(); i++) {
    items.push_back({keys[i].c_str(), vals[i].c_str()});
  }

  esp_err_t err = mdns_service_add(name.c_str(), srv.c_str(), proto.c_str(), (uint16_t)port,
                                   items.empty() ? nullptr : items.data(), items.size());
  if (err != ESP_OK) return pxjs::throw_msg(ctx, "mDNS 服务注册失败: %s", esp_err_to_name(err));

  JSValue data[2] = {JS_NewString(ctx, srv.c_str()), JS_NewString(ctx, proto.c_str())};
  JSValue unsub = JS_NewCFunctionData(ctx, mdns_unadvertise, 0, 0, 2, data);
  JS_FreeValue(ctx, data[0]);
  JS_FreeValue(ctx, data[1]);
  return unsub;
}

// ============================================================ hostname

static JSValue js_hostname(JSContext* ctx, JSValueConst, int, JSValueConst*) {
  esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  const char* name = nullptr;
  if (netif && esp_netif_get_hostname(netif, &name) == ESP_OK && name && name[0]) {
    return JS_NewString(ctx, name);
  }
  return JS_NewString(ctx, "pixelbox");
}

// ============================================================ 模块注册

static void register_classes(JSContext* ctx) {
  JSRuntime* rt = JS_GetRuntime(ctx);
  static bool ids_done = false;
  if (!ids_done) {
    JS_NewClassID(rt, &g_tcp_class_id);
    JS_NewClassID(rt, &g_server_class_id);
    JS_NewClassID(rt, &g_udp_class_id);
    ids_done = true;
  }
  static const JSClassDef tcp_def = {.class_name = "PxTcpSocket", .finalizer = js_tcp_finalizer};
  static const JSClassDef srv_def = {.class_name = "PxTcpServer", .finalizer = js_server_finalizer};
  static const JSClassDef udp_def = {.class_name = "PxUdpSocket", .finalizer = js_udp_finalizer};
  JS_NewClass(rt, g_tcp_class_id, &tcp_def);
  JS_NewClass(rt, g_server_class_id, &srv_def);
  JS_NewClass(rt, g_udp_class_id, &udp_def);

  // TcpSocket 原型
  JSValue tcp_proto = JS_NewObject(ctx);
  pxjs::set_method(ctx, tcp_proto, "send", js_tcp_send, 1);
  pxjs::set_method(ctx, tcp_proto, "close", js_tcp_close, 0);
  pxjs::set_method(ctx, tcp_proto, "onData", js_tcp_on_data, 1);
  pxjs::set_method(ctx, tcp_proto, "onClose", js_tcp_on_close, 1);
  pxjs::set_method(ctx, tcp_proto, "onError", js_tcp_on_error, 1);
  JSAtom a = JS_NewAtom(ctx, "connected");
  JSValue getter = JS_NewCFunction(ctx, js_tcp_get_connected, "get connected", 0);
  JS_DefinePropertyGetSet(ctx, tcp_proto, a, getter, JS_UNDEFINED, JS_PROP_ENUMERABLE);
  JS_FreeAtom(ctx, a);
  JS_SetClassProto(ctx, g_tcp_class_id, tcp_proto);

  // TcpServer 原型
  JSValue srv_proto = JS_NewObject(ctx);
  pxjs::set_method(ctx, srv_proto, "close", js_server_close, 0);
  JS_SetClassProto(ctx, g_server_class_id, srv_proto);

  // UdpSocket 原型
  JSValue udp_proto = JS_NewObject(ctx);
  pxjs::set_method(ctx, udp_proto, "send", js_udp_send, 3);
  pxjs::set_method(ctx, udp_proto, "onMessage", js_udp_on_message, 1);
  pxjs::set_method(ctx, udp_proto, "close", js_udp_close, 0);
  JS_SetClassProto(ctx, g_udp_class_id, udp_proto);
}

static void net_module_init(JSContext* ctx, JSValue px) {
  pxjs::set_ctx(ctx);
  NetPoll::instance().ensure_start();
  register_classes(ctx);

  JSValue net = JS_NewObject(ctx);
  pxjs::set_method(ctx, net, "connectTcp", js_connect_tcp, 1);
  pxjs::set_method(ctx, net, "listenTcp", js_listen_tcp, 1);
  pxjs::set_method(ctx, net, "createUdp", js_create_udp, 1);
  pxjs::set_method(ctx, net, "hostname", js_hostname, 0);

  JSValue mdns_obj = JS_NewObject(ctx);
  pxjs::set_method(ctx, mdns_obj, "discover", js_mdns_discover, 2);
  pxjs::set_method(ctx, mdns_obj, "advertise", js_mdns_advertise, 1);
  JS_SetPropertyStr(ctx, net, "mdns", mdns_obj);

  JS_SetPropertyStr(ctx, px, "net", net);
  ESP_LOGI(TAG, "px.net 已注册");
}

static const jsvm::Module k_net_module = {
    .name = "net",
    .priority = 10,
    .init = net_module_init,
    .prelude = nullptr,
};
JSVM_REGISTER_MODULE(k_net_module);
