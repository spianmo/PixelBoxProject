/**
 * 03 语音助手 —— 完整的语音对话体验
 *
 * 演示:
 *   - px.voice.configure / start / startContinuous / stop / interrupt
 *   - 五种状态的屏幕动画:
 *       listening = 扩散波纹 + 麦克风音量律动条
 *       thinking  = 旋转点
 *       speaking  = 像素嘴型开合
 *   - userText / assistantDelta 流式滚动字幕
 *   - speaking 时触摸屏幕 → interrupt 打断演示
 *
 * 交互:
 *   BOOT 键单击 / idle 时触摸屏幕  → 开始一轮对话
 *   BOOT 键长按                    → 持续对话模式
 *   BOOT 键双击                    → 停止
 *   speaking 时触摸屏幕            → 打断播报并重新聆听
 *
 * 中继服务器地址优先读 px.storage.kv 的 'voice.server' 键,
 * 默认 ws://192.168.1.100:8787/realtime,请改成你电脑的局域网 IP。
 */

const W = px.screen.width;
const H = px.screen.height;

// ------------------------------------------------------------
// 语音配置
// ------------------------------------------------------------
const serverUrl = px.storage.kv.get('voice.server') ?? 'ws://192.168.1.100:8787/realtime';
const token = px.storage.kv.get('voice.token') ?? undefined;

px.voice.configure({
  serverUrl,
  token,
  vadSilenceMs: 800,
});
console.log('语音中继服务器:', serverUrl);

// ------------------------------------------------------------
// 会话状态(供渲染)
// ------------------------------------------------------------
let state: PxVoiceState = 'idle';
/** 最近一次用户说的话 */
let userText = '';
/** 助手回复(流式累积) */
let assistantText = '';
/** 助手字幕的换行缓存(文本变化时才重新排版) */
let wrappedCache: string[] = [];
let wrapDirty = false;
/** 最近的错误消息(显示 5 秒) */
let errorText = '';
let errorUntil = 0;
/** 麦克风音量历史,用于 listening 律动条 */
const levels: number[] = [];
/** 动画时钟(毫秒累积) */
let clock = 0;

const SUB_STYLE: PxTextStyle = { font: 'pixel12', color: px.color.WHITE };
const SUB_MAX_WIDTH = W - 32;
const SUB_MAX_LINES = 5;

/** 按屏宽逐字换行(中英文混排),只保留最后几行实现滚动字幕 */
function wrapText(text: string, maxWidth: number, style: PxTextStyle): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    const test = cur + ch;
    if (cur !== '' && px.screen.measureText(test, style).width > maxWidth) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// ------------------------------------------------------------
// 语音事件订阅
// ------------------------------------------------------------
px.voice.on('stateChange', (s) => {
  state = s;
  console.log('voice 状态:', s);
  if (s === 'listening') {
    userText = '';
    assistantText = '';
    wrapDirty = true;
    levels.length = 0;
  }
});
px.voice.on('userText', (text) => {
  userText = text;
});
px.voice.on('assistantDelta', (delta) => {
  assistantText += delta;
  wrapDirty = true;
});
px.voice.on('assistantText', (text) => {
  assistantText = text; // 以完整文本为准
  wrapDirty = true;
});
px.voice.on('level', (level) => {
  levels.push(level);
  if (levels.length > 24) levels.shift();
});
px.voice.on('error', (message) => {
  errorText = message;
  errorUntil = px.system.now() + 5000;
  console.error('voice 错误:', message);
});

// ------------------------------------------------------------
// 输入:按键 + 触摸
// ------------------------------------------------------------
px.input.onButton((ev) => {
  if (ev.id !== 'boot') return;
  if (ev.type === 'click') {
    if (state === 'idle') px.voice.start();
    else if (state === 'speaking') px.voice.interrupt();
  } else if (ev.type === 'longPress') {
    px.voice.startContinuous();
  } else if (ev.type === 'doubleClick') {
    px.voice.stop();
  }
});

px.input.onTouch((ev) => {
  if (ev.type !== 'down') return;
  if (state === 'idle') {
    px.voice.start();
  } else if (state === 'speaking') {
    // 打断演示:speaking 时触摸 = barge-in
    console.log('打断当前播报');
    px.voice.interrupt();
  }
});

// ------------------------------------------------------------
// 各状态动画
// ------------------------------------------------------------
const CX = Math.floor(W / 2);
const CY = 140;

/** idle:呼吸圆点 */
function drawIdle(): void {
  const breath = (Math.sin(clock / 600) + 1) / 2; // 0~1
  const r = 18 + Math.round(breath * 6);
  px.screen.fillCircle(CX, CY, r, px.color.hsv(200, 60, 40 + Math.round(breath * 40)));
  drawCenterText('触摸屏幕或按 BOOT 开始对话', CY + 70, px.color.rgb(150, 150, 150));
}

