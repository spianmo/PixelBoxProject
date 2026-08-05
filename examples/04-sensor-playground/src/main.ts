/**
 * 04 传感器游乐场 —— IMU 重力小球 + 摇一摇换色 + 系统状态栏
 *
 * 演示:
 *   - px.sensors.imu.start 读取加速度,驱动小球物理(重力 + 碰壁反弹 + 摩擦)
 *   - px.sensors.imu.onShake 摇一摇换色 + 音效
 *   - px.system.battery / memory 顶部状态栏(每秒刷新缓存)
 *   - IMU 不可用时(如部分模拟环境)自动降级:固定向下重力 + 触摸施加冲量
 */

const W = px.screen.width;
const H = px.screen.height;
/** 顶部状态栏高度 */
const BAR_H = 26;

// ------------------------------------------------------------
// 小球物理
// ------------------------------------------------------------
const R = 14; // 半径
let bx = W / 2;
let by = (H + BAR_H) / 2;
let vx = 0;
let vy = 0;
/** 小球色相 */
let hue = 190;
/** 碰壁能量保留比例 */
const BOUNCE = 0.72;
/** 速度衰减(滚动摩擦) */
const FRICTION = 0.995;
/**
 * 重力加速度换算系数(像素/秒² 每 1g)。
 * QMI8658 加速度按 g 为单位;若固件输出 m/s²,把该值除以 9.8 即可。
 */
const G_SCALE = 1400;

/** 最新加速度读数(单位 g) */
let ax = 0;
let ay = 1; // 默认向"屏幕下方"的重力,IMU 数据到达后被覆盖
let imuOk = false;

/** 摇一摇闪光剩余毫秒 */
let flashMs = 0;

/** 轨迹残影 */
const trail: Array<{ x: number; y: number }> = [];
const TRAIL_MAX = 14;

// ------------------------------------------------------------
// IMU 初始化(不可用时降级)
// ------------------------------------------------------------
if (px.sensors.imu.available()) {
  imuOk = true;
  px.sensors.imu.start({
    rateHz: 50,
    onData: (d) => {
      // 屏幕坐标:x 向右,y 向下。安装方位不同时调整符号即可。
      ax = d.ax;
      ay = d.ay;
    },
  });
  px.sensors.imu.onShake(() => {
    // 摇一摇:换色 + 闪光 + 双音效
    hue = Math.floor(Math.random() * 360);
    flashMs = 180;
    px.audio.player.tone(523, 60, 25);
    setTimeout(() => px.audio.player.tone(784, 80, 25), 70);
    console.log('检测到摇晃,新色相:', hue);
  });
} else {
  console.warn('IMU 不可用,降级为固定重力 + 触摸施加冲量');
  // 触摸位置朝向小球方向施加一个冲量,模拟"拨动"
  px.input.onTouch((ev) => {
    if (ev.type !== 'down') return;
    vx += (bx - ev.x) * 3;
    vy += (by - ev.y) * 3;
  });
}

// ------------------------------------------------------------
// 系统状态缓存(每秒刷新,避免每帧查询)
// ------------------------------------------------------------
let batt: PxBatteryInfo = px.system.battery();
let mem: PxMemoryInfo = px.system.memory();
setInterval(() => {
  batt = px.system.battery();
  mem = px.system.memory();
}, 1000);

/** 顶部状态栏:电池图标 + 电量 | 内部堆 | PSRAM */
function drawStatusBar(): void {
  px.screen.fillRect(0, 0, W, BAR_H, px.color.rgb(18, 18, 24));

  // 电池图标(20x10 + 正极头)
  const bw = 20;
  const bh = 10;
  const bxx = 8;
  const byy = Math.floor((BAR_H - bh) / 2);
  const level = batt.level < 0 ? 100 : batt.level;
  const fillColor = batt.charging
    ? px.color.CYAN
    : level > 20
      ? px.color.GREEN
      : px.color.RED;
  px.screen.drawRect(bxx, byy, bw, bh, px.color.GRAY);
  px.screen.fillRect(bxx + bw, byy + 3, 2, 4, px.color.GRAY);
  px.screen.fillRect(bxx + 2, byy + 2, Math.max(1, Math.floor((bw - 4) * (level / 100))), bh - 4, fillColor);

  const battText = batt.level < 0 ? '无电池' : `${batt.level}%${batt.charging ? '+' : ''}`;
  px.screen.drawText(battText, bxx + bw + 8, 7, { font: 'pixel12', color: px.color.WHITE });

  // 内存:内部堆 KB / PSRAM MB
  const memText = `堆 ${Math.round(mem.heapFree / 1024)}K  PS ${(mem.psramFree / 1048576).toFixed(1)}M`;
  const ms: PxTextStyle = { font: 'pixel12', color: px.color.rgb(140, 140, 160) };
  const mm = px.screen.measureText(memText, ms);
  px.screen.drawText(memText, W - mm.width - 8, 7, ms);
}

// ------------------------------------------------------------
// 主循环
// ------------------------------------------------------------
px.screen.setFps(60);
px.screen.onFrame((dt) => {
  const dtSec = Math.min(dt, 50) / 1000; // 帧间隔钳制,防止卡顿后物理爆炸

  // 物理积分:加速度(g) → 像素速度
  vx += ax * G_SCALE * dtSec;
  vy += ay * G_SCALE * dtSec;
  vx *= FRICTION;
  vy *= FRICTION;
  bx += vx * dtSec;
  by += vy * dtSec;

  // 碰壁反弹(上边界是状态栏底部)
  if (bx < R) { bx = R; vx = -vx * BOUNCE; }
  if (bx > W - R) { bx = W - R; vx = -vx * BOUNCE; }
  if (by < BAR_H + R) { by = BAR_H + R; vy = -vy * BOUNCE; }
  if (by > H - R) { by = H - R; vy = -vy * BOUNCE; }

  // 轨迹
  trail.push({ x: bx, y: by });
  if (trail.length > TRAIL_MAX) trail.shift();

  // ---- 绘制 ----
  if (flashMs > 0) {
    flashMs -= dt;
    px.screen.clear(px.color.hsv(hue, 40, 30)); // 摇一摇闪光背景
  } else {
    px.screen.clear(px.color.BLACK);
  }

  // 残影(越旧越暗越小)
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    const k = (i + 1) / trail.length;
    px.screen.fillCircle(
      Math.round(p.x),
      Math.round(p.y),
      Math.max(2, Math.round(R * k * 0.8)),
      px.color.hsv(hue, 100, Math.round(18 + 50 * k)),
    );
  }

  // 小球本体 + 高光
  px.screen.fillCircle(Math.round(bx), Math.round(by), R, px.color.hsv(hue, 90, 100));
  px.screen.fillCircle(Math.round(bx) - 4, Math.round(by) - 5, 4, px.color.hsv(hue, 30, 100));

  drawStatusBar();

  // 底部提示
  const hint = imuOk ? '倾斜盒子滚动小球 · 摇一摇换色' : 'IMU 不可用 · 触摸屏幕拨动小球';
  const hs: PxTextStyle = { font: 'pixel12', color: px.color.rgb(90, 90, 90) };
  const hm = px.screen.measureText(hint, hs);
  px.screen.drawText(hint, Math.floor((W - hm.width) / 2), H - hm.height - 6, hs);
});

console.log('04-sensor-playground 已启动, IMU 可用:', imuOk);
