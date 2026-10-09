/**
 * ToolchainService(main 进程)—— IDE 内多芯片固件 编译 / 打包 / 烧录(阶段 3)
 *
 * - 按 pixelbox.json 的 firmwareBackend 选择 ESP-IDF / NuttX，旧工程缺省 ESP-IDF
 * - NuttX 独立调用 scripts/nuttx.py，不加载 IDF 环境；只开放已有 profile 的 ESP32-S3
 * - 检测 ESP-IDF:设置覆盖 > $IDF_PATH > ~/esp/esp-idf,解析 esp_idf_version.h 报版本
 * - 构建:POSIX 使用 login shell + export.sh,Windows 使用 PowerShell + export.ps1,
 *   cwd = StartTaskOptions.cwd 指定的固件工程目录(IDE v3:作用于当前工作区,
 *   须含 CMakeLists.txt,否则 toolchain:notFirmwareProject);未传 cwd 保持旧行为
 *   (仓库 firmware/);多目标独立构建目录防止污染默认 sdkconfig
 *   (与 firmware/README.md 约定一致:esp32s3 沿用默认 build/,其余
 *    `-B build_<后缀> -D SDKCONFIG=build_<后缀>/sdkconfig`;set-target 仅在
 *    已配置目标不匹配时插入,首次配置仅传 IDF_TARGET —— set-target 会清空构建目录并重生成 sdkconfig,
 *    无脑执行会毁掉增量缓存)
 * - 打包:构建成功后接 `idf.py merge-bin`(内部调 esptool merge_bin @flash_args)
 *   合成单文件 firmware/dist/<target>-merged.bin
 * - 烧录:`idf.py -B <dir> -p <port> -b <baud> flash`;串口扫描(usbmodem/wchusbserial/SLAB)
 * - 全程 stdout/stderr 流式经 IPC(toolchain:log)到「构建」tab;可取消(杀进程组)
 * - 设置来源:SettingsService(settings.json 的 toolchain 段;旧 toolchain.json
 *   已由 SettingsService 首启迁移并标记弃用),变更即时生效无需重启
 */
import { ipcMain, BrowserWindow } from 'electron'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import type {
  BuildLogLine,
  FirmwareBackend,
  FirmwareArtifact,
  FirmwareStatus,
  FirmwareTaskKind,
  FirmwareTaskResult,
  SerialPortInfo,
  ToolchainInfo,
  ToolchainSettings
} from '../shared/ipc-types'
import { getSettings } from './settings'
import { emitFsEventIfWatched } from './workspace'
import { firmwareTemplateDir, resolveFirmwareProject } from './firmwareProject'
import { isFirmwareBackend, supportsFirmwareTarget } from '../shared/firmwareBackends'
import { detectNuttxToolchain, nuttxTaskArgs } from './nuttxToolchain'

/** 工具链设置(SettingsService 的 toolchain 段) */
async function loadSettings(): Promise<ToolchainSettings> {
  return (await getSettings()).toolchain
}

// ---------------------------------------------------------------
// ESP-IDF 检测
// ---------------------------------------------------------------

/** 解析 esp_idf_version.h → "v5.5.0"(读不到返回 null) */
async function readIdfVersion(idfPath: string): Promise<string | null> {
  try {
    const header = await fsp.readFile(
      join(idfPath, 'components', 'esp_common', 'include', 'esp_idf_version.h'),
      'utf8'
    )
    const pick = (name: string): string | null => {
      const m = new RegExp(`#define\\s+ESP_IDF_VERSION_${name}\\s+(\\d+)`).exec(header)
      return m ? m[1] : null
    }
    const [maj, min, pat] = [pick('MAJOR'), pick('MINOR'), pick('PATCH')]
    return maj && min && pat ? `v${maj}.${min}.${pat}` : null
  } catch {
    return null
  }
}