/** connecting:旋转弧点 */
function drawConnecting(): void {
  const a = clock / 150;
  for (let i = 0; i < 3; i++) {
    const ang = a + (i * Math.PI * 2) / 3;
    px.screen.fillCircle(CX + Math.round(Math.cos(ang) * 26), CY + Math.round(Math.sin(ang) * 26), 5, px.color.CYAN);
  }
  drawCenterText('连接服务器中...', CY + 70, px.color.rgb(150, 150, 150));
}

/** listening:扩散波纹 + 音量律动条 */
function drawListening(): void {
  // 三圈波纹依次扩散
  for (let i = 0; i < 3; i++) {
    const progress = ((clock / 900) + i / 3) % 1; // 0~1
    const r = 14 + Math.round(progress * 70);
    const bright = Math.round((1 - progress) * 90);
    if (bright > 8) px.screen.drawCircle(CX, CY, r, px.color.hsv(140, 80, bright));
  }
  px.screen.fillCircle(CX, CY, 12, px.color.GREEN);

  // 底部音量律动条
  const barW = 6;
  const gap = 3;
  const total = levels.length * (barW + gap);
  let bx = Math.floor((W - total) / 2);
  for (const lv of levels) {
    const bh = 4 + Math.round((lv / 100) * 44);
    px.screen.fillRect(bx, CY + 96 - bh, barW, bh, px.color.hsv(140, 70, 100));
    bx += barW + gap;
  }
  drawCenterText('我在听...', CY + 120, px.color.GREEN);
}

/** thinking:八点旋转 */
function drawThinking(): void {
  const step = Math.floor(clock / 100) % 8;
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4;
    const dist = (i - step + 8) % 8;
    const v = 100 - dist * 11;
    px.screen.fillCircle(
      CX + Math.round(Math.cos(ang) * 30),
      CY + Math.round(Math.sin(ang) * 30),
      4,
      px.color.hsv(45, 90, Math.max(20, v)),
    );
  }
  drawCenterText('思考中...', CY + 70, px.color.YELLOW);
}

/** speaking:像素脸 + 嘴型开合 */
function drawSpeaking(): void {
  // 眼睛
  px.screen.fillRect(CX - 34, CY - 26, 14, 14, px.color.CYAN);
  px.screen.fillRect(CX + 20, CY - 26, 14, 14, px.color.CYAN);
  // 嘴:高度按双频正弦开合,模拟说话
  const open = Math.abs(Math.sin(clock / 90)) * 0.7 + Math.abs(Math.sin(clock / 230)) * 0.3;
  const mouthH = 4 + Math.round(open * 26);
  const mouthW = 56 + Math.round(Math.sin(clock / 170) * 8);
  px.screen.fillRect(CX - Math.floor(mouthW / 2), CY + 14, mouthW, mouthH, px.color.ORANGE);
  drawCenterText('触摸屏幕可打断', CY + 120, px.color.rgb(150, 150, 150));
}

function drawCenterText(text: string, y: number, color: Color): void {
  const style: PxTextStyle = { font: 'pixel12', color };
  const m = px.screen.measureText(text, style);
  px.screen.drawText(text, Math.floor((W - m.width) / 2), y, style);
}

/** 字幕区:用户一行 + 助手滚动多行 */
function drawSubtitles(): void {
  let y = 270;
  if (userText !== '') {
    const you = wrapText('你: ' + userText, SUB_MAX_WIDTH, SUB_STYLE);
    const line = you[you.length - 1]; // 用户文本只保留末行
    px.screen.drawText(line, 16, y, { ...SUB_STYLE, color: px.color.YELLOW });
    y += 22;
  }
  if (assistantText !== '') {
    if (wrapDirty) {
      wrappedCache = wrapText(assistantText, SUB_MAX_WIDTH, SUB_STYLE);
      wrapDirty = false;
    }
    const tail = wrappedCache.slice(-SUB_MAX_LINES); // 滚动:只显示最后几行
    for (const line of tail) {
      px.screen.drawText(line, 16, y, SUB_STYLE);
      y += 18;
    }
  }
}

// ------------------------------------------------------------
// 主循环
// ------------------------------------------------------------
px.screen.setFps(30);
px.screen.onFrame((dt) => {
  clock += dt;
  px.screen.clear(px.color.BLACK);

  // 顶部状态标签
  const labels: Record<PxVoiceState, string> = {
    idle: '空闲',
    connecting: '连接中',
    listening: '聆听',
    thinking: '思考',
    speaking: '播报',
  };
  px.screen.drawText(`语音助手 · ${labels[state]}`, 12, 10, { font: 'pixel12', color: px.color.GRAY });

  switch (state) {
    case 'idle': drawIdle(); break;
    case 'connecting': drawConnecting(); break;
    case 'listening': drawListening(); break;
    case 'thinking': drawThinking(); break;
    case 'speaking': drawSpeaking(); break;
  }

  drawSubtitles();

  // 错误提示(5 秒后消失)
  if (errorText !== '' && px.system.now() < errorUntil) {
    drawCenterText('错误: ' + errorText, H - 40, px.color.RED);
  }
});

console.log('03-voice-assistant 已启动');
