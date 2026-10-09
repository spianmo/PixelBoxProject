#!/usr/bin/env node
// 执行 App 的真实推送处理函数，验证设备选择和底部日志页状态。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['handlePush', 'handlePushToDevice'])
const functions = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
    functions.push(node.getText(file))
  }
  ts.forEachChild(node, visit)
}
visit(file)
assert.equal(functions.length, names.size, '必须找到 App 的两个推送处理函数')
const code = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function harness(selectedKey, push) {
  const device = { name: 'PixelBox', ip: '192.168.1.42', host: 'pixelbox.local', port: 8765 }
  const state = { selectedKey, devices: selectedKey.startsWith('sim:') ? [] : [device] }
  const tabs = []
  const toasts = []
  const pushed = []
  const calls = []
  const sandbox = {
    busy: null,
    workspaceRootRef: { current: '/app' },
    editorRef: { current: { saveAll: async () => undefined } },
    shellDeviceStore: {
      get: () => state,
      set: patch => { Object.assign(state, patch); calls.push({ selectedKey: state.selectedKey }) }
    },
    isSimDeviceKey: key => key.startsWith('sim:'),
    deviceKey: dev => `${dev.ip}:${dev.port}`,
    refreshDevices: async () => { state.devices = [device] },
    openBottomTab: tab => tabs.push(tab),
    setBusy: () => undefined,
    setPushPercent: () => undefined,
    showToast: (message, level) => toasts.push({ message, level }),
    t: key => key,
    window: { api: { devdPush: async options => {
      pushed.push(options)
      calls.push({ pushedTo: options.host, selectedKey: state.selectedKey })
      await push()
    } } }
  }
  runInNewContext(`${code}\nthis.actions = { handlePush, handlePushToDevice }`, sandbox)
  return { device, state, tabs, toasts, pushed, calls, ...sandbox.actions }
}

{
  const ui = harness('sim:default', async () => undefined)
  await ui.handlePushToDevice()
  assert.equal(ui.state.selectedKey, '192.168.1.42:8765')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.pushed)), [
    { root: '/app', host: ui.device.ip, port: ui.device.port }
  ])
  assert.deepEqual(ui.calls, [
    { selectedKey: '192.168.1.42:8765' },
    { pushedTo: ui.device.ip, selectedKey: '192.168.1.42:8765' }
  ])
  assert.deepEqual(ui.tabs, ['build', 'logs'])
  assert.deepEqual(ui.toasts, [{ message: 'push.done', level: 'success' }])
}

{
  const ui = harness('192.168.1.42:8765', async () => { throw new Error('push failed') })
  await ui.handlePush()
  assert.deepEqual(ui.tabs, ['build'])
  assert.equal(ui.toasts[0].level, 'error')
}

console.log('[OK] 真机推送成功切到应用日志，失败保留构建输出；自动发现目标与日志设备选择一致')
