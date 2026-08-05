/**
 * 应用构建服务(main 进程,内置 esbuild)
 * - build:一次性打包 src/main.ts → dist/main.js(ES2020 单文件)+ 拷贝 assets
 * - buildWatch:esbuild context 增量监听,每次重建向 renderer 推送 build:done
 * - 全部日志经 build:log 事件流到底部控制台「构建输出」页
 */
import { ipcMain, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import type { BuildLogLine, BuildResult, PixelboxManifest } from '../shared/ipc-types'

let watchCtx: esbuild.BuildContext | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function log(level: BuildLogLine['level'], text: string): void {
  broadcast('build:log', { level, text, ts: Date.now() } satisfies BuildLogLine)
}

/** 读取并校验 pixelbox.json */
async function readManifest(root: string): Promise<PixelboxManifest> {
  const p = join(root, 'pixelbox.json')
  if (!existsSync(p)) {
    throw new Error('未找到 pixelbox.json,请确认工作区是 PixelBox 应用项目')
  }
  const manifest = JSON.parse(await fsp.readFile(p, 'utf8')) as PixelboxManifest
  for (const key of ['id', 'name', 'version', 'entry'] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
      throw new Error(`pixelbox.json 缺少字段: ${key}`)
    }
  }
  return manifest
}

/** 定位源码入口:优先 src/main.ts,其次 src/main.js / src/index.ts */
function findEntry(root: string): string {
  for (const rel of ['src/main.ts', 'src/main.js', 'src/index.ts', 'src/index.js']) {
    const p = join(root, rel)
    if (existsSync(p)) return p
  }
  throw new Error('未找到入口文件(期望 src/main.ts)')
}

function esbuildOptions(root: string, manifest: PixelboxManifest): esbuild.BuildOptions {
  return {
    entryPoints: [findEntry(root)],
    outfile: join(root, 'dist', manifest.entry),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    absWorkingDir: root
  }
}

/** 拷贝 assets/ 到 dist/assets/(若存在) */
async function copyAssets(root: string): Promise<void> {
  const src = join(root, 'assets')
  if (existsSync(src)) {
    await fsp.cp(src, join(root, 'dist', 'assets'), { recursive: true })
    log('info', '已拷贝 assets/ → dist/assets/')
  }
}

function reportMessages(result: esbuild.BuildResult): string[] {
  const errors: string[] = []
  for (const w of result.warnings) {
    log('warn', `[warn] ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`)
  }
  for (const e of result.errors) {
    const msg = `${e.text}${e.location ? ` (${e.location.file}:${e.location.line}:${e.location.column})` : ''}`
    errors.push(msg)
    log('error', `[error] ${msg}`)
  }
  return errors
}

/** 执行一次完整构建 */
export async function buildWorkspace(root: string): Promise<BuildResult> {
  const started = Date.now()
  try {
    const absRoot = resolve(root)
    const manifest = await readManifest(absRoot)
    log('info', `开始构建 ${manifest.name}@${manifest.version} …`)
    const result = await esbuild.build(esbuildOptions(absRoot, manifest))
    const errors = reportMessages(result)
    if (errors.length > 0) {
      return { success: false, errors, durationMs: Date.now() - started }
    }
    await copyAssets(absRoot)
    const outDir = join(absRoot, 'dist')
    const code = await fsp.readFile(join(outDir, manifest.entry), 'utf8')
    const durationMs = Date.now() - started
    log('info', `构建完成,产物 dist/${manifest.entry}(${(code.length / 1024).toFixed(1)} KB,${durationMs} ms)`)
    return { success: true, code, manifest, outDir, errors: [], durationMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `构建失败: ${msg}`)
    return { success: false, errors: [msg], durationMs: Date.now() - started }
  }
}

export function registerBuilderIpc(): void {
  ipcMain.handle('build:run', async (_e, root: string): Promise<BuildResult> => {
    return buildWorkspace(root)
  })

  // watch 模式:文件变化自动重建,结果经 build:done 推给 renderer(用于热重载)
  ipcMain.handle('build:watch-start', async (_e, root: string): Promise<void> => {
    await watchCtx?.dispose()
    watchCtx = null
    const absRoot = resolve(root)
    const manifest = await readManifest(absRoot)
    const notifyPlugin: esbuild.Plugin = {
      name: 'pixelbox-watch-notify',
      setup(build) {
        build.onEnd(async (result) => {
          const errors = reportMessages(result)
          if (errors.length > 0) {
            broadcast('build:done', {
              success: false,
              errors,
              durationMs: 0
            } satisfies BuildResult)
            return
          }
          try {
            await copyAssets(absRoot)
            const outDir = join(absRoot, 'dist')
            const code = await fsp.readFile(join(outDir, manifest.entry), 'utf8')
            log('info', `[watch] 重建完成 dist/${manifest.entry}`)
            broadcast('build:done', {
              success: true,
              code,
              manifest,
              outDir,
              errors: [],
              durationMs: 0
            } satisfies BuildResult)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            broadcast('build:done', { success: false, errors: [msg], durationMs: 0 } satisfies BuildResult)
          }
        })
      }
    }
    const opts = esbuildOptions(absRoot, manifest)
    watchCtx = await esbuild.context({ ...opts, plugins: [notifyPlugin] })
    await watchCtx.watch()
    log('info', '[watch] 已开启增量监听构建')
  })

  ipcMain.handle('build:watch-stop', async (): Promise<void> => {
    await watchCtx?.dispose()
    watchCtx = null
    log('info', '[watch] 已停止监听构建')
  })
}

export async function disposeBuilder(): Promise<void> {
  await watchCtx?.dispose()
  watchCtx = null
}
