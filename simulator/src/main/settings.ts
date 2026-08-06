/**
 * SettingsService(main 进程)—— IDE 设置单一持久化源
 *
 * - 单一 JSON 落盘:userData/pixelbox-sim/settings.json(结构 = shared/ipc-types.ts
 *   的 AppSettings;默认值与逐项校验见 shared/settingsSchema.ts,单一数据源)
 * - IPC:settings:get-all(全量读)/ settings:set-many(dot-path 补丁,坏值丢弃)/
 *   settings:reset(回默认值);变更经 settings:changed 广播到全部窗口
 *   (主窗 / 设置窗 / 独立工具窗),消费方(Monaco / 终端 / 标题栏芯片 / 工具链)
 *   订阅后即时生效,无需重启窗口
 * - 向后兼容:settings.json 不存在时首启迁移旧 toolchain.json
 *   (IDF 路径覆盖 / 默认芯片 / 波特率),迁移完成后在旧文件写入 deprecated 标记,
 *   此后 toolchain.json 不再作为数据源(renderer 侧 localStorage 旧值
 *   —— minimap / 语言 —— 由 renderer settings/store.ts 首启推送迁移)
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, SettingsChangedEvent } from '../shared/ipc-types'
import { SETTINGS_DEFAULTS, applyPatch, settingsFromDisk } from '../shared/settingsSchema'

export { SETTINGS_DEFAULTS }

function settingsFile(): string {
  return join(app.getPath('userData'), 'pixelbox-sim', 'settings.json')
}

/** 旧工具链设置文件(v2.2 及以前;首启迁移后标记弃用) */
function legacyToolchainFile(): string {
  return join(app.getPath('userData'), 'pixelbox-sim', 'toolchain.json')
}

let cached: AppSettings | null = null
let loading: Promise<AppSettings> | null = null

/**
 * 首启迁移:settings.json 不存在时,吸收旧 toolchain.json 的三个字段,
 * 并把旧文件重写为带 deprecated 标记的形态(保留原值便于回溯,不再读取)。
 * 返回迁移出的 dot-path 补丁(无旧文件 / 已标记弃用返回空)。
 */
async function migrateLegacyToolchain(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fsp.readFile(legacyToolchainFile(), 'utf8')) as Record<
      string,
      unknown
    >
    if (raw.deprecated === true) return {} // 已迁移过
    const patch: Record<string, unknown> = {
      'toolchain.idfPathOverride': raw.idfPathOverride,
      'toolchain.defaultTarget': raw.defaultTarget,
      'toolchain.baudRate': raw.baudRate
    }
    // 旧源标记弃用(原字段保留便于人工回溯;SettingsService 此后不再读取)
    await fsp.writeFile(
      legacyToolchainFile(),
      JSON.stringify({ ...raw, deprecated: true, migratedTo: 'settings.json' }, null, 2),
      'utf8'
    )
    return patch
  } catch {
    return {} // 无旧文件 / 解析失败:跳过迁移
  }
}

async function persist(settings: AppSettings): Promise<void> {
  const file = settingsFile()
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
}

async function loadFromDisk(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fsp.readFile(settingsFile(), 'utf8')) as unknown
    return settingsFromDisk(raw) // 逐项校验,坏字段回退默认值
  } catch {
    // 首次启动(或文件损坏按首启处理):迁移旧 toolchain.json 后落盘初始文件
    const legacy = await migrateLegacyToolchain()
    const { next } = applyPatch(SETTINGS_DEFAULTS, legacy)
    try {
      await persist(next)
    } catch {
      // 落盘失败不阻塞启动(只读文件系统等),内存态照常工作
    }
    return next
  }
}

/** 读取全量设置(带内存缓存;并发调用共享同一次磁盘读) */
export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached
  if (!loading) {
    loading = loadFromDisk().then((s) => {
      cached = s
      return s
    })
  }
  return loading
}

/** 同步读取(未加载完成时返回默认值;window-all-closed 等同步时机用) */
export function getSettingsSync(): AppSettings {
  return cached ?? SETTINGS_DEFAULTS
}

function broadcast(ev: SettingsChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', ev)
  }
}

/**
 * 写入 dot-path 补丁:校验 → 合并 → 落盘 → settings:changed 广播。
 * 未知键 / 非法值静默丢弃;无实际变化时不落盘不广播。返回最新全量设置。
 */
export async function setSettings(patch: Record<string, unknown>): Promise<AppSettings> {
  const base = await getSettings()
  const { next, changedKeys } = applyPatch(base, patch)
  if (changedKeys.length === 0) return base
  cached = next
  await persist(next)
  broadcast({ settings: next, changedKeys })
  return next
}

/** 全量重置为默认值(落盘 + 广播实际变化键) */
export async function resetSettings(): Promise<AppSettings> {
  const base = await getSettings()
  // 以「默认值对基线的差异」计算 changedKeys(与 setSettings 广播语义一致)
  const flat: Record<string, unknown> = {}
  for (const [section, sec] of Object.entries(SETTINGS_DEFAULTS)) {
    for (const [key, value] of Object.entries(sec as Record<string, unknown>)) {
      flat[`${section}.${key}`] = value
    }
  }
  const { next, changedKeys } = applyPatch(base, flat)
  if (changedKeys.length === 0) return base
  cached = next
  await persist(next)
  broadcast({ settings: next, changedKeys })
  return next
}

export function registerSettingsIpc(): void {
  // 全量读(renderer 启动镜像 / 设置窗口初始化)
  ipcMain.handle('settings:get-all', async (): Promise<AppSettings> => getSettings())

  // dot-path 补丁写入(设置窗口 Apply / 消费方快捷入口);返回最新全量设置
  ipcMain.handle(
    'settings:set-many',
    async (_e, patch: Record<string, unknown>): Promise<AppSettings> => {
      return setSettings(typeof patch === 'object' && patch !== null ? patch : {})
    }
  )

  // 重置为默认值
  ipcMain.handle('settings:reset', async (): Promise<AppSettings> => resetSettings())

  // 注册即预热缓存(getSettingsSync 的同步消费方尽早拿到真实值)
  void getSettings()
}
