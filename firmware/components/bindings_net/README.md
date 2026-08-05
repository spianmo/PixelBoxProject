# bindings_net — 网络域 JS 绑定

把网络能力按 `sdk/types/pixelbox.d.ts` 契约暴露给 JS 运行时。包含 5 个 jsvm 模块:

| 模块名 | priority | 提供 |
|---|---|---|
| `wifi` | 10 | `px.wifi`(scan / connect / disconnect / status / on / startAP / stopAP) |
| `fetch` | 10 | 全局 `fetch()`(esp_http_client + esp_crt_bundle) |
| `websocket` | 10 | 全局 `WebSocket` 类(esp_websocket_client) |
| `net` | 10 | `px.net`(connectTcp / listenTcp / createUdp / mdns / hostname) |
| `system_net` | 20 | 向 `px.system` 追加 `ntpSync` / `otaCheck` / `otaApply` |

## 线程模型

- 所有 JS_* 调用只发生在 JS 线程;HAL / esp_event / poll / worker 线程一律经
  `jsvm::post`(封装为 `pxjs::run_on_js`)投递(architecture.md §4.1)。
- **worker 池**(`net_worker`,2 任务 × 12KB 栈):fetch、TLS 握手、mDNS 查询、
  WS close 等阻塞操作。无顺序保证,顺序敏感操作勿提交。
- **poll 线程**(hal_net::NetPoll):TCP/UDP 的读、发送队列排空、accept;
  所有 `close(fd)` 经 `post_task` 在 poll 线程执行,避免 fd 复用竞态。
- **OTA 独立任务**:otaApply 持续数分钟,单独 12KB 任务,进度回调
  (download → write → verify)按整数百分比去重后投递 JS。

## 内存策略

- fetch 响应体收入 **PSRAM**(`heap_caps_malloc(MALLOC_CAP_SPIRAM)`,内部 RAM
  兜底),上限 **2MB**,超限整个请求 reject;
- 响应体零拷贝移交 `ArrayBuffer`(GC 时 `heap_caps_free`);`arrayBuffer()`
  返回同一底层缓冲的引用(不复制,注意勿原地修改后再 `text()`);
- WebSocket 消息 / TCP 数据 → `ArrayBuffer` 同样 PSRAM 优先。

## 生命周期纪律

- 活动连接(WS 已连 / TCP 已连 / 服务器监听中 / UDP 已绑定)`dup` 持有自身
  JS 对象防 GC,终态(close/error)派发后释放;
- VM 热重启:所有跨线程回投均校验 `ctx == 当前 VM ctx`,旧 VM 的挂起
  Promise / 回调静默失效,native fd 由对象 finalizer 兜底关闭;
- Unsubscribe 闭包持宿主 weak_ptr 守卫,宿主析构后调用为空操作。

## 凭据与持久化

WiFi 凭据存 NVS 命名空间 `px_wifi`(`connect(..., {save:false})` 可跳过);
开机由 `hal_net::WifiManager::ensure_init()` 自动连接,断线 1s→30s 指数退避重连。

## 依赖

- 托管组件:`espressif/mdns`、`espressif/esp_websocket_client`(见 idf_component.yml)
- 内部组件:`jsvm`(公开头 + quickjs.h)、`hal_net`