/**
 * 定位既有的 IDF Python 虚拟环境目录(如 ~/.espressif/python_env/idf5.5_py3.13_env)。
 * export.sh 默认按 login shell 里 python3 的小版本推导 env 目录名,Homebrew 升级
 * python(3.13 → 3.14)后会指向不存在的 env 而报错;这里改为扫描
 * $IDF_TOOLS_PATH/python_env 下与 IDF 主次版本匹配的既有 env,
 * 构建脚本经 IDF_PYTHON_ENV_PATH 显式固定(idf_tools.py 优先使用该变量)。
 */
function idfToolsPath(idfPath: string): string {
  if (process.env.IDF_TOOLS_PATH) return process.env.IDF_TOOLS_PATH
  const adjacent = join(dirname(idfPath), 'tools')
  return existsSync(join(adjacent, 'python_env')) ? adjacent : join(homedir(), '.espressif')
}

async function findPythonEnv(version: string | null, toolsPath: string): Promise<string | null> {
  if (process.env.IDF_PYTHON_ENV_PATH) return process.env.IDF_PYTHON_ENV_PATH
  const envRoot = join(toolsPath, 'python_env')
  try {
    const names = await fsp.readdir(envRoot)
    // "v5.5.0" → 目录前缀 "idf5.5_py"
    const m = version ? /^v(\d+)\.(\d+)/.exec(version) : null
    const prefix = m ? `idf${m[1]}.${m[2]}_py` : 'idf'
    const hit = names
      .filter((n) => n.startsWith(prefix) && existsSync(join(envRoot, n, ...pythonRelativePath())))
      .sort()
      .pop()
    return hit ? join(envRoot, hit) : null
  } catch {
    return null
  }
}

function pythonRelativePath(): string[] {
  return process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
}

async function windowsIdfCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const roots = [join(process.env.SystemDrive || 'C:', 'Espressif'), 'D:\\Espressif', join(homedir(), 'esp')]
  const paths: string[] = []
  for (const root of roots) {
    try {
      const names = await fsp.readdir(root)
      paths.push(...names.filter((name) => name.startsWith('esp-idf')).sort().reverse().map((name) => join(root, name)))
    } catch { /* Optional installation directory. */ }
  }
  return paths
}

/**
 * 检测指定后端环境；传 cwd 时必须与工程清单一致，未声明的旧工程按 ESP-IDF。
 * overridePath:设置窗口草稿路径实时检测用 —— 传入(含空串)时替代持久化覆盖值,
 * 不落盘;undefined 时用已保存设置。
 */
export async function detectToolchain(overridePath?: string, requestedBackend?: FirmwareBackend, cwd?: string): Promise<ToolchainInfo> {
  let backend: FirmwareBackend = isFirmwareBackend(requestedBackend) ? requestedBackend : 'esp-idf'
  let fw = typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : firmwareTemplateDir(backend)
  if (requestedBackend !== undefined && !isFirmwareBackend(requestedBackend)) {
    return { ok: false, backend, idfPath: '', version: null, firmwareDir: fw, error: 'backendMismatch' }
  }
  if (cwd !== undefined) {
    try {
      const project = await resolveFirmwareProject(fw, requestedBackend)
      backend = project.backend
      fw = project.root
    } catch (error) {
      return { ok: false, backend, idfPath: '', version: null, firmwareDir: fw,
        error: error instanceof Error && error.message === 'toolchain:backendMismatch' ? 'backendMismatch' : 'notFirmwareProject' }
    }
  }
  const settings = await loadSettings()
  if (backend === 'nuttx') {
    return detectNuttxToolchain(fw, overridePath !== undefined ? overridePath : settings.nuttxPathOverride)
  }
  const base: Omit<ToolchainInfo, 'ok' | 'error'> = {
    backend,
    idfPath: '',
    version: null,
    firmwareDir: fw
  }
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
    return { ...base, ok: false, error: 'unsupportedPlatform' }
  }
  const candidates = [
    overridePath !== undefined ? overridePath.trim() : settings.idfPathOverride,
    process.env.IDF_PATH ?? '',
    join(homedir(), 'esp', 'esp-idf'),
    ...await windowsIdfCandidates()
  ].filter((p) => p.length > 0)
  const exportFile = process.platform === 'win32' ? 'export.ps1' : 'export.sh'
  const idfPath = candidates.find((p) => existsSync(join(p, exportFile))) ?? ''
  if (!idfPath) {
    // 报告首个候选路径便于用户在设置页排错
    return { ...base, idfPath: candidates[0] ?? '', ok: false, error: 'idfNotFound' }
  }
  const version = await readIdfVersion(idfPath)
  if (!existsSync(fw) || !existsSync(join(fw, 'CMakeLists.txt'))) {
    return { ...base, idfPath, version, ok: false, error: 'firmwareMissing' }
  }
  return { ...base, idfPath, version, ok: true }
}

