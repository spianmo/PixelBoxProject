export interface RunLayerOptions {
  count?: number;
  step?: number;
  scale?: number;
  layers?: Int32Array;
  padding?: number;
  left?: number;
  right?: number;
  clipTop?: number;
  clipBottom?: number;
  margin?: number;
  color?: number;
}

export interface RunLayerResult {
  left: number;
  top: number;
  right: number;
  bottom: number;
  dx: number;
  dy: number;
  pixels: number;
}

/** 9 项逻辑坐标：[left,top,right,bottom,background,gridTop,gridBottom,gridColor,gridEnabled]。 */
export type RunLayerRestore = Float64Array;

/** 物理像素边界；right/bottom 为不包含的终点。 */
export interface PhysicalBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RectLayerOptions {
  count?: number;
  step?: number;
  scale?: number;
  x?: number;
  y?: number;
  layers?: Int32Array;
}

export interface RectTarget {
  width: number;
  height: number;
  fillRect(x: number, y: number, width: number, height: number, color: number): void;
  _pixels?: ArrayBufferView;
}

const emptyLayers = new Int32Array();

function liveInt32(value: unknown, name: string): asserts value is Int32Array {
  if (!(value instanceof Int32Array)) throw new TypeError(`${name} needs Int32Array`);
  // 创建零长视图仍会检查 detached buffer，空但未分离的输入合法。
  new Int32Array(value.buffer, value.byteOffset, 0);
}

function countFor(value: Int32Array, stride: number, requested: number | undefined): number {
  const converted = requested === undefined ? undefined : Number(requested);
  // count 的 getter/valueOf 也能分离输入；先验证，再读取可能已经变成零的 length。
  liveInt32(value, 'geometry');
  const count = converted === undefined ? value.length / stride : converted;
  if (value.length % stride || !Number.isInteger(count) || count < 0 || count > 8192 || count > value.length / stride)
    throw new RangeError('invalid batch buffer/count');
  return count;
}

function finite(value: number | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result)) throw new RangeError(`invalid ${name}`);
  return result;
}

function layoutNumber(value: number | undefined, fallback: number, name: string): number {
  const result = finite(value, fallback, name);
  if (Math.abs(result) > 1e6) throw new RangeError(`invalid ${name}`);
  return result;
}

function checkTargetAliases(pixels: ArrayBufferView | undefined, input: Int32Array, layers: Int32Array): void {
  if (!pixels || !ArrayBuffer.isView(pixels)) return;
  new Uint8Array(pixels.buffer, pixels.byteOffset, 0);
  for (const value of [input, layers]) if (pixels.buffer === value.buffer &&
    pixels.byteOffset < value.byteOffset + value.byteLength && value.byteOffset < pixels.byteOffset + pixels.byteLength)
    throw new RangeError('drawing buffer aliases pixels');
}

function drawingTarget(target: RectTarget) {
  const width = Number(target.width), height = Number(target.height);
  const pixels = target._pixels, fill = target.fillRect;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048)
    throw new RangeError('invalid canvas dimensions');
  if (typeof fill !== 'function') throw new TypeError('drawing target needs fillRect');
  return { width, height, pixels, fill: fill.bind(target) };
}

function checkOptions(options: RunLayerOptions | RectLayerOptions): void {
  if (options === null || (typeof options !== 'object' && typeof options !== 'function'))
    throw new TypeError('layer options must be an object');
}

function layersFor(layers: Int32Array): number {
  liveInt32(layers, 'layers');
  if (layers.length % 3 || layers.length > 48) throw new RangeError('invalid layer buffer');
  return layers.length / 3;
}

// 与 layoutScreen 的四次 Math.round 保持相同运算顺序，不合并乘加。
function physicalRect(fill: RectTarget['fillRect'], scale: number, x: number, y: number, w: number, h: number, color: number): void {
  const left = Math.round(x * scale), top = Math.round(y * scale);
  const width = Math.round((x + w) * scale) - left, height = Math.round((y + h) * scale) - top;
  const physicalWidth = width | 0, physicalHeight = height | 0;
  if (physicalWidth > 0 && physicalHeight > 0)
    fill(left | 0, top | 0, physicalWidth, physicalHeight, (color >>> 0) & 0xffffff);
}

