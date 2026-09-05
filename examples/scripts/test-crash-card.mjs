#!/usr/bin/env node
/**
 * test-crash-card.mjs —— 「屏上报错卡片」真机端到端探针
 *
 *   node examples/scripts/test-crash-card.mjs [设备IP]
 *
 * 经 devd 依次推送三个故意出错的最小应用, 断言日志出现对应的错误出口,
 * 并提示人工核对屏幕。三种屏上表现见 docs/troubleshooting.md §10.1:
 *
 *   A 运行期非致命 → 顶部红色横幅, 5 秒自动消失, 应用继续跑
 *   B 同错刷屏     → 升级为全屏卡片 + 自动停应用
 *   C 入口崩溃     → 全屏卡片常驻
 *
 * 注意屏幕本身无法自动断言: 横幅/卡片是在 hal_display::flush() 的覆盖层钩子里
 * 叠加后**当场恢复**的, 帧缓冲不留痕, px.screen.getPixel() 读不到; 致命卡片
 * 虽然直接落帧缓冲, 但那时 VM 已拆除, js.eval 也执行不了。故本脚本只断言
 * 日志与应用状态, 屏幕留给肉眼 —— 每一步都会打印该看到什么。
 *
 * 跑完自动把 05-electronic-perler 推回去(顺带验证它的 NVS 键崩溃已消失)。
 *
 * 本脚本任何出口都走 ws.close() 并留出排空时间 —— 硬杀(kill -9 / 进程直接退出)
 * 其实也安全: 内核会发 FIN/RST, devd 的 close_fn 会立刻回收 fd(已实测)。真正
 * 会拖垮 devd 的是"连接开着但不再读"(进程被 SIGSTOP、合盖休眠、卡在断点上),
 * devd 已加了连续发送失败判死 + 日志断环两道防线兜底, 见 docs/troubleshooting.md §8.1。
 * 主动 close 只是省掉那十几秒的超时判定。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IP = process.argv[2] || process.env.PIXELBOX_IP || '192.168.1.202'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PERLER = resolve(ROOT, '05-electronic-perler')

/* ---------------------------------------------------------------- 连接 */

const ws = new WebSocket(`ws://${IP}:8765/devd`)
let seq = 1
const pending = new Map()
const logs = [] // {tag, level, msg}
let lastState = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

ws.addEventListener('message', (ev) => {
  let m
  try {
    m = JSON.parse(String(ev.data))
  } catch {
    return
  }
  if (m.id != null && pending.has(m.id)) {
    const fn = pending.get(m.id)
    pending.delete(m.id)
    fn(m)
    return
  }
  if (m.event === 'log' && m.data) {
    logs.push({ tag: m.data.tag, level: m.data.level, msg: String(m.data.msg ?? '') })
  } else if (m.event === 'app.state' && m.data) {
    lastState = m.data
  }
})