// ---------------------------------------------------------------
// 构建目录 / 命令拼装
// ---------------------------------------------------------------

/**
 * 目标芯片 → 构建目录名(与 firmware/README.md 多目标约定一致):
 * esp32s3 沿用默认 build/(既有缓存),其余 build_<去 esp32 前缀>(build_c6 / build_p4);
 * 经典 esp32 无后缀 → build_esp32
 */
export function buildDirOf(target: string): string {
  if (target === 'esp32s3') return 'build'
  const suffix = target.replace(/^esp32/, '')
  return `build_${suffix.length > 0 ? suffix : 'esp32'}`
}

/** shell 双引号安全转义 */
function q(s: string): string {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powershellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

function powershellPath(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 读取构建目录当前已配置的目标(未配置返回 null) */
async function configuredTarget(fw: string, buildDir: string): Promise<string | null> {
  try {
    const desc = JSON.parse(
      await fsp.readFile(join(fw, buildDir, 'project_description.json'), 'utf8')
    ) as { target?: string }
    return typeof desc.target === 'string' ? desc.target : null
  } catch {
    return null
  }
}

/** 读取 app bin 产物路径(pixelbox.bin;读不到回退 null) */
async function appBinOf(fw: string, buildDir: string): Promise<string | null> {
  try {
    const desc = JSON.parse(
      await fsp.readFile(join(fw, buildDir, 'project_description.json'), 'utf8')
    ) as { app_bin?: string }
    return typeof desc.app_bin === 'string' ? join(fw, buildDir, desc.app_bin) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------
// 任务执行(单实例:同一时刻仅一个固件任务)
// ---------------------------------------------------------------

interface ActiveTask {
  kind: FirmwareTaskKind
  firmwareBackend: FirmwareBackend
  target: string
  proc: ChildProcess
  cancelled: boolean
  startedAt: number
}

let active: ActiveTask | null = null
/** 异步识别清单/读取设置期间也占用任务槽，防止两个 IPC 同时启动子进程。 */
let starting = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** 行级日志(批量推送,ANSI 由 renderer 侧解析) */
function emitLines(lines: BuildLogLine[]): void {
  if (lines.length > 0) broadcast('toolchain:log', lines)
}

function line(level: BuildLogLine['level'], text: string): BuildLogLine {
  return { level, text, ts: Date.now() }
}

/** 输出行级别启发式(idf.py 非 TTY 下无 ANSI 颜色,按关键词着色) */
function classify(text: string): BuildLogLine['level'] {
  if (/\b(error|failed|fatal)\b|ninja: build stopped|错误|失败/i.test(text)) return 'error'
  if (/\bwarning\b/i.test(text)) return 'warn'
  return 'info'
}

/** 把子进程输出块切分为完整行(\r 进度行也切开),尾部残行留在缓冲 */
function splitChunk(buf: { rest: string }, chunk: string): string[] {
  buf.rest += chunk
  const parts = buf.rest.split(/\r\n|\n|\r/)
  buf.rest = parts.pop() ?? ''
  return parts.filter((s) => s.trim().length > 0)
}

function emitDone(result: FirmwareTaskResult): void {
  broadcast('toolchain:done', result)
}

/** 收集任务成功后的产物(app bin / merged.bin),stat 体积 */
async function collectArtifacts(
  kind: FirmwareTaskKind,
  fw: string,
  buildDir: string,
  mergedPath: string | null,
  backend: FirmwareBackend
): Promise<FirmwareArtifact[]> {
  const out: FirmwareArtifact[] = []
  const push = async (p: string | null): Promise<void> => {
    if (!p) return
    try {
      const st = await fsp.stat(p)
      if (!st.isFile() || st.size <= 0) throw new Error('empty artifact')
      out.push({ path: p, sizeBytes: st.size })
    } catch {
      if (backend === 'nuttx') throw new Error(`NuttX 固件产物缺失或为空: ${p}`)
      // ESP-IDF 沿用历史行为，工具自身负责对构建结果判错。
    }
  }
  if (kind === 'build' || kind === 'merge' || kind === 'flash') {
    await push(backend === 'nuttx' ? join(fw, buildDir, 'nuttx.bin') : await appBinOf(fw, buildDir))
  }
  if (kind === 'merge') await push(mergedPath)
  return out
}

export interface StartTaskOptions {
  kind: FirmwareTaskKind
  /** 请求声明仅用于核验，实际后端来自 cwd/pixelbox.json。 */
  firmwareBackend?: FirmwareBackend
  target: string
  /** 烧录串口(kind === 'flash' 必填) */
  port?: string
  /** 烧录波特率(缺省用设置值) */
  baud?: number
  /** NuttX 烧录时格式化数据区；缺省保留数据。 */
  formatStorage?: boolean
  /**
   * 固件工程目录；NuttX 校验 runner 与入口，ESP-IDF 校验 CMakeLists.txt。
   * 缺省使用所选后端的仓库/内置模板目录。
   */
  cwd?: string
}

/** 启动固件任务;并发/环境错误直接 throw(错误消息为 i18n 错误码) */
async function startTask(opts: StartTaskOptions): Promise<void> {
  if (active || starting) throw new Error('toolchain:busy')
  starting = true
  try { await startTaskInternal(opts) } finally { starting = false }
}

async function startTaskInternal(opts: StartTaskOptions): Promise<void> {
  const target = opts.target
  if (!/^[a-z0-9]+$/.test(target)) throw new Error('toolchain:badTarget')
  if (!['build', 'merge', 'flash', 'clean'].includes(opts.kind)) throw new Error('toolchain:badTask')
  const requested = opts.firmwareBackend
  if (requested !== undefined && !isFirmwareBackend(requested)) throw new Error('toolchain:backendMismatch')
  const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? resolve(opts.cwd.trim()) : firmwareTemplateDir(requested ?? 'esp-idf')
  const project = await resolveFirmwareProject(cwd, requested)
  const fw = project.root
  const backend = project.backend
  // IPC 必须显式布尔值；格式化只允许用于 NuttX 烧录任务。
  if ((opts.formatStorage !== undefined && typeof opts.formatStorage !== 'boolean') ||
      (opts.formatStorage === true && (backend !== 'nuttx' || opts.kind !== 'flash'))) {
    throw new Error('toolchain:badFormatStorage')
  }
  if (!supportsFirmwareTarget(backend, target)) throw new Error('toolchain:unsupportedBackendTarget')
  // renderer 的 target 始终是芯片名；NuttX profile 才是 runner 的真实目标。
  // 例如 esp32s3-multinet7 会选择 MultiNet7 Kconfig 覆盖并隔离自己的缓存。
  const runnerTarget = backend === 'nuttx' ? (project.nuttxProfile ?? target) : target
  const buildDir = backend === 'nuttx' ? join('build', runnerTarget) : buildDirOf(target)
  const startedAt = Date.now()
  const settings = await loadSettings()
  if (opts.kind === 'flash') {
    const port = opts.port ?? ''
    const validPort = process.platform === 'win32' ? /^COM[1-9]\d*$/i.test(port) : /^\/dev\/[\w.-]+$/.test(port)
    if (!validPort) throw new Error('toolchain:badPort')
  }

  if (backend === 'nuttx') {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('toolchain:unsupportedPlatform')
    // clean 只清理工程自己的 build/<target>，无需 SDK 源码或交叉编译器可用。
    let nuttxPath = settings.nuttxPathOverride
    if (opts.kind !== 'clean') {
      const info = await detectToolchain(undefined, backend, fw)
      if (!info.ok) throw new Error(`toolchain:${info.error ?? 'nuttxNotFound'}`)
      nuttxPath = info.nuttxPath!
    }
    const baud = typeof opts.baud === 'number' && Number.isFinite(opts.baud) && opts.baud >= 9600 && opts.baud <= 4000000
      ? Math.floor(opts.baud) : settings.baudRate
    const args = nuttxTaskArgs(opts.kind, nuttxPath, runnerTarget, opts.port, baud, opts.formatStorage)
    emitLines([line('info', `[toolchain] NuttX profile=${runnerTarget} (chip=${target})`),
      line('info', `[toolchain] python3 ${args.map(q).join(' ')}`)])
    // NuttX 直接执行独立 runner；不 source export.sh、不读取 IDF 工具路径。
    const proc = spawn('python3', args, { cwd: fw, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } })
    watchTaskProcess(proc, opts, backend, fw, buildDir, opts.kind === 'merge' ? join(fw, 'dist', `${runnerTarget}-nuttx.bin`) : null, startedAt)
    return
  }

  // ---- clean:直接删除构建目录(不需要 IDF 环境;非默认目录连内嵌 sdkconfig 一起清) ----
  if (opts.kind === 'clean') {
    const abs = join(fw, buildDir)
    emitLines([line('info', `[toolchain] 清理构建目录 ${abs} …`)])
    try {
      await fsp.rm(abs, { recursive: true, force: true })
      // 构建目录被 watcher 刻意忽略(workspace.ts ignored),删除不会产生真实
      // fs 事件 → 合成一条让文件树刷新父目录,移除已消失的 build*/
      emitFsEventIfWatched('unlinkDir', abs)
      emitLines([line('info', `[toolchain] 清理完成(${target} 下次构建将全量重新配置)`)])
      emitDone({
        kind: 'clean',
        firmwareBackend: backend,
        target,
        success: true,
        cancelled: false,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        artifacts: []
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitLines([line('error', `[toolchain] 清理失败: ${msg}`)])
      emitDone({
        kind: 'clean',
        firmwareBackend: backend,
        target,
        success: false,
        cancelled: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        artifacts: [],
        message: msg
      })
    }
    return
  }

  // ---- build / merge / flash:login shell + export.sh + idf.py ----
  const info = await detectToolchain(undefined, backend, fw)
  if (!info.ok) throw new Error(`toolchain:${info.error ?? 'idfNotFound'}`)

  // idf.py 全局参数:独立构建目录;非默认目录显式 SDKCONFIG 防止污染仓库根 sdkconfig
  const idfArgs: string[] = ['-B', buildDir]
  if (buildDir !== 'build') idfArgs.push('-D', `SDKCONFIG=${buildDir}/sdkconfig`)

  let mergedPath: string | null = null
  const actions: string[] = []
  // set-target 会清空构建目录并按 sdkconfig.defaults(.<target>) 重生成配置,
  // 首次配置传 IDF_TARGET,也允许网络中断后重试不完整的 CMake 目录。
  const configured = await configuredTarget(fw, buildDir)
  if (configured && configured !== target) actions.push('set-target', target)
  else if (!configured) idfArgs.push('-D', `IDF_TARGET=${target}`)

  if (opts.kind === 'build' || opts.kind === 'merge') actions.push('build')
  if (opts.kind === 'merge') {
    // merge-bin 内部调 esptool merge_bin @flash_args,输出合成单文件到 <工程目录>/dist/
    mergedPath = join(fw, 'dist', `${target}-merged.bin`)
    await fsp.mkdir(dirname(mergedPath), { recursive: true })
    actions.push('merge-bin', '-o', mergedPath)
  }
  if (opts.kind === 'flash') {
    const port = opts.port ?? ''
    const validPort = process.platform === 'win32' ? /^COM[1-9]\d*$/i.test(port) : /^\/dev\/[\w.-]+$/.test(port)
    if (!validPort) throw new Error('toolchain:badPort')
    const baud = typeof opts.baud === 'number' && opts.baud >= 9600 ? opts.baud : settings.baudRate
    idfArgs.push('-p', port, '-b', String(baud))
    actions.push('flash') // idf.py flash 依赖 build,过期时自动增量重建
  }

  // login shell 脚本:组件注册表镜像兜底 + 固定 Python venv + 加载 export.sh
  // (export.sh 输出收进临时日志保持「构建」tab 干净,失败时原样倒出便于排错;
  //  export.sh 可能 rc=0 但未导出 PATH,故额外用 command -v idf.py 守卫)
  const toolsPath = idfToolsPath(info.idfPath)
  const pyEnv = await findPythonEnv(info.version, toolsPath)
  const posixScript = [
    `export IDF_COMPONENT_STORAGE_URL="\${IDF_COMPONENT_STORAGE_URL:-https://components-file.espressif.cn}"`,
    ...(pyEnv
      ? [`export IDF_PYTHON_ENV_PATH="\${IDF_PYTHON_ENV_PATH:-${pyEnv.replace(/(["\\$`])/g, '\\$1')}}"`]
      : []),
    `echo "[toolchain] 加载 ESP-IDF 环境 (${info.version ?? '?'}) …"`,
    `__IDF_EXPORT_LOG="$(mktemp)"`,
    `source ${q(join(info.idfPath, 'export.sh'))} >"$__IDF_EXPORT_LOG" 2>&1 || { cat "$__IDF_EXPORT_LOG" >&2; echo "[toolchain] export.sh 加载失败" >&2; exit 201; }`,
    `command -v idf.py >/dev/null 2>&1 || { cat "$__IDF_EXPORT_LOG" >&2; echo "[toolchain] export.sh 未能导出 idf.py(检查 IDF Python 环境是否已安装)" >&2; exit 202; }`,
    `rm -f "$__IDF_EXPORT_LOG"`,
    `echo "[toolchain] idf.py ${[...idfArgs, ...actions].join(' ')}"`,
    `exec idf.py ${[...idfArgs, ...actions].map(q).join(' ')}`
  ].join('\n')

  const windowsScript = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    "if (-not $env:NO_PROXY) { $env:NO_PROXY = [Environment]::GetEnvironmentVariable('NO_PROXY', 'User') }",
    ...(pyEnv ? [`$env:PATH = ${psQuote(join(pyEnv, 'Scripts'))} + ';' + $env:PATH`] : []),
    `Write-Output ${psQuote(`[toolchain] 加载 ESP-IDF 环境 (${info.version ?? '?'}) …`)}`,
    `try { . ${psQuote(join(info.idfPath, 'export.ps1'))} } catch { Write-Output $_; exit 201 }`,
    'if (-not $env:IDF_PYTHON_ENV_PATH) { Write-Output "[toolchain] IDF Python environment missing"; exit 202 }',
    '$idfPython = Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts/python.exe"',
    `Write-Output ${psQuote(`[toolchain] idf.py ${[...idfArgs, ...actions].join(' ')}`)}`,
    `& $idfPython ${psQuote(join(info.idfPath, 'tools', 'idf.py'))} ${[...idfArgs, ...actions].map(psQuote).join(' ')}`,
    'exit $LASTEXITCODE'
  ].join('\n')
  const windows = process.platform === 'win32'
  const shell = windows ? powershellPath() : process.env.SHELL ?? '/bin/bash'
  // detached:自建进程组,取消时 kill(-pid) 连 cmake/ninja/esptool 一起终止
  const proc = spawn(shell, windows ? powershellArgs(windowsScript) : ['-lc', posixScript], {
    cwd: fw,
    detached: !windows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IDF_TOOLS_PATH: toolsPath,
      IDF_COMPONENT_STORAGE_URL: process.env.IDF_COMPONENT_STORAGE_URL || 'https://components-file.espressif.cn',
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      ...(pyEnv ? { IDF_PYTHON_ENV_PATH: pyEnv } : {}) }
  })
  watchTaskProcess(proc, opts, backend, fw, buildDir, mergedPath, startedAt)
}