export function runLayerBounds(runs: Int32Array, count: number, step: number, edge: number, left: number, right: number) {
  let top = Infinity, bottom = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = i * 3, x = runs[at] * step, y = runs[at + 1] * step;
    const start = x - edge, end = x + runs[at + 2] * step + edge + 1;
    const base = y + step + edge + 1;
    if (start < left) left = start;
    if (end > right) right = end;
    if (y - edge < top) top = y - edge;
    if (base > bottom) bottom = base;
  }
  return { left, right, top, bottom };
}

// 输入来自已按行排序的投影缓冲；仅求保守覆盖，不改变绘制数据或调用原生接口。
export function runLayerInnerRect(target: Pick<RectTarget, 'width' | 'height'>, runs: Int32Array,
    options: RunLayerOptions = {}): PhysicalBounds | undefined {
  const count = options.count ?? runs.length / 3;
  if (!count) return;
  const step = options.step ?? 1, scale = options.scale ?? 1, padding = options.padding ?? 1;
  const width = target.width / scale, clipTop = options.clipTop ?? 0, clipBottom = options.clipBottom ?? target.height / scale;
  let dx = 0, dy = 0;
  if (options.margin !== undefined) {
    let edge = 0;
    const layers = options.layers;
    if (layers) for (let i = 0; i < layers.length; i += 3) edge = Math.max(edge, Math.abs(layers[i]), Math.abs(layers[i + 1]));
    const box = runLayerBounds(runs, count, step, edge, options.left ?? Infinity, options.right ?? -Infinity);
    dx = box.left < options.margin ? options.margin - box.left : box.right > width - options.margin ? width - options.margin - box.right : 0;
    dy = box.top < clipTop ? clipTop - box.top : box.bottom > clipBottom ? clipBottom - box.bottom : 0;
  }
  // 中部一半避开耳间空隙和尖端；逐行交集保证整个矩形都将被新主体覆盖。
  const firstRow = runs[1], span = runs[(count - 1) * 3 + 1] - firstRow;
  const from = firstRow + span * .25, until = firstRow + span * .75;
  let left = 0, top = 0, right = 0, bottom = 0, bestArea = 0;
  let bestLeft = 0, bestTop = 0, bestRight = 0, bestBottom = 0;
  for (let i = 0; i < count;) {
    const row = runs[i * 3 + 1];
    let widestX = 0, widest = 0;
    while (i < count && runs[i * 3 + 1] === row) {
      const x = runs[i * 3];
      let end = x + runs[i * 3 + 2];
      i++;
      // 与 fillRunLayers 一样只合并单格针孔，避免把双耳间隙当成实心主体。
      while (i < count && runs[i * 3 + 1] === row && runs[i * 3] - x - (end - x) <= 1) {
        end = runs[i * 3] + runs[i * 3 + 2]; i++;
      }
      if (end - x > widest) { widestX = x; widest = end - x; }
    }
    if (row < from) continue;
    if (row > until) break;
    let x = widestX * step + dx, y = row * step + dy;
    let w = widest * step + padding, h = step + padding;
    // 必须复现主体的平移、裁剪和四次 round 顺序，不能用包围盒向内取整替代。
    if (x < 0) { w += x; x = 0; }
    if (y < clipTop) { h -= clipTop - y; y = clipTop; }
    if (x + w > width) w = width - x;
    if (y + h > clipBottom) h = clipBottom - y;
    if (w <= 0 || h <= 0) { bottom = top; continue; }
    const rowLeft = Math.max(0, Math.round(x * scale)), rowTop = Math.max(0, Math.round(y * scale));
    const rowRight = Math.min(target.width, Math.round((x + w) * scale));
    const rowBottom = Math.min(target.height, Math.round((y + h) * scale));
    if (rowRight <= rowLeft || rowBottom <= rowTop) { bottom = top; continue; }
    if (bottom <= top || rowTop > bottom || rowLeft >= right || rowRight <= left) {
      left = rowLeft; top = rowTop; right = rowRight; bottom = rowBottom;
    } else {
      if (rowLeft > left) left = rowLeft;
      if (rowRight < right) right = rowRight;
      if (rowBottom > bottom) bottom = rowBottom;
    }
    const area = (right - left) * (bottom - top);
    if (area > bestArea) {
      bestArea = area; bestLeft = left; bestTop = top; bestRight = right; bestBottom = bottom;
    }
  }
  return bestArea ? { left: bestLeft, top: bestTop, right: bestRight, bottom: bestBottom } : undefined;
}

