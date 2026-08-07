#!/usr/bin/env node
/**
 * macOS 红绿灯一比一验收(traffic-lights-diff)—— 真件基准 vs 全屏假件 逐像素 diff
 *
 * 背景:原生全屏下真红绿灯被 AppKit 收进顶部悬停工具条(electron#21604),TitleBar
 * 自绘假件补位(FakeTrafficLights)。本脚本用「测量驱动」验收假件与真件一比一:
 *
 * 链路(配套 main 侧钩子 fullscreen.ts runTrafficLightsDiffSmoke):
 * 1. `npm run dev` + PIXELBOX_SMOKE_TL_DIFF=1 启动:归一 → 窗口态挪到主显示器已知
 *    矩形 → 打印 `[tl-diff] windowed <json>`(bounds/scaleFactor);
 * 2. 本脚本截屏(直接或 Terminal 助手,同 fullscreen-visual-check.mjs 管线)取
 *    真件基准:常态一张;再用 python3 Quartz CGEventPost 合成鼠标移动到真件红键
 *    中心(窗口内 (18,16),即 trafficLightPosition {x:12,y:10} 的首枚 12pt 圆心)
 *    触发组悬停 → 悬停一张。合成悬停若不可用/未生效(以真件悬停 crop 与常态 crop
 *    的像素差检真,而非仅 import 成功)→ 如实降级:仅验常态,悬停标注未验;
 * 3. 写进全屏哨兵 → main setFullScreen(true) → `[tl-diff] fullscreen <json>` →
 *    同法采假件常态 + 悬停(鼠标移到假件红键中心,同为窗口内 (18,16));
 * 4. python3 + PIL:两组截屏各裁三枚 24×24pt(@scale)crop(圆心 (18,16)/(38,16)/
 *    (58,16),ICC→sRGB 后比较),逐通道平均绝对差(0-255):
 *    - 常态三枚各 ≤ 10/255(纯圆面+描边,应几乎全同)
 *    - 悬停三枚各 ≤ 18/255(符号抗锯齿 + 全屏绿键为「相向双三角」变体,放宽)
 *    crop 全部落盘 /tmp/pb-tl-crops/ 供人工复核;
 * 5. 写退出哨兵 → main 退全屏 → 收尾杀净 dev 进程树;打印每枚 diff 与 PASS/FAIL。
 *
 * 运行:pnpm run check:lights(需解锁的 GUI 会话;锁屏下系统拒绝全屏 Space 过渡)
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTER_FILE = '/tmp/pb-tl-enter-fs'
const EXIT_FILE = '/tmp/pb-tl-exit'
const CROP_DIR = '/tmp/pb-tl-crops'
const SHOTS = {
  winNormal: '/tmp/pb-tl-win-normal.png',
  winHover: '/tmp/pb-tl-win-hover.png',
  fsNormal: '/tmp/pb-tl-fs-normal.png',
  fsHover: '/tmp/pb-tl-fs-hover.png'
}
const HELPER = '/tmp/pb-tl-capture-helper.command'
const REQ = '/tmp/pb-tl-capture-req'
const DONE = '/tmp/pb-tl-capture-done'
const QUIT = '/tmp/pb-tl-capture-quit'

// 真件几何(main 侧 trafficLightPosition {x:12,y:10},12pt 圆、圆心距 20pt):
// 三枚圆心的窗口内逻辑坐标;crop 为圆心 ±12pt(24×24pt)
const CENTERS = { red: 18, yellow: 38, green: 58 }
const CENTER_Y = 16
const CROP_HALF = 12
// 阈值(逐通道平均绝对差,0-255)
const TOL_NORMAL = 10
const TOL_HOVER = 18
// 悬停检真:真件悬停 crop 与常态 crop 的差 < 此值 → 判定合成悬停未生效
const HOVER_EFFECT_MIN = 2

if (process.platform !== 'darwin') {
  console.log('[tl-diff] SKIP:仅 macOS(假红绿灯只在 macOS 原生全屏渲染)')
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (label, pass, detail = '') => {
  if (pass) console.log(`[tl-diff] ✓ ${label}${detail ? ` ${detail}` : ''}`)
  else {
    failed++
    console.error(`[tl-diff] ✗ ${label}${detail ? ` ${detail}` : ''}`)
  }
}

// ---------- 截屏(直接 → Terminal 助手降级,同 fullscreen-visual-check.mjs) ----------
let helperStarted = false
function startHelper() {
  writeFileSync(
    HELPER,
    `#!/bin/bash
rm -f ${REQ} ${DONE} ${QUIT}
for i in $(seq 1 1200); do
  [ -f ${QUIT} ] && break
  if [ -f ${REQ} ]; then
    out=$(cat ${REQ}); rm -f ${REQ}
    /usr/sbin/screencapture -x "$out" 2>/dev/null && echo ok > ${DONE} || echo fail > ${DONE}
  fi
  sleep 0.3
done
exit 0
`
  )
  chmodSync(HELPER, 0o755)
  execFileSync('open', ['-g', '-a', 'Terminal', HELPER])
  helperStarted = true
}

async function capture(out) {
  rmSync(out, { force: true })
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', out], { stdio: 'pipe' })
    if (existsSync(out)) return 'direct'
  } catch {
    /* 无授权:降级 Terminal 助手 */
  }
  if (!helperStarted) {
    startHelper()
    await sleep(3000)
  }
  rmSync(DONE, { force: true })
  writeFileSync(REQ, out)
  for (let i = 0; i < 40 && !existsSync(DONE); i++) await sleep(300)
  if (existsSync(out)) return 'helper'
  return null
}