/** 两种后端共用日志、取消、退出与产物回报，保持上层任务接口一致。 */
function watchTaskProcess(proc: ChildProcess, opts: StartTaskOptions, backend: FirmwareBackend,
  fw: string, buildDir: string, mergedPath: string | null, startedAt: number): void {
  active = { kind: opts.kind, target: opts.target, firmwareBackend: backend, proc, cancelled: false, startedAt }
  emitLines([line('info', `[toolchain] 任务开始:${backend}/${opts.kind} → ${opts.target}(cwd=${fw})`)])

  const stdoutBuf = { rest: '' }
  const stderrBuf = { rest: '' }
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    emitLines(splitChunk(stdoutBuf, chunk).map((s) => line(classify(s), s)))
  })
  proc.stderr?.on('data', (chunk: string) => {
    // idf.py 把普通进度也写 stderr,按内容分级而非一律 error
    emitLines(splitChunk(stderrBuf, chunk).map((s) => line(classify(s), s)))
  })

  proc.on('error', (err) => {
    // spawn 自身失败(shell 不存在等):close 不一定触发,这里直接终局
    if (!active || active.proc !== proc) return
    const task = active
    active = null
    emitLines([line('error', `[toolchain] 进程启动失败: ${err.message}`)])
    emitDone({
      kind: task.kind,
      firmwareBackend: task.firmwareBackend,
      target: task.target,
      success: false,
      cancelled: false,
      exitCode: null,
      durationMs: Date.now() - task.startedAt,
      artifacts: [],
      message: err.message
    })
  })

  proc.on('close', (code, signal) => {
    if (!active || active.proc !== proc) return
    const task = active
    active = null
    // 冲刷残行
    emitLines(
      [stdoutBuf.rest, stderrBuf.rest]
        .filter((s) => s.trim().length > 0)
        .map((s) => line(classify(s), s))
    )
    const durationMs = Date.now() - task.startedAt
    let success = code === 0 && !task.cancelled
    void (async (): Promise<void> => {
      let artifacts: FirmwareArtifact[] = []
      let message: string | undefined
      if (success) {
        try {
          artifacts = await collectArtifacts(task.kind, fw, buildDir, mergedPath, task.firmwareBackend)
        } catch (error) {
          success = false
          message = error instanceof Error ? error.message : String(error)
          emitLines([line('error', `[toolchain] ${message}`)])
        }
      }
      if (success) {
        // build*/dist 被 watcher 忽略,首次构建产生的目录不会有真实 fs 事件 →
        // 合成 addDir 让文件树刷新父目录,显示新出现的构建产物目录
        emitFsEventIfWatched(task.kind === 'clean' ? 'unlinkDir' : 'addDir', join(fw, buildDir))
        if (task.kind === 'merge') emitFsEventIfWatched('addDir', join(fw, 'dist'))
      }
      const secs = (durationMs / 1000).toFixed(1)
      if (success) {
        const detail = artifacts
          .map((a) => `${basename(a.path)} ${(a.sizeBytes / 1024).toFixed(1)} KB`)
          .join(', ')
        emitLines([
          line('info', `[toolchain] 任务完成:${task.kind} → ${task.target}(${secs}s${detail ? `,${detail}` : ''})`)
        ])
      } else if (task.cancelled) {
        emitLines([line('warn', `[toolchain] 任务已取消(${secs}s)`)])
      } else {
        emitLines([
          line('error', `[toolchain] 任务失败:exit=${code ?? `signal ${signal ?? '?'}`}(${secs}s)`)
        ])
      }
      emitDone({
        kind: task.kind,
        firmwareBackend: task.firmwareBackend,
        target: task.target,
        success,
        cancelled: task.cancelled,
        exitCode: code,
        durationMs,
        artifacts,
        ...(message ? { message } : {})
      })
    })()
  })
}

