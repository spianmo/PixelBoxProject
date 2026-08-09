/**
 * ToolchainService(main 进程)—— IDE 内多芯片固件 编译 / 打包 / 烧录(阶段 3)
 *
 * - 检测 ESP-IDF:设置覆盖 > $IDF_PATH > ~/esp/esp-idf,解析 esp_idf_version.h 报版本
 * - 构建:以 login shell($SHELL -lc)运行 `source export.sh && idf.py … build`,
 *   cwd = StartTaskOptions.cwd 指定的固件工程目录(IDE v3:作用于当前工作区,
 *   须含 CMakeLists.txt,否则 toolchain:notFirmwareProject);未传 cwd 保持旧行为
 *   (仓库 firmware/);多目标独立构建目录防止污染默认 sdkconfig
 *   (与 firmware/README.md 约定一致:esp32s3 沿用默认 build/,其余
 *    `-B build_<后缀> -D SDKCONFIG=build_<后缀>/sdkconfig`;set-target 仅在
 *    构建目录目标缺失/不匹配时插入 —— set-target 会清空构建目录并重生成 sdkconfig,
 *    无脑执行会毁掉增量缓存)
 * - 打包:构建成功后接 `idf.py merge-bin`(内部调 esptool merge_bin @flash_args)
 *   合成单文件 firmware/dist/<target>-merged.bin
 * - 烧录:`idf.py -B <dir> -p <port> -b <baud> flash`;串口扫描(usbmodem/wchusbserial/SLAB)
 * - 全程 stdout/stderr 流式经 IPC(toolchain:log)到「构建」tab;可取消(杀进程组)
 * - 设置来源:SettingsService(settings.json 的 toolchain 段;旧 toolchain.json
 *   已由 SettingsService 首启迁移并标记弃用),变更即时生效无需重启
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import type {
  BuildLogLine,
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

/** 工具链设置(SettingsService 的 toolchain 段) */
async function loadSettings(): Promise<ToolchainSettings> {
  return (await getSettings()).toolchain
}

// ---------------------------------------------------------------
// ESP-IDF 检测
// ---------------------------------------------------------------

/** 仓库 firmware/ 目录(开发形态:simulator/ 与 firmware/ 同级) */
function firmwareDir(): string {
  return resolve(app.getAppPath(), '..', 'firmware')
}

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
async function findPythonEnv(version: string | null): Promise<string | null> {
  const toolsPath = process.env.IDF_TOOLS_PATH ?? join(homedir(), '.espressif')
  const envRoot = join(toolsPath, 'python_env')
  try {
    const names = await fsp.readdir(envRoot)
    // "v5.5.0" → 目录前缀 "idf5.5_py"
    const m = version ? /^v(\d+)\.(\d+)/.exec(version) : null
    const prefix = m ? `idf${m[1]}.${m[2]}_py` : 'idf'
    const hit = names
      .filter((n) => n.startsWith(prefix) && existsSync(join(envRoot, n, 'bin', 'python')))
      .sort()
      .pop()
    return hit ? join(envRoot, hit) : null
  } catch {
    return null
  }
}

/**
 * 检测 ESP-IDF 环境(设置覆盖 > $IDF_PATH > ~/esp/esp-idf)。
 * overridePath:设置窗口草稿路径实时检测用 —— 传入(含空串)时替代持久化覆盖值,
 * 不落盘;undefined 时用已保存设置。
 */
export async function detectToolchain(overridePath?: string): Promise<ToolchainInfo> {
  const fw = firmwareDir()
  const base: Omit<ToolchainInfo, 'ok' | 'error'> = {
    idfPath: '',
    version: null,
    firmwareDir: fw
  }
  if (process.platform === 'win32') {
    // 本阶段仅支持 POSIX(login shell + export.sh);Windows 走 IDF 命令行自行构建
    return { ...base, ok: false, error: 'unsupportedPlatform' }
  }
  const settings = await loadSettings()
  const candidates = [
    overridePath !== undefined ? overridePath.trim() : settings.idfPathOverride,
    process.env.IDF_PATH ?? '',
    join(homedir(), 'esp', 'esp-idf')
  ].filter((p) => p.length > 0)
  const idfPath = candidates.find((p) => existsSync(join(p, 'export.sh'))) ?? ''
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
  target: string
  proc: ChildProcess
  cancelled: boolean
  startedAt: number
}

let active: ActiveTask | null = null

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
  if (/\b(error|failed|fatal)\b|ninja: build stopped/i.test(text)) return 'error'
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
  mergedPath: string | null
): Promise<FirmwareArtifact[]> {
  const out: FirmwareArtifact[] = []
  const push = async (p: string | null): Promise<void> => {
    if (!p) return
    try {
      const st = await fsp.stat(p)
      out.push({ path: p, sizeBytes: st.size })
    } catch {
      // 产物缺失不阻塞成功汇报
    }
  }
  if (kind === 'build' || kind === 'merge' || kind === 'flash') {
    await push(await appBinOf(fw, buildDir))
  }
  if (kind === 'merge') await push(mergedPath)
  return out
}

