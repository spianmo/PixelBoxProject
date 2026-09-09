#!/usr/bin/env node
// 运行真实构建和devd:push入口，验证预览图不进包；本地WebSocket代替物理设备。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { once } from 'node:events'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const handlers = new Map()
const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [] } }
async function loadModule(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: name => name === 'electron' ? electron : require(name),
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval
  })
  return module.exports
}
const devd = await loadModule(join(root, 'src/main/devd.ts'))
const sdk = await loadModule(join(root, '../sdk/src/build.ts'))
devd.registerDevdIpc()
const temporary = await mkdtemp(join(tmpdir(), 'pixelbox-push-check-'))
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(server, 'listening')
let received, committed
server.on('connection', socket => socket.on('message', raw => {
  const { id, method, params } = JSON.parse(String(raw))
  let result = {}
  if (method === 'app.push_begin') {
    received = new Map(params.files.map(file => [file.path, { ...file, bytes: Buffer.alloc(file.size), written: 0 }]))
    committed = false
    result = { session: 'local-test' }
  } else if (method === 'app.push_chunk') {
    const file = received.get(params.path), chunk = Buffer.from(params.dataB64, 'base64')
    assert.equal(params.offset, file.written)
    chunk.copy(file.bytes, params.offset)
    file.written += chunk.length
    result = { received: chunk.length }
  } else if (method === 'app.push_end') {
    for (const file of received.values()) {
      assert.equal(file.written, file.size)
      assert.equal(createHash('sha256').update(file.bytes).digest('hex'), file.sha256)
    }
    committed = true
    result = { ok: true }
  }
  socket.send(JSON.stringify({ id, result }))
}))
try {
  for (const withAssets of [false, true]) {
    const project = join(temporary, withAssets ? 'assets' : 'plain')
    const entry = withAssets ? 'code/app.js' : 'main.js'
    const manifest = { id: 'test.push', name: 'Push test', version: '1.0.0', entry, assets: withAssets ? ['assets/**'] : [] }
    await mkdir(join(project, 'src'), { recursive: true })
    await mkdir(join(project, 'dist/screenshots'), { recursive: true })
    await writeFile(join(project, 'pixelbox.json'), JSON.stringify(manifest))
    await writeFile(join(project, 'src/main.ts'), 'export const answer: number = 42;')
    await writeFile(join(project, 'dist/pixelbox.json'), JSON.stringify(manifest))
    for (let i = 0; i < 151; i++) await writeFile(join(project, `dist/screenshots/${i}.png`), Buffer.alloc(1024))
    const expectedPaths = [entry]
    if (withAssets) {
      await mkdir(join(project, 'assets/nested'), { recursive: true })
      await writeFile(join(project, 'assets/nested/icon.png'), Buffer.alloc(60000, 127))
      await writeFile(join(project, 'assets/empty.txt'), '')
      await writeFile(join(project, 'assets/.gitkeep'), '')
      await writeFile(join(project, 'assets/.DS_Store'), 'not-an-asset')
      expectedPaths.push('assets/nested/icon.png', 'assets/empty.txt')
    }
    await handlers.get('devd:push')(null, { root: project, host: '127.0.0.1', port: server.address().port })
    assert.ok(committed, '真实推送流程必须完成文件校验和提交')
    assert.deepEqual([...received.keys()].sort(), expectedPaths.sort(), '推送仅含入口和assets，151张预览图与清单不进包')
    assert.equal((await readFile(join(project, 'dist/screenshots/0.png'))).length, 1024, '筛选推送文件不会删除本地预览')

    // SDK --no-build 路径会扫描现有dist；collectPushFiles同样必须过滤发布目录中的杂项。
    const paths = [...expectedPaths, 'screenshots/0.png', 'pixelbox.json']
    const files = paths.map(relPath => ({ relPath, absPath: join(project, 'dist', relPath), size: 0 }))
    const packed = sdk.collectPushFiles({ projectDir: project, distDir: join(project, 'dist'), manifest, files })
    assert.deepEqual(Array.from(packed, file => file.path).sort(), expectedPaths.sort())
    console.log(`[OK] ${entry}: ${expectedPaths.length}个运行文件，预览图未上传，分块内容及SHA-256一致`)
  }
} finally {
  for (const socket of server.clients) socket.terminate()
  await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
