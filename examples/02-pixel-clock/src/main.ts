/**
 * 02 像素时钟 —— NTP 对时 + 大字号时钟 + 天气 + 触摸换表盘
 *
 * 演示:
 *   - px.system.ntpSync / setTimezone 对时
 *   - 自绘 5x7 点阵数字(fillRect 整数放大 = 真正的大字号像素数字)
 *   - fetch 拉取 wttr.in 天气(纯文本自定义格式,流量极小)
 *   - px.input.onTouch 切换三种表盘样式,px.storage.kv 记住选择
 *
 * 说明:为了不依赖引擎的本地时区实现,时间显示统一用 UTC+8 手动换算
 * (px.system.setTimezone 仍会调用,便于固件侧日志时间正确)。
 */

const W = px.screen.width;
const H = px.screen.height;

/** 显示时区偏移(小时),默认中国标准时间 UTC+8 */
const TZ_OFFSET_HOURS = 8;

// ------------------------------------------------------------
// 5x7 点阵数字字体(1 = 实心),用 fillRect 放大绘制
// ------------------------------------------------------------
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
};
const GLYPH_W = 5;
const GLYPH_H = 7;

/** 计算点阵字符串的像素宽度 */
function bigTextWidth(text: string, scale: number): number {
  return text.length * (GLYPH_W + 1) * scale - scale;
}

/** 绘制点阵大数字(colon 也在字体表里) */
function drawBigText(text: string, x: number, y: number, scale: number, color: Color): void {
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph !== undefined) {
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          if (glyph[r].charAt(c) === '1') {
            px.screen.fillRect(cx + c * scale, y + r * scale, scale, scale, color);
          }
        }
      }
    }
    cx += (GLYPH_W + 1) * scale;
  }
}

// ------------------------------------------------------------
// 日期换算(epoch 毫秒 → UTC+8 年月日时分秒/星期),不依赖 Date 时区
// ------------------------------------------------------------
interface LocalTime {
  y: number; mo: number; d: number;
  h: number; mi: number; s: number;
  /** 0 = 周日 */
  week: number;
}

/** Howard Hinnant civil_from_days 算法:天数 → 公历年月日 */
function civilFromDays(z: number): { y: number; mo: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp < 10 ? mp + 3 : mp - 9;
  return { y: mo <= 2 ? y + 1 : y, mo, d };
}