/** 取消当前任务:SIGTERM 进程组,3s 未退出补 SIGKILL */
function cancelTask(): void {
  const task = active
  if (!task || task.proc.pid === undefined) return
  task.cancelled = true
  const pid = task.proc.pid
  emitLines([line('warn', '[toolchain] 已请求取消,正在终止进程树…')])
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (!error || active?.proc !== task.proc) return
      // taskkill can report a child that exited during traversal even when the root was killed.
      try { process.kill(pid, 0) } catch { return }
      emitLines([line('error', `[toolchain] taskkill failed (exit=${error.code ?? '?'}, pid=${pid})`)])
    })
    return
  }
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig) // 负 pid = 整个进程组(cmake/ninja/esptool)
    } catch {
      // 进程已退出
    }
  }
  killGroup('SIGTERM')
  setTimeout(() => {
    if (active && active.proc === task.proc) killGroup('SIGKILL')
  }, 3000)
}

// ---------------------------------------------------------------
// 串口扫描
// ---------------------------------------------------------------

/** macOS:cu.usbmodem* / cu.wchusbserial* / cu.usbserial* / cu.SLAB*;Linux:ttyUSB* / ttyACM* */
const PORT_PATTERNS: Record<string, RegExp> = {
  darwin: /^cu\.(usbmodem|wchusbserial|usbserial|SLAB)/,
  linux: /^tty(USB|ACM)\d+$/
}

