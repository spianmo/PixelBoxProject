/* 与主prelude共享Canvas/screen/native闭包；RGB888和透明掩码都由VM持有。 */
const imageBytes = source => typeof source === 'string' ? native.fs.readBytes(source) : u8(source);
const decodedCanvas = image => {
  const canvas = Object.create(Canvas.prototype);
  Object.defineProperties(canvas, {
    width: { value: image.width, enumerable: true }, height: { value: image.height, enumerable: true }
  });
  canvas._pixels = new Uint32Array(image.pixels);
  canvas._alpha = image.alpha ? new Uint8Array(image.alpha) : null;
  return canvas;
};
const imageSource = source => source instanceof Canvas ?
  { canvas: source, owned: false } : { canvas: decodedCanvas(native.decodeImage(imageBytes(source))), owned: true };
const canvasDispose = Canvas.prototype.dispose;
Canvas.prototype.dispose = function () { canvasDispose.call(this); this._alpha = null; };

Canvas.prototype.drawImage = function (source, x, y, opts = {}) {
  this._check();
  if (arguments.length < 3) throw new TypeError('drawImage needs source, x and y');
  if (!opts || typeof opts !== 'object') throw new TypeError('drawImage options must be an object');
  const integer = (value, fallback) => {
    if (value === undefined) return fallback;
    value = Number(value);
    if (!Number.isFinite(value)) throw new RangeError('invalid drawImage dimensions');
    return value | 0;
  };
  x = integer(x, 0); y = integer(y, 0);
  let sx = integer(opts.sx, 0), sy = integer(opts.sy, 0);
  let sw = integer(opts.sw, -1), sh = integer(opts.sh, -1);
  let width = integer(opts.w, -1), height = integer(opts.h, -1);
  const keyValue = opts.colorKey;
  const key = keyValue === undefined || keyValue === null ? null : Number(keyValue) >>> 0 & 0xffffff;
  const resolved = imageSource(source), input = resolved.canvas;
  let painting = false;
  try {
    // options getter可执行JS；读取像素前重新检查双方dispose状态。
    this._check(); input._check();
    if (sw < 0) sw = input.width;
    if (sh < 0) sh = input.height;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    sw = Math.min(sw, input.width - sx); sh = Math.min(sh, input.height - sy);
    if (sw <= 0 || sh <= 0) return;
    if (width < 0) width = sw;
    if (height < 0) height = sh;
    if (width <= 0 || height <= 0) return;
    const firstX = Math.max(0, -x), firstY = Math.max(0, -y);
    const endX = Math.min(width, this.width - x), endY = Math.min(height, this.height - y);
    if (firstX >= endX || firstY >= endY) return;
    // 行缓存无需逐像素跨JS解释器：在所有getter完成后把已裁剪的整数区域交给C。
    // 有透明掩码/色键、缩放或自绘的图片仍遵循下面的原采样规则。
    if (!input._alpha && key === null && width === sw && height === sh &&
        input._pixels.buffer !== this._pixels.buffer) {
      painting = true;
      native.blitCanvas(this._pixels, this.width, this.height, input._pixels, input.width, input.height,
        x + firstX, y + firstY, sx + firstX, sy + firstY, endX - firstX, endY - firstY,
        this._changedRows, this._dirtyBlocks);
      this._markDirty(x + firstX, y + firstY, endX - firstX, endY - firstY, false);
      return;
    }
    // 沿用原gfx::blit的16.16最近邻；只遍历落入目标画布的像素。
    const stepX = Math.floor(sw * 65536 / width), stepY = Math.floor(sh * 65536 / height);
    const pixels = input === this ? input._pixels.slice() : input._pixels;
    const mask = input._alpha, maskStride = Math.ceil(input.width / 8);
    painting = true;
    for (let row = firstY; row < endY; ++row) {
      const v = sy + Math.floor(row * stepY / 65536);
      for (let col = firstX; col < endX; ++col) {
        const u = sx + Math.floor(col * stepX / 65536);
        if (mask && !(mask[v * maskStride + (u >> 3)] & (0x80 >> (u & 7)))) continue;
        const color = pixels[v * input.width + u];
        if (color !== key) this._pixels[(y + row) * this.width + x + col] = color;
      }
    }
    // 此覆盖实现直接写像素；必须报告裁剪后的范围供自动帧增量提交。
    this._markDirty(x + firstX, y + firstY, endX - firstX, endY - firstY);
  } catch (error) {
    // 写入中途出错时保留已修改像素，异常被调用者捕获后也能在下一帧提交。
    if (painting) this._markDirty(0, 0, this.width, this.height);
    throw error;
  } finally {
    if (resolved.owned) input.dispose();
  }
};

