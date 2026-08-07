#!/usr/bin/env node
/**
 * macOS 原生全屏视觉级验证(v2.5)—— 在真实 mac GUI 上截屏做像素断言
 *
 * 链路:
 * 1. `pnpm run dev` + PIXELBOX_SMOKE_FS_VISUAL=1 启动(main 侧钩子见 fullscreen.ts
 *    runFullscreenVisualSmoke):窗口挪到主显示器 → setFullScreen(true)(绿灯同一
 *    原生入口)进原生全屏 Space → 稳态后打印 `[fs-visual] entered <json>`
 *    (display/workArea/bounds/scaleFactor/主题标题栏色/native/simple);
 * 2. 本脚本等 entered 标记 + 1.5s 动画余量 → /usr/sbin/screencapture -x 截主显示器
 *    (无屏幕录制权限时自动降级:经 `open -g -a Terminal` 启动捕屏助手,由持有
 *    Screen Recording 授权的 Terminal.app 作为责任进程执行 screencapture;两路都
 *    失败则如实降级为 AppKit 状态断言并打印权限授予指引,绝不假装通过);
 * 3. python3 + PIL 像素断言(Retina 坐标 = 逻辑坐标 × scaleFactor):
 *    a) 无系统灰条(硬断言):标题栏横带(左缘 100pt 右侧 → 屏宽 80%)采样求众数,
 *       断言众数色 ≈ 主题标题栏色(dark #2B2D30 / light #F7F8FA,±12/通道)且占比
 *       ≥ 35%。系统菜单栏在全屏可见(系统设置控制)时可能叠占窗口顶部,故对
 *       「窗顶+20pt」与「窗顶+52pt(越过 ~33pt 菜单栏)」双候选行采样,任一命中即过;
 *    b) 假红绿灯(硬断言):原生全屏下真件被 AppKit 收走,TitleBar 原位自绘仿
 *       macOS 红绿灯(红 #FF5F57 / 黄 #FEBC2E / 绿 #28C840,红=关/黄=禁/绿=退全屏)
 *       ——三簇必须常驻可见且 x 序 红<黄<绿;
 *    c) 菜单栏行:如实记录可见性与众数色(受系统设置影响,不作硬断言);
 * 4. 写哨兵文件 → main 退出原生全屏 → 断言 `[fs-visual] exited` 的 native=false、
 *    simple=false 且 bounds 精确恢复;
 * 5. 打印 [fs-visual] PASS/FAIL 与各断言值;收尾杀净 dev 进程树。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXIT_FILE = '/tmp/pb-fs-visual-exit'
const SHOT = '/tmp/pb-fs.png'
const HELPER = '/tmp/pb-fs-capture-helper.command'
const REQ = '/tmp/pb-fs-capture-req'
const DONE = '/tmp/pb-fs-capture-done'
const QUIT = '/tmp/pb-fs-capture-quit'

if (process.platform !== 'darwin') {
  console.log('[fs-visual] SKIP:仅 macOS(Win/Linux 为 F11 原生全屏,无本视觉断言)')
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (label, pass, detail = '') => {
  if (pass) console.log(`[fs-visual] ✓ ${label}${detail ? ` ${detail}` : ''}`)
  else {
    failed++
    console.error(`[fs-visual] ✗ ${label}${detail ? ` ${detail}` : ''}`)
  }
}

// ---------- 截屏(直接 → Terminal 助手降级) ----------
let helperStarted = false
function startHelper() {
  // Terminal.app 持有 Screen Recording 授权(TCC);open -g 不抢前台焦点,
  // 助手循环监听请求文件,以 Terminal 为责任进程执行 screencapture
  writeFileSync(
    HELPER,
    `#!/bin/bash
rm -f ${REQ} ${DONE} ${QUIT}
for i in $(seq 1 600); do
  [ -f ${QUIT} ] && break
  if [ -f ${REQ} ]; then
    out=$(cat ${REQ}); rm -f ${REQ}
    /usr/sbin/screencapture -x "$out" 2>/dev/null && echo ok > ${DONE} || echo fail > ${DONE}
  fi
  sleep 0.5
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
  // 1) 直接截(当前进程的责任应用已有屏幕录制授权时可用)
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', out], { stdio: 'pipe' })
    if (existsSync(out)) return 'direct'
  } catch {
    /* 无授权:降级 Terminal 助手 */
  }
  // 2) Terminal 助手
  if (!helperStarted) {
    startHelper()
    await sleep(3000)
  }
  rmSync(DONE, { force: true })
  writeFileSync(REQ, out)
  for (let i = 0; i < 30 && !existsSync(DONE); i++) await sleep(500)
  if (existsSync(out)) return 'helper'
  return null
}

