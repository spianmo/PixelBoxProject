#!/usr/bin/env node
/** 生产主进程双后端测试：假工具链真实子进程验证 IPC、模板独立性与取消，不需要硬件或 ESP-IDF。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'

const simRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('ESP-IDF / NuttX 项目、设置、IPC 与任务生命周期', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pixelbox-firmware-backends-'))
  const originalEnv = { IDF_PATH: process.env.IDF_PATH, NUTTX_PATH: process.env.NUTTX_PATH, SHELL: process.env.SHELL }
  let api
  try {
    const resources = join(temp, 'resources')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    const templateRoot = join(resources, 'firmware-templates')
    const template = join(templateRoot, 'firmware-nuttx')
    const files = {
      'firmware-nuttx/src/main.c': 'int pixelbox_main(void) { return 0; }\n',
      'firmware-nuttx/README.md': '# Apache NuttX\n',
      'firmware-nuttx/vendor/quickjs-dtoa/dtoa.c': '/* QuickJS-ng dtoa fixture */\n',
      'firmware-nuttx/vendor/quickjs-dtoa/dtoa.h': '/* QuickJS-ng dtoa header fixture */\n',
      'firmware-nuttx/vendor/quickjs-dtoa/LICENSE': 'MIT fixture\n',
      'firmware-nuttx/vendor/quickjs-dtoa/README.md': '# dtoa fixture\n',
      'firmware-nuttx/build/stale.bin': '不应复制的旧产物',
      'firmware-nuttx/build-host/old': '不应复制的主机构建缓存',
      'firmware-nuttx/.cache/old': '不应复制的缓存',
      'firmware-nuttx/.nuttx-build.lock': '不应复制的构建锁',
      'firmware-nuttx/.git/config': '不应复制的版本库元数据',
      'firmware/components/jsvm/quickjs-ng/quickjs.c': '/* vendored QuickJS fixture */\n',
      'firmware/components/jsvm/quickjs-ng/quickjs.h': '/* vendored header */\n',
      'firmware/components/jsvm/quickjs-ng/LICENSE': 'MIT fixture\n',
      'firmware/components/jsvm/quickjs-ng/.git/config': '不应复制的 submodule 元数据',
      'firmware/components/jsvm/src/prelude_core.js': 'globalThis.px = {};\n',
      'firmware/components/appmgr/src/settings_app.js': '// 原设置页\r\nglobalThis.settings = true;\r\n',
      'firmware/components/appmgr/src/default_app.js': '// 原欢迎页\nglobalThis.welcome = true;\n',
      'firmware/components/hal_display/fonts/pixel8.pxf': 'font8-fixture',
      'firmware/components/hal_display/fonts/pixel12.pxf': 'font12-fixture',
      'firmware/components/hal_display/fonts/pixel16.pxf': 'font16-fixture',
      'firmware/components/hal_display/src/pxfont.c': '/* pxfont fixture */\n',
      'firmware/components/hal_display/include/hal_display/pxfont.h': '/* pxfont header fixture */\n',
      'LICENSE': 'MIT fixture\n',
      'simulator/src/renderer/src/device-sim/sandbox/fonts/OFL.txt': 'OFL fixture\n',
      'tools/fontgen/README.md': '# Font sources fixture\n'
    }
    for (const name of ['pngle.c', 'pngle.h', 'miniz.c', 'miniz.h', 'gifdec.c', 'gifdec.h', 'README.md']) {
      files[`firmware/components/hal_display/vendor/${name}`] = `/* ${name} fixture */\n`
    }
    for (const name of ['tjpgd.c', 'tjpgd.h']) {
      files[`firmware/managed_components/espressif__esp_jpeg/tjpgd/${name}`] = `/* ${name} fixture */\n`
    }
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(templateRoot, name)), { recursive: true })
      await writeFile(join(templateRoot, name), content)
    }
    // 假 runner 通过真实 Python 进程返回不同退出状态，验证的仍是生产 spawn/事件代码。
    await mkdir(join(template, 'scripts'), { recursive: true })
    await writeFile(join(template, 'scripts', 'nuttx.py'), `import json, pathlib, sys, time, shutil
root = pathlib.Path.cwd()
args = sys.argv[1:]
(root / 'argv.json').write_text(json.dumps(args))
print('NuttX runner started', flush=True)
mode = (root / 'task-mode').read_text() if (root / 'task-mode').exists() else ''
if mode == 'fail':
    print('错误: configured failure', flush=True)
    sys.exit(7)
if mode == 'wait':
    time.sleep(60)
kind = args[0]
target = args[args.index('--target') + 1]
dest = root / 'build' / target
if mode == 'missing':
    shutil.rmtree(dest, ignore_errors=True)
    sys.exit(0)
if kind == 'clean':
    shutil.rmtree(dest, ignore_errors=True)
else:
    dest.mkdir(parents=True, exist_ok=True)
    (dest / 'nuttx.bin').write_bytes(b'' if mode == 'empty' else b'NUTTX-IMAGE')
    if kind == 'merge':
        (root / 'dist').mkdir(exist_ok=True)
        (root / 'dist' / (target + '-nuttx.bin')).write_bytes(b'NUTTX-IMAGE')
`)
    const handlers = new Map()
    const events = []
    const waiters = []
    globalThis.__firmwareElectronStub = {
      app: { isPackaged: true, getAppPath: () => '/no-source-repository', getPath: () => join(temp, 'userdata') },
      dialog: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send(channel, payload) {
        events.push({ channel, payload })
        if (channel === 'toolchain:done') waiters.shift()?.(payload)
      } } }] }
    }
    const bundle = join(temp, 'production.mjs')
    await build({
      stdin: { contents: `export * from './src/main/projectScaffold'; export * from './src/main/toolchain'; export * from './src/main/settings'; export * from './src/main/clangd';`, resolveDir: simRoot },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'test-host', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'host' }))
        builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: 'export const { app, dialog, ipcMain, BrowserWindow } = globalThis.__firmwareElectronStub;' }))
        builder.onResolve({ filter: /^\.\/workspace$/ }, () => ({ path: 'workspace', namespace: 'workspace' }))
        builder.onLoad({ filter: /.*/, namespace: 'workspace' }, () => ({ contents: 'export function emitFsEventIfWatched() {} export function getWatchedRoot() { return null }' }))
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }))
        builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }))
      } }]
    })
    api = await import(pathToFileURL(bundle).href)
    api.registerToolchainIpc()
    const invoke = (channel, ...args) => handlers.get(channel)(null, ...args)
    const completed = () => new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 toolchain:done 超过 10 秒')), 10000)
      waiters.push((value) => { clearTimeout(timer); resolveDone(value) })
    })
    async function task(options) {
      const done = completed()
      await invoke('toolchain:start', options)
      return done
    }

    const location = join(temp, 'projects')
    const idf = await api.createProject({ kind: 'firmware', name: 'legacy', location })
    assert.equal((await api.readProjectInfo(idf.root)).firmwareBackend, 'esp-idf')
    const legacyManifest = JSON.parse(await readFile(join(idf.root, 'pixelbox.json'), 'utf8'))
    delete legacyManifest.firmwareBackend
    await writeFile(join(idf.root, 'pixelbox.json'), JSON.stringify(legacyManifest))
    assert.equal((await api.readProjectInfo(idf.root)).firmwareBackend, 'esp-idf', '旧清单缺省 ESP-IDF')

    const nuttx = await api.createProject({ kind: 'firmware', name: 'nuttx-local', location, firmwareBackend: 'nuttx' })
    assert.equal(nuttx.entryFile, join(nuttx.root, 'src', 'main.c'))
    assert.equal((await api.readProjectInfo(nuttx.root)).firmwareBackend, 'nuttx')
    assert.equal((await api.readProjectInfo(nuttx.root)).manifest.nuttxProfile, 'esp32s3-multinet7')
    assert.equal((await api.readProjectInfo(nuttx.root)).manifest.nuttxBoard, 'esp32s3-devkit:nsh')
    assert(existsSync(join(nuttx.root, 'quickjs-ng', 'quickjs.c')))
    assert(existsSync(join(nuttx.root, 'quickjs-ng', 'LICENSE')))
    assert(existsSync(join(nuttx.root, 'vendor', 'quickjs-dtoa', 'dtoa.c')))
    assert(existsSync(join(nuttx.root, 'vendor', 'quickjs-dtoa', 'dtoa.h')))
    assert(existsSync(join(nuttx.root, 'vendor', 'quickjs-dtoa', 'LICENSE')))
    assert.equal(await readFile(join(nuttx.root, 'shared', 'prelude_core.js'), 'utf8'), 'globalThis.px = {};\n')
    for (const filename of ['settings_app.js', 'default_app.js']) {
      const original = join(templateRoot, 'firmware', 'components', 'appmgr', 'src', filename)
      assert.deepEqual(await readFile(join(nuttx.root, 'shared', filename)), await readFile(original))
    }
    const builtinPath = join(templateRoot, 'firmware', 'components', 'appmgr', 'src', 'settings_app.js')
    await rm(builtinPath)
    await assert.rejects(api.createProject({ kind: 'firmware', name: 'missing-builtin', location, firmwareBackend: 'nuttx' }), /firmwareTemplateMissing/)
    assert(!existsSync(join(location, 'missing-builtin', 'src')), '缺失内置JS时不能留下半份工程')
    await writeFile(builtinPath, files['firmware/components/appmgr/src/settings_app.js'])
    assert(!existsSync(join(nuttx.root, 'CMakeLists.txt')))
    assert(!existsSync(join(nuttx.root, 'build')))
    assert(!existsSync(join(nuttx.root, 'build-host')))
    assert(!existsSync(join(nuttx.root, '.cache')))
    assert(!existsSync(join(nuttx.root, '.nuttx-build.lock')))
    assert(!existsSync(join(nuttx.root, '.git')))
    assert(!existsSync(join(nuttx.root, 'quickjs-ng', '.git')))
    assert(!/quickjs|shared/.test(await readFile(join(nuttx.root, '.gitignore'), 'utf8')), '独立工程提交共享源码')
    await assert.rejects(api.createProject({ kind: 'firmware', name: 'bad', location, firmwareBackend: 'nuttx', chip: 'esp32c6' }), /unsupportedBackendTarget/)
    await assert.rejects(api.createProject({ kind: 'firmware', name: 'bad', location, firmwareBackend: 'other' }), /firmwareBackendInvalid/)
    assert(!existsSync(join(location, 'bad')))

    const source = join(temp, 'nuttx-source')
    await mkdir(join(source, 'tools'), { recursive: true })
    await mkdir(join(source, 'boards'), { recursive: true })
    await writeFile(join(source, 'Makefile'), '# NuttX fixture\n')
    await writeFile(join(source, 'tools', 'configure.sh'), '#!/bin/sh\n')
    await writeFile(join(source, '.version'), 'CONFIG_VERSION_STRING="12.9.0"\n')
    process.env.IDF_PATH = join(temp, 'missing-idf')
    process.env.NUTTX_PATH = source
    await api.setSettings({ 'toolchain.nuttxPathOverride': source })
    assert.equal((await api.getSettings()).toolchain.nuttxPathOverride, source)
    const detected = await invoke('toolchain:detect', undefined, undefined, nuttx.root)
    assert.equal(detected.backend, 'nuttx')
    assert.equal(detected.ok, true, 'NuttX 检测不依赖 ESP-IDF')
    assert.equal(detected.idfPath, '')
    assert.equal(detected.version, '12.9.0')
    assert.equal((await invoke('toolchain:detect', join(temp, 'typo-path'), 'nuttx', nuttx.root)).error, 'nuttxNotFound', '显式错误路径不回退 NUTTX_PATH')
    assert.equal((await invoke('toolchain:detect', undefined, 'esp-idf', nuttx.root)).error, 'backendMismatch')
    await assert.rejects(invoke('toolchain:start', { kind: 'build', target: 'esp32s3', cwd: nuttx.root, firmwareBackend: 'esp-idf' }), /backendMismatch/)
    await assert.rejects(invoke('toolchain:start', { kind: 'build', target: 'esp32p4', cwd: nuttx.root }), /unsupportedBackendTarget/)
    await assert.rejects(invoke('toolchain:start', { kind: 'flash', target: 'esp32s3', cwd: nuttx.root, port: '/tmp/evil;echo' }), /badPort/)

    const opts = { target: 'esp32s3', cwd: nuttx.root }
    const built = await task({ ...opts, kind: 'build' })
    assert.equal(built.success, true)
    assert.equal(built.firmwareBackend, 'nuttx')
    assert.deepEqual(built.artifacts.map((item) => item.path), [join(nuttx.root, 'build', 'esp32s3-multinet7', 'nuttx.bin')])
    assert.deepEqual(JSON.parse(await readFile(join(nuttx.root, 'argv.json'), 'utf8')), ['build', '--nuttx-path', source, '--target', 'esp32s3-multinet7'])
    const packed = await task({ ...opts, kind: 'merge' })
    assert.equal(packed.success, true)
    // NuttX 的 runner 目标是 manifest.nuttxProfile，产物名必须跟 profile 隔离，
    // 否则 MultiNet7 与普通 ESP32-S3 构建会互相覆盖 dist 镜像。
    assert(packed.artifacts.some((item) => item.path.endsWith('/dist/esp32s3-multinet7-nuttx.bin') && item.sizeBytes > 0))
    assert.equal((await task({ ...opts, kind: 'flash', port: '/dev/ttyUSB0', baud: 115200 })).success, true)
    assert.deepEqual(JSON.parse(await readFile(join(nuttx.root, 'argv.json'), 'utf8')).slice(-4), ['--port', '/dev/ttyUSB0', '--baud', '115200'])
    assert.equal((await task({ ...opts, kind: 'flash', port: '/dev/ttyUSB0', formatStorage: true })).success, true)
    assert.equal(JSON.parse(await readFile(join(nuttx.root, 'argv.json'), 'utf8')).at(-1), '--format-storage')
    assert.equal((await task({ ...opts, kind: 'flash', port: '/dev/ttyUSB0', formatStorage: false })).success, true)
    assert(!JSON.parse(await readFile(join(nuttx.root, 'argv.json'), 'utf8')).includes('--format-storage'))
    for (const kind of ['build', 'merge', 'clean']) {
      await assert.rejects(invoke('toolchain:start', { ...opts, kind, formatStorage: true }), /badFormatStorage/)
    }
    for (const formatStorage of ['true', 1, null]) {
      await assert.rejects(invoke('toolchain:start', { ...opts, kind: 'flash', port: '/dev/ttyUSB0', formatStorage }), /badFormatStorage/)
    }
    await assert.rejects(invoke('toolchain:start', { kind: 'flash', target: 'esp32s3', cwd: idf.root, port: '/dev/ttyUSB0', formatStorage: true }), /badFormatStorage/)

    await writeFile(join(nuttx.root, 'task-mode'), 'fail')
    const failed = await task({ ...opts, kind: 'build' })
    assert.equal(failed.success, false)
    assert.equal(failed.exitCode, 7)
    assert.deepEqual(failed.artifacts, [])
    assert(events.some((event) => event.channel === 'toolchain:log' && event.payload.some((line) => line.level === 'error' && line.text.includes('configured failure'))))

    for (const mode of ['missing', 'empty']) {
      await writeFile(join(nuttx.root, 'task-mode'), mode)
      const invalidArtifact = await task({ ...opts, kind: 'build' })
      assert.equal(invalidArtifact.success, false, `${mode} 产物不能汇报成功`)
      assert.equal(invalidArtifact.exitCode, 0)
      assert.match(invalidArtifact.message, /产物缺失或为空/)
    }

    await writeFile(join(nuttx.root, 'task-mode'), 'wait')
    const cancelledDone = completed()
    const firstStart = invoke('toolchain:start', { ...opts, kind: 'build' })
    await assert.rejects(invoke('toolchain:start', { ...opts, kind: 'build' }), /busy/, '识别清单期间也拒绝并发任务')
    await firstStart
    assert.equal((await invoke('toolchain:status')).firmwareBackend, 'nuttx')
    await assert.rejects(invoke('toolchain:start', { ...opts, kind: 'build' }), /busy/)
    await invoke('toolchain:cancel')
    const cancelled = await cancelledDone
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.success, false)
    assert.equal((await invoke('toolchain:status')).running, null)
    await writeFile(join(nuttx.root, 'task-mode'), '')
    await api.setSettings({ 'toolchain.nuttxPathOverride': join(temp, 'removed-sdk') })
    assert.equal((await task({ ...opts, kind: 'clean' })).success, true)
    assert(!existsSync(join(nuttx.root, 'build', 'esp32s3-multinet7')))

    assert.equal(await api.resolveCompileCommandsDir(nuttx.root), null)
    await mkdir(join(nuttx.root, 'build', 'esp32s3-multinet7'), { recursive: true })
    await writeFile(join(nuttx.root, 'build', 'esp32s3-multinet7', 'compile_commands.json'), '[]')
    assert.deepEqual(await api.resolveCompileCommandsDir(nuttx.root), { path: join(nuttx.root, 'build', 'esp32s3-multinet7'), backend: 'nuttx' })

    // ESP-IDF 回归使用假 export.sh 与真实可执行脚本，确保仍保留原命令与目录约定。
    const fakeIdf = join(temp, 'fake-idf')
    await mkdir(join(fakeIdf, 'bin'), { recursive: true })
    await writeFile(join(fakeIdf, 'export.sh'), `export PATH='${join(fakeIdf, 'bin')}':"$PATH"\n`)
    const fakeIdfPy = join(fakeIdf, 'bin', 'idf.py')
    await writeFile(fakeIdfPy, `#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path.cwd()
(root / 'idf-argv.json').write_text(json.dumps(args))
out = root / args[args.index('-B') + 1]
out.mkdir(parents=True, exist_ok=True)
(out / 'project_description.json').write_text(json.dumps({'target': 'esp32s3', 'app_bin': 'pixelbox.bin'}))
(out / 'pixelbox.bin').write_bytes(b'IDF-IMAGE')
if 'merge-bin' in args:
    pathlib.Path(args[args.index('-o') + 1]).write_bytes(b'IDF-MERGED')
print('ESP-IDF fixture complete')
`)
    await chmod(fakeIdfPy, 0o755)
    process.env.SHELL = '/bin/bash'
    await api.setSettings({ 'toolchain.idfPathOverride': fakeIdf })
    assert.equal((await invoke('toolchain:detect', undefined, undefined, idf.root)).backend, 'esp-idf')
    const legacy = await task({ kind: 'merge', target: 'esp32s3', cwd: idf.root })
    assert.equal(legacy.success, true)
    assert.equal(legacy.firmwareBackend, 'esp-idf')
    assert(legacy.artifacts.some((item) => item.path.endsWith('/esp32s3-merged.bin')))
    const idfArgs = JSON.parse(await readFile(join(idf.root, 'idf-argv.json'), 'utf8'))
    assert.deepEqual(idfArgs.slice(0, 4), ['-B', 'build', '-D', 'IDF_TARGET=esp32s3'])
    assert(idfArgs.includes('merge-bin'))

    // 用真实仓库模板再生成一次，并明确禁用仓库回退，验证 vendored 依赖可独立准备。
    globalThis.__firmwareElectronStub.app.isPackaged = false
    globalThis.__firmwareElectronStub.app.getAppPath = () => simRoot
    const standalone = await api.createProject({ kind: 'firmware', name: 'standalone', location, firmwareBackend: 'nuttx' })
    assert(existsSync(join(standalone.root, 'src', 'runtime.c')))
    assert(existsSync(join(standalone.root, 'scripts', 'cc_capture.py')))
    assert(existsSync(join(standalone.root, 'vendor', 'quickjs-dtoa', 'dtoa.c')))
    assert(existsSync(join(standalone.root, 'vendor', 'quickjs-dtoa', 'dtoa.h')))
    assert(existsSync(join(standalone.root, 'vendor', 'quickjs-dtoa', 'LICENSE')))
    execFileSync('python3', ['tools/prepare.py', '--repo-root', join(temp, 'no-monorepo')], {
      cwd: standalone.root, encoding: 'utf8', timeout: 30000
    })
    assert(existsSync(join(standalone.root, 'generated', 'quickjs-ng', 'quickjs.c')))
    assert(existsSync(join(standalone.root, 'generated', 'prelude_core.h')))
    assert(existsSync(join(standalone.root, 'generated', 'prelude_nuttx.h')))
    assert(existsSync(join(standalone.root, 'generated', 'builtin_apps_data.h')))
    assert(existsSync(join(standalone.root, 'generated', 'pixelbox_fonts.h')))
    for (const name of ['pngle.c', 'gifdec.c', 'tjpgd.c', 'tjpgdcnf.h']) {
      assert(existsSync(join(standalone.root, 'generated', 'images', name)))
    }
    for (const name of ['pixel8', 'pixel12', 'pixel16']) {
      assert.deepEqual(await readFile(join(standalone.root, 'shared', 'hal_display', 'fonts', `${name}.pxf`)),
        await readFile(join(simRoot, '..', 'firmware', 'components', 'hal_display', 'fonts', `${name}.pxf`)))
    }
    for (const name of ['pixelbox-pxfont-LICENSE', 'fusion-pixel-OFL.txt', 'FONT-SOURCES.md']) {
      assert(existsSync(join(standalone.root, 'generated', 'licenses', name)))
    }
    for (const filename of ['settings_app.js', 'default_app.js']) {
      assert.deepEqual(await readFile(join(standalone.root, 'shared', filename)),
        await readFile(join(simRoot, '..', 'firmware', 'components', 'appmgr', 'src', filename)))
    }
    console.log('通过：打包模板与真实模板独立生成/prepare、旧清单、设置持久化、后端校验、检测、构建/导出/烧录参数、失败透传、取消、clangd 路径与 ESP-IDF 回归。')
  } finally {
    api?.disposeToolchain()
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(temp, { recursive: true, force: true })
  }
})
