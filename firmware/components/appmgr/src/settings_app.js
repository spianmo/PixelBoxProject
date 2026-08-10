/*
 * settings_app.js — 内置设置页 (按键① 打开, 按键② 返回应用)
 *
 * 触摸交互: 亮度/音量滑条拖动即时生效。信息区每秒刷新。
 * 全部屏幕/外设调用容错 (裁剪构建可能缺模块)。
 */
(function () {
  'use strict';

  var W = px.screen.width;
  var H = px.screen.height;
  var col = px.color;
  var S = Math.min(W, H) / 368;
  var textScale = S >= 1.2 ? 2 : 1;

  var PAD = Math.round(W * 0.06);
  var ROW_H = Math.round(H * 0.105);
  var SLIDER_W = Math.round(W * 0.46);

  /* 行布局: 标题 + 两个滑条 + 四行信息 + 底部按键提示 */
  var yTitle = Math.round(H * 0.045);
  var rows = [];
  var yCur = Math.round(H * 0.16);
  function addRow(r) { r.y = yCur; rows.push(r); yCur += ROW_H; }

  var brightness = px.screen.getBrightness ? px.screen.getBrightness() : 80;
  var volume = px.audio && px.audio.getVolume ? px.audio.getVolume() : 70;

  addRow({ kind: 'slider', label: '亮度', get: function () { return brightness; },
           set: function (v) { brightness = v; try { px.screen.setBrightness(v); } catch (e) {} } });
  addRow({ kind: 'slider', label: '音量', get: function () { return volume; },
           set: function (v) { volume = v; try { px.audio.setVolume(v); } catch (e) {} } });
  addRow({ kind: 'info', label: 'WiFi', get: function () {
    try { var st = px.wifi.status(); return st.connected ? (st.ssid + '  ' + (st.ip || '')) : '未连接'; }
    catch (e) { return '不可用'; }
  } });
  addRow({ kind: 'info', label: '电池', get: function () {
    try { var b = px.system.battery(); return b.level < 0 ? '无电池' : (b.level + '%' + (b.charging ? ' 充电中' : '')); }
    catch (e) { return '不可用'; }
  } });
  addRow({ kind: 'info', label: '型号', get: function () {
    try { var i = px.system.info(); return i.model + '  fw ' + i.firmwareVersion; } catch (e) { return '-'; }
  } });
  addRow({ kind: 'info', label: '内存', get: function () {
    try { var m = px.system.memory(); return ((m.heapFree / 1024) | 0) + 'K 内部 / ' + ((m.psramFree / 1048576 * 10 | 0) / 10) + 'M PSRAM'; }
    catch (e) { return '-'; }
  } });

  var dragging = null; /* 拖动中的 slider 行 */

  function sliderRect(r) {
    return { x: W - PAD - SLIDER_W, y: r.y + Math.round(ROW_H * 0.28), w: SLIDER_W, h: Math.round(ROW_H * 0.34) };
  }

  function applySlider(r, tx) {
    var sr = sliderRect(r);
    var v = Math.round(((tx - sr.x) / sr.w) * 100);
    r.set(Math.max(0, Math.min(100, v)));
  }

  function draw() {
    px.screen.clear(0x0b0e14);
    px.screen.drawText('设置', PAD, yTitle, { color: 0xffffff, font: 'pixel16', scale: textScale + 1, align: 'left' });

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      px.screen.drawText(r.label, PAD, r.y + Math.round(ROW_H * 0.25), {
        color: 0x9db2c8, font: 'pixel12', scale: textScale, align: 'left',
      });
      if (r.kind === 'slider') {
        var sr = sliderRect(r);
        var v = r.get();
        px.screen.fillRect(sr.x, sr.y, sr.w, sr.h, 0x1c2433);
        px.screen.fillRect(sr.x, sr.y, Math.round(sr.w * v / 100), sr.h, 0x3d9bff);
        px.screen.drawRect(sr.x, sr.y, sr.w, sr.h, 0x33445c);
        px.screen.drawText(String(v), sr.x + sr.w + 8, r.y + Math.round(ROW_H * 0.25), {
          color: 0xffffff, font: 'pixel12', scale: textScale, align: 'left',
        });
      } else {
        px.screen.drawText(r.get(), W - PAD, r.y + Math.round(ROW_H * 0.25), {
          color: 0xe8eef6, font: 'pixel12', scale: textScale, align: 'right',
        });
      }
    }

    /* 注意: 带圈数字 U+2460-2462 不在 GB2312 一级字库, 用半角数字 */
    px.screen.drawText('键1 设置  键2 返回应用', (W / 2) | 0, H - Math.round(H * 0.115), {
      color: 0x5e7490, font: 'pixel12', scale: textScale, align: 'center',
    });
    px.screen.drawText('键3 短按息屏 长按关机', (W / 2) | 0, H - Math.round(H * 0.06), {
      color: 0x5e7490, font: 'pixel12', scale: textScale, align: 'center',
    });
  }

  try {
    px.screen.setFps(20);
    px.screen.onFrame(function () { draw(); });
  } catch (e) {
    console.error('[settings] 屏幕不可用: ' + e);
  }

  try {
    px.input.onTouch(function (ev) {
      if (ev.type === 'down') {
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r.kind !== 'slider') continue;
          var sr = sliderRect(r);
          if (ev.x >= sr.x - 8 && ev.x <= sr.x + sr.w + 8 && ev.y >= r.y && ev.y <= r.y + ROW_H) {
            dragging = r;
            applySlider(r, ev.x);
            return;
          }
        }
      } else if (ev.type === 'move' && dragging) {
        applySlider(dragging, ev.x);
      } else if (ev.type === 'up') {
        dragging = null;
      }
    });
  } catch (e) {
    /* 无触摸 */
  }

  console.log('[settings] 设置页就绪');
})();
