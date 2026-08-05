/*
 * default_app.js — 内置欢迎应用 (无用户应用时运行)
 *
 * 像素星空 + 弹跳色块动画, 屏上提示使用 `pixelbox push` 推送应用。
 * screen API 可能未注册 (裁剪构建), 全部屏幕调用做容错。
 */
(function () {
  'use strict';
  console.log('[welcome] PixelBox 就绪 — 运行 `pixelbox push` 推送你的第一个应用');

  var screenOk = false;
  try {
    screenOk = !!(px.screen && typeof px.screen.onFrame === 'function');
  } catch (e) {
    screenOk = false;
  }

  if (!screenOk) {
    console.warn('[welcome] screen API 不可用, 进入纯日志模式');
    setInterval(function () {
      console.log('[welcome] 等待应用推送… (pixelbox push)');
    }, 10000);
    return;
  }

  try {
    var W = px.screen.width;
    var H = px.screen.height;
    var col = px.color;

    /* 星空粒子 */
    var stars = [];
    for (var i = 0; i < 48; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        v: 0.2 + Math.random() * 1.4,
        p: Math.random() * Math.PI * 2,
      });
    }

    /* 弹跳像素方块 */
    var box = { x: W / 2, y: H / 3, vx: 1.4, vy: 1.0, size: 32 };
    var t = 0;

    px.screen.setFps(30);
    px.screen.onFrame(function (dt) {
      t += dt;
      var k = dt / 16.7; /* 帧速归一化 */

      px.screen.clear(0x0a0a14);

      /* 星光下落 + 闪烁 */
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        s.y += s.v * k;
        if (s.y >= H) {
          s.y = 0;
          s.x = Math.random() * W;
        }
        var tw = (Math.sin(t / 300 + s.p) + 1) / 2;
        px.screen.setPixel(s.x | 0, s.y | 0, col.lerp(0x1a2233, 0xaaccff, tw));
      }

      /* 弹跳方块 (HSV 循环渐变) */
      box.x += box.vx * k;
      box.y += box.vy * k;
      var half = box.size / 2;
      if (box.x < half || box.x > W - half) box.vx = -box.vx;
      if (box.y < half || box.y > H * 0.55) box.vy = -box.vy;
      box.x = Math.min(Math.max(box.x, half), W - half);
      box.y = Math.min(Math.max(box.y, half), H * 0.55);
      var hue = (t / 20) % 360;
      var bx = (box.x - half) | 0;
      var by = (box.y - half) | 0;
      px.screen.fillRect(bx, by, box.size, box.size, col.hsv(hue, 75, 100));
      px.screen.drawRect(bx - 2, by - 2, box.size + 4, box.size + 4, 0xffffff);

      /* 文案 (drawText 可能不支持某些字体, 容错) */
      try {
        var pulse = (Math.sin(t / 500) + 1) / 2;
        px.screen.drawText('PixelBox', (W / 2) | 0, (H * 0.66) | 0, {
          color: 0xffffff,
          font: 'pixel16',
          scale: 2,
          align: 'center',
        });
        px.screen.drawText('pixelbox push', (W / 2) | 0, (H * 0.78) | 0, {
          color: col.lerp(0x557799, 0x99eeff, pulse),
          font: 'pixel12',
          align: 'center',
        });
        px.screen.drawText('推送你的应用开始创作', (W / 2) | 0, (H * 0.85) | 0, {
          color: 0x8899aa,
          font: 'pixel12',
          align: 'center',
        });
      } catch (e) {
        /* 字体/文本不可用时忽略 */
      }
    });
  } catch (e) {
    console.error('[welcome] 屏幕动画初始化失败: ' + e);
    setInterval(function () {
      console.log('[welcome] 等待应用推送… (pixelbox push)');
    }, 10000);
  }
})();
