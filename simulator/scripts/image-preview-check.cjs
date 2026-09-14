#!/usr/bin/env node
/** 真实 Electron + 文件 IPC + DOM 回归;临时工作区/用户目录隔离,总超时 60 秒。前置:pnpm run build。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

if (!process.versions.electron) {
  const { buildSync } = require('esbuild')
  const moduleBox = { exports: {} }
  const utility = buildSync({ entryPoints: [join(__dirname, '../src/renderer/src/editor/imageFile.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' })
  require('node:vm').runInNewContext(utility.outputFiles[0].text, { module: moduleBox, exports: moduleBox.exports })
  const { isImageFile, imageMimeForPath } = moduleBox.exports
  for (const ext of ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']) {
    assert.equal(isImageFile(`C:\\图片目录\\预览.${ext.toUpperCase()}`), true)
    assert.ok(imageMimeForPath(`图片 # 预览.${ext}`).startsWith('image/'))
  }
  for (const path of ['/folder.png/README', 'preview.png.txt', 'file.constructor', 'file.__proto__', 'file.tiff', 'video.mp4', '']) {
    assert.equal(isImageFile(path), false, path)
  }
  console.log('PASS 图片格式分流单元检查(大小写/中文/Windows 路径/非图片)')
  const { spawn } = require('node:child_process')
  const artifacts = fs.mkdtempSync(join(tmpdir(), 'pixelbox-image-check-'))
  const { ELECTRON_RUN_AS_NODE, ELECTRON_RENDERER_URL, ...env } = process.env
  const child = spawn(join(__dirname, '../node_modules/.bin/electron'), [__filename, artifacts], {
    cwd: join(__dirname, '..'), env, stdio: 'inherit'
  })
  const timer = setTimeout(() => {
    console.error('IMAGE_PREVIEW_TIMEOUT (60s)')
    child.kill('SIGKILL')
  }, 60_000)
  child.on('error', (error) => { console.error(error); clearTimeout(timer); process.exitCode = 1 })
  child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
  const artifacts = process.argv[2]
  const root = join(artifacts, '图片 # 预览')
  fs.mkdirSync(root)
  const userData = join(artifacts, 'user-data')
  fs.mkdirSync(userData)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)

  // 记录实际 IPC 调用,确认图片从不进入 UTF-8 读取/写回;延迟文本读取覆盖切页竞态。
  const textReads = [], binaryReads = [], writes = []
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    if (channel === 'fs:read-file') {
      textReads.push(args[0])
      if (args[0].endsWith('/slow.txt')) await new Promise(resolve => setTimeout(resolve, 300))
    }
    if (channel === 'fs:read-file-binary') binaryReads.push(args[0])
    if (channel === 'fs:write-file') writes.push(args[0])
    return listener(event, ...args)
  })
  require('../out/main/index.js')

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(check, message) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (await check()) return
      await pause(35)
    }
    throw new Error(`等待失败: ${message}`)
  }

  void (async () => {
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length, '主窗口')
    const win = BrowserWindow.getAllWindows()[0]
    const js = (fn, arg) => win.webContents.executeJavaScript(`(${fn})(${JSON.stringify(arg) ?? ''})`)
    await until(() => js(() => !!document.querySelector('.monaco-editor')), '编辑器挂载')
    await js(() => {
      window.__imageCheck = { urls: new Set(), errors: [], cancellations: 0 }
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = blob => {
        const url = create(blob)
        if (blob.type.startsWith('image/')) window.__imageCheck.urls.add(url)
        return url
      }
      URL.revokeObjectURL = url => { window.__imageCheck.urls.delete(url); revoke(url) }
      window.addEventListener('error', e => window.__imageCheck.errors.push(e.error?.stack ?? e.message))
      window.addEventListener('unhandledrejection', e => {
        // Monaco 0.52 WordHighlighter 的 50ms Delayer 在切换模型时取消(其 trigger 未 catch)。
        // 只单独记录这个明确的取消信号;真实读取、解码和渲染异常仍令检查失败。
        if (e.reason?.name === 'Canceled' && e.reason?.message === 'Canceled') {
          window.__imageCheck.cancellations++
          return
        }
        window.__imageCheck.errors.push(e.reason?.stack ?? String(e.reason))
      })
    })

    const makePng = (width, height) => {
      const bitmap = Buffer.alloc(width * height * 4)
      for (let i = 0; i < bitmap.length; i += 4) {
        bitmap[i] = 190; bitmap[i + 1] = 110; bitmap[i + 2] = 55
        bitmap[i + 3] = Math.floor(i / 4 / width / 40) % 2 ? 130 : 255
      }
      return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
    }
    const png = makePng(1200, 800), icon = makePng(16, 16)
    fs.writeFileSync(join(root, 'preview.PNG'), png)
    fs.writeFileSync(join(root, 'photo.jpeg'), nativeImage.createFromBuffer(png).toJPEG(80))
    fs.writeFileSync(join(root, 'photo.jpg'), nativeImage.createFromBuffer(png).toJPEG(80))
    fs.writeFileSync(join(root, 'photo.jfif'), nativeImage.createFromBuffer(png).toJPEG(80))
    // 固定 16×16 样本由 ffmpeg testsrc 生成,运行回归无需安装编码器。
    fs.writeFileSync(join(root, 'sample.avif'), Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAGSAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EgAAAAAAATY29scm5jbHgAAgACAACAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAGabWRhdAoMIAAAAZ/5tfJAQ0AIMoEDEADAAIIGGCi66MQyniPM6xVhxfPykIArNwrx9/A2ZIqo2axbszkG0pSUmJkXfREiKGs9iL7mB6LNQltd6oxdcF0ZmEu8+2rHZBXkMPT+j//M3HMI4oxpPu4fmHhz7tQgzAFdCpLFGcUHJlOWsY/NvpNeKsbm6F/q4//6+Oas2EGW9PQ5T1LuM9FgFNypvXIpvyPtciXk9w+I2zj3Adnpqca5qBEfv4jWGr31fk5lBoF6Wzie8WP7JMUqn6sEg5wMe9jYy09Mg/pCaKUD82eovA6Zw8Vxp0LcWlqcc/6pxBkeI0ydCduW7UyoM64PEP5RuiMg4u3h0s+Pfl3U+4CDFRrnHSRRpWWHDuGsvqewHyY6c87YNI8ucrYIeLHipTO3ZY5AXtSbwy5owhMQaXn9StDU98PbALd32MOfzrwmBGoj/l9Oxv7uRD6M/LIVri5iRrVpzdCZBkARNwHCDt4Yz2NbyuxT27cl2xxQTIA1PQGUE748noqhCc3Mi0AvliqcwA==', 'base64'))
    fs.writeFileSync(join(root, 'animation.apng'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAQAAAAEAAAAAAAAAAAAAEAAgAAbVWenQAAAG9JREFUeJzt0ssJgDAQBNDpRDvRTrQT7UQ70U60k5H9JIEgBj14SljYTNi3pwB6qGWNWhYsWbeDDNCvdMYEcxBmbkB8SsB3PALf+QWEyTKI2ysoAAkjuOMgJqKR3IOrjC9ExxacwVPyRgw/gLe/9QLO1WCuKM9M7wAAABpmY1RMAAAAAQAAABAAAAADAAAAAAAAAAwAAQACAABkmesLAAAAO2ZkQVQAAAACeJy1y1ERABEAANFtQhOauCY0uWtCE9dkEcLM+9zFhj9dinA8OJhSJZjxQ49XknEHt4cFvVtHuWG28eoAAAAASUVORK5CYII=', 'base64'))
    fs.writeFileSync(join(root, 'animation.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    fs.writeFileSync(join(root, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><script>window.__svgExecuted=true</script><rect width="240" height="160" fill="#5093e8"/></svg>')
    const ico = Buffer.alloc(22)
    ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 16; ico[7] = 16
    ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(icon.length, 14); ico.writeUInt32LE(22, 18)
    fs.writeFileSync(join(root, 'icon.ico'), Buffer.concat([ico, icon]))
    const bmp = Buffer.alloc(58)
    bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp[56] = 255
    fs.writeFileSync(join(root, 'bitmap.bmp'), bmp)
    const webp = await js(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24
      canvas.getContext('2d').fillRect(0, 0, 32, 24)
      return canvas.toDataURL('image/webp').split(',')[1]
    })
    fs.writeFileSync(join(root, 'sample.webp'), Buffer.from(webp, 'base64'))
    fs.writeFileSync(join(root, 'broken.png'), 'invalid image')
    fs.writeFileSync(join(root, 'notes.txt'), '文本编辑保留\n')
    fs.writeFileSync(join(root, 'slow.txt'), '慢速读取\n')
    fs.writeFileSync(join(root, 'README.md'), '# Markdown 预览\n\n![图片](preview.PNG)\n')
    const enclosurePath = join(__dirname, '../../output/hardware/esp32s3-official-reference/enclosure-preview.png')
    if (fs.existsSync(enclosurePath)) fs.copyFileSync(enclosurePath, join(root, 'enclosure-preview.png'))
    win.webContents.send('smoke:session-prepare', { root, file: join(root, 'preview.PNG') })
    const waitImage = async (name, count = 1) => until(() => js(({ name, count }) => {
      const images = [...document.querySelectorAll('.image-preview img')]
      return images.length === count && images.every(img => img.alt === name && img.complete && img.naturalWidth > 0)
    }, { name, count }), `图片 ${name} × ${count}`)
    const treeOpen = async name => {
      await js(name => {
        const label = [...document.querySelectorAll('span.truncate')].find(el => el.textContent === name && el.parentElement.classList.contains('h-6'))
        if (!label) throw new Error(`文件树缺少 ${name}`)
        label.click()
      }, name)
    }
    const tabSelect = async name => js(path => {
      const tab = [...document.querySelectorAll('div.group[title]')].find(el => el.title === path)
      if (!tab) throw new Error(`页签缺少 ${path}`)
      tab.click()
    }, join(root, name))
    const button = async title => js(title => {
      const el = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === title || el.textContent === title)
      if (!el) throw new Error(`按钮缺少 ${title}`)
      el.click()
    }, title)
    await waitImage('preview.PNG')
    assert.equal(await js(() => document.body.innerText.includes('UTF-8')), false)
    assert.ok(await js(() => {
      const img = document.querySelector('.image-preview img'), box = document.querySelector('.image-preview-viewport')
      return img.width <= box.clientWidth && img.height <= box.clientHeight
    }), '大图适应窗口')
    await button('100%')
    await until(() => js(() => document.querySelector('.image-preview img')?.width === 1200), '原始尺寸')
    await button('放大')
    await until(() => js(() => document.querySelector('.image-preview img')?.width === 1500), '缩放')
    await button('适应窗口')
    const screenshot = await win.webContents.capturePage()
    fs.writeFileSync(join(artifacts, 'image-preview-dark.png'), screenshot.toPNG())
    console.log('PASS PNG 二进制读取、透明背景、适应窗口/原始尺寸/缩放')

    if (fs.existsSync(enclosurePath)) {
      await treeOpen('enclosure-preview.png'); await waitImage('enclosure-preview.png')
      fs.writeFileSync(join(artifacts, 'enclosure-preview-ide.png'), (await win.webContents.capturePage()).toPNG())
    }
    for (const name of ['photo.jpeg', 'photo.jpg', 'photo.jfif', 'animation.gif', 'animation.apng', 'vector.svg', 'sample.webp', 'sample.avif', 'bitmap.bmp', 'icon.ico']) {
      await treeOpen(name); await waitImage(name)
    }
    assert.equal(await js(() => !!window.__svgExecuted), false, 'SVG 图片不得执行脚本')
    await treeOpen('broken.png')
    await until(() => js(() => document.querySelector('.image-preview [role=alert]')?.textContent.includes('已损坏')), '损坏图片提示')
    fs.writeFileSync(join(root, 'broken.png'), icon)
    await waitImage('broken.png')
    console.log('PASS JPEG/JPG/JFIF/GIF/APNG/SVG/WebP/AVIF/BMP/ICO 与损坏文件修复后自动重载')

    await treeOpen('slow.txt'); await tabSelect('preview.PNG'); await waitImage('preview.PNG')
    await pause(350)
    assert.equal(await js(() => !!document.activeElement?.closest('.monaco-editor')), false, '晚到的文本读取不得抢回焦点')
    await treeOpen('notes.txt')
    await until(() => js(() => [...document.querySelectorAll('.monaco-editor')].some(el => el.offsetWidth && el.textContent.includes('文本编辑保留'))), '文本编辑器')
    win.webContents.insertText('新增文字')
    await until(() => js(() => !!document.querySelector('[title="未保存"]')), '文本编辑脏状态')
    await tabSelect('preview.PNG'); await waitImage('preview.PNG')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    assert.deepEqual(fs.readFileSync(join(root, 'preview.PNG')), png, '图片字节保持完整')
    console.log('PASS 文本/图片切换、慢读取竞态、文本编辑和图片保存隔离')

    await js(path => document.querySelector(`div.group[title="${CSS.escape(path)}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 90 })), join(root, 'preview.PNG'))
    await button('左右拆分'); await waitImage('preview.PNG', 2)
    fs.writeFileSync(join(root, 'preview.PNG'), makePng(320, 200))
    await until(() => js(() => [...document.querySelectorAll('.image-preview img')].length === 2 && [...document.querySelectorAll('.image-preview img')].every(img => img.naturalWidth === 320)), '双组文件变更刷新')
    assert.equal(await js(() => window.__imageCheck.urls.size), 2, '旧预览 Blob 全部释放')
    await until(() => js(root => window.api.sessionForRoot(root).then(session => session?.groups?.length === 2), root), '分屏会话保存')
    await js(() => window.api.settingsSetMany({ 'appearance.theme': 'light' }))
    await until(() => js(() => document.documentElement.dataset.theme === 'light'), '浅色主题')
    fs.writeFileSync(join(artifacts, 'image-preview-light-split.png'), (await win.webContents.capturePage()).toPNG())
    const errors = await js(() => window.__imageCheck.errors)
    assert.deepEqual(errors, [], `预览运行时异常: ${JSON.stringify(errors)}`)
    console.log('Monaco 词高亮取消次数:', await js(() => window.__imageCheck.cancellations))
    await new Promise(resolve => {
      win.webContents.once('did-finish-load', resolve)
      win.webContents.reload()
    })
    await waitImage('preview.PNG', 2)
    assert.ok(binaryReads.length >= 12)
    assert.deepEqual(textReads.filter(path => /\.(a?png|jpe?g|jfif|gif|svg|webp|avif|bmp|ico)$/i.test(path)), [], '会话恢复和所有图片入口均不读 UTF-8')
    assert.deepEqual(writes.filter(path => /\.(a?png|jpe?g|jfif|gif|svg|webp|avif|bmp|ico)$/i.test(path)), [], '图片无文本写回')
    await js(path => [...document.querySelectorAll('div.group[title]')].filter(el => el.title === path).at(-1).querySelector('button').click(), join(root, 'preview.PNG'))
    await until(() => js(() => document.querySelectorAll('.image-preview').length === 1), '关闭一组图片保留另一组')
    console.log('PASS 分屏、外部更新、Blob 回收、浅色主题、会话恢复和关闭页签')
    console.log('IMAGE_PREVIEW_PASS 截图/隔离工程:', artifacts)
    app.exit(0)
  })().catch(error => { console.error('IMAGE_PREVIEW_FAIL', error); app.exit(1) })
}