const animationBytesLimit = 4 * 1024 * 1024;
const animationFramesLimit = 256;
const frameBytes = canvas => canvas._pixels.byteLength + (canvas._alpha ? canvas._alpha.byteLength : 0);
const disposeFrames = frames => { for (const frame of frames) if (frame.owned) frame.canvas.dispose(); };

class ImageAnimation {
  constructor(frames, delays, loop) {
    this._frames = frames; this._delays = delays; this._loop = loop;
    this._cur = 0; this._acc = 0; this._playing = false; this._disposed = false;
    this._unsub = null; this._endCbs = new Set();
  }
  get playing() { return this._playing; }
  get frameCount() { return this._frames.length; }
  get currentFrame() { return this._cur; }
  play() {
    if (this._disposed || this._playing) return;
    // 注册失败时仍保持暂停状态，不能把ENOTSUP伪装为正在播放。
    const unsubscribe = screen.onFrame(dt => this._tick(dt));
    this._unsub = unsubscribe; this._playing = true;
  }
  pause() {
    this._playing = false;
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }
  stop() { this.pause(); this._cur = 0; this._acc = 0; }
  seek(frame) {
    if (this._disposed) return;
    this._cur = Math.max(0, Math.min(this._frames.length - 1, frame | 0)); this._acc = 0;
  }
  draw(x, y, target, opts) {
    if (this._disposed) throw new Error('animation is disposed');
    (target || screen).drawImage(this._frames[this._cur].canvas, x | 0, y | 0, opts);
  }
  onEnd(callback) {
    if (typeof callback !== 'function') throw new TypeError('onEnd needs a function');
    this._endCbs.add(callback); return () => this._endCbs.delete(callback);
  }
  dispose() {
    if (this._disposed) return;
    this.pause(); disposeFrames(this._frames); this._frames = []; this._endCbs.clear(); this._disposed = true;
  }
  _tick(dt) {
    if (!this._playing || this._disposed || !Number.isFinite(dt) || dt < 0) return;
    this._acc += dt;
    // 每次最多推进一圈，与原实现一致，长暂停不产生无限补帧循环。
    let remaining = this._frames.length + 1;
    while (remaining-- > 0 && this._acc >= this._delays[this._cur]) {
      this._acc -= this._delays[this._cur];
      if (this._cur + 1 < this._frames.length) ++this._cur;
      else if (this._loop) this._cur = 0;
      else {
        this.pause();
        for (const callback of [...this._endCbs]) {
          try { callback(); } catch (error) { console.error('Animation onEnd callback:', error); }
        }
        break;
      }
    }
  }
}

