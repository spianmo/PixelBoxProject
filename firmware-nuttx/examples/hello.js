console.log('PixelBox on NuttX', JSON.stringify(px.system.info()));
console.log('SHA-256', px.util.hexEncode(px.util.sha256('hello NuttX')));

// 同一份上层脚本使用原有 px/pixelbox FFI，无需导入 NuttX 专有模块。
let count = 0;
const timer = setInterval(() => {
  console.log('tick', ++count, 'heap', px.system.memory().jsHeapUsed);
  if (count === 3) clearInterval(timer);
}, 100);
px.app.onExit(() => console.log('application stopped'));
