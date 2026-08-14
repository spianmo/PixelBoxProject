/**
 * prelude_screen.js — px.screen 的纯 JS 增强层
 *
 * 实现 d.ts 中的 createAnimation / loadGif (PxAnimation 包装):
 *   - 帧画布由 native 助手 __decodeImage / __loadGifFrames 解码 (帧存 PSRAM);
 *   - 播放计时用 screen.onFrame 驱动 (play 时订阅, pause/stop/dispose 退订),
 *     支持逐帧独立时长 (GIF) 与固定 fps (帧数组/雪碧图);
 *   - draw(x, y, target?, opts?) 把当前帧画到目标 (默认主屏)。
 */
(function () {
  'use strict';
  const screen = px.screen;
  const isCanvas = (v) => screen.__isCanvas(v);

  /** 把 frames 数组元素统一为画布; 返回 { canvas, owned } */
  function toFrameCanvas(item) {
    if (isCanvas(item)) return { canvas: item, owned: false };
    // 路径 / 二进制 → 解码为新画布 (归动画所有)
    return { canvas: screen.__decodeImage(item), owned: true };
  }

  class PxAnimationImpl {
    /**
     * @param {Array<{canvas, owned}>} frames
     * @param {number[]} delays 每帧毫秒
     * @param {boolean} loop
     */
    constructor(frames, delays, loop) {
      if (!frames.length) throw new Error('createAnimation: 至少需要 1 帧');
      this._frames = frames;
      this._delays = delays;
      this._loop = loop;
      this._cur = 0;
      this._acc = 0;
      this._playing = false;
      this._disposed = false;
      this._unsub = null;
      this._endCbs = new Set();
    }

    get playing() { return this._playing; }
    get frameCount() { return this._frames.length; }
    get currentFrame() { return this._cur; }

    play() {
      if (this._disposed || this._playing) return;
      this._playing = true;
      // 用主屏帧循环推进计时 (dt = 与上一帧间隔毫秒)
      this._unsub = screen.onFrame((dt) => this._tick(dt));
    }

    pause() {
      this._playing = false;
      if (this._unsub) { this._unsub(); this._unsub = null; }
    }

    stop() {
      this.pause();
      this._cur = 0;
      this._acc = 0;
    }

    seek(frame) {
      if (this._disposed) return;
      frame = frame | 0;
      if (frame < 0) frame = 0;
      if (frame >= this._frames.length) frame = this._frames.length - 1;
      this._cur = frame;
      this._acc = 0;
    }

    draw(x, y, target, opts) {
      if (this._disposed) throw new Error('动画已 dispose');
      (target || screen).drawImage(this._frames[this._cur].canvas, x | 0, y | 0, opts);
    }

    onEnd(cb) {
      if (typeof cb !== 'function') throw new TypeError('onEnd 需要函数参数');
      this._endCbs.add(cb);
      return () => this._endCbs.delete(cb);
    }

    dispose() {
      if (this._disposed) return;
      this.pause();
      for (const f of this._frames) {
        if (f.owned) f.canvas.dispose();
      }
      this._frames = [];
      this._endCbs.clear();
      this._disposed = true;
    }

    _tick(dt) {
      if (!this._playing || this._disposed) return;
      this._acc += dt;
      // 按逐帧时长推进 (可一次跨多帧, 上限一圈防死循环)
      let guard = this._frames.length + 1;
      while (this._acc >= this._delays[this._cur] && guard-- > 0) {
        this._acc -= this._delays[this._cur];
        if (this._cur + 1 < this._frames.length) {
          this._cur += 1;
        } else if (this._loop) {
          this._cur = 0;
        } else {
          // 停在最后一帧, 触发 onEnd
          this.pause();
          for (const cb of [...this._endCbs]) {
            try { cb(); } catch (e) { console.error('Animation onEnd 回调异常:', e); }
          }
          break;
        }
      }
    }
  }

  /**
   * createAnimation({ frames, fps?, loop? })
   * frames: (路径|二进制|画布)[] 或雪碧图 { sheet, frameW, frameH }
   */
  screen.createAnimation = function createAnimation(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('createAnimation(opts) 需要选项对象');
    }
    const fps = Math.min(60, Math.max(1, (opts.fps | 0) || 12));
    const loop = opts.loop !== false;  // 默认循环
    const frameMs = Math.round(1000 / fps);
    let frames;

    if (Array.isArray(opts.frames)) {
      frames = opts.frames.map(toFrameCanvas);
    } else if (opts.frames && typeof opts.frames === 'object' && 'sheet' in opts.frames) {
      // 雪碧图切帧: 从左到右、从上到下
      const { sheet, frameW, frameH } = opts.frames;
      const fw = frameW | 0, fh = frameH | 0;
      if (fw <= 0 || fh <= 0) throw new TypeError('雪碧图 frameW/frameH 需为正整数');
      const src = toFrameCanvas(sheet);
      const cols = Math.floor(src.canvas.width / fw);
      const rows = Math.floor(src.canvas.height / fh);
      if (cols < 1 || rows < 1) throw new Error('雪碧图尺寸小于单帧尺寸');
      frames = [];
      try {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const f = screen.createCanvas(fw, fh);
            f.drawImage(src.canvas, 0, 0, { sx: c * fw, sy: r * fh, sw: fw, sh: fh });
            frames.push({ canvas: f, owned: true });
          }
        }
      } finally {
        if (src.owned) src.canvas.dispose();  // 切完释放整图
      }
    } else {
      throw new TypeError('frames 需为数组或 { sheet, frameW, frameH }');
    }
    return new PxAnimationImpl(frames, frames.map(() => frameMs), loop);
  };

  /** loadGif(src, opts?): GIF → 动画 (逐帧时长取自 GIF, 默认循环) */
  screen.loadGif = function loadGif(src, opts) {
    const r = screen.__loadGifFrames(src, opts);
    const frames = r.frames.map((c) => ({ canvas: c, owned: true }));
    return new PxAnimationImpl(frames, r.delays, true);
  };
})();
