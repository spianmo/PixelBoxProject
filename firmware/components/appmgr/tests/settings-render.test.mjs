import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../src/settings_app.js', import.meta.url)), 'utf8');
// 参考实现每帧从空屏重绘，逐像素检查保留帧缓冲是否漏清、漏画。
const referenceSource = source.replace('if (!renderDirty) return false;', 'fullRedraw = true;');
assert.notEqual(referenceSource, source);

function createDevice(code, width, height, cacheEnabled = true) {
  const pixels = new Uint32Array(width * height);
  let drawCalls = [], frameCallback, touchCallback, exitCallback, scanResolve, connectReject, connectResolve, rendered;
  let frameUnsubscribed = 0, touchUnsubscribed = 0;
  let status = { connected: true, ssid: 'Finger', ip: '192.168.31.100', mac: '00:11:22:33:44:55' };
  let memory = 88000, battery = 82, fps = 30, liveCanvases = 0, peakCanvases = 0, failAllocation = false;
  const setPixel = (x, y, c) => {
    x |= 0; y |= 0;
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = c;
  };
  const fill = (x, y, w, h, c) => {
    x |= 0; y |= 0; w |= 0; h |= 0;
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      pixels.fill(c, yy * width + Math.max(0, x), yy * width + Math.max(0, Math.min(width, x + w)));
    }
  };
  const line = (x0, y0, x1, y1, c) => {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      setPixel(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e = 2 * error;
      if (e >= dy) { error += dy; x0 += sx; }
      if (e <= dx) { error += dx; y0 += sy; }
    }
  };
  const metrics = (text, style = {}) => {
    const h = style.font === 'pixel16' ? 16 : 12, scale = style.scale || 1;
    return { width: [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? h / 2 : h), 0) * scale, height: h * scale };
  };
  const screen = {
    width, height, _pixels: pixels, dispose() { this._pixels = null; }, getBrightness: () => 80, setBrightness() {}, setFps: value => { fps = value; },
    onFrame: fn => { frameCallback = fn; return () => { frameCallback = null; frameUnsubscribed++; }; }, measureText: metrics,
    clear(c) { drawCalls.push(['clear']); pixels.fill(c); },
    fillRect(x, y, w, h, c) { drawCalls.push(['fillRect', x, y, w, h]); fill(x, y, w, h, c); },
    fillRects(rects) {
      for (let i = 0; i < rects.length; i += 5) this.fillRect(...rects.slice(i, i + 5));
    },
    drawRect(x, y, w, h, c) {
      drawCalls.push(['drawRect', x, y, w, h]);
      line(x, y, x + w - 1, y, c); line(x, y + h - 1, x + w - 1, y + h - 1, c);
      line(x, y, x, y + h - 1, c); line(x + w - 1, y, x + w - 1, y + h - 1, c);
    },
    drawLine(x0, y0, x1, y1, c) { drawCalls.push(['drawLine', x0, y0, x1, y1]); line(x0, y0, x1, y1, c); },
    drawCircle(cx, cy, radius, c) {
      drawCalls.push(['drawCircle']);
      for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
        if (Math.abs(Math.sqrt(x * x + y * y) - radius) < .6) setPixel(cx + x, cy + y, c);
      }
    },
    fillCircle(cx, cy, radius, c) {
      drawCalls.push(['fillCircle']);
      for (let y = -radius; y <= radius; y++) {
        const x = Math.floor(Math.sqrt(radius * radius - y * y)); fill(cx - x, cy + y, x * 2 + 1, 1, c);
      }
    },
    drawImage(source, x, y, options = {}) {
      drawCalls.push(['drawImage', x, y, options.sw ?? source.width, options.sh ?? source.height]);
      const sx = options.sx ?? 0, sy = options.sy ?? 0, sw = options.sw ?? source.width, sh = options.sh ?? source.height;
      for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
        setPixel(x + xx, y + yy, source._pixels[(sy + yy) * source.width + sx + xx]);
      }
    },
    _composeRows(sources, geometry, rects, top, bottom, background) {
      drawCalls.push(['drawImage', 0, top, width, 0]);
      // 独立逐像素参考：候选块扩到8像素边界，再从当前有序行求最终颜色。
      for (let y = top; y < bottom; y++) {
        const marked = new Uint8Array(width);
        for (let n = 0; n < rects.length; n += 4) if (y >= rects[n + 1] && y < rects[n + 1] + rects[n + 3])
          marked.fill(1, Math.max(0, Math.floor(rects[n] / 8) * 8), Math.min(width, Math.ceil((rects[n] + rects[n + 2]) / 8) * 8));
        const rowIndex = sources.findIndex((_, n) => y >= geometry[n * 2] && y < geometry[n * 2] + geometry[n * 2 + 1]);
        for (let x = 0; x < width; x++) if (marked[x])
          setPixel(x, y, rowIndex < 0 ? background : sources[rowIndex]._pixels[(y - geometry[rowIndex * 2]) * width + x]);
      }
    },
    _drawImageRegions(source, x, y, rects, top, bottom) {
      // 单独按源坐标裁剪；C 实现另由真实 QuickJS/UBSan 回归验证。
      for (let i = 0; i < rects.length; i += 4) {
        const [sx, sy, sw, sh] = rects.slice(i, i + 4);
        const first = Math.max(top, y + sy), last = Math.min(bottom, y + sy + sh);
        if (first < last) this.drawImage(source, x + sx, first, { sx, sy: first - y, sw, sh: last - first });
      }
    },
    drawText(text, x, y, style = {}) {
      drawCalls.push(['drawText', text, x, y]);
      const m = metrics(text, style);
      x = (x - (style.align === 'center' ? m.width / 2 : style.align === 'right' ? m.width : 0)) | 0;
      // 用覆盖到字体边界的确定性图案代替字库，特别检查半可见文字的边缘修补。
      for (const ch of text) {
        const cw = metrics(ch, style).width, cp = ch.charCodeAt(0);
        for (let dy = 0; dy < m.height; dy++) for (let dx = 0; dx < cw; dx++) {
          if ((dx + dy + cp) % 3 !== 0) setPixel(x + dx, y + dy, style.color ?? 0xffffff);
        }
        x += cw;
      }
    },
  };
  if (process.env.PX_SETTINGS_COMPOSE === '0') delete screen._composeRows;
  if (cacheEnabled) screen.createCanvas = (w, h) => {
    if (failAllocation) throw new Error('simulated canvas allocation failure');
    const canvas = createDevice('', w, h, false).screen;
    liveCanvases++;
    peakCanvases = Math.max(peakCanvases, liveCanvases);
    canvas.dispose = () => { if (canvas._pixels) liveCanvases--; canvas._pixels = null; };
    return canvas;
  };
  const context = vm.createContext({
    px: {
      app: { onExit: fn => { exitCallback = fn; } },
      screen, audio: { getVolume: () => 70, setVolume() {} },
      input: { onTouch: fn => { touchCallback = fn; return () => { touchCallback = null; touchUnsubscribed++; }; } },
      system: { battery: () => ({ level: battery }), memory: () => ({ heapFree: memory, psramFree: 8000000 }), info: () => ({ model: 'ESP32-S3', firmwareVersion: 'NuttX' }) },
      wifi: {
        status: () => ({ ...status }),
        scan: () => new Promise(resolve => { scanResolve = resolve; }),
        connect: () => new Promise((resolve, reject) => { connectResolve = resolve; connectReject = reject; }),
        disconnect: () => { status = { ...status, connected: false, ssid: '', ip: '' }; },
      },
    },
    console: { log() {}, error() {} }, setTimeout() {},
  });
  vm.runInContext(code, context);
  return {
    pixels, screen, api: context.__pxset,
    get liveCanvases() { return liveCanvases; }, get peakCanvases() { return peakCanvases; },
    get frameUnsubscribed() { return frameUnsubscribed; }, get touchUnsubscribed() { return touchUnsubscribed; },
    failAllocation() { failAllocation = true; },
    get calls() { return drawCalls; }, get rendered() { return rendered; }, get fps() { return fps; },
    step(dt = 1000 / 60) { drawCalls = []; rendered = frameCallback(dt); },
    touch: ev => touchCallback(ev), scan: list => scanResolve(structuredClone(list)),
    exit: () => exitCallback(),
    reject: () => connectReject(new Error('test failure')),
    resolve: () => { status = { ...status, connected: true, ssid: 'Network-00', ip: '192.168.31.101' }; connectResolve(status); },
    changeStatus: value => { status = { ...status, ...value }; },
    changeValues() { memory += 1024; battery++; },
  };
}

