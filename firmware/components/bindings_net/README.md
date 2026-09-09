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
  WS close 等阻塞操作。S3 栈使用 PSRAM，TCB 保持内部 RAM；无 PSRAM 时使用内部栈。
  无顺序保证，顺序敏感操作和 Flash 写入勿提交。所有 worker 创建失败时立即返回
  `NETWORK_WORKER_ALLOC_FAILED`，不将请求留在无人处理的队列中，后续提交会重试创建。
  普通请求最多排队 16 个；跨 VM 的旧请求在执行前丢弃，WebSocket 关闭/销毁任务保留。
  排队超过 250 毫秒会记录等待时间；HTTP 记录连接、上传、响应头与总耗时，不输出请求头。
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

默认关闭 Wi-Fi modem sleep，减少交互请求和语音上传的 DTIM 等待，代价是待机功耗增加。
电池优先的项目可启用 `CONFIG_PX_WIFI_POWER_SAVE`。S3 speech 默认 TCP 收发窗口为 16 KiB，
接收队列为 14；已有 sdkconfig 需同步配置并重新烧录，不能仅推送 JS 生效。

静态 Wi-Fi TX 缓冲至少保留 16 个，HAL 初始化也会将旧配置的 8 个提升到 16 个。
8 个槽无法承接 16 KiB TCP 窗口的突发发送；实机可在内部 RAM 尚有余量时出现发送池
`fail_oom`，导致 TCP 等待重传、应用 PCM 队列周期性溢出。显示 QSPI 双 DMA 行带
限制为 8 行（480 宽合计 15 KiB），为网络和语音保留内部 RAM，不能只看 PSRAM 余量。

## 依赖

- 托管组件:`espressif/mdns`、`espressif/esp_websocket_client`(见 idf_component.yml)
- 内部组件:`jsvm`(公开头 + quickjs.h)、`hal_net`

## 实时 WebSocket 发送

WebSocket 使用显式持有的标准 TCP/TLS transport，在 CONNECTED 事件中对底层 socket 设置 `TCP_NODELAY`。固件对自己登记的 transport 合并帧头与掩码负载，在客户端既有 TX 锁内一次提交；部分写继续同一帧的剩余字节，并共用总截止时间。通过链接器 `--wrap=esp_transport_ws_send_raw` 接入，不修改本机 IDF 或托管依赖；未登记的 transport 仍调用 IDF 原函数。服务端设置 TCP_NODELAY 仅影响下行。TLS 仍使用系统 CA 证书包，路径、查询、Basic 认证、子协议和控制帧按标准 transport 处理。客户端销毁完成后再释放 transport。

原生发送队列仍限制为 65536 字节/16 条，每 5 秒输出累计发送字节、待发队列和最大写入耗时，不记录内容。`node tools/check-websocket-transport.mjs <设备地址> <本机IPv4>` 覆盖真实路径/查询、认证、子协议、8192 字节二进制及分片重组。

发送 worker 在写帧前按 100ms 轮询可写状态，最多等待 10 秒，期间不持有客户端发送锁。避免底层库将暂时不可写当作传输错误直接销毁连接。进入写帧后沿用 10 秒网络操作超时，失败立即停止队列并关闭，不能重发部分写入的整帧。`node tools/check-websocket-backpressure.mjs <设备地址> <本机IPv4>` 验证接收窗口暂停 4 秒后仍保持连接和数据顺序。错误日志只记录类型、可用 errno/TLS 错误码与内部堆余量。

`bash firmware/components/bindings_net/test_host/build_run.sh` 覆盖帧长度边界、掩码、控制帧、延续帧、部分写、内存失败和超时。完整帧发送的实机拥堵改善效果尚未验证，见 `docs/pixelbox-voice-congestion.md`。