function rpc(method, params, timeoutMs = 15000) {
  return new Promise((ok, fail) => {
    const id = seq++
    const t = setTimeout(() => {
      pending.delete(id)
      fail(new Error(`rpc ${method} 超时(${timeoutMs}ms)`))
    }, timeoutMs)
    pending.set(id, (m) => {
      clearTimeout(t)
      m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evalJs = async (code, timeoutMs = 10000) => (await rpc('js.eval', { code }, timeoutMs)).result

/** 应用还活着吗(VM 能跑代码) */
async function vmAlive() {
  try {
    const v = await evalJs('1+1', 4000)
    return String(v) === '2'
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- 推送 */

async function push(manifest, source) {
  const body = Buffer.from(source, 'utf8')
  const sha = createHash('sha256').update(body).digest('hex')
  const { session } = await rpc('app.push_begin', {
    manifest,
    files: [{ path: 'main.js', size: body.length, sha256: sha }]
  })
  for (let off = 0; off < body.length; off += 4096) {
    await rpc('app.push_chunk', {
      session,
      path: 'main.js',
      offset: off,
      dataB64: body.subarray(off, Math.min(off + 4096, body.length)).toString('base64')
    })
  }
  await rpc('app.push_end', { session })
}

const probeManifest = (name, version) => ({
  id: 'com.pixelbox.probe.crashcard',
  name,
  version,
  entry: 'main.js',
  minFirmware: '0.1.0'
})

/* ------------------------------------------------------- 三个故障应用 */

/** A: 定时器里间隔抛错 3 次 —— 每条消息都不同, 不会触发刷屏升级 */
const APP_RUNTIME = `
px.screen.setFps(10);
px.screen.onFrame(function () {
  px.screen.clear(0x001830);
  px.screen.drawText('A 横幅测试: 应用应当继续跑', 8, 200,
                     { font: 'pixel12', color: 0xffffff });
});
var n = 0;
var t = setInterval(function () {
  n++;
  if (n > 3) { clearInterval(t); return; }
  throw new Error('探针A: 定时器故意抛错 #' + n);
}, 900);
`

/** B: onFrame 每帧抛同一条 —— 3 秒内远超 5 次, 应升级为全屏卡片并停应用 */
const APP_BURST = `
px.screen.setFps(30);
px.screen.onFrame(function () {
  throw new Error('探针B: onFrame 每帧抛同一条错误');
});
`

/** C: 入口直接抛 —— 应用根本没跑起来, 全屏卡片常驻 */
const APP_ENTRY = `
px.screen.clear(0x000000);
throw new RangeError('探针C: 应用入口故意抛错');
`

/* ---------------------------------------------------------------- 断言 */

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

/** 取本步开始之后的日志 */
const since = (mark) => logs.slice(mark)
const countMatching = (mark, re) => since(mark).filter((l) => re.test(l.msg)).length

/* ---------------------------------------------------------------- 主流程 */

let opened = false
let finished = false

ws.addEventListener('error', (ev) => {
  if (finished) return
  const why = ev.error?.message || ev.message || '(无详情)'
  console.error(
    opened
      ? `\n✗ 连接中断: ${why} —— 设备可能重启了, 或 devd 把这条连接踢掉了`
      : `\n✗ 连不上 ws://${IP}:8765/devd (${why}) —— 设备不在网, 或 IP 不对`
  )
  process.exit(2)
})

ws.addEventListener('close', (ev) => {
  if (finished || !opened) return
  console.error(`\n✗ 连接被关闭 (code=${ev.code} reason=${ev.reason || '空'})`)
  process.exit(2)
})

ws.addEventListener('open', async () => {
  opened = true
  try {
    const h = await rpc('hello', {})
    console.log(`设备: ${h.name} (${h.model}) fw=${h.fw} 当前应用=${h.app} v${h.appVersion}`)
    await rpc('logs.subscribe', { since: 0 })

    /* --- 0. 固件代次探测 -------------------------------------------- */
    console.log('\n[0] 固件代次探测(NVS 键错误信息是否带上下文)')
    let newFirmware = false
    if (await vmAlive()) {
      const msg = String(
        await evalJs(
          `(function(){try{px.storage.kv.getJSON('probe.key.definitely.too.long');return 'NO-THROW'}catch(e){return e.message}})()`
        )
      )
      newFirmware = /当前\s*"/.test(msg)
      console.log(`  NVS 长键报错: ${msg}`)
      console.log(
        newFirmware
          ? '  → 设备已是含「屏上报错」的新固件, 屏幕应有横幅/卡片'
          : '  → 设备仍是旧固件(错误信息不带键名): 日志断言仍会过, 但屏幕不会有任何卡片。\n' +
              '     要看屏幕效果请先烧录本仓库当前固件: idf.py -p <串口> flash'
      )
    } else {
      console.log('  VM 当前不可用(应用已崩溃?), 跳过代次探测')
    }

    /* --- A. 运行期非致命 → 顶部横幅 --------------------------------- */
    console.log('\n[A] 运行期非致命异常 → 顶部红色横幅(应用继续跑)')
    let mark = logs.length
    await push(probeManifest('探针A 横幅', '1.0.0'), APP_RUNTIME)
    console.log('  已推送, 观察屏幕: 蓝底画面上方应闪出红色横幅「应用异常 …(5 秒后自动隐藏)」')
    await sleep(5000)
    const aThrows = countMatching(mark, /探针A: 定时器故意抛错/)
    check('日志出现定时器未捕获异常', aThrows >= 2, `${aThrows} 条`)
    check('走的是「未捕获异常」出口', countMatching(mark, /未捕获异常/) >= 2)
    check('应用没有被打死(VM 仍可执行)', await vmAlive())
    await sleep(4000)
    check('横幅期已过, 应用仍在跑', await vmAlive())
    console.log('  人工核对: 横幅此刻应已自动消失, 蓝底画面恢复完整')

    /* --- B. 同错刷屏 → 升级全屏卡片 + 停应用 ------------------------ */
    console.log('\n[B] 同一错误刷屏(onFrame 每帧抛) → 升级全屏卡片并自动停应用')
    mark = logs.length
    lastState = null
    await push(probeManifest('探针B 刷屏', '1.0.1'), APP_BURST)
    await sleep(6000)
    const bThrows = countMatching(mark, /探针B: onFrame 每帧抛同一条错误/)
    check('日志出现 onFrame 未捕获异常', bThrows >= 5, `${bThrows} 条`)
    const bStopped = !(await vmAlive())
    if (newFirmware) {
      check('刷屏已被判定并停掉应用', bStopped, bStopped ? '' : 'VM 仍在跑, 升级逻辑未生效?')
    } else {
      console.log(`  (旧固件无升级逻辑, VM 存活=${!bStopped} 属预期)`)
    }
    console.log('  人工核对: 屏幕应是全屏红色卡片, 标题带 ×N, 底部「同一错误反复发生, 应用已停止」')

    /* --- C. 入口崩溃 → 全屏卡片 ------------------------------------- */
    console.log('\n[C] 应用入口异常 → 全屏卡片常驻')
    mark = logs.length
    lastState = null
    await push(probeManifest('探针C 入口', '1.0.2'), APP_ENTRY)
    await sleep(4000)
    check('日志出现「应用入口异常」', countMatching(mark, /应用入口异常/) >= 1)
    check('错误内容为探针抛出的 RangeError', countMatching(mark, /探针C: 应用入口故意抛错/) >= 1)
    check(
      'devd 广播 app.state = crashed',
      lastState?.state === 'crashed',
      lastState ? `state=${lastState.state}` : '未收到 app.state'
    )
    console.log('  人工核对: 屏幕全屏红卡, 应显示「探针C 入口 v1.0.2」+ RangeError 摘要 + 调用栈')

    /* --- D. 恢复现场: 推回电子拼豆 ---------------------------------- */
    console.log('\n[D] 恢复现场: 推回 05-electronic-perler(顺带验证 NVS 键崩溃已消失)')
    mark = logs.length
    const perlerManifest = JSON.parse(readFileSync(`${PERLER}/pixelbox.json`, 'utf8'))
    const perlerSrc = readFileSync(`${PERLER}/dist/main.js`, 'utf8')
    await push(perlerManifest, perlerSrc)
    console.log(`  已推送 ${perlerManifest.name} v${perlerManifest.version} (${perlerSrc.length} 字节)`)
    await sleep(5000)
    check('没有再出现 NVS 键长度报错', countMatching(mark, /NVS 键长度/) === 0)
    check('没有出现入口异常', countMatching(mark, /应用入口异常/) === 0)
    check('应用正常跑起来了', await vmAlive())

    console.log(
      failures === 0
        ? '\n全部日志侧断言通过。屏幕表现请按上面每步的「人工核对」逐条确认。'
        : `\n✗ ${failures} 项断言未通过`
    )
    process.exitCode = failures === 0 ? 0 : 1
  } catch (e) {
    console.error('\n✗ 探针失败:', e.message)
    process.exitCode = 1
  } finally {
    finished = true
    ws.close() /* 必须发出 close 帧, 让 devd 的 on_close 把 fd 摘干净 (见文件头警告) */
    setTimeout(() => process.exit(), 800)
  }
})

/* Ctrl-C 也要礼貌收场, 否则会把 devd 打进上面那个死循环 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    finished = true
    try {
      ws.close()
    } catch {}
    setTimeout(() => process.exit(130), 800)
  })
}
