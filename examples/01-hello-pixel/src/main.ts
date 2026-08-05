/**
 * 01 你好像素 —— PixelBox 最小可玩示例
 *
 * 演示:
 *   - px.screen.onFrame 逐帧渲染(回调返回后自动 flush)
 *   - px.color.hsv 彩虹渐变
 *   - 离屏思路的像素画 Logo(点阵图案 + 整数放大,保像素风)
 *   - 碰壁反弹 + 轻量音效(px.audio.player.tone)
 */

const W = px.screen.width;
const H = px.screen.height;

// 12x12 点阵 Logo:一只呆萌的像素盒子('#' = 实心像素)
const LOGO: string[] = [
  '............',
  '.##########.',
  '.#........#.',
  '.#.##..##.#.',
  '.#.##..##.#.',
  '.#........#.',
  '.#..####..#.',
  '.#...##...#.',
  '.#........#.',
  '.##########.',
  '....####....',
  '............',
];
const LOGO_SIZE = 12;
/** 每个点阵像素放大的倍数(整数,保像素风) */
const SCALE = 8;
const LOGO_PX = LOGO_SIZE * SCALE;

// 运动状态:位置 + 速度(像素/秒)
let x = (W - LOGO_PX) / 2;
let y = (H - LOGO_PX) / 3;
let vx = 96;
let vy = 72;
/** 彩虹色相 0-360,随时间流动 */
let hue = 0;

/** 绘制 Logo:每个点阵像素按 (行+列) 偏移色相,形成对角彩虹渐变 */
function drawLogo(ox: number, oy: number, baseHue: number): void {
  for (let r = 0; r < LOGO_SIZE; r++) {
    const row = LOGO[r];
    for (let c = 0; c < LOGO_SIZE; c++) {
      if (row.charAt(c) !== '#') continue;
      const color = px.color.hsv((baseHue + (r + c) * 9) % 360, 100, 100);
      px.screen.fillRect(ox + c * SCALE, oy + r * SCALE, SCALE, SCALE, color);
    }
  }
}

px.screen.setFps(60);

px.screen.onFrame((dt) => {
  const dtSec = dt / 1000;

  // 位置积分 + 碰壁反弹
  x += vx * dtSec;
  y += vy * dtSec;
  let bounced = false;
  if (x <= 0) { x = 0; vx = Math.abs(vx); bounced = true; }
  if (x >= W - LOGO_PX) { x = W - LOGO_PX; vx = -Math.abs(vx); bounced = true; }
  if (y <= 0) { y = 0; vy = Math.abs(vy); bounced = true; }
  if (y >= H - LOGO_PX) { y = H - LOGO_PX; vy = -Math.abs(vy); bounced = true; }
  if (bounced) {
    // 撞墙:换个起始色相 + 轻微"嘟"声
    hue = (hue + 47) % 360;
    px.audio.player.tone(660, 30, 12);
  }

  hue = (hue + 60 * dtSec) % 360;

  // 背景与画面
  px.screen.clear(px.color.BLACK);
  drawLogo(Math.round(x), Math.round(y), hue);

  // 底部标题:文字颜色跟随彩虹流动
  const title = 'PixelBox 像素盒';
  const style: PxTextStyle = {
    font: 'pixel12',
    scale: 2,
    color: px.color.hsv((hue + 180) % 360, 80, 100),
  };
  const m = px.screen.measureText(title, style);
  px.screen.drawText(title, Math.floor((W - m.width) / 2), H - m.height - 12, style);
});

console.log('01-hello-pixel 已启动:弹跳像素 Logo + 彩虹渐变');