export interface StartTaskOptions {
  kind: FirmwareTaskKind
  target: string
  /** 烧录串口(kind === 'flash' 必填) */
  port?: string
  /** 烧录波特率(缺省用设置值) */
  baud?: number
  /**
   * 固件工程目录(IDE v3:idf.py 作用于当前工作区;须含 CMakeLists.txt,
   * 否则 throw toolchain:notFirmwareProject)。缺省保持旧行为:仓库 firmware/
   */
  cwd?: string
}

/** 启动固件任务;并发/环境错误直接 throw(错误消息为 i18n 错误码) */
async function startTask(opts: StartTaskOptions): Promise<void> {
  if (active) throw new Error('toolchain:busy')
  const target = opts.target
  if (!/^[a-z0-9]+$/.test(target)) throw new Error('toolchain:badTarget')

  const info = await detectToolchain()
  // cwd 模式只依赖 IDF 环境本身:monorepo firmware/ 缺失(打包分发形态)不阻塞
  if (!info.ok && !(opts.cwd && info.error === 'firmwareMissing')) {
    throw new Error(`toolchain:${info.error ?? 'idfNotFound'}`)
  }
  // 任务工作目录:cwd 指定的固件工程(校验 CMakeLists.txt)> 旧 monorepo firmware/
  let fw: string
  if (typeof opts.cwd === 'string' && opts.cwd.trim().length > 0) {
    fw = resolve(opts.cwd.trim())
    if (!existsSync(join(fw, 'CMakeLists.txt'))) throw new Error('toolchain:notFirmwareProject')
  } else {
    fw = info.firmwareDir
  }
  const buildDir = buildDirOf(target)
  const startedAt = Date.now()

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
  const settings = await loadSettings()

  // idf.py 全局参数:独立构建目录;非默认目录显式 SDKCONFIG 防止污染仓库根 sdkconfig
  const idfArgs: string[] = ['-B', buildDir]
  if (buildDir !== 'build') idfArgs.push('-D', `SDKCONFIG=${buildDir}/sdkconfig`)

  let mergedPath: string | null = null
  const actions: string[] = []
  // set-target 会清空构建目录并按 sdkconfig.defaults(.<target>) 重生成配置,
  // 仅在目录未配置或目标不匹配时插入,保住增量缓存
  const configured = await configuredTarget(fw, buildDir)
  if (configured !== target) actions.push('set-target', target)

  if (opts.kind === 'build' || opts.kind === 'merge') actions.push('build')
  if (opts.kind === 'merge') {
    // merge-bin 内部调 esptool merge_bin @flash_args,输出合成单文件到 <工程目录>/dist/
    mergedPath = join(fw, 'dist', `${target}-merged.bin`)
    await fsp.mkdir(dirname(mergedPath), { recursive: true })
    actions.push('merge-bin', '-o', mergedPath)
  }
  if (opts.kind === 'flash') {
    const port = opts.port ?? ''
    if (!/^\/dev\/[\w.-]+$/.test(port)) throw new Error('toolchain:badPort')
    const baud = typeof opts.baud === 'number' && opts.baud >= 9600 ? opts.baud : settings.baudRate
    idfArgs.push('-p', port, '-b', String(baud))
    actions.push('flash') // idf.py flash 依赖 build,过期时自动增量重建
  }

  // login shell 脚本:组件注册表镜像兜底 + 固定 Python venv + 加载 export.sh
  // (export.sh 输出收进临时日志保持「构建」tab 干净,失败时原样倒出便于排错;
  //  export.sh 可能 rc=0 但未导出 PATH,故额外用 command -v idf.py 守卫)
  const pyEnv = await findPythonEnv(info.version)
  const script = [
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

  const shell = process.env.SHELL ?? '/bin/zsh'
  // detached:自建进程组,取消时 kill(-pid) 连 cmake/ninja/esptool 一起终止
  const proc = spawn(shell, ['-lc', script], {
    cwd: fw,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  active = { kind: opts.kind, target, proc, cancelled: false, startedAt }
  emitLines([line('info', `[toolchain] 任务开始:${opts.kind} → ${target}(cwd=${fw})`)])

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
    const success = code === 0 && !task.cancelled
    void (async (): Promise<void> => {
      const artifacts = success ? await collectArtifacts(task.kind, fw, buildDir, mergedPath) : []
      if (success) {
        // build*/dist 被 watcher 忽略,首次构建产生的目录不会有真实 fs 事件 →
        // 合成 addDir 让文件树刷新父目录,显示新出现的构建产物目录
        emitFsEventIfWatched('addDir', join(fw, buildDir))
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
        target: task.target,
        success,
        cancelled: task.cancelled,
        exitCode: code,
        durationMs,
        artifacts
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
    async (_e, overridePath?: string): Promise<ToolchainInfo> =>
      detectToolchain(typeof overridePath === 'string' ? overridePath : undefined)
  )

  // 启动任务(构建/打包/烧录/清理);完成经 toolchain:done 事件回报
  ipcMain.handle('toolchain:start', async (_e, opts: StartTaskOptions): Promise<void> => {
    await startTask(opts)
  })

  // 取消当前任务(杀进程组)
  ipcMain.handle('toolchain:cancel', (): void => cancelTask())

  // 运行状态(renderer 重载后恢复按钮禁用态)
  ipcMain.handle('toolchain:status', (): FirmwareStatus => {
    return { running: active?.kind ?? null, target: active?.target ?? null }
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
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
  active = null
}