// ---------- python3 + PIL 像素断言 ----------
function pixelAssert(payload) {
  const py = `
import json, sys, io
from PIL import Image, ImageCms
from collections import Counter

p = json.loads(sys.argv[1])
im = Image.open('${SHOT}')
# screencapture 以显示器色彩空间(Display P3 等)落盘并内嵌 ICC:
# 转换到 sRGB 后特征色即为名义值(实测红绿灯像素与 #FF5F57/#FEBC2E 完全一致)
icc = im.info.get('icc_profile')
im = im.convert('RGB')
if icc:
    try:
        im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile('sRGB'))
    except Exception:
        pass  # 转换失败按原图匹配(容差兜底)
W, H = im.size
s = p['scaleFactor']
wa, b = p['workArea'], p['bounds']
res = {'shot': [W, H]}

# --- a) 假红绿灯三簇(硬断言):原生全屏下真件被 AppKit 收走,TitleBar 在原位
#     自绘仿 macOS 红绿灯(FakeTrafficLights,名义色同真件)——必须常驻可见,
#     三簇 x 序 红<黄<绿
targets = {'red': (255, 95, 87), 'yellow': (254, 188, 46), 'green': (40, 200, 64)}
def near(c, t, tol=30):
    return all(abs(a - v) <= tol for a, v in zip(c, t))
x0, y0 = int(b['x'] * s), int(b['y'] * s)
bx1, by1 = min(W, x0 + int(100 * s)), min(H, y0 + int(40 * s))
found = {}
for k, t in targets.items():
    pts = [(x, y) for y in range(y0, by1) for x in range(x0, bx1) if near(im.getpixel((x, y)), t)]
    found[k] = {
        'count': len(pts),
        'cx': (sum(q[0] for q in pts) / len(pts) / s - b['x']) if pts else None,
    }
res['lights'] = found
ok_lights = all(found[k]['count'] >= 20 for k in targets) and (
    found['red']['cx'] < found['yellow']['cx'] < found['green']['cx']
)
res['ok_lights'] = bool(ok_lights)

# --- b) 无灰条(硬断言):标题栏横带众数 ≈ 主题标题栏色。
#     系统菜单栏在全屏可见(系统设置)时可能叠占窗口顶部 ~33pt,
#     故双候选行采样(窗顶+20pt / 窗顶+52pt),任一命中即过
theme_hex = p['titlebarHex'].lstrip('#')
theme = tuple(int(theme_hex[i:i+2], 16) for i in (0, 2, 4))
xs = list(range(int((b['x'] + 100) * s), int(W * 0.8), max(1, int(8 * s))))
res['band'] = []
ok_band = False
for dy in (20, 52):
    band_y = min(H - 1, int((b['y'] + dy) * s))
    samples = [im.getpixel((x, band_y)) for x in xs]
    mode, n = Counter(samples).most_common(1)[0]
    frac = n / len(samples)
    hit = all(abs(a - v) <= 12 for a, v in zip(mode, theme)) and frac >= 0.35
    res['band'].append({'dy_pt': dy, 'y_px': band_y, 'mode': mode, 'frac': round(frac, 3), 'hit': bool(hit)})
    ok_band = ok_band or hit
res['theme'] = theme
res['ok_band'] = bool(ok_band)

# --- c) 菜单栏行(窗口顶边之上;如实记录,不作硬断言)
menu_visible = b['y'] > 0
menu_mode = None
if menu_visible:
    my = max(0, int(b['y'] * s / 2))
    row = [im.getpixel((x, my)) for x in range(0, W, max(1, int(8 * s)))]
    menu_mode = Counter(row).most_common(1)[0][0]
res['menubar'] = {'visible_above_window': bool(menu_visible), 'mode': menu_mode, 'window_top_pt': b['y']}

print(json.dumps(res))
sys.exit(0 if (ok_lights and ok_band) else 3)
`
  try {
    const out = execFileSync('python3', ['-c', py, JSON.stringify(payload)], {
      stdio: ['pipe', 'pipe', 'inherit']
    })
    return { code: 0, res: JSON.parse(out.toString()) }
  } catch (e) {
    const out = e.stdout?.toString() ?? ''
    try {
      return { code: e.status ?? 1, res: JSON.parse(out) }
    } catch {
      return { code: e.status ?? 1, res: null }
    }
  }
}

// ---------- 主流程 ----------
rmSync(EXIT_FILE, { force: true })
rmSync(QUIT, { force: true })
// 预热 Terminal 捕屏助手:在 app 启动前 open,避免截屏时才拉起 Terminal 夺焦
try {
  startHelper()
} catch {
  /* Terminal 不可用则截屏阶段再降级判定 */
}

const dev = spawn('npm', ['run', 'dev'], {
  cwd: root,
  env: { ...process.env, PIXELBOX_SMOKE_FS_VISUAL: '1', PIXELBOX_SMOKE_FS_EXIT_FILE: EXIT_FILE },
  detached: true, // 独立进程组:收尾可整组杀净(dev.mjs 会派生 electron 子进程)
  stdio: ['ignore', 'pipe', 'pipe']
})

let entered = null
let exited = null
let buf = ''
const onLine = (line) => {
  if (line.includes('[fs-visual]') || line.includes('[fullscreen]')) console.log(`  (app) ${line}`)
  let m = line.match(/\[fs-visual\] entered (\{.*\})/)
  if (m) entered = JSON.parse(m[1])
  m = line.match(/\[fs-visual\] exited (\{.*\})/)
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
    process.kill(-dev.pid, 'SIGTERM') // 杀整个进程组(npm → dev.mjs → electron)
  } catch {
    /* 已退出 */
  }
  if (helperStarted) writeFileSync(QUIT, '1')
}

