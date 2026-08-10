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

    /* 按屏幕尺寸整体缩放 (设计基准 368x448) */
    var S = Math.min(W, H) / 368;
    var dotSize = S >= 1.2 ? 2 : 1; /* 星点边长 */

    /* 文字: 按屏高占比取倍率, 吸附到平滑放大可用档 (Scale2x/3x 组合仅
     * 支持 2/3/4/6/8; 5/7 会退化成块状锯齿) */
    var SMOOTH_STEPS = [1, 2, 3, 4, 6, 8];
    function snapScale(v) {
      var best = 1;
      var d = 1e9;
      for (var si = 0; si < SMOOTH_STEPS.length; si++) {
        var e = Math.abs(SMOOTH_STEPS[si] - v);
        if (e < d) { d = e; best = SMOOTH_STEPS[si]; }
      }
      return best;
    }
    function fitScale(fontH, frac, minS) {
      return Math.max(minS, snapScale((H * frac) / fontH));
    }
    var titleScale = fitScale(16, 0.18, 2);  /* 标题 ~0.18H */
    var subScale = fitScale(12, 0.075, 1);   /* 命令行 ~0.075H */
    var hintScale = fitScale(12, 0.10, 1);   /* 中文提示 ~0.10H */
    /* 标题宽度约束: 'PixelBox' 8 字 × pixel16 步进 8 = 64px/倍 */
    while (titleScale > 2 && 64 * titleScale > W * 0.95) {
      titleScale = snapScale(titleScale - 1);
    }

    /* 文字块自动排版: 自 textTop 起 标题/命令/提示两行 依次向下, 间距 0.02H
     * (中文提示拆两行独立居中: 单行 10 全角字在大倍率下会撑满屏宽) */
    var titleH = 16 * titleScale;
    var subH = 12 * subScale;
    var hintH = 12 * hintScale;
    var gap = Math.round(H * 0.02);
    var blockH = titleH + gap + subH + gap + hintH + (gap >> 1) + hintH;
    var textTop = Math.min((H * 0.58) | 0, H - blockH - Math.round(H * 0.04));
    var titleY = textTop;
    var subY = titleY + titleH + gap;
    var hintY = subY + subH + gap;
    var hintY2 = hintY + hintH + (gap >> 1);

    /* 星空粒子 (数量按面积缩放) */
    var stars = [];
    var starCount = Math.round(48 * S * S);
    for (var i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        v: (0.2 + Math.random() * 1.4) * S,
        p: Math.random() * Math.PI * 2,
      });
    }

    /* 弹跳像素方块 */
    var box = { x: W / 2, y: H / 3, vx: 1.4 * S, vy: 1.0 * S, size: Math.round(32 * S) };
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
        px.screen.fillRect(s.x | 0, s.y | 0, dotSize, dotSize, col.lerp(0x1a2233, 0xaaccff, tw));
      }

      /* 弹跳方块 (HSV 循环渐变) */
      box.x += box.vx * k;
      box.y += box.vy * k;
      var half = box.size / 2;
      var boxMaxY = textTop - half - 6; /* 方块活动区让位给文字块 */
      if (box.x < half || box.x > W - half) box.vx = -box.vx;
      if (box.y < half || box.y > boxMaxY) box.vy = -box.vy;
      box.x = Math.min(Math.max(box.x, half), W - half);
      box.y = Math.min(Math.max(box.y, half), boxMaxY);
      var hue = (t / 20) % 360;
      var bx = (box.x - half) | 0;
      var by = (box.y - half) | 0;
      px.screen.fillRect(bx, by, box.size, box.size, col.hsv(hue, 75, 100));
      px.screen.drawRect(bx - 2, by - 2, box.size + 4, box.size + 4, 0xffffff);

      /* 文案 (drawText 可能不支持某些字体, 容错) */
      try {
        var pulse = (Math.sin(t / 500) + 1) / 2;
        /* smooth 仅用于大号拉丁字 (EPX 会侵蚀中文笔画, 中文行保持默认关) */
        px.screen.drawText('PixelBox', (W / 2) | 0, titleY, {
          color: 0xffffff,
          font: 'pixel16',
          scale: titleScale,
          smooth: true,
          align: 'center',
        });
        px.screen.drawText('pixelbox push', (W / 2) | 0, subY, {
          color: col.lerp(0x557799, 0x99eeff, pulse),
          font: 'pixel12',
          scale: subScale,
          smooth: true,
          align: 'center',
        });
        px.screen.drawText('推送你的应用', (W / 2) | 0, hintY, {
          color: 0x8899aa,
          font: 'pixel12',
          scale: hintScale,
          align: 'center',
        });
        px.screen.drawText('开始创作', (W / 2) | 0, hintY2, {
          color: 0x8899aa,
          font: 'pixel12',
          scale: hintScale,
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
