# hal_net — 网络 HAL

与 JS 无关的纯 C++ 网络硬件抽象层,供 `bindings_net` 使用。

## 提供的能力

| 头文件 | 内容 |
|---|---|
| `hal_net/wifi_manager.hpp` | `WifiManager` 单例:STA 连接、NVS 凭据持久化(命名空间 `px_wifi`)、开机自动连接、断线指数退避重连(1s→30s)、异步扫描、SoftAP |
| `hal_net/net_poll.hpp` | `NetPoll` 单例:单一 `select()` 循环任务统一管理所有 lwip fd(TCP/UDP),回调在 poll 任务上下文执行 |

## 线程模型约定

- `WifiManager` 事件监听回调在 **esp_event 任务** 上下文执行;
- `NetPoll` 三类回调(readable/writable/error)在 **poll 任务** 上下文执行;
- 两者都 **不得阻塞、不得直接调用 JS_\*** —— 上层 `bindings_net` 负责经
  `jsvm::post` 把结果投递到 JS 线程(见 docs/architecture.md §4.1)。

## fd 生命周期纪律

`close(fd)` 必须通过 `NetPoll::post_task()` 投递到 poll 线程执行,避免
select 使用中的 fd 被其他线程关闭/复用导致的竞态。`remove(fd)` 只注销监听,
不负责关闭。