// ---------- Quartz 合成鼠标(悬停触发;不可用则如实降级) ----------
const PY_MOVE = `
import sys, time
import Quartz
x, y = float(sys.argv[1]), float(sys.argv[2])
# 两段式移动:先落到目标左侧 40px 再进入,保证产生跨入 tracking area 的移动事件
for px, py in ((x - 40, y), (x, y)):
    e = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (px, py), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    time.sleep(0.12)
`
let quartzOk = null
function quartzAvailable() {
  if (quartzOk !== null) return quartzOk
  try {
    execFileSync('python3', ['-c', 'import Quartz'], { stdio: 'pipe' })
    quartzOk = true
  } catch {
    quartzOk = false
  }
  return quartzOk
}
function mouseMove(x, y) {
  execFileSync('python3', ['-c', PY_MOVE, String(x), String(y)], { stdio: 'pipe' })
}

// ---------- python3 + PIL:裁三枚 crop + 逐通道平均绝对差 ----------
function analyze(payload) {
  const py = `
import json, sys, io, os
from PIL import Image, ImageCms

p = json.loads(sys.argv[1])

def load(path):
    im = Image.open(path)
    icc = im.info.get('icc_profile')
    im = im.convert('RGB')
    # screencapture 按显示器色彩空间(Display P3 等)落盘并内嵌 ICC → 转 sRGB
    # 后与名义色对齐(与 fullscreen-visual-check.mjs 同一处理)
    if icc:
        try:
            im = ImageCms.profileToProfile(
                im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile('sRGB'))
        except Exception:
            pass
    return im

CENTERS = p['centers']  # {'red': 18, ...}
CY, HALF = p['centerY'], p['half']

def crop(im, bounds, scale, cx):
    x0 = int(round((bounds['x'] + cx - HALF) * scale))
    y0 = int(round((bounds['y'] + CY - HALF) * scale))
    n = int(round(2 * HALF * scale))
    return im.crop((x0, y0, x0 + n, y0 + n))

def meandiff(a, b):
    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    pa, pb = a.load(), b.load()
    W, H = a.size
    tot = 0
    for y in range(H):
        for x in range(W):
            ca, cb = pa[x, y], pb[x, y]
            tot += abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
    return tot / (W * H * 3)

os.makedirs(p['cropDir'], exist_ok=True)
res = {'normal': {}, 'hover': {}, 'hoverEffect': {}}
imgs = {}
for key, path in p['shots'].items():
    if path and os.path.exists(path):
        imgs[key] = load(path)

for name, cx in CENTERS.items():
    real_n = crop(imgs['winNormal'], p['win']['bounds'], p['win']['scaleFactor'], cx)
    fake_n = crop(imgs['fsNormal'], p['fs']['bounds'], p['fs']['scaleFactor'], cx)
    real_n.save(os.path.join(p['cropDir'], f'real-normal-{name}.png'))
    fake_n.save(os.path.join(p['cropDir'], f'fake-normal-{name}.png'))
    res['normal'][name] = round(meandiff(real_n, fake_n), 2)
    if 'winHover' in imgs and 'fsHover' in imgs:
        real_h = crop(imgs['winHover'], p['win']['bounds'], p['win']['scaleFactor'], cx)
        fake_h = crop(imgs['fsHover'], p['fs']['bounds'], p['fs']['scaleFactor'], cx)
        real_h.save(os.path.join(p['cropDir'], f'real-hover-{name}.png'))
        fake_h.save(os.path.join(p['cropDir'], f'fake-hover-{name}.png'))
        res['hover'][name] = round(meandiff(real_h, fake_h), 2)
        # 悬停检真:真件/假件 悬停 vs 常态 的差(≈0 说明合成悬停没触发符号)
        res['hoverEffect'][name] = {
            'real': round(meandiff(real_n, real_h), 2),
            'fake': round(meandiff(fake_n, fake_h), 2),
        }
print(json.dumps(res))
`
  const out = execFileSync('python3', ['-c', py, JSON.stringify(payload)], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  return JSON.parse(out.toString())
}

// ---------- 主流程 ----------
rmSync(ENTER_FILE, { force: true })
rmSync(EXIT_FILE, { force: true })
rmSync(QUIT, { force: true })
rmSync(CROP_DIR, { recursive: true, force: true })
mkdirSync(CROP_DIR, { recursive: true })
// 预热 Terminal 捕屏助手(app 启动前 open,避免截屏时才拉起 Terminal 夺焦)
try {
  startHelper()
} catch {
  /* Terminal 不可用则截屏阶段再降级判定 */
}

const dev = spawn('npm', ['run', 'dev'], {
  cwd: root,
  env: {
    ...process.env,
    PIXELBOX_SMOKE_TL_DIFF: '1',
    PIXELBOX_SMOKE_TL_ENTER_FILE: ENTER_FILE,
    PIXELBOX_SMOKE_TL_EXIT_FILE: EXIT_FILE
  },
  detached: true, // 独立进程组:收尾整组杀净(dev.mjs 会派生 electron 子进程)
  stdio: ['ignore', 'pipe', 'pipe']
})

let windowed = null
let fullscreen = null
let exited = null
let buf = ''
const onLine = (line) => {
  if (line.includes('[tl-diff]') || line.includes('[fullscreen]')) console.log(`  (app) ${line}`)
  let m = line.match(/\[tl-diff\] windowed (\{.*\})/)
  if (m) windowed = JSON.parse(m[1])
  m = line.match(/\[tl-diff\] fullscreen (\{.*\})/)
  if (m) fullscreen = JSON.parse(m[1])
  m = line.match(/\[tl-diff\] exited (\{.*\})/)
  if (m) exited = JSON.parse(m[1])
}
for (const stream of [dev.stdout, dev.stderr]) {
  stream.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
}

const killAll = () => {
  try {
    process.kill(-dev.pid, 'SIGTERM')
  } catch {
    /* 已退出 */
  }
  if (helperStarted) writeFileSync(QUIT, '1')
}

void (async () => {
  // 1) 等窗口态稳定标记(dev 编译 + 启动 + 归一,宽限 90s)
  for (let i = 0; i < 180 && !windowed; i++) await sleep(500)
  if (!windowed) {
    console.error('[tl-diff] FAIL:90s 内未见 [tl-diff] windowed(dev 启动失败)')
    killAll()
    process.exit(1)
  }
  const wb = windowed.bounds
  const scale = windowed.scaleFactor
  console.log(`[tl-diff] 窗口态就绪 bounds=${JSON.stringify(wb)} scale=${scale}`)

  const hoverUsable = quartzAvailable()
  if (!hoverUsable)
    console.error(
      '[tl-diff] python3 Quartz 不可用(pip3 install pyobjc-framework-Quartz)→ 悬停采样降级,仅验常态'
    )
  // 中性点:窗口中部(远离标题栏),常态截屏前先把鼠标挪开,避免残留悬停态
  const neutral = [wb.x + Math.round(wb.width / 2), wb.y + 400]

  // 2) 真件基准:常态 + 悬停(悬停生效与否稍后用像素差检真)
  let how = null
  if (hoverUsable) mouseMove(neutral[0], neutral[1])
  await sleep(600)
  how = await capture(SHOTS.winNormal)
  if (!how) {
    console.error('[tl-diff] FAIL:截屏不可用(直接 + Terminal 助手两路均失败)')
    console.error('[tl-diff] 授权指引:系统设置 › 隐私与安全性 › 屏幕录制 → 为终端(或 Terminal.app)开启')
    killAll()
    process.exit(1)
  }
  console.log(`[tl-diff] 真件常态截屏 ✓(${how})`)
  let hoverCaptured = false
  if (hoverUsable) {
    // 悬停真件红键中心(窗口内 (18,16));macOS 组悬停 → 三枚同时出符号
    mouseMove(wb.x + CENTERS.red, wb.y + CENTER_Y)
    await sleep(700)
    hoverCaptured = (await capture(SHOTS.winHover)) !== null
    mouseMove(neutral[0], neutral[1])
    console.log(`[tl-diff] 真件悬停截屏 ${hoverCaptured ? '✓' : '✗(悬停降级)'}`)
  }

  // 3) 进全屏 → 假件采样(常态 + 悬停)
  writeFileSync(ENTER_FILE, '1')
  for (let i = 0; i < 60 && !fullscreen; i++) await sleep(500)
  if (!fullscreen) {
    console.error('[tl-diff] FAIL:30s 内未见 [tl-diff] fullscreen(进全屏失败)')
    killAll()
    process.exit(1)
  }
  const fb = fullscreen.bounds
  console.log(`[tl-diff] 全屏态就绪 bounds=${JSON.stringify(fb)}`)
  if (hoverUsable) mouseMove(fb.x + Math.round(fb.width / 2), fb.y + 400)
  await sleep(800)
  assert('全屏假件常态截屏', (await capture(SHOTS.fsNormal)) !== null)
  if (hoverUsable && hoverCaptured) {
    // 悬停假件红键中心(绝对定位后与真件同为窗口内 (18,16))
    mouseMove(fb.x + CENTERS.red, fb.y + CENTER_Y)
    await sleep(700)
    hoverCaptured = (await capture(SHOTS.fsHover)) !== null
    mouseMove(fb.x + Math.round(fb.width / 2), fb.y + 400)
    console.log(`[tl-diff] 假件悬停截屏 ${hoverCaptured ? '✓' : '✗(悬停降级)'}`)
  }

  // 4) 退全屏收尾(分析之前就发退出哨兵,减少全屏 Space 占用时间)
  writeFileSync(EXIT_FILE, '1')

  // 5) 裁 crop + 逐像素 diff
  let res = null
  try {
    res = analyze({
      shots: {
        winNormal: SHOTS.winNormal,
        winHover: hoverCaptured ? SHOTS.winHover : null,
        fsNormal: SHOTS.fsNormal,
        fsHover: hoverCaptured ? SHOTS.fsHover : null
      },
      win: windowed,
      fs: fullscreen,
      centers: CENTERS,
      centerY: CENTER_Y,
      half: CROP_HALF,
      cropDir: CROP_DIR
    })
  } catch (e) {
    console.error(`[tl-diff] FAIL:python3/PIL 分析失败(${e.message ?? e})`)
    killAll()
    process.exit(1)
  }
  console.log(`[tl-diff] crop 已落盘 ${CROP_DIR}(real/fake × normal/hover × 三枚)`)

  // 常态:三枚各 ≤ TOL_NORMAL
  for (const name of Object.keys(CENTERS)) {
    const d = res.normal[name]
    assert(`常态 ${name} diff=${d} ≤ ${TOL_NORMAL}`, d <= TOL_NORMAL)
  }
  // 悬停:先检真(真件悬停必须真的出了符号),再验三枚各 ≤ TOL_HOVER
  if (hoverCaptured && Object.keys(res.hover).length > 0) {
    const eff = res.hoverEffect
    const realTriggered = Object.values(eff).some((e) => e.real >= HOVER_EFFECT_MIN)
    if (!realTriggered) {
      console.error(
        `[tl-diff] ⚠ 合成悬停未生效(真件悬停 crop 与常态几乎无差:${JSON.stringify(eff)})→ 悬停未验(降级)`
      )
      console.error('[tl-diff]   可能原因:辅助功能权限拒绝合成鼠标事件 → 系统设置 › 隐私与安全性 › 辅助功能')
    } else {
      for (const name of Object.keys(CENTERS)) {
        const d = res.hover[name]
        assert(
          `悬停 ${name} diff=${d} ≤ ${TOL_HOVER}(effect real=${eff[name].real} fake=${eff[name].fake})`,
          d <= TOL_HOVER
        )
      }
    }
  } else {
    console.error('[tl-diff] ⚠ 悬停未验(Quartz 不可用或悬停截屏失败)—— 仅常态结果有效')
  }

  // 6) 等退出确认 → 杀净
  for (let i = 0; i < 60 && !exited; i++) await sleep(500)
  if (exited) console.log(`[tl-diff] 退出全屏确认 native=${exited.native}`)
  console.log(failed === 0 ? '[tl-diff] PASS' : `[tl-diff] FAIL(${failed} 项)`)
  killAll()
  await sleep(1500)
  rmSync(ENTER_FILE, { force: true })
  rmSync(EXIT_FILE, { force: true })
  process.exit(failed === 0 ? 0 : 1)
})()