let frames = 0;
for (const [width, height] of [[368, 448], [410, 502], [480, 480]]) {
  const device = createDevice(source, width, height), reference = createDevice(referenceSource, width, height, false);
  let stage = 'initial';
  const both = fn => { fn(device); fn(reference); };
  const step = (count = 1, dt = 1000 / 60) => {
    for (let f = 0; f < count; f++) {
      both(d => d.step(dt)); frames++;
      const mismatch = device.pixels.findIndex((p, i) => p !== reference.pixels[i]);
      assert.equal(mismatch, -1, `${width}x${height} ${stage} frame ${frames} mismatch at ${mismatch % width},${Math.floor(mismatch / width)}`);
    }
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const tap = point => both(d => d.api.tap(point.x, point.y));
  const key = ch => tap(device.api.key(ch));
  const drag = (x, y, distance) => {
    both(d => d.api.down(x, y));
    for (let i = 0; i < 75; i++) { both(d => d.api.move(x, y - distance * i / 74)); step(); }
    both(d => d.api.up(x, y - distance)); step();
  };

  step(3);
  assert.equal(device.rendered, false, '静止主页应返回 false 跳过 flush');
  assert.equal(device.calls.length, 0);
  assert.ok(device.liveCanvases > 0, '使用不透明行缓存');
  stage = 'main scroll'; drag(20, height * .7, height * .34); drag(20, height * .3, -height * .34);
  both(d => d.changeValues()); step(2, 1000);
  stage = 'slider cache invalidation'; tap({ x: width * .63, y: height * .16 + Math.round(height * .105) / 2 }); step();
  // 单次滚动帧应保留屏幕底部完整提示，避免重画整个固定区域。
  both(d => { d.api.down(20, height * .6); d.api.move(20, height * .55); d.api.move(20, height * .53); }); step();
  assert.ok(!device.calls.some(c => c[0] === 'drawText'), '已缓存列表滚动不应重画字体');
  assert.ok(device.calls.some(c => c[0] === 'drawImage'), '滚动使用原生画布复制');
  assert.ok(device.calls.filter(c => c[0] === 'drawImage').reduce((n, c) => n + c[3] * c[4], 0) < width * height * .45,
    '文字/图标块复制面积应显著小于整张屏幕');
  assert.ok(!device.calls.some(c => c[0] === 'fillRect' && c[1] === 0 && c[3] === width), '缓存命中不能先清视口');
  both(d => d.api.up(20, height * .53)); step();
  stage = 'wifi scanning'; tap(device.api.rows.wifi); step(24);
  const networks = Array.from({ length: 18 }, (_, i) => ({ ssid: `Network-${String(i).padStart(2, '0')}`, secure: true, rssi: -30 - i * 3 }));
  both(d => d.scan(networks)); await settle(); step();
  stage = 'wifi scroll'; drag(width / 2, height * .85, height * .5); drag(width / 2, height * .3, -height * .5);
  assert.ok(device.peakCanvases <= Math.ceil(height / Math.min(Math.round(height * .105), Math.round(height * .1))) + 2, 'AP 增长不能突破一屏缓存上限');
  stage = 'wifi scan cache invalidation'; tap({ x: width - 20, y: 20 }); step();
  both(d => d.scan(networks.map((item, i) => ({ ...item, rssi: -35 - i * 2, secure: i % 2 === 0 }))));
  await settle(); step();
  both(d => d.changeStatus({ ssid: 'Network-00' })); step(1, 300);
  both(d => d.changeStatus({ ssid: 'Finger' })); step(1, 300);
  stage = 'wifi reconnect status'; both(d => d.changeStatus({ connected: false })); step(1, 300);
  drag(width / 2, height * .8, height * .3); drag(width / 2, height * .3, -height * .3);
  both(d => d.changeStatus({ connected: true })); step(1, 300);
  stage = 'password'; tap(device.api.listRow(0)); step(20);
  assert.equal(device.api.state().page, 'pass');
  assert.equal(device.liveCanvases, 0, '密码页释放列表缓存');
  assert.ok(!device.calls.some(c => c[0] === 'fillRect' && c[2] >= Math.round(height * .56)), '光标闪烁不得重画键盘');
  for (const ch of ['a', 'b', 'c', 'shift', 'D', 'num', '1', '2', 'sym', '@', 'abc', 'space']) { key(ch); step(); }
  // 真实按下和抬起分帧，验证局部按键高亮和跨键取消。
  const q = device.api.key('q'); both(d => d.api.down(q.x, q.y)); step();
  assert.ok(device.calls.filter(c => c[0] === 'drawText' && c[3] > height * .56).length <= 2);
  both(d => d.api.move(0, 0)); step(); both(d => d.api.up(0, 0)); step(80);
  const bksp = device.api.key('bksp'); both(d => d.api.down(bksp.x, bksp.y)); step(70);
  both(d => d.api.up(bksp.x, bksp.y)); step();
  tap({ x: width * .9, y: height * .19 }); step();
  for (let i = 0; i < 48; i++) { key('x'); step(); }
  stage = 'connect overlay'; key('ok'); step(24);
  assert.ok(!device.calls.some(c => c[0] === 'drawText' && c[3] > height * .64), '连接动画不得重画键盘');
  stage = 'connect failure'; both(d => d.reject()); await settle(); step();
  stage = 'connect success'; key('ok'); step(); both(d => d.resolve()); await settle(); step(4);
  stage = 'toast removal'; step(1, 2700);
  stage = 'open AP failure';
  tap({ x: width - 20, y: 20 }); step();
  both(d => d.scan([{ ssid: 'Open', secure: false, rssi: -30 }, ...networks]));
  await settle(); step();
  tap(device.api.listRow(0)); step(24);
  both(d => d.reject()); await settle(); step();
  step(1, 2700);
  stage = 'back main'; tap({ x: 20, y: 20 }); step(3);
  assert.equal(device.api.state().page, 'main');
  stage = 'allocation failure'; device.failAllocation(); tap(device.api.rows.wifi);
  both(d => d.scan(networks)); await settle(); step();
  drag(width / 2, height * .85, height * .5);
  assert.equal(device.liveCanvases, 0, '分配失败释放已有缓存并回退');
}
const exiting = createDevice(source, 480, 480);
exiting.step();
assert.ok(exiting.liveCanvases > 0, '设置页应持有行画布');
exiting.exit();
assert.equal(exiting.liveCanvases, 0, '退出设置页应立即释放行画布');
assert.equal(exiting.frameUnsubscribed, 1, '退出设置页应停止帧回调');
assert.equal(exiting.touchUnsubscribed, 1, '退出设置页应停止触摸回调');
exiting.exit();
assert.equal(exiting.liveCanvases, 0, '退出钩子重复执行也不应重复释放');
assert.equal(exiting.frameUnsubscribed, 1, '重复退出不应再次退订帧回调');
assert.equal(exiting.touchUnsubscribed, 1, '重复退出不应再次退订触摸回调');
console.log(`settings retained rendering: ${frames} frames pixel-equivalent at 3 display sizes`);
