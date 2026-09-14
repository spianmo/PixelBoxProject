#!/usr/bin/env node
/** 单元 + 真实 Electron/IPC/WebGL 回归;临时工程与用户目录隔离,60 秒上限。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')

async function prepare(root) {
  const THREE = require('three')
  const { STLExporter } = await import('three/addons/exporters/STLExporter.js')
  const { zipSync, strToU8 } = await import(join(dirname(require.resolve('three')), '../examples/jsm/libs/fflate.module.js'))
  const geometry = new THREE.BoxGeometry(2, 3, 4)
  const mesh = new THREE.Mesh(geometry)
  const exporter = new STLExporter()
  const stl = exporter.parse(mesh, { binary: true })
  fs.writeFileSync(join(root, 'box.STL'), Buffer.from(stl.buffer))
  fs.writeFileSync(join(root, 'ascii.stl'), exporter.parse(mesh))
  fs.writeFileSync(join(root, 'triangle.obj'), 'v 0 0 0\nv 2 0 0\nv 0 3 4\nf 1 2 3\n')
  fs.writeFileSync(join(root, 'material.obj'), 'mtllib surface.mtl\nv 0 0 0\nv 2 0 0\nv 0 3 4\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl surface\nf 1/1 2/2 3/3\n')
  fs.writeFileSync(join(root, 'surface.mtl'), 'newmtl surface\nKd 0.9 0.5 0.2\nmap_Kd tex%20%23.png\n')
  const plyHeader = 'element vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n'
  fs.writeFileSync(join(root, 'triangle.ply'), `ply\nformat ascii 1.0\n${plyHeader}0 0 0\n2 0 0\n0 3 4\n3 0 1 2\n`)
  const body = Buffer.alloc(49)
  ;[0, 0, 0, 2, 0, 0, 0, 3, 4].forEach((value, i) => body.writeFloatLE(value, i * 4))
  body[36] = 3; body.writeInt32LE(0, 37); body.writeInt32LE(1, 41); body.writeInt32LE(2, 45)
  fs.writeFileSync(join(root, 'binary.ply'), Buffer.concat([Buffer.from(`ply\nformat binary_little_endian 1.0\n${plyHeader}`), body]))
  fs.writeFileSync(join(root, 'cloud.ply'), 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n2 0 0\n0 3 4\n')
  fs.writeFileSync(join(root, 'invalid.ply'), `ply\nformat ascii 1.0\n${plyHeader}0 0 0\n2 0 0\n0 3 4\n3 0 1 9\n`)
  fs.writeFileSync(join(root, 'broken.stl'), 'solid empty\nendsolid empty\n')
  fs.writeFileSync(join(root, 'notes.txt'), '模型切换仍可编辑文本\n')
  fs.writeFileSync(join(root, 'slow.txt'), '读取延迟\n')
  const data = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 1].forEach((value, i) => data.writeFloatLE(value, i * 4))
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, 20, 30], scale: [2, 3, 4] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.3, 0.6, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }]
  }
  const json = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '))
  const header = Buffer.alloc(20), binaryHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + data.length, 8)
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  binaryHeader.writeUInt32LE(data.length); binaryHeader.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(join(root, 'triangle.glb'), Buffer.concat([header, json, binaryHeader, data]))
  document.buffers[0].uri = `data:application/octet-stream;base64,${data.toString('base64')}`
  fs.writeFileSync(join(root, 'embedded.gltf'), JSON.stringify(document))
  document.buffers[0].uri = 'data%20%23.bin'
  document.images = [{ uri: 'tex%20%23.png' }]
  document.textures = [{ source: 0 }]
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }
  fs.writeFileSync(join(root, 'external.gltf'), JSON.stringify(document))
  fs.writeFileSync(join(root, 'data #.bin'), data)
  document.buffers[0].uri = 'missing.bin'
  fs.writeFileSync(join(root, 'missing.gltf'), JSON.stringify(document))
  document.buffers[0].uri = 'https://example.invalid/model.bin'
  fs.writeFileSync(join(root, 'remote.gltf'), JSON.stringify(document))
  document.extensionsUsed = ['KHR_draco_mesh_compression']
  fs.writeFileSync(join(root, 'compressed.gltf'), JSON.stringify(document))
  fs.writeFileSync(join(root, 'print.3mf'), zipSync({
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8('<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="3" z="0"/><vertex x="0" y="0" z="4"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>')
  }))
  const actual = join(__dirname, '../../output/hardware/esp32s3-official-reference/export/print/base.stl')
  if (fs.existsSync(actual)) fs.copyFileSync(actual, join(root, 'enclosure.stl'))
  geometry.dispose(); mesh.material.dispose()
}

if (!process.versions.electron) {
  void (async () => {
    const artifacts = fs.mkdtempSync(join(tmpdir(), 'pixelbox-model-check-'))
    const root = join(artifacts, '模型 # 预览'); fs.mkdirSync(root)
    await prepare(root)
    const { buildSync } = require('esbuild'), Module = require('node:module')
    const compile = file => {
      const output = buildSync({ entryPoints: [join(__dirname, '../src/renderer/src/editor', file)], bundle: true, write: false, platform: 'node', format: 'cjs' })
      const compiled = new Module(file, module)
      compiled._compile(output.outputFiles[0].text, file)
      return compiled.exports
    }
    const { isModelFile, modelResourcePath } = compile('modelFile.ts')
    for (const ext of ['STL', 'OBJ', 'PLY', 'GLB', 'GLTF', '3MF']) assert.ok(isModelFile(`C:\\模型\\file.${ext}`))
    for (const file of ['model.stl.txt', '/dir.stl/README', 'foo.constructor', 'model.step']) assert.equal(isModelFile(file), false)
    assert.equal(modelResourcePath('/project/models/a.gltf', '../tex%20%23.png'), '/project/tex #.png')
    assert.equal(modelResourcePath('C:\\project\\a.obj', 'maps/tex.png'), 'C:\\project\\maps\\tex.png')
    for (const uri of ['https://host/a.bin', '//host/a.bin', 'file:///tmp/a.bin', '/etc/passwd']) assert.throws(() => modelResourcePath('/project/a.gltf', uri))
    global.window = { api: { readFileBinary: async file => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } } }
    const { loadModel } = compile('modelLoader.ts')
    for (const name of ['box.STL', 'ascii.stl', 'triangle.obj', 'triangle.ply', 'binary.ply', 'cloud.ply']) {
      const result = await loadModel(join(root, name), new AbortController().signal, () => {}).catch(error => { console.error('样本:', name); throw error })
      assert.deepEqual([...result.size], [2, 3, 4], name)
      assert.equal(result.triangles, name.includes('stl') || name.includes('STL') ? 12 : name === 'cloud.ply' ? 0 : 1, name)
      let disposed = 0
      result.object.traverse(node => node.geometry?.addEventListener('dispose', () => disposed++))
      result.dispose(); result.dispose()
      assert.equal(disposed, 1, '共享资源/重复 dispose 应只回收一次')
    }
    for (const name of ['broken.stl', 'invalid.ply', 'missing.gltf', 'remote.gltf', 'compressed.gltf']) {
      await assert.rejects(loadModel(join(root, name), new AbortController().signal, () => {}))
    }
    const controller = new AbortController(); controller.abort()
    await assert.rejects(loadModel(join(root, 'box.STL'), controller.signal, () => {}), { name: 'AbortError' })
    console.log('PASS 模型格式/路径、ASCII/二进制 STL/PLY、OBJ/点云、尺寸、错误与取消、资源回收单元检查')
    const { spawn } = require('node:child_process')
    const { ELECTRON_RUN_AS_NODE, ELECTRON_RENDERER_URL, ...env } = process.env
    const child = spawn(join(__dirname, '../node_modules/.bin/electron'), [__filename, artifacts], { cwd: join(__dirname, '..'), env, stdio: 'inherit' })
    const timer = setTimeout(() => { console.error('MODEL_PREVIEW_TIMEOUT (60s)'); child.kill('SIGKILL') }, 60_000)
    child.on('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1 })
    child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
  const artifacts = process.argv[2], root = join(artifacts, '模型 # 预览'), userData = join(artifacts, 'user-data')
  fs.mkdirSync(userData); app.setPath('userData', userData); app.setPath('sessionData', userData)
  const bitmap = Buffer.alloc(4 * 4 * 4, 255)
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 120; bitmap[i + 1] = 40 }
  fs.writeFileSync(join(root, 'tex #.png'), nativeImage.createFromBitmap(bitmap, { width: 4, height: 4 }).toPNG())
  const textReads = [], writes = [], binaryReads = []
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    if (channel === 'fs:read-file') {
      textReads.push(args[0])
      if (args[0].endsWith('/slow.txt')) await new Promise(resolve => setTimeout(resolve, 300))
    }
    if (channel === 'fs:write-file') writes.push(args[0])
    if (channel === 'fs:read-file-binary') binaryReads.push(args[0])
    return listener(event, ...args)
  })
  require('../out/main/index.js')
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(check, message) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await check()) return; await pause(50) }
    throw new Error(`等待失败: ${message}`)
  }
  void (async () => {
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length, '主窗口')
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2 && /GLTFLoader|ModelPreview|Refused to|Failed to (load|fetch)/i.test(message)) console.log('[model-renderer]', message)
    })
    const js = (fn, arg) => win.webContents.executeJavaScript(`(${fn})(${JSON.stringify(arg) ?? ''})`)
    await until(() => js(() => !!document.querySelector('.monaco-editor')), '编辑器')
    await js(() => {
      window.__modelCheck = { errors: [], urls: new Set(), gl: new Set(), lost: 0 }
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (...args) {
        const context = getContext.apply(this, args)
        if (context && String(args[0]).startsWith('webgl') && !window.__modelCheck.gl.has(context)) {
          window.__modelCheck.gl.add(context)
          this.addEventListener('webglcontextlost', () => window.__modelCheck.lost++)
        }
        return context
      }
      window.addEventListener('error', e => window.__modelCheck.errors.push(e.message))
      window.addEventListener('unhandledrejection', e => {
        if (e.reason?.name !== 'Canceled') window.__modelCheck.errors.push(String(e.reason))
      })
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = blob => { const url = create(blob); window.__modelCheck.urls.add(url); return url }
      URL.revokeObjectURL = url => { window.__modelCheck.urls.delete(url); revoke(url) }
    })
    const waitModel = (name, count = 1) => until(() => js(({ path, count }) => {
      const views = [...document.querySelectorAll('.model-preview')]
      const failed = views.find(v => v.dataset.path === path && v.dataset.status === 'error')
      if (failed) throw new Error(failed.textContent)
      return views.length === count && views.every(v => v.dataset.path === path && v.dataset.status === 'ready' && v.querySelector('canvas').width > 0)
    }, { path: join(root, name), count }), name)
    const treeOpen = name => js(name => {
      const el = [...document.querySelectorAll('span.truncate')].find(el => el.textContent === name && el.parentElement.classList.contains('h-6'))
      if (!el) throw new Error(`文件树缺少 ${name}`)
      el.click()
    }, name)
    const tab = name => js(path => [...document.querySelectorAll('div.group[title]')].find(el => el.title === path).click(), join(root, name))
    const button = title => js(title => {
      const b = [...document.querySelectorAll('button')].find(el => el.textContent === title || el.getAttribute('aria-label') === title)
      if (!b) throw new Error(`按钮缺少 ${title}`)
      b.click()
    }, title)
    const snapshot = async name => {
      const rect = await js(() => {
        const r = document.querySelector('.model-preview canvas').getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })
      const image = await win.webContents.capturePage(rect)
      const bitmap = image.toBitmap()
      let colored = 0
      for (let i = 0; i < bitmap.length; i += 4) if (Math.max(...bitmap.subarray(i, i + 3)) - Math.min(...bitmap.subarray(i, i + 3)) > 25) colored++
      assert.ok(colored > 100, 'WebGL 应实际绘出彩色模型,不能是空画布')
      if (name) fs.writeFileSync(join(artifacts, name), (await win.webContents.capturePage()).toPNG())
      return createHash('sha256').update(bitmap).digest('hex')
    }
    win.webContents.send('smoke:session-prepare', { root, file: join(root, 'box.STL') })
    await waitModel('box.STL')
    assert.ok(await js(() => document.querySelector('.model-preview').textContent.includes('12 三角面')))
    assert.ok(await js(() => document.querySelector('.model-preview').textContent.includes('2 × 3 × 4')))
    assert.equal(await js(() => document.body.innerText.includes('UTF-8')), false)
    const original = await snapshot('model-dark.png')
    const rect = await js(() => { const r = document.querySelector('.model-preview canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    const x = Math.round(rect.x + rect.width * .5), y = Math.round(rect.y + rect.height * .5)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x + 70, y: y + 25, button: 'left' })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + 70, y: y + 25, button: 'left', clickCount: 1 })
    await pause(100)
    assert.notEqual(await snapshot(), original, '鼠标旋转应改变真实渲染画面')
    const rotated = await snapshot()
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x + 30, y: y - 20, button: 'right' })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + 30, y: y - 20, button: 'right', clickCount: 1 })
    await pause(100)
    const panned = await snapshot()
    assert.notEqual(panned, rotated, '右键平移应改变真实渲染画面')
    await button('放大'); assert.notEqual(await snapshot(), panned, '缩放应改变画面')
    await button('复位视图')
    await button('线框'); assert.notEqual(await snapshot(), original, '线框应改变画面')
    await button('线框')
    console.log('PASS 二进制 STL 真实 WebGL、尺寸/面数、旋转/平移/缩放/复位/线框')
    for (const name of ['ascii.stl', 'triangle.obj', 'material.obj', 'triangle.ply', 'binary.ply', 'cloud.ply', 'triangle.glb', 'embedded.gltf', 'external.gltf', 'print.3mf']) {
      await treeOpen(name); await waitModel(name)
      assert.ok(await js(() => document.querySelector('.model-preview').textContent.includes('2 × 3 × 4')), name)
    }
    assert.ok(binaryReads.some(file => file.endsWith('data #.bin')))
    assert.ok(binaryReads.some(file => file.endsWith('tex #.png')))
    assert.ok(binaryReads.some(file => file.endsWith('surface.mtl')))
    console.log('PASS ASCII STL、OBJ/MTL/贴图、ASCII/二进制 PLY/点云、GLB/glTF/外部资源、3MF')
    for (const name of ['broken.stl', 'missing.gltf', 'remote.gltf', 'compressed.gltf']) {
      await treeOpen(name)
      await until(() => js(path => {
        const view = document.querySelector('.model-preview')
        return view?.dataset.path === path && !!view.querySelector('[role=alert]')
      }, join(root, name)), name)
    }
    await tab('missing.gltf')
    fs.copyFileSync(join(root, 'data #.bin'), join(root, 'missing.bin'))
    await waitModel('missing.gltf')
    await tab('broken.stl')
    fs.copyFileSync(join(root, 'box.STL'), join(root, 'broken.stl'))
    await waitModel('broken.stl')
    const beforeReload = binaryReads.filter(file => file === join(root, 'broken.stl')).length
    await button('重新加载模型')
    await until(() => binaryReads.filter(file => file === join(root, 'broken.stl')).length > beforeReload, '重试确实重新读取')
    await waitModel('broken.stl')
    await treeOpen('slow.txt'); await tab('box.STL'); await waitModel('box.STL'); await pause(350)
    assert.equal(await js(() => !!document.activeElement?.closest('.monaco-editor')), false)
    await treeOpen('notes.txt')
    await until(() => js(() => [...document.querySelectorAll('.monaco-editor')].some(el => el.offsetWidth && el.textContent.includes('模型切换'))), '文本正常编辑')
    await treeOpen('tex #.png')
    await until(() => js(() => document.querySelector('.image-preview img')?.naturalWidth === 4), '图片预览不回归')
    await tab('box.STL'); await waitModel('box.STL')
    if (fs.existsSync(join(root, 'enclosure.stl'))) {
      await treeOpen('enclosure.stl'); await waitModel('enclosure.stl'); await snapshot('enclosure-model-ide.png')
    }
    await tab('box.STL'); await waitModel('box.STL')
    await js(path => [...document.querySelectorAll('div.group[title]')].find(el => el.title === path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 90 })), join(root, 'box.STL'))
    await button('左右拆分'); await waitModel('box.STL', 2)
    const beforeRefresh = binaryReads.filter(file => file === join(root, 'box.STL')).length
    fs.copyFileSync(join(root, 'ascii.stl'), join(root, 'box.STL'))
    await until(() => binaryReads.filter(file => file === join(root, 'box.STL')).length >= beforeRefresh + 2, '双组刷新读取')
    await waitModel('box.STL', 2)
    await js(() => window.api.settingsSetMany({ 'appearance.theme': 'light' }))
    await until(() => js(() => document.documentElement.dataset.theme === 'light'), '浅色主题')
    await snapshot('model-light-split.png')
    assert.deepEqual(await js(() => window.__modelCheck.errors), [], '无未处理运行时异常')
    assert.equal(await js(() => window.__modelCheck.urls.size), 0, '离开材质/贴图页签后 Blob 应回收')
    await until(() => js(() => [...window.__modelCheck.gl].filter(gl => !gl.isContextLost()).length === 2), '仅保留两组模型的 WebGL 上下文')
    await pause(1200)
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
    await waitModel('box.STL', 2)
    const modelPattern = /\.(stl|obj|ply|glb|gltf|3mf)$/i
    assert.deepEqual(textReads.filter(file => modelPattern.test(file)), [], '模型不走 UTF-8 文本读取')
    assert.deepEqual(writes.filter(file => modelPattern.test(file)), [], '模型不能文本写回')
    await js(path => [...document.querySelectorAll('div.group[title]')].filter(el => el.title === path).at(-1).querySelector('button').click(), join(root, 'box.STL'))
    await waitModel('box.STL')
    console.log('PASS 错误/缺失资源恢复、刷新、文本/图片切换、实际外壳、分屏、浅色主题、会话恢复、关闭/资源回收')
    console.log('MODEL_PREVIEW_PASS 截图/隔离工程:', artifacts)
    app.exit(0)
  })().catch(error => { console.error('MODEL_PREVIEW_FAIL', error); app.exit(1) })
}
