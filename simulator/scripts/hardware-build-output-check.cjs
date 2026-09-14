/** 真实 Electron：硬件评估/SCAD → 构建广播 → 构建页与通知，验证失败后恢复。 */
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const artifacts = fs.mkdtempSync(join(tmpdir(), 'pb-hardware-output-'))
  const { ELECTRON_RUN_AS_NODE, ELECTRON_RENDERER_URL, ...env } = process.env
  const child = spawn(join(__dirname, '../node_modules/.bin/electron'), [__filename, artifacts], {
    cwd: join(__dirname, '..'), env, stdio: 'inherit'
  })
  const timer = setTimeout(() => { console.error('HARDWARE_OUTPUT_TIMEOUT (60s)'); child.kill('SIGKILL') }, 60_000)
  child.on('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const artifacts = process.argv[2]
  const userData = join(artifacts, 'user-data')
  fs.mkdirSync(userData)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  const batches = []
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    if (channel === 'build:report') batches.push(args[0])
    return listener(event, ...args)
  })
  require('../out/main/index.js')
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(check, label, timeout = 20_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await check()) return; await pause(60) }
    throw new Error(`等待失败：${label}`)
  }
  void (async () => {
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length, '主窗口')
    const win = BrowserWindow.getAllWindows()[0]
    const js = (fn, arg) => win.webContents.executeJavaScript(`(${fn})(${JSON.stringify(arg) ?? ''})`)
    await until(() => js(() => !!document.querySelector('.monaco-editor')), '编辑器')
    const project = await js(location => window.api.projectCreate({ location, name: 'hardware-output-check', kind: 'hardware', chip: 'esp32s3' }), artifacts)
    const root = project.root
    const boardPath = join(root, 'design/board.tsx')
    const original = fs.readFileSync(boardPath, 'utf8')
    win.webContents.send('smoke:session-prepare', { root, file: boardPath })
    await until(() => js(() => !!document.querySelector('button[title="硬件设计"]')), '硬件工具入口')
    await js(() => {
      if (!document.querySelector('button[title="查看构建输出"]')) document.querySelector('button[title="硬件设计"]')?.click()
    })
    const summaries = () => batches.flat().filter(line => line.text.includes('设计检查：'))
    await until(() => summaries().length > 0, 'PCB 与外壳检查报告', 30_000)
    assert.equal(summaries().length, 1, '首次并行编译只发布一次最终报告')
    assert(summaries()[0].text.includes('0 项待处理'))
    assert(batches.flat().some(line => line.level === 'warn' && line.text.includes('尚未实物制板')))
    assert(!batches.flat().some(line => line.level === 'error'), '外壳未完成时不能产生临时缺失错误')
    await js(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent === '3D')
      button?.click()
    })
    await js(() => {
      const button = document.querySelector('button[title="查看构建输出"]')
      if (!button) throw new Error('缺少构建输出入口')
      button.click()
    })
    await until(() => js(() => [...document.querySelectorAll('.selectable')].some(el => el.textContent.includes('设计检查：17 元件'))), '底部真实构建输出')
    assert.equal(await js(() => document.body.innerText.includes('查看尺寸与制造检查')), false, '旧报告块已移除')
    // 日志通过已有广播同时送到独立构建窗口。
    await js(() => {
      window.api.toolwindowOpen('build')
    })
    await until(() => BrowserWindow.getAllWindows().length > 1, '独立构建窗口')
    const detached = BrowserWindow.getAllWindows().find(w => w !== win)
    await until(() => detached.webContents.executeJavaScript('!!document.querySelector("button")'), '独立窗口加载')
    fs.writeFileSync(boardPath, 'export default () => { throw new Error("硬件回归：测试失败") }\n')
    await until(() => batches.flat().some(line => line.level === 'error' && line.text.includes('硬件回归：测试失败')), '求值失败日志')
    await until(() => detached.webContents.executeJavaScript('document.body.innerText.includes("硬件回归：测试失败")'), '独立窗口接收硬件日志')
    // 合法 TSX 但尺寸错误也必须进入检查报告，不能只覆盖抛异常路径。
    fs.writeFileSync(boardPath, original.replace('width={41}', 'width={44}'))
    await until(() => summaries().length === 2, '尺寸错误报告')
    assert(batches.flat().some(line => line.level === 'error' && line.text.includes('设计板宽')))
    assert(!summaries()[1].text.includes('0 项待处理'))
    fs.writeFileSync(boardPath, original)
    await until(() => summaries().length === 3, '修改恢复后检查成功')
    assert(summaries()[2].text.includes('0 项待处理'))
    await js(() => window.api.toolwindowClose('build'))
    win.focus()
    await js(() => document.querySelector('button[title="通知"]')?.click())
    await until(() => js(() => [...document.querySelectorAll('button')].some(el => el.textContent === '清空')), '通知面板')
    assert(await js(() => {
      const history = [...document.querySelectorAll('button')].find(el => el.textContent === '清空')?.parentElement.parentElement
      return history?.textContent.includes('设计检查：0 项错误') && history.textContent.includes('硬件回归：测试失败')
    }), '结果确实保存在铃铛历史，不依赖临时 toast')
    await pause(100)
    fs.writeFileSync(join(artifacts, 'build-and-notifications.png'), (await win.webContents.capturePage()).toPNG())
    await js(() => {
      const history = [...document.querySelectorAll('button')].find(el => el.textContent === '清空')?.parentElement.parentElement
      const action = [...(history?.querySelectorAll('button') ?? [])].find(el => el.textContent === '查看构建输出')
      if (!action) throw new Error('通知缺少构建跳转')
      action.click()
    })
    await until(() => js(() => [...document.querySelectorAll('.selectable')].some(el => el.textContent.includes('设计检查：17 元件'))), '通知跳转后构建页')
    fs.writeFileSync(join(artifacts, 'build-batches.json'), JSON.stringify(batches, null, 2))
    console.log('HARDWARE_OUTPUT_PASS 首次收敛、构建日志、独立窗口广播、通知与失败恢复；截图：', artifacts)
    app.exit(0)
  })().catch(error => { console.error('HARDWARE_OUTPUT_FAIL', error); fs.writeFileSync(join(artifacts, 'failed-batches.json'), JSON.stringify(batches, null, 2)); app.exit(1) })
}
