/// <reference path="../../../sdk/types/pixelbox.d.ts" />
/**
 * PixelBox 内置演示 —— 像素弹跳
 *
 * 演示内容:
 *   - px.screen.onFrame 逐帧动画(小球弹跳 + 拖尾)
 *   - px.input.onTouch 触摸交互(点按/拖动生成新球)
 *   - px.input.onButton BOOT 键切换配色,长按清场
 *   - px.color 工具与像素字体中文绘制
 *   - px.storage.kv 持久化最高球数
 */

interface Ball {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: Color
}

const W = px.screen.width
const H = px.screen.height
const GRAVITY = 420 // px/s^2
const BOUNCE = 0.86

let hueBase = 190
const balls: Ball[] = []
let record = Number(px.storage.kv.get('bounce.record') ?? '0')

function spawnBall(x: number, y: number): void {
  const speed = 90 + Math.random() * 160
  const angle = Math.random() * Math.PI * 2
  balls.push({
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed - 120,
    r: 5 + Math.floor(Math.random() * 8),
    color: px.color.hsv((hueBase + Math.random() * 80) % 360, 85, 100)
  })
  if (balls.length > record) {
    record = balls.length
    px.storage.kv.set('bounce.record', String(record))
  }
}

// 初始三个球
spawnBall(W / 2, H / 3)
spawnBall(W / 3, H / 2)
spawnBall((W * 2) / 3, H / 2)

// 触摸:点哪儿弹哪儿,拖动连续生球
let dragging = false
px.input.onTouch((ev) => {
  if (ev.type === 'down') {
    dragging = true
    spawnBall(ev.x, ev.y)
  } else if (ev.type === 'move' && dragging && balls.length < 80) {
    if (Math.random() < 0.3) spawnBall(ev.x, ev.y)
  } else if (ev.type === 'up') {
    dragging = false
  }
})

// BOOT 键:click 换配色,longPress 清场
px.input.onButton((ev) => {
  if (ev.id !== 'boot') return
  if (ev.type === 'click') {
    hueBase = (hueBase + 60) % 360
    for (const b of balls) b.color = px.color.hsv((hueBase + Math.random() * 80) % 360, 85, 100)
    px.audio.player.tone(880, 60, 40)
  } else if (ev.type === 'longPress') {
    balls.length = 0
    spawnBall(W / 2, H / 2)
    px.audio.player.tone(220, 180, 50)
  }
})

// 摇一摇:所有球获得随机冲量
px.sensors.imu.onShake(() => {
  for (const b of balls) {
    b.vx += (Math.random() - 0.5) * 400
    b.vy -= 200 + Math.random() * 200
  }
})

console.log('像素弹跳启动:触摸生球,BOOT 换色,长按清场,摇一摇加速')

px.screen.setFps(30)
px.screen.onFrame((dt) => {
  const s = Math.min(dt, 50) / 1000

  // 半透明拖尾:整屏叠一层带透明感的暗色(用暗矩形近似)
  px.screen.fillRect(0, 0, W, H, 0x000000)

  // 网格背景
  for (let gx = 0; gx < W; gx += 46) px.screen.drawLine(gx, 0, gx, H, 0x101822)
  for (let gy = 0; gy < H; gy += 46) px.screen.drawLine(0, gy, W, gy, 0x101822)

  // 物理与绘制
  for (const b of balls) {
    b.vy += GRAVITY * s
    b.x += b.vx * s
    b.y += b.vy * s
    if (b.x - b.r < 0) {
      b.x = b.r
      b.vx = -b.vx * BOUNCE
    } else if (b.x + b.r > W) {
      b.x = W - b.r
      b.vx = -b.vx * BOUNCE
    }
    if (b.y + b.r > H - 2) {
      b.y = H - 2 - b.r
      b.vy = -b.vy * BOUNCE
      b.vx *= 0.99
    }
    px.screen.fillCircle(b.x | 0, b.y | 0, b.r, b.color)
    px.screen.drawCircle(b.x | 0, b.y | 0, b.r, 0xffffff)
  }

  // 顶部信息(像素字体,含中文)
  px.screen.drawText('PixelBox 像素弹跳', 8, 8, { font: 'pixel12', color: 0xffffff })
  px.screen.drawText(`球数 ${balls.length}  纪录 ${record}`, 8, 26, {
    font: 'pixel12',
    color: 0x7fd4ff
  })
  px.screen.drawText('触摸屏幕试试!', W - 8, H - 20, {
    font: 'pixel12',
    color: 0xffcc66,
    align: 'right'
  })
})