function localTime(epochMs: number): LocalTime {
  const shifted = epochMs + TZ_OFFSET_HOURS * 3600 * 1000;
  const days = Math.floor(shifted / 86400000);
  const rem = shifted - days * 86400000;
  const { y, mo, d } = civilFromDays(days);
  return {
    y, mo, d,
    h: Math.floor(rem / 3600000),
    mi: Math.floor(rem / 60000) % 60,
    s: Math.floor(rem / 1000) % 60,
    week: (days + 4) % 7, // 1970-01-01 是周四
  };
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

// ------------------------------------------------------------
// 应用状态
// ------------------------------------------------------------
/** 表盘样式:0 经典 / 1 极简 / 2 霓虹 */
let style = 0;
let ntpOk = false;
/** 天气文本,如 "+25C 多云";空串表示尚未获取 */
let weather = '';
let weatherUpdatedAt = 0;
/** 霓虹表盘的流动色相 */
let hue = 0;

// 恢复上次选择的表盘
const savedStyle = px.storage.kv.get('clock.style');
if (savedStyle !== null) {
  const n = parseInt(savedStyle, 10);
  if (n >= 0 && n <= 2) style = n;
}

// ------------------------------------------------------------
// NTP 对时(失败自动重试)与天气拉取
// ------------------------------------------------------------
async function syncTime(): Promise<void> {
  px.system.setTimezone('CST-8');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await px.system.ntpSync();
      ntpOk = true;
      console.log('NTP 对时成功');
      return;
    } catch (err) {
      console.warn(`NTP 对时失败(第 ${attempt} 次):`, err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/** 拉取天气:wttr.in 自定义纯文本格式 "%t|%C",配合 lang=zh 返回中文天气 */
async function fetchWeather(): Promise<void> {
  if (!px.wifi.status().connected) return;
  try {
    const url = 'https://wttr.in/?format=' + encodeURIComponent('%t|%C') + '&lang=zh';
    const res = await fetch(url, { timeoutMs: 10000 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    const parts = text.split('|');
    if (parts.length >= 2) {
      // '°' 字符像素字体未必收录,去掉之
      weather = parts[0].replace('°', '') + ' ' + parts[1];
      weatherUpdatedAt = px.system.now();
      console.log('天气更新:', weather);
    }
  } catch (err) {
    console.warn('天气获取失败:', err);
  }
}

void syncTime().then(() => fetchWeather());
// 每 30 分钟刷新一次天气
setInterval(() => { void fetchWeather(); }, 30 * 60 * 1000);

// 触摸切换表盘并持久化
px.input.onTouch((ev) => {
  if (ev.type !== 'down') return;
  style = (style + 1) % 3;
  px.storage.kv.set('clock.style', String(style));
  px.audio.player.tone(880, 25, 10);
});

// ------------------------------------------------------------
// 三种表盘
// ------------------------------------------------------------

/** 表盘 0 经典:大数字 + 秒进度条 + 日期 + 天气 */
function drawClassic(t: LocalTime): void {
  const timeStr = `${pad2(t.h)}:${pad2(t.mi)}`;
  const scale = 10;
  const tw = bigTextWidth(timeStr, scale);
  drawBigText(timeStr, Math.floor((W - tw) / 2), 120, scale, px.color.WHITE);

  // 秒进度条
  const barW = Math.floor((W - 80) * (t.s / 59));
  px.screen.fillRect(40, 220, W - 80, 6, px.color.rgb(40, 40, 40));
  px.screen.fillRect(40, 220, barW, 6, px.color.CYAN);

  const dateStr = `${t.y}-${pad2(t.mo)}-${pad2(t.d)} ${WEEK_CN[t.week]}`;
  const ds: PxTextStyle = { font: 'pixel12', scale: 2, color: px.color.rgb(160, 160, 160) };
  const dm = px.screen.measureText(dateStr, ds);
  px.screen.drawText(dateStr, Math.floor((W - dm.width) / 2), 260, ds);

  const wText = weather !== '' ? weather : (ntpOk ? '天气获取中...' : '对时中...');
  const wStyle: PxTextStyle = { font: 'pixel12', scale: 2, color: px.color.ORANGE };
  const wm = px.screen.measureText(wText, wStyle);
  px.screen.drawText(wText, Math.floor((W - wm.width) / 2), 320, wStyle);
}

/** 表盘 1 极简:只有时间,冒号呼吸闪烁 */
function drawMinimal(t: LocalTime): void {
  const scale = 11;
  const showColon = t.s % 2 === 0;
  const timeStr = `${pad2(t.h)}${showColon ? ':' : ' '}${pad2(t.mi)}`;
  // ' ' 不在字体表,占位不绘制,宽度一致不会跳动
  const tw = bigTextWidth(timeStr, scale);
  const dim = px.color.rgb(220, 220, 220);
  drawBigText(timeStr, Math.floor((W - tw) / 2), Math.floor(H / 2) - (GLYPH_H * scale) / 2, scale, dim);
}

/** 表盘 2 霓虹:色相流动的数字 + 秒数 + 天气 */
function drawNeon(t: LocalTime): void {
  const timeStr = `${pad2(t.h)}:${pad2(t.mi)}`;
  const scale = 10;
  const tw = bigTextWidth(timeStr, scale);
  drawBigText(timeStr, Math.floor((W - tw) / 2), 110, scale, px.color.hsv(hue, 90, 100));

  const secStr = pad2(t.s);
  const sw = bigTextWidth(secStr, 4);
  drawBigText(secStr, Math.floor((W - sw) / 2), 210, 4, px.color.hsv((hue + 120) % 360, 90, 100));

  if (weather !== '') {
    const wStyle: PxTextStyle = { font: 'pixel12', scale: 2, color: px.color.hsv((hue + 240) % 360, 70, 100) };
    const wm = px.screen.measureText(weather, wStyle);
    px.screen.drawText(weather, Math.floor((W - wm.width) / 2), 300, wStyle);
  }
}

// ------------------------------------------------------------
// 主循环
// ------------------------------------------------------------
px.screen.setFps(30);
px.screen.onFrame((dt) => {
  hue = (hue + dt * 0.03) % 360;
  px.screen.clear(px.color.BLACK);
  const t = localTime(px.system.now());
  if (style === 0) drawClassic(t);
  else if (style === 1) drawMinimal(t);
  else drawNeon(t);

  // 底部小提示
  const hint = '触摸屏幕切换表盘';
  const hs: PxTextStyle = { font: 'pixel12', color: px.color.rgb(90, 90, 90) };
  const hm = px.screen.measureText(hint, hs);
  px.screen.drawText(hint, Math.floor((W - hm.width) / 2), H - hm.height - 6, hs);
});

console.log('02-pixel-clock 已启动,当前表盘样式:', style);
// weatherUpdatedAt 供扩展使用(比如显示"x 分钟前更新")
void weatherUpdatedAt;
