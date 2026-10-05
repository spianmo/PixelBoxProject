/* NuttX 的 FFI 适配层：公共签名以 sdk/types/pixelbox.d.ts 为准。
 * OS 能力通过私有 POSIX 绑定实现；未移植驱动按能力协议显式 ENOTSUP。
 */
(() => {
  'use strict';
  const g = globalThis;
  const native = g.__pxNative;
  delete g.__pxNative;
  const unsupported = () => { throw new Error('ENOTSUP'); };
  const rejected = () => Promise.reject(new Error('ENOTSUP'));
  const noop = () => {};
  const noSubscription = (...args) => {
    if (typeof args[args.length - 1] !== 'function') throw new TypeError('callback must be a function');
    return noop;
  };
  const unavailable = () => false;
  const u8 = data => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('expected ArrayBuffer or Uint8Array');
  };
  const px = g.px = g.pixelbox = {};
  /* 信息展示和只读 OTA 查询共用静态版本，查询不触发 info() 的硬件探测。 */
  const firmwareVersion = '0.1.0';
  px.util = { crc32: native.crc32, sha256: native.sha256, randomBytes: native.randomBytes };
  px.system = {
    info: () => ({
      model: native.model, firmwareVersion, chip: native.chip,
      deviceId: native.deviceId,
      screen: { width: native.width, height: native.height },
      capabilities: { camera: false, gps: false, ble: px.ble.available(), led: false, imu: native.imuAvailable(),
        touch: native.touchAvailable(), battery: native.powerAvailable(), mic: native.micAvailable(), speaker: native.audioAvailable() }
    }),
    memory: native.memory,
    battery: native.battery,
    now: native.now, setTimezone: native.setTimezone,
    restart: native.restart, deepSleep: native.deepSleep || unsupported, temperature: unsupported,
    ntpSync: rejected, otaApply: rejected, on: noSubscription
  };

  /* KV 使用真实挂载文件系统；挂载缺失/损坏会向调用者报错，绝不退回 RAM。 */
  const kvPath = '/data/.pixelbox-kv.json';
  const readKv = () => {
    if (!native.fs.exists('/data')) throw new Error('storage is not mounted');
    if (!native.fs.exists(kvPath)) return Object.create(null);
    const parsed = JSON.parse(native.fs.readText(kvPath));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid persistent KV file');
    return Object.assign(Object.create(null), parsed);
  };
  const keyOf = key => {
    if (typeof key !== 'string' || !key.length || key.length > 256 || key.includes('\0'))
      throw new TypeError('KV key must be a nonempty string of at most 256 characters');
    return key;
  };
  px.storage = {
    fs: native.fs,
    kv: {
      get(key) { const store = readKv(); key = keyOf(key); return Object.hasOwn(store, key) ? store[key] : null; },
      getJSON(key) { const value = this.get(key); return value === null ? null : JSON.parse(value); },
      set(key, value) {
        const store = readKv(); key = keyOf(key);
        const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        store[key] = text;
        native.atomicWrite(kvPath, JSON.stringify(store));
      },
      remove(key) { const store = readKv(); delete store[keyOf(key)]; native.atomicWrite(kvPath, JSON.stringify(store)); },
      keys() { return Object.keys(readKv()); },
      clear() { readKv(); native.atomicWrite(kvPath, '{}'); }
    }
  };

  const exitHandlers = new Set();
  /* @include prelude_system_net.js */
  let manifest = {};
  if (native.fs.exists('/app/manifest.json')) manifest = JSON.parse(native.fs.readText('/app/manifest.json'));
  const assetPath = path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(x => x === '.' || x === '..'))
      throw new TypeError('asset path must stay relative to assets/');
    return '/app/assets/' + path;
  };
  px.app = {
    name: String(manifest.name || 'PixelBox NuttX'), id: String(manifest.id || 'pixelbox.nuttx'),
    version: String(manifest.version || '0.1.0'),
    readAsset: path => native.fs.readBytes(assetPath(path)),
    readAssetText: path => native.fs.readText(assetPath(path)),
    onExit(callback) {
      if (typeof callback !== 'function') throw new TypeError('onExit needs a function');
      exitHandlers.add(callback); return () => { exitHandlers.delete(callback); };
    },
    exit: native.exit
  };
  g.__pxRunExit = () => {
    for (const callback of [...exitHandlers]) callback();
    exitHandlers.clear();
  };

  /* 与 C++ 快速路径相同的 Float32 逐次累加和双重网格取整，保留输入/输出别名校验。 */
  px.util.blendPoints = native.blendPoints;
  px.util.projectPoints = native.projectPoints;
  px.util.projectPointRuns = native.projectPointRuns;
  px.util.projectPointBounds = native.projectPointBounds;

  /* 离屏画布保留纯 CPU 绘制能力；只在真实 /dev/fb0 可用时把主屏写回硬件。 */
  class Canvas {
    constructor(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048)
        throw new RangeError('canvas size must be 1..2048');
      Object.defineProperties(this, { width: { value: width, enumerable: true }, height: { value: height, enumerable: true } });
      /* 只有主屏需要精确文字脏区；离屏 Canvas 保留旧的整屏安全语义。 */
      Object.defineProperty(this, '_trackTextBounds', { value: false, writable: true });
      this._pixels = new Uint32Array(width * height);
      this._rect = new Int32Array(5);
      this._composePixelsScratch = [];
      // 记录自上次 flush 后实际写入的范围，避免 NuttX 每帧扫描整块 framebuffer。
      this._dirty = null;
    }
    _check() { if (!this._pixels) throw new Error('canvas is disposed'); }
    _markDirty(x, y, width, height, recordRows = true) {
      if (width <= 0 || height <= 0) return;
      const left = Math.max(0, Math.floor(x)), top = Math.max(0, Math.floor(y));
      const right = Math.min(this.width, Math.ceil(x + width)), bottom = Math.min(this.height, Math.ceil(y + height));
      if (right <= left || bottom <= top) return;
      // 原生绘制已逐行记录实际写入；JS绘制保守覆盖声明矩形，避免遗漏异常前的写入。
      // 每bit覆盖同行8个像素，保留分离变化之间的干净区域；末字只置有效位。
      const blocks = this._dirtyBlocks;
      if (recordRows && blocks) {
        const stride = Math.ceil(this.width / 256), first = left >> 3, last = (right - 1) >> 3;
        for (let row = top; row < bottom; ++row) for (let word = first >> 5; word <= (last >> 5); ++word) {
          const low = word === (first >> 5) ? first & 31 : 0;
          const high = word === (last >> 5) ? last & 31 : 31;
          blocks[row * stride + word] |= (0xffffffff << low) & (0xffffffff >>> (31 - high));
        }
      }
      const rows = this._changedRows;
      if (recordRows && rows) for (let row = top * 2; row < bottom * 2; row += 2) {
        if (!rows[row] || left + 1 < rows[row]) rows[row] = left + 1;
        if (right > rows[row + 1]) rows[row + 1] = right;
      }
      const dirty = this._dirty;
      if (!dirty) this._dirty = { x: left, y: top, right, bottom };
      else {
        if (left < dirty.x) dirty.x = left;
        if (top < dirty.y) dirty.y = top;
        if (right > dirty.right) dirty.right = right;
        if (bottom > dirty.bottom) dirty.bottom = bottom;
      }
    }
    _markTrackedDirty(top = 0, bottom = this.height) {
      /* 原生批处理已经把实际变化写入 _changedRows；只扫描行边界，
       * 不再把中间未变化的空白区域扩进 framebuffer 提交范围。 */
      const rows = this._changedRows;
      if (!rows) return;
      const first = Math.max(0, Math.floor(top)), last = Math.min(this.height, Math.ceil(bottom));
      let dirty = null;
      for (let y = first; y < last; ++y) {
        const left = rows[y * 2], right = rows[y * 2 + 1];
        if (!left || right <= left) continue;
        const x = left - 1;
        if (!dirty) dirty = { x, y, right, bottom: y + 1 };
        else {
          if (x < dirty.x) dirty.x = x;
          if (right > dirty.right) dirty.right = right;
          if (y + 1 > dirty.bottom) dirty.bottom = y + 1;
        }
      }
      if (!dirty) return;
      const current = this._dirty;
      if (!current) this._dirty = dirty;
      else {
        if (dirty.x < current.x) current.x = dirty.x;
        if (dirty.y < current.y) current.y = dirty.y;
        if (dirty.right > current.right) current.right = dirty.right;
        if (dirty.bottom > current.bottom) current.bottom = dirty.bottom;
      }
    }
    dispose() { this._pixels = null; this._dirty = null; this._changedRows = undefined; this._dirtyBlocks = undefined; this._composePixelsScratch = undefined; }
    clear(color = 0) {
      this._check();
      if (native.clearCanvas && this._changedRows) {
        try {
          const dirty = native.clearCanvas(this._pixels, this.width, this.height, color & 0xffffff,
            this._changedRows, this._dirtyBlocks);
          if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
          return;
        } catch (error) {
          /* 原生清屏可能在中断或分配异常前已写入部分像素，必须整屏重扫。 */
          this._markDirty(0, 0, this.width, this.height); throw error;
        }
      }
      this._pixels.fill(color & 0xffffff); this._markDirty(0, 0, this.width, this.height);
    }
    setPixel(x, y, color) {
      this._check(); x = x | 0; y = y | 0;
      if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
        this._pixels[y * this.width + x] = color & 0xffffff;
        this._markDirty(x, y, 1, 1);
      }
    }
    getPixel(x, y) {
      this._check(); x = x | 0; y = y | 0;
      return x < 0 || y < 0 || x >= this.width || y >= this.height ? 0 : this._pixels[y * this.width + x];
    }
    fillRect(x, y, width, height, color) {
      this._check();
      // 复用单矩形参数，避免逐行跨入 TypedArray.fill 和每次分配缓冲区。
      const rect = this._rect;
      rect[0] = x | 0; rect[1] = y | 0; rect[2] = width | 0; rect[3] = height | 0; rect[4] = color & 0xffffff;
      try {
        const dirty = native.fillRects(this._pixels, this.width, this.height, rect, 1, this._changedRows, this._dirtyBlocks);
        if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
      } catch (error) {
        // 原生中断或结果分配失败前可能已写入部分像素，下一帧必须完整重扫。
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    fillRects(rects, count = rects.length / 5) {
      this._check();
      if (!(rects instanceof Int32Array)) throw new TypeError('fillRects needs Int32Array');
      if (!Number.isInteger(count) || count < 0 || count > 8192 || count * 5 > rects.length)
        throw new RangeError('invalid rectangle count');
      try {
        const dirty = native.fillRects(this._pixels, this.width, this.height, rects, count, this._changedRows, this._dirtyBlocks);
        if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
      } catch (error) {
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    fillRunLayers(runs, options) {
      this._check();
      try {
        const result = native.fillRunLayers(this._pixels, this.width, this.height, runs, options, this._changedRows, this._dirtyBlocks);
        const dirty = result.dirty;
        if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
        return result.bounds;
      } catch (error) {
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    fillRunLayersRestored(runs, options, restore) {
      this._check();
      try {
        const result = native.fillRunLayersRestored(this._pixels, this.width, this.height, runs, options, restore, this._changedRows, this._dirtyBlocks);
        const dirty = result.dirty;
        if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
        return result.bounds;
      } catch (error) {
        // 背景恢复和主体是一次有序绘制；部分写入后异常同样保留下一帧重扫能力。
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    fillRectLayers(rects, options) {
      this._check();
      try {
        const dirty = native.fillRectLayers(this._pixels, this.width, this.height, rects, options, this._changedRows, this._dirtyBlocks);
        if (dirty) this._markDirty(dirty.x, dirty.y, dirty.width, dirty.height, false);
      } catch (error) {
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    _composeRows(sources, geometry, regions, top, bottom, background) {
      this._check();
      const pixels = this._composePixelsScratch;
      pixels.length = 0;
      for (const source of sources) {
        source._check();
        if (source.width !== this.width) throw new RangeError('composed row width must match target');
        pixels.push(source._pixels);
      }
      try {
        native.composeRows(this._pixels, this.width, this.height, pixels, geometry, regions,
          top, bottom, background, this._changedRows, this._dirtyBlocks);
        this._markTrackedDirty(top, bottom);
      } catch (error) {
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    _drawImageRegions(source, x, y, rects, top, bottom) {
      this._check(); source._check();
      try {
        native.blitCanvas(this._pixels, this.width, this.height,
          source._pixels, source.width, source.height, x, y, 0, 0, source.width, source.height,
          this._changedRows, this._dirtyBlocks, rects, top, bottom);
        // 原生层已经逐行逐块登记，只合并实际变化的行，不把间隔空白重新标脏。
        this._markTrackedDirty(Math.max(y, top), Math.min(y + source.height, bottom));
      } catch (error) {
        this._markDirty(0, 0, this.width, this.height); throw error;
      }
    }
    drawRect(x, y, width, height, color) {
      this.fillRect(x, y, width, 1, color); this.fillRect(x, y + height - 1, width, 1, color);
      this.fillRect(x, y, 1, height, color); this.fillRect(x + width - 1, y, 1, height, color);
    }
    drawLine(x0, y0, x1, y1, color) {
      this._check(); x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      if (dx > 1000000 || -dy > 1000000) throw new RangeError('line coordinates too large');
      // 系统列表分隔线走一次原生填充，省去逐像素 JS 调用和脏区登记。
      // 对象颜色仍沿用逐像素转换，保留 valueOf 的次数与副作用语义。
      if (typeof color === 'number') {
        if (y0 === y1) { this.fillRect(Math.min(x0, x1), y0, dx + 1, 1, color); return; }
        if (x0 === x1) { this.fillRect(x0, Math.min(y0, y1), 1, 1 - dy, color); return; }
      }
      let error = dx + dy;
      for (;;) {
        this.setPixel(x0, y0, color); if (x0 === x1 && y0 === y1) break;
        const twice = 2 * error;
        if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; }
      }
    }
    drawCircle(cx, cy, radius, color) {
      this._check(); radius |= 0;
      if (radius < 0 || radius > 8192) throw new RangeError('invalid circle radius');
      let x = radius, y = 0, error = 1 - radius;
      while (x >= y) {
        for (const [dx, dy] of [[x,y],[y,x],[-y,x],[-x,y],[-x,-y],[-y,-x],[y,-x],[x,-y]]) this.setPixel(cx + dx, cy + dy, color);
        ++y; if (error < 0) error += 2 * y + 1; else { --x; error += 2 * (y - x) + 1; }
      }
    }
    fillCircle(cx, cy, radius, color) {
      this._check(); radius |= 0;
      if (radius < 0 || radius > 8192) throw new RangeError('invalid circle radius');
      for (let y = -radius; y <= radius; ++y) {
        const x = Math.floor(Math.sqrt(radius * radius - y * y)); this.fillRect(cx - x, cy + y, 2 * x + 1, 1, color);
      }
    }
    drawText(text, x, y, style) {
      if (arguments.length < 3) throw new TypeError('drawText needs text, x and y');
      this._check();
      try {
        /*
         * native.drawText 只写入文字笔画。旧实现为安全起见把整张画布标成
         * dirty，滚动时因此每个字都会触发整屏 RGB888→RGB565 转换。绘制
         * 完成后读取同一字体度量，按锚点计算实际文字包围盒；度量或样式
         * 解析失败时保留整屏回退，保证异常路径不会漏提交。
         */
        /* 主屏样式通常是字面量；复制五个 native 字段后再传入 C，保证
         * 带 getter 的用户样式各读取一次，也能安全读取 align 计算脏区。 */
        let drawStyle = style;
        if (this._trackTextBounds && style && typeof style === 'object') {
          drawStyle = {
            color: style.color, font: style.font, scale: style.scale,
            align: style.align, smooth: style.smooth,
          };
        }
        const metrics = native.drawText(this._pixels, this.width, this.height, text, x, y, drawStyle);
        if (!this._trackTextBounds) {
          this._markDirty(0, 0, this.width, this.height);
          return;
        }
        let width, height;
        if (typeof metrics === 'number' && Number.isInteger(metrics) && metrics >= 0) {
          width = metrics >>> 12;
          height = metrics & 0xfff;
        } else {
          width = Number(metrics && metrics.width);
          height = Number(metrics && metrics.height);
        }
        const anchorX = Number(x), top = Number(y);
        if (!Number.isFinite(width) || !Number.isFinite(height) ||
            !Number.isFinite(anchorX) || !Number.isFinite(top) || width < 0 || height < 0) {
          throw new RangeError('invalid text bounds');
        }
        let left = anchorX;
        let align = 'left';
        if (drawStyle && typeof drawStyle === 'object') align = drawStyle.align;
        if (align === 'center') left -= width / 2;
        else if (align === 'right') left -= width;
        this._markDirty(left, top, width, height);
      } catch (error) {
        // drawText 可能已写入部分像素；异常时整屏重试，避免漏掉脏区。
        this._markDirty(0, 0, this.width, this.height);
        throw error;
      }
    }
    measureText(text, style) {
      if (!arguments.length) throw new TypeError('measureText needs text');
      this._check(); return native.measureText(text, style);
    }
    drawImage(source, x, y, opts = {}) {
      this._check();
      if (!(source instanceof Canvas)) unsupported();
      source._check();
      if (!opts || typeof opts !== 'object') throw new TypeError('drawImage options must be an object');
      const sx = opts.sx === undefined ? 0 : Number(opts.sx);
      const sy = opts.sy === undefined ? 0 : Number(opts.sy);
      const sw = opts.sw === undefined ? source.width : Number(opts.sw);
      const sh = opts.sh === undefined ? source.height : Number(opts.sh);
      const width = opts.w === undefined ? sw : Number(opts.w);
      const height = opts.h === undefined ? sh : Number(opts.h);
      if (![sx, sy, sw, sh, width, height].every(Number.isFinite) || sw < 0 || sh < 0 || width < 0 || height < 0 || width > 8192 || height > 8192)
        throw new RangeError('invalid drawImage dimensions');
      // 基础Canvas只加速未提供options的调用，保留Proxy/getter的逐像素色键语义。
      if (arguments.length < 4 && [x, y].every(v => Number.isInteger(v) && Math.abs(v) <= 8192) &&
          source._pixels.buffer !== this._pixels.buffer) {
        try {
          native.blitCanvas(this._pixels, this.width, this.height, source._pixels, source.width, source.height,
            x, y, 0, 0, source.width, source.height, this._changedRows, this._dirtyBlocks);
          this._markDirty(x, y, source.width, source.height, false);
        } catch (error) { this._markDirty(0, 0, this.width, this.height); throw error; }
        return;
      }
      /* 自绘时快照源像素，避免重叠矩形覆盖尚未采样的输入。 */
      const pixels = source === this ? source._pixels.slice() : source._pixels;
      for (let row = 0; row < height; ++row) for (let col = 0; col < width; ++col) {
        const u = Math.floor(sx + col * sw / width), v = Math.floor(sy + row * sh / height);
        if (u < 0 || v < 0 || u >= source.width || v >= source.height) continue;
        const color = pixels[v * source.width + u]; if (color !== opts.colorKey) this.setPixel(x + col, y + row, color);
      }
      this._markDirty(x, y, width, height);
    }
  }
  const drawMethods = ['clear','setPixel','getPixel','drawLine','drawRect','fillRect','fillRects','fillRunLayers','fillRunLayersRestored','fillRectLayers','_composeRows','_drawImageRegions',
    'drawCircle','fillCircle','drawText','measureText','drawImage'];
  let fps = 30;
  let screen = native.width ? new Canvas(native.width, native.height) : { width: 0, height: 0 };
  if (native.width) screen._trackTextBounds = true;
  // 主屏每行仅用四字节，离屏画布无需追踪硬件提交范围。
  if (native.width) {
    screen._changedRows = new Uint16Array(native.height * 2);
    screen._dirtyBlocks = new Uint32Array(Math.ceil(native.width / 256) * native.height);
  }
  if (!native.width) for (const name of drawMethods) screen[name] = unsupported;
  Object.assign(screen, {
    setBrightness: native.setBrightness || unsupported, getBrightness: native.getBrightness || unsupported,
    setPower: native.setPower || unsupported,
    setRotation(degrees) {
      if (!native.setRotation) unsupported();
      if (native.setRotation(degrees)) screen.clear();
    },
    flush(knownClean = false) {
      if (!native.width) unsupported();
      const dirty = screen._dirty;
      // 只有自动帧可依赖Canvas脏区；手动flush保留扫描私有像素缓冲的原行为。
      if (knownClean === true && dirty) native.flush(screen._pixels, dirty.x, dirty.y, dirty.right - dirty.x, dirty.bottom - dirty.y, false, screen._changedRows, screen._dirtyBlocks);
      else if (knownClean === true) native.flush(screen._pixels, 0, 0, 0, 0, true);
      else native.flush(screen._pixels);
      // native.flush 保留失败时的 C 侧重试状态；只有成功提交才清除 JS 脏区。
      screen._dirty = null;
      screen._changedRows.fill(0);
      screen._dirtyBlocks.fill(0);
    },
    frameStats() { if (!native.frameStats) unsupported(); return native.frameStats(); },
    onFrame(callback) {
      if (!native.width) unsupported(); if (typeof callback !== 'function') throw new TypeError('onFrame needs a function');
      const period = () => 1000 / fps;
      let last = g.performance.now(), deadline = last + period(), timer, active = true;
      const frame = () => {
        if (!active) return;
        const now = g.performance.now();
        /* 回调返回 false 表示本帧没有视觉变化；但保留待重试脏区时仍必须 flush。 */
        const shouldFlush = callback(now - last) !== false || !!screen._dirty;
        last = now;
        if (shouldFlush) screen.flush(true);
        if (active) {
          // 保留绝对时基吸收 tick 取整；只在落后一个周期后重置，避免积压补帧。
          const step = period();
          deadline += step;
          if (deadline < now - step) deadline = now;
          timer = setTimeout(frame, Math.max(0, deadline - g.performance.now()));
        }
      };
      timer = setTimeout(frame, period()); return () => { active = false; clearTimeout(timer); };
    },
    setFps(value) { if (!native.width) unsupported(); if (!Number.isFinite(value)) throw new RangeError('invalid fps'); fps = Math.min(60, Math.max(1, value | 0)); },
    createCanvas: (width, height) => new Canvas(width, height),
    createAnimation: unsupported, loadGif: unsupported
  });
  px.screen = screen;
  /* @include prelude_image.js */
  /* NuttX 事件在 QuickJS 主循环中轮询，保证回调与其它 FFI 一样运行在 JS 线程。 */
  const touchSubscribers = new Set();
  const gestureSubscribers = new Set();
  let touchPollTimer = 0;
  let gestureDown = null;
  const pollTouch = () => {
    const event = native.touchRead();
    if (!event) return;
    const sampledAt = g.performance.now();
    let gestureEvent = null;
    if (event.type === 'down') {
      gestureDown = { x: event.x, y: event.y, at: sampledAt };
    } else if (event.type === 'up' && gestureDown) {
      const elapsed = sampledAt - gestureDown.at;
      const dx = event.x - gestureDown.x, dy = event.y - gestureDown.y;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (elapsed <= 800 && (ax >= 30 || ay >= 30)) {
        gestureEvent = { dir: ax >= ay ? (dx > 0 ? 'right' : 'left') :
                       (dy > 0 ? 'down' : 'up'), distance: ax >= ay ? ax : ay };
      }
      gestureDown = null;
    }
    /* 设置页只有一个订阅者时走无分配快路径；多订阅者仍复制快照，
       保证回调中退订不会跳过同一轮后续回调。 */
    if (touchSubscribers.size === 1) {
      for (const callback of touchSubscribers) { callback(event); break; }
    } else if (touchSubscribers.size > 1) {
      for (const callback of [...touchSubscribers]) callback(event);
    }
    if (gestureEvent) {
      for (const callback of [...gestureSubscribers]) callback(gestureEvent);
    }
  };
  const stopTouchPolling = () => {
    if (touchPollTimer && !touchSubscribers.size && !gestureSubscribers.size) {
      clearInterval(touchPollTimer); touchPollTimer = 0;
    }
  };
  const startTouchPolling = () => {
    /* 1ms 系统 tick 下每 5ms 采样一次，缩短按下/抬起的轮询等待。 */
    if (!touchPollTimer) touchPollTimer = setInterval(pollTouch, 5);
  };
  px.input = {
    onTouch(callback) {
      if (typeof callback !== 'function') throw new TypeError('onTouch needs a function');
      if (!native.touchAvailable()) unsupported();
      touchSubscribers.add(callback); startTouchPolling();
      return () => { touchSubscribers.delete(callback); stopTouchPolling(); };
    },
    onButton: unsupported,
    onGesture(callback) {
      if (typeof callback !== 'function') throw new TypeError('onGesture needs a function');
      if (!native.touchAvailable()) unsupported();
      gestureSubscribers.add(callback); startTouchPolling();
      return () => { gestureSubscribers.delete(callback); stopTouchPolling(); };
    }
  };

  /* @include prelude_power.js */

  px.audio = {
    encodeImaAdpcm: native.encodeImaAdpcm,
    setVolume: unsupported, getVolume: () => 0,
    mic: { start: unsupported, stop: unsupported, setGain: unsupported, active: false },
    player: { play: rejected, playPcm: unsupported, openPcmStream: unsupported, tone: unsupported, stopAll: unsupported, playing: false },
    record: rejected
  };
  /* @include prelude_audio.js */
  /* @include prelude_mic.js */
  /* 能力探测同时保留在公共命名空间，供应用在调用播放/采集前做无异常判断。 */
  px.audio.available = audioInternal.available;
  px.audio.mic.available = micHub.available;
  /* @include prelude_wifi.js */
  /* @include prelude_portal.js */
  px.net = { connectTcp: rejected, listenTcp: unsupported, createUdp: unsupported,
    mdns: { discover: rejected, advertise: unsupported }, hostname: () => native.hostname };
  /* @include prelude_ble.js */
  px.camera = { available: unavailable, init: rejected, capture: rejected, startStream: unsupported, stopStream: unsupported, deinit: unsupported };
  px.gps = { available: unavailable, start: unsupported, stop: unsupported, last: unsupported };
  /* QMI8658 通过 native.imuRead() 提供与 ESP-IDF 相同的六轴字段和检测语义。 */
  const imuShakeSubscribers = new Set();
  const imuOrientationSubscribers = new Set();
  let imuStreamTimer = 0;
  let imuDetectTimer = 0;
  let imuStreamCallback = null;
  let imuLastShake = -Infinity;
  let imuAx = 0, imuAy = 0, imuAz = 1;
  let imuOrientation = 'flat';
  const imuOrientationOf = (ax, ay, az, previous) => {
    const fx = Math.abs(ax), fy = Math.abs(ay), fz = Math.abs(az);
    if (fz >= fx && fz >= fy && fz > 0.70) return az > 0 ? 'flat' : 'faceDown';
    if (fy >= fx && fy > 0.70) return ay > 0 ? 'up' : 'down';
    if (fx > 0.70) return ax > 0 ? 'right' : 'left';
    return previous;
  };
  const imuDetect = sample => {
    const now = g.performance.now();
    const magnitude = Math.sqrt(sample.ax * sample.ax + sample.ay * sample.ay + sample.az * sample.az);
    if (magnitude > 1.8 && now - imuLastShake >= 700) {
      imuLastShake = now;
      for (const callback of [...imuShakeSubscribers]) callback();
    }
    imuAx += 0.15 * (sample.ax - imuAx);
    imuAy += 0.15 * (sample.ay - imuAy);
    imuAz += 0.15 * (sample.az - imuAz);
    const next = imuOrientationOf(imuAx, imuAy, imuAz, imuOrientation);
    if (next !== imuOrientation) {
      imuOrientation = next;
      for (const callback of [...imuOrientationSubscribers]) callback(next);
    }
  };
  const imuPoll = () => {
    const sample = native.imuRead();
    if (!sample) return;
    if (imuStreamCallback) imuStreamCallback(sample);
    if (imuDetectTimer) imuDetect(sample);
  };
  const ensureImuDetection = () => {
    if (!imuDetectTimer) imuDetectTimer = setInterval(imuPoll, 20);
  };
  const stopImuDetection = () => {
    if (imuDetectTimer && !imuShakeSubscribers.size && !imuOrientationSubscribers.size) {
      clearInterval(imuDetectTimer); imuDetectTimer = 0;
    }
  };
  const imu = {
    available: () => native.imuAvailable(),
    start(options = {}) {
      if (!native.imuAvailable()) unsupported();
      if (!options || typeof options !== 'object') throw new TypeError('start options must be an object');
      if (typeof options.onData !== 'function') throw new TypeError('start needs an onData function');
      let rate = options.rateHz === undefined ? 50 : Number(options.rateHz);
      if (!Number.isFinite(rate)) throw new RangeError('rateHz must be finite');
      rate = Math.min(500, Math.max(5, rate));
      if (imuStreamTimer) clearInterval(imuStreamTimer);
      imuStreamCallback = options.onData;
      imuStreamTimer = setInterval(imuPoll, 1000 / rate);
    },
    stop() {
      if (imuStreamTimer) clearInterval(imuStreamTimer);
      imuStreamTimer = 0; imuStreamCallback = null;
    },
    onShake(callback) {
      if (!native.imuAvailable()) unsupported();
      if (typeof callback !== 'function') throw new TypeError('onShake needs a function');
      imuShakeSubscribers.add(callback); ensureImuDetection();
      return () => { imuShakeSubscribers.delete(callback); stopImuDetection(); };
    },
    onOrientation(callback) {
      if (!native.imuAvailable()) unsupported();
      if (typeof callback !== 'function') throw new TypeError('onOrientation needs a function');
      imuOrientationSubscribers.add(callback); ensureImuDetection(); callback(imuOrientation);
      return () => { imuOrientationSubscribers.delete(callback); stopImuDetection(); };
    }
  };
  px.sensors = { imu };
  px.led = { available: unavailable, count: 0, setBrightness: unsupported, set: unsupported, fill: unsupported, clear: unsupported, show: unsupported };
  /* 网络模块覆盖前面的能力占位，共用当前 VM 的生命周期清理。 */
  /* @include prelude_net.js */
  /* @include prelude_mdns.js */
  /* @include prelude_http.js */
  /* @include prelude_ota.js */
  /* @include prelude_ws.js */
  /* @include prelude_speech_transport.js */
  /* @include prelude_speech.js */
  /* @include prelude_voice.js */
})();