export function fillRunLayers(target: RectTarget, input: Int32Array, options: RunLayerOptions = {}): RunLayerResult {
  const drawing = drawingTarget(target);
  checkOptions(options);
  liveInt32(input, 'runs');
  const count = countFor(input, 3, options.count);
  const step = finite(options.step, 1, 'step'), scale = finite(options.scale, 1, 'scale');
  const layerOption = options.layers;
  const layers = layerOption == null ? emptyLayers : layerOption, padding = layoutNumber(options.padding, 1, 'padding');
  const leftOption = options.left;
  const leftSeed = leftOption === undefined ? Infinity : layoutNumber(leftOption, 0, 'left');
  const rightOption = options.right;
  const rightSeed = rightOption === undefined ? -Infinity : layoutNumber(rightOption, 0, 'right');
  const clipTop = layoutNumber(options.clipTop, 0, 'clipTop');
  const clipBottom = layoutNumber(options.clipBottom, drawing.height / scale, 'clipBottom');
  const marginOption = options.margin;
  const margin = marginOption === undefined ? undefined : layoutNumber(marginOption, 0, 'margin');
  const color = finite(options.color, 0xffffff, 'color');
  const layerCount = layersFor(layers);
  liveInt32(input, 'runs');
  checkTargetAliases(drawing.pixels, input, layers);
  if (!Number.isInteger(step) || step <= 0 || step > 2048 || scale < 1 / 2048 || scale > 2048 || padding < 0 || clipBottom < clipTop || (margin !== undefined && margin < 0))
    throw new RangeError('invalid run options');
  // 先校验全部输入再绘制；按行有序的契约用于最大遮挡矩形查找。
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    if (input[at + 2] <= 0 || (i && (input[at + 1] < input[at - 2] ||
      (input[at + 1] === input[at - 2] && input[at] < input[at - 3] + input[at - 1]))))
      throw new RangeError('runs must be positive, sorted and nonoverlapping');
  }
  const result: RunLayerResult = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, dx: 0, dy: 0, pixels: 0 };
  if (!count) return result;
  let edge = 0;
  for (let i = 0; i < layerCount * 3; i += 3) edge = Math.max(edge, Math.abs(layers[i]), Math.abs(layers[i + 1]));
  const width = drawing.width / scale;
  if (margin !== undefined) {
    const box = runLayerBounds(input, count, step, edge, leftSeed, rightSeed);
    result.dx = box.left < margin ? margin - box.left : box.right > width - margin ? width - margin - box.right : 0;
    result.dy = box.top < clipTop ? clipTop - box.top : box.bottom > clipBottom ? clipBottom - box.bottom : 0;
  }
  // 只合并单格针孔，保留双耳间隙；不修改调用者的投影缓冲。
  const runs = new Float64Array(count * 3);
  const offsets = new Int32Array(layers);
  let merged = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 3, previous = (merged - 1) * 3;
    result.pixels += input[at + 2];
    if (merged && input[at + 1] === runs[previous + 1] && input[at] - runs[previous] - runs[previous + 2] <= 1)
      runs[previous + 2] = input[at] + input[at + 2] - runs[previous];
    else { runs.set(input.subarray(at, at + 3), merged * 3); merged++; }
  }
  const paint = (x: number, y: number, w: number, h: number, ink: number) => {
    x += result.dx; y += result.dy;
    if (x < 0) { w += x; x = 0; }
    if (y < clipTop) { h -= clipTop - y; y = clipTop; }
    if (x + w > width) w = width - x;
    if (y + h > clipBottom) h = clipBottom - y;
    if (w <= 0 || h <= 0) return;
    if (x < result.left) result.left = x;
    if (y < result.top) result.top = y;
    if (x + w > result.right) result.right = x + w;
    if (y + h > result.bottom) result.bottom = y + h;
    physicalRect(drawing.fill, scale, x, y, w, h, ink);
  };
  for (let layer = 0; layer < layerCount * 3; layer += 3) {
    let row = 0;
    for (let i = 0; i < merged * 3; i += 3) {
      const x = runs[i] * step + offsets[layer], y = runs[i + 1] * step + offsets[layer + 1];
      const right = x + runs[i + 2] * step + padding, bottom = y + step + padding;
      const gridY = Math.floor(y / step) * step;
      while (row < merged * 3 && runs[row + 1] * step < gridY) row += 3;
      let leftCut = 0, topCut = 0, rightCut = 0, bottomCut = 0, area = 0;
      // 仅减去同一栅格行中最大的主体遮挡，顺序与原绘制定义一致。
      for (let j = row; j < merged * 3 && runs[j + 1] * step === gridY; j += 3) {
        const bx = runs[j] * step, by = runs[j + 1] * step;
        const br = bx + runs[j + 2] * step + padding, bb = by + step + padding;
        const left = x > bx ? x : bx, top = y > by ? y : by;
        const end = right < br ? right : br, base = bottom < bb ? bottom : bb;
        if (end <= left || base <= top) continue;
        const overlap = (end - left) * (base - top);
        if (overlap > area) { area = overlap; leftCut = left; topCut = top; rightCut = end; bottomCut = base; }
      }
      const ink = offsets[layer + 2];
      if (!area) paint(x, y, right - x, bottom - y, ink);
      else {
        if (topCut > y) paint(x, y, right - x, topCut - y, ink);
        if (bottomCut < bottom) paint(x, bottomCut, right - x, bottom - bottomCut, ink);
        if (leftCut > x) paint(x, topCut, leftCut - x, bottomCut - topCut, ink);
        if (rightCut < right) paint(rightCut, topCut, right - rightCut, bottomCut - topCut, ink);
      }
    }
  }
  for (let i = 0; i < merged * 3; i += 3) paint(runs[i] * step, runs[i + 1] * step, runs[i + 2] * step + padding, step + padding, color);
  return result;
}

