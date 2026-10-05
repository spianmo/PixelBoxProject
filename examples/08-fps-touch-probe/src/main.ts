/**
 * 08 刷新率触摸测试：在真机上同时测量 onFrame 调度与 framebuffer 有效提交。
 * 触摸上下拖动彩色列表，便于直接观察滚动期间的延迟和局部更新。
 */
const W = px.screen.width;
const H = px.screen.height;
const ROW_H = Math.max(34, Math.floor(H / 9));
const ROWS = 28;
const VIEW_TOP = 48;
const VIEW_BOTTOM = H - 42;
const MAX_SCROLL = Math.max(0, ROWS * ROW_H - (VIEW_BOTTOM - VIEW_TOP));

let scroll = 0;
let gesture: { y: number; start: number; moved: boolean } | null = null;
let callbacks = 0;
let lastReportAt = 0;
let startAt = performance.now();
let baseStats = px.screen.frameStats();
let renderDirty = true;
let headerDirty = true;
let staticLayerDrawn = false;
let report = {
  callbackFps: 0, submittedFps: 0, frames: 0, updates: 0, elapsedMs: 0,
  changedPixels: 0, transmittedPixels: 0, conversionMs: 0, updateMs: 0,
};

function snapshot() {
  const elapsedMs = Math.max(1, performance.now() - startAt);
  const stats = px.screen.frameStats();
  report = {
    callbackFps: callbacks * 1000 / elapsedMs,
    submittedFps: (stats.updates - baseStats.updates) * 1000 / elapsedMs,
    frames: callbacks,
    updates: stats.updates - baseStats.updates,
    elapsedMs,
    changedPixels: stats.changedPixels - baseStats.changedPixels,
    transmittedPixels: stats.transmittedPixels - baseStats.transmittedPixels,
    conversionMs: stats.conversionMs - baseStats.conversionMs,
    updateMs: stats.updateMs - baseStats.updateMs,
  };
  /* 只在指标文字变化时重绘顶部窄条，不触发整页重绘。 */
  headerDirty = true;
  return report;
}

function drawStaticLayer(): void {
  px.screen.clear(0x080d16);
  px.screen.fillRect(0, 0, W, VIEW_TOP, 0x16263c);
  px.screen.fillRect(0, VIEW_BOTTOM, W, H - VIEW_BOTTOM, 0x16263c);
  px.screen.drawText('触摸滚动刷新率测试', 12, 14, { font: 'pixel12', scale: 1, color: 0xffffff });
  px.screen.drawText('拖动列表；数值为 回调/有效提交', W / 2, H - 26, {
    font: 'pixel12', scale: 1, color: 0x9db2c8, align: 'center',
  });
  staticLayerDrawn = true;
}

function drawHeaderMetric(): void {
  /* 清理指标所在的右上角，保留标题文字和其它静态像素。 */
  px.screen.fillRect(Math.floor(W * 0.54), 0, W - Math.floor(W * 0.54), VIEW_TOP, 0x16263c);
  const metric = report.callbackFps > 0
    ? `${report.callbackFps.toFixed(1)}/${report.submittedFps.toFixed(1)} FPS`
    : '采样中...';
  px.screen.drawText(metric, W - 12, 14, { font: 'pixel12', scale: 1, color: 0x74c7ff, align: 'right' });
  headerDirty = false;
}

// 缓存只覆盖一屏加两行；长列表不会按总行数消耗内存。
const rowCache: { index: number; canvas: PxCanvas }[] = [];
const CACHE_ROWS = Math.ceil((VIEW_BOTTOM - VIEW_TOP) / ROW_H) + 2;
function cachedRow(index: number): PxCanvas {
  const slot = index % CACHE_ROWS;
  let entry = rowCache[slot];
  if (!entry) {
    entry = { index: -1, canvas: px.screen.createCanvas(W, ROW_H) };
    rowCache[slot] = entry;
  }
  if (entry.index !== index) {
    const c = entry.canvas;
    c.clear(0x080d16);
    c.fillRect(8, 2, W - 16, ROW_H - 4, index % 2 === 0 ? 0x203550 : 0x17283e);
    c.drawText(`滚动行 ${String(index + 1).padStart(2, '0')}`, 18, 12, {
      font: 'pixel12', scale: 1, color: index % 3 === 0 ? 0x8ee6b1 : 0xe8eef6,
    });
    entry.index = index;
  }
  return entry.canvas;
}
function drawRows(): void {
  const offset = Math.round(scroll);
  for (let i = Math.floor(offset / ROW_H); i < ROWS; i++) {
    const y = VIEW_TOP + i * ROW_H - offset;
    if (y >= VIEW_BOTTOM) break;
    const top = Math.max(VIEW_TOP, y), bottom = Math.min(VIEW_BOTTOM, y + ROW_H);
    // 不先清空视口：原生拷贝可跳过同色像素，并保留固定标题/底栏。
    px.screen.drawImage(cachedRow(i), 0, top, { sx: 0, sy: top - y, sw: W, sh: bottom - top });
  }
}

function draw(): boolean {
  if (!renderDirty && !headerDirty) return false;
  if (!staticLayerDrawn) drawStaticLayer();
  if (renderDirty) {
    drawRows();
    renderDirty = false;
  }
  if (headerDirty) drawHeaderMetric();
  return true;
}

function handleTouch(event: PxTouchEvent): void {
  if (event.type === 'down') {
    gesture = { y: event.y, start: scroll, moved: false };
  } else if (event.type === 'move' && gesture) {
    if (Math.abs(event.y - gesture.y) >= 4) gesture.moved = true;
    const next = Math.max(0, Math.min(MAX_SCROLL, gesture.start - (event.y - gesture.y)));
    if (next !== scroll) {
      scroll = next;
      renderDirty = true;
    }
  } else if (event.type === 'up') {
    gesture = null;
  }
}

px.screen.setFps(60);
px.input.onTouch(handleTouch);

const api = {
  reset() {
    callbacks = 0;
    startAt = performance.now();
    baseStats = px.screen.frameStats();
    renderDirty = true;
    headerDirty = true;
    staticLayerDrawn = false;
    report = {
      callbackFps: 0, submittedFps: 0, frames: 0, updates: 0, elapsedMs: 0,
      changedPixels: 0, transmittedPixels: 0, conversionMs: 0, updateMs: 0,
    };
    return true;
  },
  /** 远程测试用的同路径拖动注入；真机触摸仍走 px.input.onTouch。 */
  swipe(x: number, y: number, x2: number, y2: number, steps = 12) {
    const count = Math.max(1, steps | 0);
    handleTouch({ type: 'down', x, y });
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      handleTouch({ type: 'move', x: x + (x2 - x) * t, y: y + (y2 - y) * t });
    }
    handleTouch({ type: 'up', x: x2, y: y2 });
    return true;
  },
  down(x: number, y: number) { handleTouch({ type: 'down', x, y }); return true; },
  move(x: number, y: number) { handleTouch({ type: 'move', x, y }); return true; },
  up(x: number, y: number) { handleTouch({ type: 'up', x, y }); return true; },
  snapshot,
};
(globalThis as unknown as { __refreshProbe?: typeof api }).__refreshProbe = api;

px.screen.onFrame((dt) => {
  callbacks++;
  if (performance.now() - lastReportAt >= 250) {
    lastReportAt = performance.now();
    snapshot();
  }
  return draw();
});

console.log('08-fps-touch-probe 已启动，调用 __refreshProbe.snapshot() 获取回调/提交 FPS');