export async function scanSerialPorts(): Promise<SerialPortInfo[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)(powershellPath(), powershellArgs(
        '[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress'
      ), { windowsHide: true, timeout: 10000 })
      const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : []
      const names: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
      return names.filter((name): name is string => typeof name === 'string' && /^COM[1-9]\d*$/i.test(name))
        .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
        .map((name) => ({ path: name, label: name }))
    } catch { return [] }
  }
  const pattern = PORT_PATTERNS[process.platform]
  if (!pattern) return []
  try {
    const names = await fsp.readdir('/dev')
    return names
      .filter((n) => pattern.test(n))
      .sort()
      .map((n) => ({ path: `/dev/${n}`, label: n.replace(/^cu\./, '') }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------
// IPC 注册 / 收尾
// ---------------------------------------------------------------

export function registerToolchainIpc(): void {
  // 环境检测(设置页实时回显 / 构建前预检);可传草稿覆盖路径做不落盘试探
  ipcMain.handle(
    'toolchain:detect',
    async (_e, overridePath?: string, backend?: FirmwareBackend, cwd?: string): Promise<ToolchainInfo> =>
      detectToolchain(typeof overridePath === 'string' ? overridePath : undefined, backend, typeof cwd === 'string' ? cwd : undefined)
  )

  // 启动任务(构建/打包/烧录/清理);完成经 toolchain:done 事件回报
  ipcMain.handle('toolchain:start', async (_e, opts: StartTaskOptions): Promise<void> => {
    await startTask(opts)
  })

  // 取消当前任务(杀进程组)
  ipcMain.handle('toolchain:cancel', (): void => cancelTask())

  // 运行状态(renderer 重载后恢复按钮禁用态)
  ipcMain.handle('toolchain:status', (): FirmwareStatus => {
    return { running: active?.kind ?? null, target: active?.target ?? null, firmwareBackend: active?.firmwareBackend }
  })

  // 串口扫描(烧录对话框轮询刷新)
  ipcMain.handle('toolchain:ports', async (): Promise<SerialPortInfo[]> => scanSerialPorts())
  // 设置读写已收敛到 SettingsService(settings:get-all / settings:set-many)
}

/** 退出前兜底:不留后台构建进程 */
export function disposeToolchain(): void {
  const pid = active?.proc.pid
  if (pid !== undefined) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
      } else process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
  active = null
}
