# bindings_screen — px.screen JS 绑定

`JSVM_REGISTER_MODULE("screen", priority 10)`,契约:
`sdk/types/pixelbox.d.ts` 的 `PxScreen` / `PxDrawTarget` / `PxCanvas` / `PxAnimation`。

## 结构

- `src/bindings_screen.cpp` — native 绑定:
  - `px.screen` 与 `PxCanvas` **共用一个 QuickJS class**(共享全部绘图
    方法与 `width`/`height` getter),以 opaque `CanvasHandle` 区分主屏
    (动态取 `hal_display` 帧缓冲,绘图后登记脏矩形)与离屏画布
    (PSRAM 像素,finalizer/dispose 释放);
  - `onFrame`:esp_timer 按 `setFps`(1-60,默认 30)周期在定时器任务发
    tick,经 `jsvm::post` 投递到 JS 线程执行(**不跨线程调 JS_\***);
    JS 忙时原子标记跳帧,防事件队列堆积;回调返回后自动 `flush()`;
    退订闭包移除订阅,空订阅自动停表;VM 热重启由 teardown 钩子清理;
  - `drawImage` 三种 src:路径(经 appmgr 弱符号 `appmgr_resolve_path`
    解析,兜底 `/app`→`/flash/apps/current`、`/data`→`/flash/data`)、
    二进制(`jsvm::get_binary`)、画布;PNG alpha 掩码在直绘时生效;
    传 GIF 时取首帧;
  - 内部助手(不可枚举):`__decodeImage`(解码为新画布)、
    `__loadGifFrames`(GIF → 画布数组 + 逐帧时长,总内存 4MB 上限)、
    `__isCanvas`。
- `src/prelude_screen.js` — 纯 JS 增强(EMBED_TXTFILES):
  `createAnimation`(帧数组或雪碧图切帧)与 `loadGif` 返回 `PxAnimation`
  包装;播放计时用 `screen.onFrame` 驱动,支持 GIF 逐帧时长、loop、
  `onEnd`、`seek`;`dispose` 释放动画持有的帧画布。

## 行为说明(超出 d.ts 的实现细节)

- `drawText` 默认样式:`pixel8`、白色、scale 1、left;未知字体名回退
  `pixel8`;`scale` 截断到 1..8;支持 `\n` 多行。
- `getPixel` 返回按 565 量化后的 0xRRGGBB。
- `createCanvas` 尺寸限制 1..2048;画布 `dispose` 后再绘制抛错。
- `createAnimation` 默认 `fps=12`、`loop=true`;雪碧图从左到右、从上到
  下切帧,切完释放整图。
- 屏幕未初始化(硬件异常)时全部方法抛 `Error("ENOTSUP")`。
