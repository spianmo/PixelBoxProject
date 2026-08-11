/*
 * settings_app.js — 内置设置页 (按键① 打开, 按键② 返回应用)
 *
 * 三页面: main(亮度/音量/信息) → wifi(扫描列表/断开) → pass(屏幕键盘输密码)
 * 交互对齐微雪 2.16 出厂镜像 (esp-brookesia): 网络列表带信号强度与锁标,
 * 点选加密网络弹 QWERTY 键盘 (abc/ABC/123/#+= 四模式), 连接成功回列表。
 * 键盘仅出 ASCII 可打印字符 (WPA2 口令字符集), 图标全部矢量绘制避开字库缺字。
 *
 * 交互约定 (对抗评审后定型):
 *   - 列表/主页行均为「down 锁定目标, up 无位移才执行」, 防滚动误触与状态漂移
 *   - 时间一律用 onFrame dt 累计的单调钟 monoMs (Date.now 会被 NTP 跳变)
 *   - 扫描失败自动重试 3 次 (开机自动重连窗口内 scan_start 会被拒)
 *   - 全部屏幕/外设调用容错 (裁剪构建可能缺模块)
 */
(function () {
  'use strict';

  var W = px.screen.width;
  var H = px.screen.height;
  var S = Math.min(W, H) / 368;
  var textScale = S >= 1.2 ? 2 : 1;
  var IS = textScale; /* 图标尺寸基数: 与文字同档放大, 避免 480 板图标偏小 */
  var F12 = { font: 'pixel12', scale: textScale };
  var LH12 = 12 * textScale; /* pixel12 行高 */

  var PAD = Math.round(W * 0.06);
  var ROW_H = Math.round(H * 0.105); /* 指宽下限, 不因加行而缩小 —— 装不下就滚动 (见 mainMaxScroll) */
  var VAL_W = 6 * textScale * 3 + Math.round(8 * S); /* 滑条数值列 (3 位数字) */
  var SLIDER_W = Math.round(W * 0.42);
  var TAP_SLOP = Math.max(8, Math.round(H * 0.02)); /* 位移超过即视为拖动 */

  var C = {
    bg: 0x0b0e14, panel: 0x1c2433, panelHi: 0x2a3850, border: 0x33445c,
    accent: 0x3d9bff, text: 0xe8eef6, dim: 0x9db2c8, dimmer: 0x7089a4,
    green: 0x39c26d, red: 0xff5a5a, keyBg: 0x222c3d, keyFn: 0x161e2b,
  };

  var hasWifi = typeof px.wifi === 'object' && !!px.wifi;

  /* ------------------------------------------------------------ 全局状态 */

  var page = 'main';            /* main | wifi | pass */
  var frame = 0;                /* 帧计数 (动画) */
  var monoMs = 0;               /* 单调毫秒钟 (onFrame dt 累计, 不受 NTP 跳变影响) */
  var toast = null;             /* { text, color, until(monoMs) } */

  /* wifi 页 */
  var aps = [];                 /* 扫描结果 [{ssid, rssi, secure, disp}] */
  var pendingAps = null;        /* 手势进行中到达的扫描结果, up 后再应用 */
  var scanning = false;
  var scanErr = null;
  var scanned = false;          /* 至少完成过一次扫描 */
  var scanRetries = 0;
  var scanStartAt = 0;
  var lastScanAt = 0;
  var scrollY = 0;
  var touchState = null;        /* down 后的手势: { x, y, scrollY, moved, tgt, listTop } */

  /* pass 页 */
  var passSsid = '';
  var passDispTitle = '';
  var passInput = '';
  var showPass = false;
  var lastTypeAt = -9999;       /* 末字符明文显示窗口 (monoMs) */
  var kbMode = 'lower';         /* lower | upper | num | sym */
  var pressedKey = null;        /* { id, ch, downAt, lastRep } 高亮 + 退格连删 */
  var passErr = null;

  /* 连接中 (wifi/pass 页共用遮罩) */
  var connecting = null;        /* { ssid, fromKeyboard } */

  function showToast(text, color) { toast = { text: text, color: color || C.text, until: monoMs + 2500 }; }

  function wifiStatus() {
    if (!hasWifi) return { connected: false, ssid: null, ip: null, mac: '' };
    try { return px.wifi.status(); } catch (e) { return { connected: false, ssid: null, ip: null, mac: '' }; }
  }

  /* 出厂 MAC 不会变: 缓存一次, 免得 MAC 行每帧再调一次 px.wifi.status()。
   * 空串 = WiFi 尚未 init 且 eFuse 也没读到, 此时不缓存, 下一帧再试。 */
  var macCache = null;
  function deviceMac() {
    if (macCache) return macCache;
    var m = wifiStatus().mac;
    if (!m) return '-';
    macCache = String(m).toUpperCase(); /* 像素字体下大写十六进制更好认, 也对齐路由器客户端列表 */
    return macCache;
  }

  /** 字库外码点替换为 '?' (连续折叠): 仅保留 ASCII / GB2312 常用汉字 / 全角标点 */
  function dispText(s) {
    var o = '', lastQ = false;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var okc = (c >= 0x20 && c < 0x7f) || (c >= 0x4e00 && c <= 0x9fa5) || (c >= 0xff01 && c <= 0xff5e);
      if (okc) { o += s.charAt(i); lastQ = false; }
      else if (!lastQ) { o += '?'; lastQ = true; }
    }
    return o;
  }

  /* ------------------------------------------------------------ 主页行 */

  var rows = [];
  var yTitle = Math.round(H * 0.045);
  /* 主页布局: 标题固定在上, 三行按键提示固定在下, 中间行列表在 [MAIN_TOP, mainViewBottom()) 内滚动。
   * r.y 是内容坐标 (不随滚动变), 屏幕坐标一律走 rowScreenY(r) —— 绘制与命中共用同一换算。 */
  var MAIN_TOP = Math.round(H * 0.16);
  var HINT_TOP = H - Math.round(H * 0.17); /* 底部三行提示的第一行 */
  var yCur = MAIN_TOP;
  function addRow(r) { r.y = yCur; rows.push(r); yCur += ROW_H; }

  var brightness = px.screen.getBrightness ? px.screen.getBrightness() : 80;
  var volume = px.audio && px.audio.getVolume ? px.audio.getVolume() : 70;

  addRow({ kind: 'slider', label: '亮度', get: function () { return brightness; },
           set: function (v) { brightness = v; try { px.screen.setBrightness(v); } catch (e) {} } });
  addRow({ kind: 'slider', label: '音量', get: function () { return volume; },
           set: function (v) { volume = v; try { px.audio.setVolume(v); } catch (e) {} } });
  var wifiRow = { kind: 'link', label: 'WiFi', get: function () {
    if (!hasWifi) return '不可用';
    var st = wifiStatus();
    return st.connected ? dispText(st.ssid || '') : '未连接';
  } };
  addRow(wifiRow);
  addRow({ kind: 'info', label: 'MAC', get: deviceMac });
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

  var dragging = null;    /* 拖动中的 slider 行 */
  var mainTouch = null;   /* 主页手势: { x, y, scrollY, moved, tgt } —— moved 后转为滚动 */
  var mainScrollY = 0;    /* 主页行列表滚动偏移 (像素) */

  function mainViewBottom() { return HINT_TOP - Math.round(4 * S); }
  function mainMaxScroll() {
    return Math.max(0, rows.length * ROW_H - (mainViewBottom() - MAIN_TOP));
  }
  function clampMainScroll() {
    var ms = mainMaxScroll();
    if (mainScrollY > ms) mainScrollY = ms;
    if (mainScrollY < 0) mainScrollY = 0;
  }
  /** 内容坐标 → 屏幕坐标 */
  function rowScreenY(r) { return r.y - mainScrollY; }

  function sliderRect(r) {
    var y = rowScreenY(r);
    return { x: W - PAD - VAL_W - SLIDER_W, y: y + Math.round(ROW_H * 0.28), w: SLIDER_W, h: Math.round(ROW_H * 0.34) };
  }
  function applySlider(r, tx) {
    var sr = sliderRect(r);
    var v = Math.round(((tx - sr.x) / sr.w) * 100);
    r.set(Math.max(0, Math.min(100, v)));
  }

  /* ------------------------------------------------------------ 绘图小件 (矢量图标, 避开字库缺字) */

  function textMidY(boxY, boxH) { return boxY + ((boxH - LH12) >> 1); }

  /** 右向箭头 > */
  function drawChevron(x, cy, size, color) {
    px.screen.drawLine(x, cy - size, x + size, cy, color);
    px.screen.drawLine(x + size, cy, x, cy + size, color);
  }
  /** 左向箭头 < */
  function drawChevronL(x, cy, size, color) {
    px.screen.drawLine(x + size, cy - size, x, cy, color);
    px.screen.drawLine(x, cy, x + size, cy + size, color);
  }
  /** 对勾 */
  function drawCheck(x, cy, size, color) {
    px.screen.drawLine(x, cy, x + (size * 0.4) | 0, cy + ((size * 0.4) | 0), color);
    px.screen.drawLine(x + (size * 0.4) | 0, cy + ((size * 0.4) | 0), x + size, cy - ((size * 0.5) | 0), color);
  }
  /** WiFi 信号条: 4 根, level 1-4 */
  function drawBars(x, yBottom, level, color) {
    var bw = 3 * IS, gap = 2 * IS, unit = 4 * IS;
    for (var i = 0; i < 4; i++) {
      var bh = unit * (i + 1);
      px.screen.fillRect(x + i * (bw + gap), yBottom - bh, bw, bh, i < level ? color : C.border);
    }
  }
  function barsWidth() { return 3 * IS * 4 + 2 * IS * 3; }
  /** 挂锁 */
  function drawLock(x, yTop, color) {
    var u = 2 * IS + (IS > 1 ? 1 : 0); /* 368:2px 480:5px */
    px.screen.drawRect(x + u, yTop, u * 3, u * 3, color);       /* 锁环 */
    px.screen.fillRect(x, yTop + u * 2, u * 5, u * 4, color);   /* 锁体 */
  }
  function lockWidth() { return (2 * IS + (IS > 1 ? 1 : 0)) * 5; }
  /** Shift 上三角 (active 实心) */
  function drawShift(cx, cy, size, color, active) {
    var h = size, w2 = size;
    if (active) {
      for (var i = 0; i <= h; i++) {
        var half = Math.round(w2 * i / h);
        px.screen.fillRect(cx - half, cy - (h >> 1) + i, half * 2 + 1, 1, color);
      }
    } else {
      px.screen.drawLine(cx, cy - (h >> 1), cx - w2, cy + (h >> 1), color);
      px.screen.drawLine(cx, cy - (h >> 1), cx + w2, cy + (h >> 1), color);
      px.screen.drawLine(cx - w2, cy + (h >> 1), cx + w2, cy + (h >> 1), color);
    }
  }
  /** 退格 ⌫: 左尖五边形 + x */
  function drawBksp(cx, cy, size, color) {
    var w = size * 2, h = size + Math.round(size * 0.4);
    var x0 = cx - w / 2, x1 = cx + w / 2, tip = Math.round(w * 0.35);
    px.screen.drawLine(x0, cy, x0 + tip, cy - (h >> 1), color);
    px.screen.drawLine(x0 + tip, cy - (h >> 1), x1, cy - (h >> 1), color);
    px.screen.drawLine(x1, cy - (h >> 1), x1, cy + (h >> 1), color);
    px.screen.drawLine(x1, cy + (h >> 1), x0 + tip, cy + (h >> 1), color);
    px.screen.drawLine(x0 + tip, cy + (h >> 1), x0, cy, color);
    var xr = Math.max(2, size >> 2);
    var xc = cx + Math.round(tip * 0.3);
    px.screen.drawLine(xc - xr, cy - xr, xc + xr, cy + xr, color);
    px.screen.drawLine(xc - xr, cy + xr, xc + xr, cy - xr, color);
  }
  /** 眼睛 (密码可见切换) */
  function drawEye(cx, cy, size, color, open) {
    px.screen.drawCircle(cx, cy, size, color);
    if (open) px.screen.fillCircle(cx, cy, Math.max(2, size >> 1), color);
    else px.screen.drawLine(cx - size, cy + size, cx + size, cy - size, color);
  }

  /** 按像素宽截断文本 (加 '..') */
  function truncText(text, maxW) {
    try {
      if (px.screen.measureText(text, F12).width <= maxW) return text;
      var t = text;
      while (t.length > 1) {
        t = t.substring(0, t.length - 1);
        if (px.screen.measureText(t + '..', F12).width <= maxW) return t + '..';
      }
      return t;
    } catch (e) { return text; }
  }

  /* ------------------------------------------------------------ WiFi 扫描 */

  function rssiLevel(rssi) {
    if (rssi >= -50) return 4;
    if (rssi >= -62) return 3;
    if (rssi >= -74) return 2;
    return 1;
  }

  function startScan() {
    if (!hasWifi || scanning || connecting) return;
    scanning = true;
    scanErr = null;
    scanRetries = 0;
    scanStartAt = monoMs;
    doScan();
  }

  function doScan() {
    px.wifi.scan().then(function (list) {
      scanning = false;
      scanned = true;
      lastScanAt = monoMs;
      /* 过滤空 SSID + 同名去重取最强 + 按信号排序 */
      var seen = {};
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a.ssid) continue;
        var old = seen[a.ssid];
        if (!old || a.rssi > old.rssi) seen[a.ssid] = a;
      }
      var arr = [];
      for (var k in seen) arr.push(seen[k]);
      arr.sort(function (a, b) { return b.rssi - a.rssi; });
      var maxTextW = W - PAD * 2 - barsWidth() - lockWidth() - Math.round(24 * S);
      for (var j = 0; j < arr.length; j++) arr[j].disp = truncText(dispText(arr[j].ssid), maxTextW);
      /* 手势进行中不换列表 (防拖动跳变/点错行), up 后应用; scrollY 由 draw 钳制 */
      if (touchState) pendingAps = arr;
      else { aps = arr; pendingAps = null; }
    }).catch(function (e) {
      /* 开机自动重连窗口内 scan_start 会被拒 (WIFI_STATE), 静默重试 */
      if (scanRetries < 3 && page === 'wifi' && !connecting) {
        scanRetries++;
        setTimeout(doScan, 1800); /* scanning 保持 true, UI 继续"正在扫描" */
        return;
      }
      scanning = false;
      scanned = true;
      lastScanAt = monoMs;
      scanErr = String((e && e.message) || e);
      if (aps.length > 0) showToast('扫描失败', C.red); /* 有旧列表时只弹 toast */
    });
  }

  function connectTo(ssid, pass, fromKeyboard) {
    if (!hasWifi || connecting) return;
    connecting = { ssid: ssid, fromKeyboard: fromKeyboard };
    pressedKey = null; /* down 后 up 会被遮罩吞掉, 在此清理防高亮/连删卡死 */
    passErr = null;
    px.wifi.connect(ssid, pass || undefined, { timeoutMs: 20000 }).then(function (st) {
      connecting = null;
      page = 'wifi';
      showToast('已连接 ' + dispText(ssid) + (st.ip ? '  ' + st.ip : ''), C.green);
    }).catch(function (e) {
      connecting = null;
      var msg = String((e && e.message) || e);
      if (fromKeyboard) {
        page = 'pass';
        passErr = '连接失败: 密码错误或超时';
        console.log('[settings] wifi connect fail: ' + msg);
      } else {
        showToast('连接失败 ' + dispText(ssid), C.red);
      }
    });
  }

  /* ------------------------------------------------------------ 键盘布局 */

  /* 特殊键: id 决定行为; w 为宽度权重 */
  function K(ch) { return { id: 'ch', ch: ch, w: 1 }; }
  function kbRows() {
    var r3 = [
      { id: kbMode === 'lower' || kbMode === 'upper' ? 'num' : 'abc',
        label: kbMode === 'lower' || kbMode === 'upper' ? '123' : 'abc', w: 2 },
      { id: 'space', label: '空格', w: 4 },
      { id: 'ok', label: '连接', w: 2 },
    ];
    if (kbMode === 'lower' || kbMode === 'upper') {
      var up = kbMode === 'upper';
      function L(c) { return K(up ? c.toUpperCase() : c); }
      return [
        [L('q'), L('w'), L('e'), L('r'), L('t'), L('y'), L('u'), L('i'), L('o'), L('p')],
        [L('a'), L('s'), L('d'), L('f'), L('g'), L('h'), L('j'), L('k'), L('l')],
        [{ id: 'shift', w: 1.5 }, L('z'), L('x'), L('c'), L('v'), L('b'), L('n'), L('m'), { id: 'bksp', w: 1.5 }],
        r3,
      ];
    }
    if (kbMode === 'num') {
      return [
        [K('1'), K('2'), K('3'), K('4'), K('5'), K('6'), K('7'), K('8'), K('9'), K('0')],
        [K('-'), K('/'), K(':'), K(';'), K('('), K(')'), K('$'), K('&'), K('@'), K('"')],
        [{ id: 'sym', label: '#+=', w: 1.5 }, K('.'), K(','), K('?'), K('!'), K("'"), { id: 'bksp', w: 1.5 }],
        r3,
      ];
    }
    /* sym */
    return [
      [K('['), K(']'), K('{'), K('}'), K('#'), K('%'), K('^'), K('*'), K('+'), K('=')],
      [K('_'), K('\\'), K('|'), K('~'), K('<'), K('>'), K('`'), K('.'), K(','), K('?')],
      [{ id: 'num', label: '123', w: 1.5 }, K('!'), K("'"), K('"'), K('@'), K('&'), { id: 'bksp', w: 1.5 }],
      r3,
    ];
  }

  var KB_H = Math.round(H * 0.44);
  var KB_TOP = H - KB_H;
  var KB_GAP = Math.max(3, Math.round(3 * S));

  /**
   * 计算键盘所有键的矩形 [{key, ri, x, y, w, h}]。
   * 浮点游标 + 逐键取整: 消除 Math.round 逐键累积溢出 (368 板曾右溢 2px);
   * 9 键字母行按 10 单元分摊宽度, 左右各留半键对称边距。
   */
  function kbLayout() {
    var out = [];
    var rowsK = kbRows();
    var rowH = Math.floor((KB_H - KB_GAP) / rowsK.length);
    for (var ri = 0; ri < rowsK.length; ri++) {
      var row = rowsK[ri];
      var sumW = 0;
      for (var i = 0; i < row.length; i++) sumW += row[i].w;
      var centered = row.length === 9 && row[0].id === 'ch';
      var availW = W - KB_GAP * 2 - KB_GAP * (row.length - 1);
      var unit = availW / (sumW + (centered ? 1 : 0));
      var xf = KB_GAP + (centered ? unit / 2 : 0);
      var y = KB_TOP + KB_GAP + ri * rowH;
      for (var j = 0; j < row.length; j++) {
        var xi = Math.round(xf);
        var kw = Math.round(xf + unit * row[j].w) - xi;
        if (xi + kw > W - KB_GAP) kw = W - KB_GAP - xi; /* 末键兜底钳位 */
        out.push({ key: row[j], ri: ri, x: xi, y: y, w: kw, h: rowH - KB_GAP });
        xf += unit * row[j].w + KB_GAP;
      }
    }
    return out;
  }

  /** 命中键 (键间隙对半分摊消灭死区; 末行向屏底延伸) */
  function keyAt(x, y) {
    var keys = kbLayout();
    var gL = KB_GAP >> 1, gR = KB_GAP - gL;
    for (var i = 0; i < keys.length; i++) {
      var it = keys[i];
      var yMax = it.ri === 3 ? H : it.y + it.h + gR;
      if (x >= it.x - gL && x < it.x + it.w + gR && y >= it.y - gL && y < yMax) return it;
    }
    return null;
  }

  function keyMatches(a, b) {
    return a && b && a.id === b.id && (a.id !== 'ch' || a.ch === b.ch);
  }

  function pressKey(key) {
    lastTypeAt = monoMs;
    passErr = null;
    if (key.id === 'ch') {
      if (passInput.length < 63) passInput += key.ch;
    } else if (key.id === 'space') {
      if (passInput.length < 63) passInput += ' ';
    } else if (key.id === 'bksp') {
      passInput = passInput.substring(0, passInput.length - 1);
    } else if (key.id === 'shift') {
      kbMode = kbMode === 'upper' ? 'lower' : 'upper';
    } else if (key.id === 'num') {
      kbMode = 'num';
    } else if (key.id === 'sym') {
      kbMode = 'sym';
    } else if (key.id === 'abc') {
      kbMode = 'lower';
    } else if (key.id === 'ok') {
      /* 与绘制侧的置灰一致: 空密码不发起连接 */
      if (!connecting && passInput.length > 0) connectTo(passSsid, passInput, true);
    }
  }

  /* ------------------------------------------------------------ 页面几何 */

  var HDR_H = Math.round(H * 0.1);
  function backRect() { return { x: 0, y: 0, w: Math.round(W * 0.28), h: HDR_H }; }
  function refreshRect() { return { x: W - Math.round(W * 0.28), y: 0, w: Math.round(W * 0.28), h: HDR_H }; }
  function inRect(x, y, r) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }

  var BANNER_H = Math.round(H * 0.14);
  function wifiListTop(connected) {
    if (connected === undefined) connected = wifiStatus().connected;
    return HDR_H + (connected ? BANNER_H : 0) + Math.round(4 * S);
  }
  function wifiRowH() { return Math.round(H * 0.1); }
  function disconnectRect() {
    var bw = Math.round(W * 0.17), bh = Math.round(BANNER_H * 0.42);
    return { x: W - PAD - bw, y: HDR_H + ((BANNER_H - bh) >> 1), w: bw, h: bh };
  }
  function maxScroll(connected) {
    var viewH = H - wifiListTop(connected);
    return Math.max(0, aps.length * wifiRowH() - viewH);
  }
  function wifiRowAt(yy, connected) {
    var top = wifiListTop(connected);
    if (yy < top) return -1;
    var idx = Math.floor((yy + scrollY - top) / wifiRowH());
    return idx >= 0 && idx < aps.length ? idx : -1;
  }

  /* pass 页输入框 */
  function inputRect() {
    return { x: PAD, y: Math.round(H * 0.15), w: W - PAD * 2, h: Math.round(H * 0.09) };
  }
  function eyeRect() {
    var ir = inputRect();
    var s = Math.round(ir.h * 0.8);
    return { x: ir.x + ir.w - s - 4, y: ir.y + ((ir.h - s) >> 1), w: s, h: s };
  }

  function toastRect() {
    var th = Math.round(H * 0.09);
    /* pass 页放键盘上方, 其余页放屏底 */
    var ty = page === 'pass' ? KB_TOP - th - Math.round(4 * S) : H - th - Math.round(H * 0.02);
    return { x: PAD >> 1, y: ty, w: W - PAD, h: th };
  }

  /* ------------------------------------------------------------ 绘制 */

  function drawHeader(title, withRefresh) {
    var cy = HDR_H >> 1;
    var chs = Math.round(6 * S);
    drawChevronL(PAD, cy, chs, C.accent);
    px.screen.drawText('返回', PAD + chs + Math.round(8 * S), textMidY(0, HDR_H), {
      color: C.accent, font: 'pixel12', scale: textScale, align: 'left',
    });
    px.screen.drawText(title, (W / 2) | 0, (HDR_H - 16 * textScale) >> 1, {
      color: C.text, font: 'pixel16', scale: textScale, align: 'center',
    });
    if (withRefresh) {
      px.screen.drawText(scanning ? '...' : '刷新', W - PAD, textMidY(0, HDR_H), {
        color: scanning ? C.dimmer : C.accent, font: 'pixel12', scale: textScale, align: 'right',
      });
    }
    px.screen.drawLine(0, HDR_H - 1, W, HDR_H - 1, C.border);
  }

  /** 主页行值: 标签宽缓存 + 按预算截断 (长 SSID/型号防与标签重叠) */
  function drawRowValue(r, anchorX) {
    if (r.labelW === undefined) {
      try { r.labelW = px.screen.measureText(r.label, F12).width; } catch (e) { r.labelW = 40; }
    }
    var v = String(r.get());
    if (r.vCache !== v) {
      r.vCache = v;
      r.vDisp = truncText(v, anchorX - (PAD + r.labelW + Math.round(10 * S)));
    }
    px.screen.drawText(r.vDisp, anchorX, rowScreenY(r) + Math.round(ROW_H * 0.25), {
      color: C.text, font: 'pixel12', scale: textScale, align: 'right',
    });
  }

  function drawMain() {
    clampMainScroll(); /* 行数/几何变化后重钳, 与命中用同一个 mainScrollY */
    var bot = mainViewBottom();
    var ms = mainMaxScroll();

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var y = rowScreenY(r);
      if (y + ROW_H <= MAIN_TOP || y >= bot) continue; /* 视区外整行跳过 */
      var ty = y + Math.round(ROW_H * 0.25);
      px.screen.drawText(r.label, PAD, ty, {
        color: C.dim, font: 'pixel12', scale: textScale, align: 'left',
      });
      if (r.kind === 'slider') {
        var sr = sliderRect(r);
        var v = r.get();
        px.screen.fillRect(sr.x, sr.y, sr.w, sr.h, C.panel);
        px.screen.fillRect(sr.x, sr.y, Math.round(sr.w * v / 100), sr.h, C.accent);
        px.screen.drawRect(sr.x, sr.y, sr.w, sr.h, C.border);
        px.screen.drawText(String(v), W - PAD, ty, {
          color: C.text, font: 'pixel12', scale: textScale, align: 'right',
        });
      } else if (r.kind === 'link') {
        var chs = Math.round(5 * S);
        drawChevron(W - PAD - chs, ty + (LH12 >> 1), chs, C.dimmer);
        drawRowValue(r, W - PAD - chs * 2 - Math.round(8 * S));
      } else {
        drawRowValue(r, W - PAD);
      }
    }

    /* 滚动条 (同 wifi 页画法) */
    if (ms > 0) {
      var viewH = bot - MAIN_TOP;
      var barH = Math.max(20, Math.round(viewH * viewH / (rows.length * ROW_H)));
      var barY = MAIN_TOP + Math.round((viewH - barH) * mainScrollY / ms);
      px.screen.fillRect(W - 3, barY, 2, barH, C.border);
    }

    /* 上下不透明覆盖带: gfx 无裁剪, 半可见行会画进标题/提示区, 后画盖掉 */
    px.screen.fillRect(0, 0, W, MAIN_TOP, C.bg);
    px.screen.fillRect(0, bot, W, H - bot, C.bg);

    px.screen.drawText('设置', PAD, yTitle, { color: 0xffffff, font: 'pixel16', scale: textScale + 1, align: 'left' });

    /* 注意: 带圈数字 U+2460-2462 不在 GB2312 一级字库, 用半角数字。 */
    px.screen.drawText('键1 设置  键2 返回应用', (W / 2) | 0, HINT_TOP, {
      color: C.dimmer, font: 'pixel12', scale: textScale, align: 'center',
    });
    px.screen.drawText('键3 短按息屏 长按关机', (W / 2) | 0, H - Math.round(H * 0.115), {
      color: C.dimmer, font: 'pixel12', scale: textScale, align: 'center',
    });
    px.screen.drawText('键1+键3 长按 网页配网', (W / 2) | 0, H - Math.round(H * 0.06), {
      color: C.dimmer, font: 'pixel12', scale: textScale, align: 'center',
    });
  }

  var bannerCache = { key: null, disp: '' };

  function drawWifi() {
    /* 状态帧内单快照: banner 出现与否/覆盖带高度/命中全用同一值, 消除撕裂 */
    var st = wifiStatus();
    var top = wifiListTop(st.connected);
    var ms = maxScroll(st.connected);
    if (scrollY > ms) scrollY = ms; /* 连接状态变化会移动 listTop, 重钳 */

    var rowH = wifiRowH();
    if (scanning && aps.length === 0) {
      var dots = '';
      for (var d = 0; d < ((frame / 6) | 0) % 4; d++) dots += '.';
      px.screen.drawText('正在扫描' + dots, (W / 2) | 0, top + Math.round(H * 0.1), {
        color: C.dim, font: 'pixel12', scale: textScale, align: 'center',
      });
    } else if (scanErr && aps.length === 0) {
      px.screen.drawText('扫描失败', (W / 2) | 0, top + Math.round(H * 0.08), {
        color: C.red, font: 'pixel12', scale: textScale, align: 'center',
      });
      px.screen.drawText('点右上角刷新重试', (W / 2) | 0, top + Math.round(H * 0.15), {
        color: C.dimmer, font: 'pixel12', scale: textScale, align: 'center',
      });
    } else if (scanned && aps.length === 0) {
      px.screen.drawText('未发现网络', (W / 2) | 0, top + Math.round(H * 0.1), {
        color: C.dim, font: 'pixel12', scale: textScale, align: 'center',
      });
    }

    for (var i = 0; i < aps.length; i++) {
      var y = top + i * rowH - scrollY;
      if (y + rowH <= top || y >= H) continue;
      var a = aps[i];
      var textY = textMidY(y, rowH);
      var isCur = st.connected && st.ssid === a.ssid;
      px.screen.drawText(a.disp, PAD, textY, {
        color: isCur ? C.green : C.text, font: 'pixel12', scale: textScale, align: 'left',
      });
      var bx = W - PAD - barsWidth();
      drawBars(bx, y + rowH - Math.round(rowH * 0.32), rssiLevel(a.rssi), isCur ? C.green : C.accent);
      if (a.secure) drawLock(bx - lockWidth() - Math.round(10 * S), y + Math.round(rowH * 0.3), C.dimmer);
      px.screen.drawLine(PAD, y + rowH - 1, W - PAD, y + rowH - 1, 0x1a2230);
    }

    /* 滚动条 */
    if (ms > 0) {
      var viewH = H - top;
      var barH = Math.max(20, Math.round(viewH * viewH / (aps.length * rowH)));
      var barY = top + Math.round((viewH - barH) * scrollY / ms);
      px.screen.fillRect(W - 3, barY, 2, barH, C.border);
    }

    /* 顶部不透明覆盖带 (gfx 无裁剪, 滚动的半可见行会画进头部, 后画盖掉) */
    px.screen.fillRect(0, 0, W, top, C.bg);
    drawHeader('WiFi', true);
    if (st.connected) {
      px.screen.fillRect(0, HDR_H, W, BANNER_H, C.panel);
      var ckS = Math.round(7 * S);
      drawCheck(PAD, HDR_H + (BANNER_H >> 1) - Math.round(2 * S), ckS, C.green);
      var tx = PAD + ckS + Math.round(10 * S);
      var dr = disconnectRect();
      if (bannerCache.key !== st.ssid) {
        bannerCache.key = st.ssid;
        bannerCache.disp = truncText(dispText(st.ssid || ''), dr.x - tx - Math.round(8 * S));
      }
      px.screen.drawText(bannerCache.disp, tx, HDR_H + Math.round(BANNER_H * 0.16), {
        color: C.text, font: 'pixel12', scale: textScale, align: 'left',
      });
      px.screen.drawText(st.ip || '', tx, HDR_H + Math.round(BANNER_H * 0.55), {
        color: C.dim, font: 'pixel12', scale: textScale, align: 'left',
      });
      px.screen.drawRect(dr.x, dr.y, dr.w, dr.h, C.border); /* 幽灵按钮: 红字描边 */
      px.screen.drawText('断开', dr.x + (dr.w >> 1), textMidY(dr.y, dr.h), {
        color: C.red, font: 'pixel12', scale: textScale, align: 'center',
      });
      px.screen.drawLine(0, HDR_H + BANNER_H - 1, W, HDR_H + BANNER_H - 1, C.border);
    }
  }

  function drawPass() {
    drawHeader(passDispTitle, false);

    var ir = inputRect();
    px.screen.fillRect(ir.x, ir.y, ir.w, ir.h, C.panel);
    px.screen.drawRect(ir.x, ir.y, ir.w, ir.h, passErr ? C.red : C.border);

    var er = eyeRect();
    var reveal = monoMs - lastTypeAt < 1200;
    var shown;
    if (showPass) {
      shown = passInput;
    } else {
      shown = '';
      for (var i = 0; i < passInput.length; i++) {
        shown += (reveal && i === passInput.length - 1) ? passInput.charAt(i) : '*';
      }
    }
    var maxW = er.x - ir.x - Math.round(16 * S);
    /* 超宽时保尾部 (光标处) */
    while (shown.length > 1) {
      var mw = 0;
      try { mw = px.screen.measureText(shown, F12).width; } catch (e) { break; }
      if (mw <= maxW) break;
      shown = shown.substring(1);
    }
    var tY = textMidY(ir.y, ir.h);
    px.screen.drawText(shown, ir.x + Math.round(8 * S), tY, {
      color: C.text, font: 'pixel12', scale: textScale, align: 'left',
    });
    /* 光标 */
    if (((frame / 10) | 0) % 2 === 0 && !connecting) {
      var cw = 0;
      try { cw = px.screen.measureText(shown, F12).width; } catch (e) {}
      px.screen.fillRect(ir.x + Math.round(8 * S) + cw + 2, tY, 2, LH12, C.accent);
    }
    drawEye((er.x + er.w / 2) | 0, (er.y + er.h / 2) | 0, Math.round(er.h * 0.3), showPass ? C.accent : C.dimmer, showPass);

    var hintY = ir.y + ir.h + Math.round(6 * S);
    if (passErr) {
      px.screen.drawText(passErr, PAD, hintY, { color: C.red, font: 'pixel12', scale: textScale, align: 'left' });
    } else if (passInput.length > 0 && passInput.length < 8) {
      px.screen.drawText('WPA 密码至少 8 位', PAD, hintY, { color: C.dimmer, font: 'pixel12', scale: textScale, align: 'left' });
    }

    /* 键盘 */
    px.screen.fillRect(0, KB_TOP, W, KB_H, 0x0e1420);
    var keys = kbLayout();
    for (var k = 0; k < keys.length; k++) {
      var it = keys[k];
      var key = it.key;
      var isFn = key.id !== 'ch';
      var isOk = key.id === 'ok';
      var pressed = keyMatches(pressedKey, key);
      var okOn = isOk && passInput.length > 0;
      var bg = isOk ? (okOn ? C.green : C.keyFn)
                    : (pressed ? C.panelHi : (isFn ? C.keyFn : C.keyBg));
      px.screen.fillRect(it.x, it.y, it.w, it.h, bg);
      px.screen.drawRect(it.x, it.y, it.w, it.h, pressed ? C.accent : C.border);
      var cx = it.x + (it.w >> 1);
      if (key.id === 'shift') {
        drawShift(cx, it.y + (it.h >> 1), Math.round(it.h * 0.22), kbMode === 'upper' ? C.accent : C.dim, kbMode === 'upper');
      } else if (key.id === 'bksp') {
        drawBksp(cx, it.y + (it.h >> 1), Math.round(it.h * 0.24), C.dim);
      } else {
        var label = key.id === 'ch' ? key.ch : key.label;
        /* 深色字上绿键 (白字对比度不足), 置灰连接键用亮灰 */
        var lc = isOk ? (okOn ? C.bg : C.dimmer) : C.text;
        px.screen.drawText(label, cx, textMidY(it.y, it.h), {
          color: lc, font: 'pixel12', scale: textScale, align: 'center',
        });
      }
    }
  }

  function drawConnecting() {
    var bw = Math.round(W * 0.8), bh = Math.round(H * 0.24);
    var bx = (W - bw) >> 1, by = (H - bh) >> 1;
    px.screen.fillRect(bx, by, bw, bh, C.panel);
    px.screen.drawRect(bx, by, bw, bh, C.border);
    /* 转圈: 8 点环 */
    var cx = W >> 1, cy = by + Math.round(bh * 0.36);
    var rad = Math.round(10 * S);
    var t = (frame / 2) | 0;
    for (var i = 0; i < 8; i++) {
      var ang = i * Math.PI / 4;
      var lit = ((i - t) % 8 + 8) % 8;
      var dotR = lit < 3 ? Math.max(2, Math.round(2.5 * S)) : Math.max(1, Math.round(1.5 * S));
      var col = lit < 3 ? C.accent : C.border;
      px.screen.fillCircle(cx + Math.round(Math.cos(ang) * rad), cy + Math.round(Math.sin(ang) * rad), dotR, col);
    }
    px.screen.drawText('正在连接 ' + truncText(dispText(connecting.ssid), Math.round(bw * 0.7)), cx, by + Math.round(bh * 0.62), {
      color: C.text, font: 'pixel12', scale: textScale, align: 'center',
    });
  }

  function draw(dt) {
    frame++;
    monoMs += (dt > 0 && dt < 10000) ? dt : 50;

    /* 扫描看门狗: 固件层扫描被打断时的兜底 (正常路径不触发) */
    if (scanning && monoMs - scanStartAt > 25000) {
      scanning = false;
      scanErr = '扫描超时';
      lastScanAt = monoMs;
    }
    /* wifi 页空闲自动重扫 (对齐官方: 列表保持新鲜); 手势/连接中不打扰 */
    if (page === 'wifi' && hasWifi && scanned && !scanning && !connecting &&
        !touchState && monoMs - lastScanAt > 15000) {
      startScan();
    }

    px.screen.clear(C.bg);
    if (page === 'main') drawMain();
    else if (page === 'wifi') drawWifi();
    else drawPass();

    if (connecting) drawConnecting();

    if (toast) {
      if (monoMs > toast.until) { toast = null; }
      else {
        var tr = toastRect();
        px.screen.fillRect(tr.x, tr.y, tr.w, tr.h, C.panelHi);
        px.screen.drawRect(tr.x, tr.y, tr.w, tr.h, C.border);
        px.screen.drawText(truncText(toast.text, tr.w - Math.round(16 * S)), (W / 2) | 0, textMidY(tr.y, tr.h), {
          color: toast.color, font: 'pixel12', scale: textScale, align: 'center',
        });
      }
    }

    /* 退格长按连删: 按住 500ms 后每 150ms 删一个 (时间驱动, 帧率无关) */
    if (pressedKey && pressedKey.id === 'bksp' && page === 'pass' && !connecting) {
      if (monoMs - pressedKey.downAt > 500 && monoMs - pressedKey.lastRep >= 150) {
        pressedKey.lastRep = monoMs;
        passInput = passInput.substring(0, passInput.length - 1);
      }
    }
  }

  /* ------------------------------------------------------------ 触摸 */

  function enterWifiPage() {
    page = 'wifi';
    toast = null;
    scrollY = 0;
    touchState = null;
    pendingAps = null;
    startScan();
  }

  function enterPassPage(ssid) {
    passSsid = ssid;
    passDispTitle = truncText(dispText(ssid), Math.round(W * 0.4));
    passInput = '';
    passErr = null;
    kbMode = 'lower';
    showPass = false;
    pressedKey = null;
    toast = null;
    page = 'pass';
  }

  function touchMain(ev) {
    if (ev.type === 'down') {
      /* 标题带/提示带是覆盖画上去的, 其下可能压着半行 —— 不许穿透 */
      if (ev.y < MAIN_TOP || ev.y >= mainViewBottom()) return;
      var i, r;
      /* 滑条轨道优先: 落在轨道上就是调值 (横向拖), 不参与纵向滚动。
       * 轨道只占右半宽, 左侧标签区始终是滚动手柄。 */
      for (i = 0; i < rows.length; i++) {
        r = rows[i];
        if (r.kind !== 'slider') continue;
        var sr = sliderRect(r);
        if (ev.x >= sr.x - 8 && ev.x <= sr.x + sr.w + 8 &&
            ev.y >= rowScreenY(r) && ev.y <= rowScreenY(r) + ROW_H) {
          dragging = r;
          applySlider(r, ev.x);
          return;
        }
      }
      /* 其余区域 = 滚动手柄; 若落在 link 行上, 无位移的 up 才当 tap (防误触) */
      var tgt = null;
      for (i = 0; i < rows.length; i++) {
        r = rows[i];
        if (r.kind === 'link' && hasWifi &&
            ev.y >= rowScreenY(r) && ev.y <= rowScreenY(r) + ROW_H) { tgt = r; break; }
      }
      mainTouch = { x: ev.x, y: ev.y, scrollY: mainScrollY, moved: false, tgt: tgt };
    } else if (ev.type === 'move') {
      if (dragging) { applySlider(dragging, ev.x); return; }
      if (!mainTouch) return;
      if (!mainTouch.moved) {
        if (Math.abs(ev.y - mainTouch.y) > TAP_SLOP || Math.abs(ev.x - mainTouch.x) > TAP_SLOP) {
          mainTouch.moved = true;
          /* 重定基准到当前点: 拖动从 0 平滑起步, 消除 TAP_SLOP 死区跳变 */
          mainTouch.y = ev.y;
          mainTouch.scrollY = mainScrollY;
        }
      } else {
        mainScrollY = mainTouch.scrollY - (ev.y - mainTouch.y);
        clampMainScroll();
      }
    } else if (ev.type === 'up') {
      dragging = null;
      var ts = mainTouch;
      mainTouch = null;
      if (!ts || ts.moved || !ts.tgt) return;
      /* up 必须仍落在同一行上 (滚动中途松手不算 tap) */
      if (ev.y >= rowScreenY(ts.tgt) && ev.y <= rowScreenY(ts.tgt) + ROW_H) enterWifiPage();
    }
  }

  function touchWifi(ev) {
    if (connecting) return; /* 遮罩期间不响应 */
    if (ev.type === 'down') {
      /* down 时刻锁定命中目标; up 时校验布局未移位才执行 (防 banner 出没/扫描重排错位) */
      var st0 = wifiStatus();
      var top0 = wifiListTop(st0.connected);
      var tgt = null;
      if (inRect(ev.x, ev.y, backRect())) {
        tgt = { kind: 'back' };
      } else if (inRect(ev.x, ev.y, refreshRect())) {
        tgt = { kind: 'refresh' };
      } else if (st0.connected && ev.y >= HDR_H && ev.y < HDR_H + BANNER_H) {
        /* 断开命中区 = 横幅右段整块 (绘制矩形太小, 26px 高不满足指宽) */
        if (ev.x >= disconnectRect().x - Math.round(8 * S)) tgt = { kind: 'disconnect' };
      } else {
        var idx = wifiRowAt(ev.y, st0.connected);
        if (idx >= 0) tgt = { kind: 'row', ssid: aps[idx].ssid };
      }
      touchState = { x: ev.x, y: ev.y, scrollY: scrollY, moved: false, tgt: tgt, listTop: top0 };
    } else if (ev.type === 'move' && touchState) {
      if (!touchState.moved &&
          (Math.abs(ev.y - touchState.y) > TAP_SLOP || Math.abs(ev.x - touchState.x) > TAP_SLOP)) {
        touchState.moved = true;
        /* 重定基准到当前点: 拖动从 0 平滑起步, 消除 TAP_SLOP 死区跳变 */
        touchState.y = ev.y;
        touchState.scrollY = scrollY;
      } else if (touchState.moved) {
        scrollY = touchState.scrollY - (ev.y - touchState.y);
        if (scrollY < 0) scrollY = 0;
        var ms = maxScroll();
        if (scrollY > ms) scrollY = ms;
      }
    } else if (ev.type === 'up') {
      if (!touchState) return;
      var ts = touchState;
      touchState = null;
      if (pendingAps) { aps = pendingAps; pendingAps = null; } /* 手势结束, 应用新扫描 */
      if (ts.moved || !ts.tgt) return;
      if (wifiListTop() !== ts.listTop) return; /* 布局已移位, 本次 tap 作废 */
      if (ts.tgt.kind === 'back') { toast = null; page = 'main'; return; }
      if (ts.tgt.kind === 'refresh') { startScan(); return; }
      if (ts.tgt.kind === 'disconnect') {
        try { px.wifi.disconnect(); showToast('已断开', C.dim); } catch (e) {}
        return;
      }
      /* row: 按 ssid 在当前列表重定位 (扫描可能已替换列表) */
      var a = null;
      for (var i = 0; i < aps.length; i++) {
        if (aps[i].ssid === ts.tgt.ssid) { a = aps[i]; break; }
      }
      if (!a) return;
      var st = wifiStatus();
      if (st.connected && st.ssid === a.ssid) { showToast('已连接此网络', C.dim); return; }
      if (a.secure) enterPassPage(a.ssid);
      else connectTo(a.ssid, '', false);
    }
  }

  function touchPass(ev) {
    /* up 清理必须先于 connecting 守卫, 否则按压高亮/连删永久卡死 */
    if (ev.type === 'up') { pressedKey = null; return; }
    if (connecting) return;
    if (ev.type === 'move') {
      if (pressedKey) {
        var hit = keyAt(ev.x, ev.y);
        if (!hit || !keyMatches(pressedKey, hit.key)) pressedKey = null; /* 滑出键面取消 */
      }
      return;
    }
    /* down */
    if (inRect(ev.x, ev.y, backRect())) { pressedKey = null; toast = null; page = 'wifi'; return; }
    var ir = inputRect(), er = eyeRect();
    /* 眼睛命中区 = 输入框右段整块 (框内其余区域本无功能) */
    var ex = er.x - Math.round(12 * S);
    if (inRect(ev.x, ev.y, { x: ex, y: ir.y, w: ir.x + ir.w - ex, h: ir.h })) {
      showPass = !showPass;
      return;
    }
    var it = keyAt(ev.x, ev.y);
    if (it) {
      pressedKey = { id: it.key.id, ch: it.key.ch, downAt: monoMs, lastRep: 0 };
      pressKey(it.key);
    }
  }

  function onTouch(ev) {
    /* toast 可点消除, 且防触摸穿透到其下的列表/键盘 */
    if (toast && ev.type === 'down' && inRect(ev.x, ev.y, toastRect())) { toast = null; return; }
    if (page === 'main') touchMain(ev);
    else if (page === 'wifi') touchWifi(ev);
    else touchPass(ev);
  }

  /* ------------------------------------------------------------ 启动 */

  try {
    px.screen.setFps(20);
    px.screen.onFrame(function (dt) { draw(dt); });
  } catch (e) {
    console.error('[settings] 屏幕不可用: ' + e);
  }

  try {
    px.input.onTouch(onTouch);
  } catch (e) {
    /* 无触摸 */
  }

  /* devd 远程调试钩子: js.eval 可驱动全流程 (真机免触屏验收) */
  try {
    globalThis.__pxset = {
      down: function (x, y) { onTouch({ type: 'down', x: x, y: y }); },
      up: function (x, y) { onTouch({ type: 'up', x: x, y: y }); },
      tap: function (x, y) { onTouch({ type: 'down', x: x, y: y }); onTouch({ type: 'up', x: x, y: y }); },
      swipe: function (x, y, x2, y2) {
        onTouch({ type: 'down', x: x, y: y });
        var steps = 6;
        for (var i = 1; i <= steps; i++) {
          onTouch({ type: 'move', x: x + (x2 - x) * i / steps, y: y + (y2 - y) * i / steps });
        }
        onTouch({ type: 'up', x: x2, y: y2 });
      },
      move: function (x, y) { onTouch({ type: 'move', x: x, y: y }); },
      key: function (ch) { /* 当前键盘模式下某键中心坐标 */
        var keys = kbLayout();
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i].key;
          if ((k.id === 'ch' && k.ch === ch) || k.id === ch || (k.label && k.label === ch)) {
            return { x: keys[i].x + (keys[i].w >> 1), y: keys[i].y + (keys[i].h >> 1) };
          }
        }
        return null;
      },
      keys: function () { return kbLayout(); },
      state: function () {
        var names = [], secs = [];
        for (var i = 0; i < aps.length; i++) { names.push(aps[i].ssid); secs.push(aps[i].secure ? 1 : 0); }
        return { page: page, aps: aps.length, ssids: names, secures: secs, scanning: scanning, scanErr: scanErr,
                 passSsid: passSsid, passLen: passInput.length, kbMode: kbMode,
                 connecting: !!connecting, passErr: passErr, scrollY: scrollY,
                 mainScrollY: mainScrollY, mainMaxScroll: mainMaxScroll(), mainRows: rows.length,
                 pressed: pressedKey ? pressedKey.id : null, pendingAps: !!pendingAps,
                 toast: toast ? toast.text : null };
      },
      /* 主页行坐标随滚动移动, 用 getter 取"此刻"的屏幕坐标 (滚动为 0 时与旧值一致) */
      rows: { get wifi() { return { x: (W / 2) | 0, y: rowScreenY(wifiRow) + (ROW_H >> 1) }; } },
      mainRow: function (i) {
        var r = rows[i];
        var y = rowScreenY(r);
        return { x: (W / 2) | 0, y: y + (ROW_H >> 1), label: r.label, value: String(r.get()),
                 visible: y >= MAIN_TOP && y + ROW_H <= mainViewBottom() };
      },
      listRow: function (i) { return { x: (W / 2) | 0, y: wifiListTop() + i * wifiRowH() - scrollY + (wifiRowH() >> 1) }; },
    };
  } catch (e) {}

  console.log('[settings] 设置页就绪 (WiFi 配网可用)');
})();
