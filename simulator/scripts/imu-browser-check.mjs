import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwind from 'tailwindcss'

const require = createRequire(import.meta.url)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const simRoot = new URL('..', import.meta.url).pathname
const timeout = setTimeout(() => { console.error('IMU_BROWSER_TIMEOUT (60s)'); process.exit(1) }, 60_000)
const runtime = await build({
  absWorkingDir: simRoot, entryPoints: ['src/renderer/src/device-sim/sandbox/runtime/index.ts'],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', loader: { '.woff2': 'base64' }
})
const bundle = await build({
  absWorkingDir: simRoot, entryPoints: ['scripts/checks/imu-browser.entry.tsx'],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic',
  loader: { '.woff2': 'dataurl' },
  plugins: [{ name: 'sandbox', setup(builder) {
    builder.onResolve({ filter: /^virtual:pixelbox-sandbox-runtime$/ }, () => ({ path: 'runtime', namespace: 'sandbox' }))
    builder.onLoad({ filter: /.*/, namespace: 'sandbox' }, () => ({ contents: `export default ${JSON.stringify(runtime.outputFiles[0].text)}` }))
  } }]
})
const config = require('../tailwind.config.js')
const css = await postcss([tailwind({ ...config, content: [join(simRoot, 'src/renderer/src/device-sim/panel/*.tsx')] })])
  .process(await readFile(join(simRoot, 'src/renderer/src/assets/main.css'), 'utf8'), { from: undefined })
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}
html,body,#root{width:100%;height:100%;margin:0}#root{display:flex;flex-direction:column;background:#202124;color:#ddd}
</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const artifacts = await mkdtemp(join(tmpdir(), 'espide-imu-'))
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.imuCheck?.samples.length > 3)
    const canvas = page.locator('canvas').first()
    await canvas.waitFor({ state: 'visible' })
    // 通过真实相机投影与遮挡检测定位外壳、屏幕;不依赖固定像素坐标。
    const point = async (screen) => page.evaluate((wantScreen) => {
      const v = window.imuCheck.viewers.at(-1)
      v.scene.updateMatrixWorld(true)
      const rect = v.canvas.getBoundingClientRect()
      for (let y = .2; y < .85; y += .015) for (let x = .2; x < .85; x += .015) {
        v.pointerNdc.set(x * 2 - 1, 1 - y * 2)
        v.raycaster.setFromCamera(v.pointerNdc, v.camera)
        const hit = v.raycaster.intersectObject(v.poseRoot, true)[0]
        if (hit && (hit.object === v.screenMesh) === wantScreen) return { x: rect.x + x * rect.width, y: rect.y + y * rect.height }
      }
      throw new Error('未找到可见的' + (wantScreen ? '屏幕' : '外壳'))
    }, screen)
    const state = () => page.evaluate(() => {
      const c = window.imuCheck, v = c.viewers.at(-1)
      return { imu: c.engine.periphStore.get().imu, pose: v.poseRoot.quaternion.toArray(), camera: v.camera.position.toArray(), samples: c.samples.slice(-10), touches: c.touches.length }
    })
    const before = await state()
    const shell = await point(false)
    await page.mouse.move(shell.x, shell.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(shell.x + i * 3, shell.y + i * 2)
      await page.waitForTimeout(22)
    }
    const moving = await state()
    assert.notDeepEqual(moving.pose, before.pose)
    assert.deepEqual(moving.camera, before.camera, '拖设备不应移动相机')
    assert.ok(moving.samples.some(s => Math.hypot(s.gx, s.gy, s.gz) > 1), '沙箱程序未收到旋转角速度')
    await page.waitForTimeout(70)
    const held = await state()
    assert.ok(['gx', 'gy', 'gz'].every(axis => held.imu[axis] === 0), '按住但不移动时角速度应归零')
    await page.mouse.up()
    await page.waitForTimeout(100)
    const after = await state()
    assert.ok(Math.hypot(after.imu.ax, after.imu.ay) > .1)
    assert.ok(Math.abs(Math.hypot(after.imu.ax, after.imu.ay, after.imu.az) - 1) < 1e-8)
    for (const axis of ['gx', 'gy', 'gz']) assert.ok(after.imu[axis] === 0)
    assert.equal(after.touches, before.touches, '外壳拖动不能产生屏幕触摸')
    const app = after.samples.at(-1)
    for (const axis of ['ax', 'ay', 'az']) assert.ok(Math.abs(app[axis] - after.imu[axis]) < .006, '沙箱读数应与面板相同(噪声除外)')
    await page.screenshot({ path: join(artifacts, `drag-${viewport.width}.png`) })
    console.log('拖动截图:', artifacts, JSON.stringify(after.imu))
    const screen = await point(true)
    await page.mouse.click(screen.x, screen.y)
    await page.waitForTimeout(40)
    assert.equal((await state()).touches, before.touches + 2, '旋转后触摸应成对到达程序')
    assert.deepEqual((await state()).pose, after.pose)
    await page.evaluate(() => window.imuCheck.switchView('2d'))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.imuCheck.switchView('3d'))
    await page.waitForTimeout(150)
    assert.ok((await state()).pose.every((v, i) => Math.abs(v - after.pose[i]) < 1e-10), '切回 3D 应保留姿态')
    await page.getByTitle('IMU 传感器', { exact: true }).click()
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page.waitForTimeout(100)
    const reset = await state()
    assert.deepEqual(reset.pose.map(v => v || 0), [0, 0, 0, 1])
    assert.deepEqual(reset.imu, { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 })
    await page.screenshot({ path: join(artifacts, `imu-${viewport.width}.png`) })
    // 在同一帧读取 WebGL 像素,确认模型与应用纹理确实渲染,不把透明空画布算作通过。
    const pixels = await page.evaluate(() => {
      const v = window.imuCheck.viewers.at(-1), gl = v.renderer.getContext()
      v.renderer.render(v.scene, v.camera)
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, data = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
      let shell = 0, screen = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 100 && data[i+1] > 100 && data[i+2] > 100 && data[i+3] > 200) shell++
        if (data[i+1] > data[i] * 1.5 && data[i+1] > 100 && data[i+3] > 200) screen++
      }
      return { shell, screen }
    })
    assert.ok(pixels.shell > 500 && pixels.screen > 20, JSON.stringify(pixels))
    // 窄面板也要完整取景;把所有部件的包围盒角点投影后检查横向边界。
    assert.ok(await page.evaluate(() => {
      const v = window.imuCheck.viewers.at(-1)
      let inside = true
      v.poseRoot.traverse(node => {
        if (!node.geometry) return
        node.geometry.computeBoundingBox()
        const { min, max } = node.geometry.boundingBox
        for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
          const p = min.clone().set(x, y, z).applyMatrix4(node.matrixWorld).project(v.camera)
          if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) inside = false
        }
      })
      return inside
    }), '装配体应完整位于视口内')
    if (viewport.width < 500) await page.getByTitle('IMU 传感器', { exact: true }).click()
    for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
      const screenPoint = await point(true)
      const baseline = await state()
      await page.keyboard.down('Shift')
      await page.mouse.move(screenPoint.x, screenPoint.y)
      await page.mouse.down()
      await page.mouse.move(screenPoint.x - 8, screenPoint.y - 4, { steps: 3 })
      await page.waitForTimeout(30)
      await page.evaluate(type => {
        const v = window.imuCheck.viewers.at(-1)
        if (type === 'blur') window.dispatchEvent(new Event('blur'))
        else v.canvas.dispatchEvent(new PointerEvent(type, { pointerId: v.deviceDrag.pointerId }))
      }, cancel)
      await page.mouse.up()
      await page.keyboard.up('Shift')
      const stopped = await state()
      assert.notDeepEqual(stopped.pose, baseline.pose, 'Shift+屏幕拖动应旋转设备')
      assert.equal(stopped.touches, baseline.touches, '旋转模式不能误触屏幕')
      assert.ok(['gx', 'gy', 'gz'].every(axis => stopped.imu[axis] === 0), `${cancel} 应清零角速度`)
    }
    if (viewport.width >= 500) {
      assert.ok(await page.getByRole('button', { name: '重置', exact: true }).isVisible(), '拖设备时应保留 IMU 面板')
      await page.getByTitle('IMU 传感器', { exact: true }).click()
    }
    const rotatedState = await state()
    const bounds = await canvas.boundingBox()
    await page.mouse.move(bounds.x + 8, bounds.y + 8)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 35, bounds.y + 15, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(120)
    assert.deepEqual((await state()).imu, rotatedState.imu, '空白处观察相机不能改变 IMU')
    // 无显示模组时的回退贴片也必须跟随姿态,且不能进入 STL 导出。
    await page.evaluate(() => {
      const c = window.imuCheck, v = c.viewers.at(-1)
      c.engine.periphStore.set({ imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 } })
      const hw = { ...c.engine.profile.hardware3d, enclosure: undefined }
      v.setHardware(hw)
      if (v.screenMesh.parent !== v.poseRoot) throw new Error('回退屏幕未挂姿态组')
      if (v.getPartNames().includes('screen')) throw new Error('屏幕不应进入可导出的部件根组')
      const pose = v.poseRoot.quaternion.clone().setFromAxisAngle(v.poseCenter.clone().set(1, 0, 0), .2)
      v.setDeviceRotation(pose)
      const center = v.screenMesh.position.clone().applyMatrix4(v.poseRoot.matrixWorld)
      const actual = v.getScreenWorldCenter()
      if (center.distanceTo(center.clone().set(actual.x, actual.y, actual.z)) > 1e-8) throw new Error('回退屏幕姿态不一致')
    })
    assert.deepEqual(errors, [])
    console.log(`IMU_BROWSER_OK ${viewport.width}x${viewport.height}`, JSON.stringify({ imu: after.imu, pixels }))
    await page.close()
  }
  console.log('截图目录:', artifacts)
} finally {
  clearTimeout(timeout)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
