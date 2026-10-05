/* 进入请求由常驻 service 接收后停止当前 VM；不返回依赖旧 VM 存活的 Promise。 */
/* 未编译门户时保留明确 ENOTSUP 契约，加载主 prelude 不依赖缺失的 native。 */
px.wifi.portal = Object.freeze(native.wifiPortal ? {
  start() { native.wifiPortal.start(); },
  stop() { native.wifiPortal.stop(); },
  status() { return native.wifiPortal.status(); }
} : {start: unsupported, stop: unsupported, status: unsupported});