screen.createAnimation = function (options) {
  if (!options || typeof options !== 'object') throw new TypeError('createAnimation needs options');
  const rate = Math.min(60, Math.max(1, (options.fps | 0) || 12));
  const loop = options.loop !== false, source = options.frames;
  const frames = [];
  let total = 0;
  const append = frame => {
    frame.canvas._check();
    const bytes = frameBytes(frame.canvas);
    if (frames.length >= animationFramesLimit || bytes > animationBytesLimit - total) {
      if (frame.owned) frame.canvas.dispose();
      throw new RangeError('animation frames or memory exceed limits');
    }
    total += bytes; frames.push(frame);
  };
  try {
    if (Array.isArray(source)) {
      if (!source.length || source.length > animationFramesLimit) throw new RangeError('animation needs 1..256 frames');
      for (const item of source) append(imageSource(item));
    } else if (source && typeof source === 'object' && 'sheet' in source) {
      const width = source.frameW | 0, height = source.frameH | 0;
      if (width <= 0 || height <= 0) throw new TypeError('sprite frame dimensions must be positive');
      const sheet = imageSource(source.sheet);
      try {
        sheet.canvas._check();
        const columns = Math.floor(sheet.canvas.width / width), rows = Math.floor(sheet.canvas.height / height);
        if (!columns || !rows || columns * rows > animationFramesLimit ||
            columns * rows * width * height * 4 > animationBytesLimit)
          throw new RangeError('invalid sprite dimensions or memory limit');
        for (let y = 0; y < rows; ++y) for (let x = 0; x < columns; ++x) {
          const canvas = new Canvas(width, height);
          // 切帧直接复制RGB和mask，透明区域不能提前混合成黑色。
          if (sheet.canvas._alpha) canvas._alpha = new Uint8Array(Math.ceil(width / 8) * height);
          for (let v = 0; v < height; ++v) for (let u = 0; u < width; ++u) {
            const sx = x * width + u, sy = y * height + v;
            canvas._pixels[v * width + u] = sheet.canvas._pixels[sy * sheet.canvas.width + sx];
            if (canvas._alpha && sheet.canvas._alpha[sy * Math.ceil(sheet.canvas.width / 8) + (sx >> 3)] & (0x80 >> (sx & 7)))
              canvas._alpha[v * Math.ceil(width / 8) + (u >> 3)] |= 0x80 >> (u & 7);
          }
          append({ canvas, owned: true });
        }
      } finally { if (sheet.owned) sheet.canvas.dispose(); }
    } else throw new TypeError('frames must be an array or sprite sheet');
    return new ImageAnimation(frames, frames.map(() => Math.round(1000 / rate)), loop);
  } catch (error) { disposeFrames(frames); throw error; }
};

const removeGifBackground = (canvas, threshold) => {
  const width = canvas.width, height = canvas.height, pixels = canvas._pixels, count = pixels.length;
  const visited = new Uint8Array(count), queue = new Uint32Array(count);
  const corners = [pixels[0], pixels[width - 1], pixels[(height - 1) * width], pixels[count - 1]];
  const background = [16, 8, 0].map(shift => Math.floor(corners.reduce((sum, color) => sum + (color >> shift & 255), 0) / 4));
  let head = 0, tail = 0;
  const enqueue = index => {
    if (visited[index]) return;
    const color = pixels[index];
    const dr = (color >> 16 & 255) - background[0], dg = (color >> 8 & 255) - background[1], db = (color & 255) - background[2];
    if (dr * dr + dg * dg + db * db > threshold * threshold) return;
    visited[index] = 1; queue[tail++] = index;
  };
  for (let x = 0; x < width; ++x) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y + 1 < height; ++y) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    if (x) enqueue(index - 1); if (x + 1 < width) enqueue(index + 1);
    if (y) enqueue(index - width); if (y + 1 < height) enqueue(index + width);
  }
  // 原SDK语义为边界四连通背景转黑；封闭内部同色区域保持原色。
  for (let index = 0; index < count; ++index) if (visited[index]) pixels[index] = 0;
};

screen.loadGif = function (source, options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('loadGif options must be an object');
  const removeBackground = !!options.removeBackground;
  const threshold = options.backgroundThreshold === undefined ? 44 : options.backgroundThreshold | 0;
  if (threshold < 0 || threshold > 255) throw new RangeError('backgroundThreshold must be 0..255');
  const decoded = native.loadGifFrames(imageBytes(source)), frames = [], delays = [];
  try {
    for (const image of decoded) {
      const canvas = decodedCanvas(image);
      frames.push({ canvas, owned: true }); delays.push(image.duration);
      if (removeBackground) removeGifBackground(canvas, threshold);
    }
    if (!frames.length) throw new Error('GIF contains no frames');
    // 沿用原SDK：无限循环GIF附加的重复尾帧只保留一份。
    if (frames.length > 1) {
      const first = frames[0].canvas, last = frames[frames.length - 1].canvas;
      if (first.width === last.width && first.height === last.height &&
          first._pixels.every((pixel, index) => pixel === last._pixels[index])) {
        frames.pop().canvas.dispose(); delays.pop();
      }
    }
    return new ImageAnimation(frames, delays, true);
  } catch (error) { disposeFrames(frames); throw error; }
};
