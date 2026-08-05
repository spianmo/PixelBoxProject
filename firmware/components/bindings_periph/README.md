# bindings_periph — 外设 JS 绑定

把 `hal_periph` 暴露为 `px.*` API,方法名/参数/返回值与 `sdk/types/pixelbox.d.ts` 严格对齐。
全部模块经 `JSVM_REGISTER_MODULE` 静态自注册(组件 `WHOLE_ARCHIVE`),priority 统一为 10(hal 域)。

## 模块与契约对照

| jsvm 模块 | 挂载点 | 要点 |
|---|---|---|
| `storage` | `px.storage.kv` / `px.storage.fs` | kv = NVS 命名空间 `pxapp`(blob 存储,set 自动 JSON 序列化,getJSON 自动解析);fs = `/data`↔`/flash/data`、`/app`↔当前应用包(只读),路径规范化拒绝 `..` 逃逸,权威映射走 `appmgr_resolve_path()` |
| `input` | `px.input` | `onTouch`/`onButton`/`onGesture`;swipe 手势在触摸驱动任务内合成(距离 ≥30px、时长 ≤800ms、主导轴判向) |
| `sensors` | `px.sensors.imu` | `start` 数据流(单回调);`onShake` 模长 >2.3g + 700ms 去抖;`onOrientation` 重力低通 + 六态判定(新订阅立即回放当前姿态) |
| `ble` | `px.ble` | peripheral:动态 GATT / notify(仅发给已订阅连接)/ 连接事件;central:scan(onDevice 增量 + 汇总)/ connect / services / read / write / subscribe;16/32/128 位 UUID 字符串 |
| `camera` | `px.camera` | Kconfig 默认关 → `available()===false` 其余抛 `Error("ENOTSUP")`;init/capture 走工作任务 + Promise;取流带背压(上一帧未消费则丢帧) |
| `gps` | `px.gps` | Kconfig 默认关;`onFix` 按 `intervalMs` 节流,`onStatus` searching/fixed/lost |
| `led` | `px.led` | Kconfig 默认关;`count` 数据属性;show 时按亮度缩放提交 |
| `util_native` | `px.util` + 全局 `__native_util` | crc32/sha256/randomBytes;幂等挂载(fw-core 已提供时不覆盖),`__native_util` 别名始终导出供 prelude 引用 |

## 线程与生命周期约定

- 事件回调全部经 `jsvm::Callback`(内部 `jsvm::post`)投递到 JS 线程,禁止跨线程 `JS_*`;
- 唯一例外:BLE 特征 `onRead` 同步读桥 —— NimBLE host 任务阻塞 ≤100ms 等 JS 线程执行
  `onRead`,超时退回特征缓存值(见 `mod_ble.cpp` §3);
- 所有订阅函数返回幂等的 `Unsubscribe`;
- VM 热重启时各模块 init 自动:清空订阅表、停 IMU/GPS 数据流、停摄像头取流、
  停 BLE 广播/扫描并断开 central 连接,保证新应用拿到干净硬件状态。

## Promise 约定

native 异步操作(camera init/capture、ble scan/connect/GATT)在 JS 线程创建
promise,决议函数包成 `jsvm::Callback` 后可从任意任务安全 resolve/reject
(VM 重启后自动失效,不会触碰已销毁的运行时)。