void (async () => {
  // 1) 等 entered(dev 编译 + 启动 + 归一 + 进原生全屏 Space,宽限 90s)
  for (let i = 0; i < 180 && !entered; i++) await sleep(500)
  if (!entered) {
    console.error('[fs-visual] FAIL:90s 内未见 [fs-visual] entered(dev 启动或进全屏失败)')
    killAll()
    process.exit(1)
  }
  console.log(`[fs-visual] entered:theme=${entered.theme} display=${JSON.stringify(entered.display)} scale=${entered.scaleFactor}`)
  assert('AppKit 态:native=true simple=false(原生全屏 Space)', entered.native === true && entered.simple === false)
  const disp = entered.display
  const wa = entered.workArea
  const bo = entered.bounds
  assert(
    '原生全屏 bounds 铺满所在显示器(宽=屏宽,高≥workArea 高)',
    Math.abs(bo.width - disp.width) <= 2 && bo.height >= wa.height - 2,
    `bounds=${JSON.stringify(bo)}`
  )

  // 2) 动画余量 1.5s → 截屏 + 像素断言(截屏可能撞上瞬态/被遮挡:最多重试 3 次,
  //    main 侧钩子有保焦自愈,重试窗口内会恢复稳态)
  await sleep(1500)
  let res = null
  let how = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    how = await capture(SHOT)
    if (!how) break // 权限问题不重试,走降级分支
    const r = pixelAssert(entered)
    res = r.res
    if (res && res.ok_lights && res.ok_band) break
    if (attempt < 3) {
      console.log(`[fs-visual] 第 ${attempt} 次截屏断言未过(可能撞上瞬态)→ 2.5s 后重试`)
      await sleep(2500)
    }
  }
  if (!how) {
    // 如实降级:不做像素断言,权限指引 + 仅 AppKit 态断言
    console.error('[fs-visual] 截屏不可用(两路均失败)—— 降级为 AppKit 状态断言,视觉断言未执行')
    console.error('[fs-visual] 授权指引:系统设置 › 隐私与安全性 › 屏幕录制(Screen & System Audio Recording)')
    console.error('[fs-visual]   → 为运行本脚本的终端(或 Terminal.app)开启授权后重跑本脚本')
    failed++
  } else {
    console.log(`[fs-visual] 截屏成功(${how === 'direct' ? '直接' : 'Terminal 助手(责任进程持有屏幕录制授权)'})→ ${SHOT}`)
    // 3) 像素断言
    if (!res) {
      console.error('[fs-visual] python3/PIL 分析失败(需 pip3 install pillow)')
      failed++
    } else {
      const L = res.lights
      assert(
        '假红绿灯三簇常驻可见且 x 序 红<黄<绿(TitleBar 自绘)',
        res.ok_lights,
        `red=${L.red.count}px@x${L.red.cx?.toFixed(0)} yellow=${L.yellow.count}px@x${L.yellow.cx?.toFixed(0)} ` +
          `green=${L.green.count}px@x${L.green.cx?.toFixed(0)}(窗口内逻辑坐标)`
      )
      const bandDetail = res.band
        .map((b2) => `dy=${b2.dy_pt}pt mode=rgb(${b2.mode}) 占比 ${(b2.frac * 100).toFixed(0)}%${b2.hit ? '✓' : ''}`)
        .join(' | ')
      assert(
        `无系统灰条:标题栏横带众数 ≈ 主题色 ${entered.titlebarHex}(双候选行任一命中)`,
        res.ok_band,
        bandDetail
      )
      console.log(
        `[fs-visual] 菜单栏(如实记录,不作硬断言):窗口顶边 y=${res.menubar.window_top_pt}pt` +
          `${res.menubar.visible_above_window ? `,其上为系统菜单栏区,众数色 rgb(${res.menubar.mode})` : ',窗口顶边为 0(菜单栏被系统设置隐藏)'}`
      )
    }
  }

  // 4) 哨兵 → 退出原生全屏 → bounds 恢复断言
  writeFileSync(EXIT_FILE, '1')
  for (let i = 0; i < 60 && !exited; i++) await sleep(500)
  if (!exited) {
    console.error('[fs-visual] FAIL:30s 内未见 [fs-visual] exited')
    failed++
  } else {
    assert(
      '退出全屏回窗口态且 bounds 精确恢复',
      exited.restored === true && exited.native === false && exited.simple === false,
      `before=${JSON.stringify(exited.before)} after=${JSON.stringify(exited.after)}`
    )
  }

  console.log(failed === 0 ? '[fs-visual] PASS' : `[fs-visual] FAIL(${failed} 项)`)
  killAll()
  await sleep(1500)
  rmSync(EXIT_FILE, { force: true })
  process.exit(failed === 0 ? 0 : 1)
})()