export function fillRectLayers(target: RectTarget, rects: Int32Array, options: RectLayerOptions = {}): void {
  const drawing = drawingTarget(target);
  checkOptions(options);
  liveInt32(rects, 'rects');
  const count = countFor(rects, 5, options.count);
  const step = finite(options.step, 1, 'step'), scale = finite(options.scale, 1, 'scale');
  const x = layoutNumber(options.x, 0, 'x'), y = layoutNumber(options.y, 0, 'y');
  const layerOption = options.layers;
  const layers = layerOption == null ? emptyLayers : layerOption, layerCount = layersFor(layers);
  liveInt32(rects, 'rects');
  checkTargetAliases(drawing.pixels, rects, layers);
  if (step <= 0 || step > 2048 || scale < 1 / 2048 || scale > 2048) throw new RangeError('invalid rectangle options');
  // 绘制目标可运行用户回调；先复制几何和图层，避免中途分离输入改变本批结果。
  const geometry = rects.slice(0, count * 5), offsets = new Int32Array(layers);
  for (let layer = 0; layer < layerCount * 3; layer += 3) for (let i = 0; i < count * 5; i += 5) {
    if (geometry[i + 2] <= 0 || geometry[i + 3] <= 0) continue;
    physicalRect(drawing.fill, scale, x + geometry[i] * step + offsets[layer], y + geometry[i + 1] * step + offsets[layer + 1],
      geometry[i + 2] * step, geometry[i + 3] * step, offsets[layer + 2]);
  }
  for (let i = 0; i < count * 5; i += 5) {
    if (geometry[i + 2] <= 0 || geometry[i + 3] <= 0) continue;
    physicalRect(drawing.fill, scale, x + geometry[i] * step, y + geometry[i + 1] * step,
      geometry[i + 2] * step, geometry[i + 3] * step, geometry[i + 4]);
  }
}
