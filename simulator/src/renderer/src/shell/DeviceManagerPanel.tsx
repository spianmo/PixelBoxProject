/**
 * 设备管理器工具窗(左轨道入口,类 AVD Manager)
 *
 * - 顶部工具行:「新建模拟器」按钮
 * - 表格列:名称 / 芯片 / 分辨率 / PSRAM / 操作(▶ 启动|⏹ 停止 · 编辑 · 复制 · 删除)
 * - 运行中的档案名称旁显示绿色指示点(AVD Manager 的 Running 语义)
 * - 内置默认档案「PixelBox S3」不可编辑/删除(可复制),行尾锁形提示
 * - 行点击 = 选为当前运行目标(与标题栏设备下拉、状态栏联动)
 * - ESP32-P4 档案在芯片列展示 hosted 提示(无片上 WiFi/BLE)
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCopy, LuInfo, LuLock, LuPencil, LuPlay, LuPlus, LuSquare, LuTrash2 } from 'react-icons/lu'
import type { DeviceProfile } from '../../../shared/ipc-types'
import { BUILTIN_PROFILE_ID, chipCapability } from '../../../shared/chipCapabilities'
import { closeSession, stopSession, useRunningSimKeys } from '../device-sim/sessions'
import {
  chipLabel,
  deleteDeviceProfile,
  saveDeviceProfile,
  shellDeviceStore,
  simDeviceKey,
  useDeviceProfiles,
  useShellDevices
} from './store'
import { openDeviceWizard } from './DeviceWizardModal'
import { ConfirmModal } from '../components/Modal'
import { showToast } from '../components/toast'

/** 行内小图标按钮(tone:▶ 启动绿 / ⏹ 停止红;缺省灰,danger 悬停变红) */
function RowButton(props: {
  title: string
  disabled?: boolean
  danger?: boolean
  tone?: 'green' | 'red'
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const toneCls =
    props.tone === 'green'
      ? 'text-green-500 hover:bg-ink-700 hover:text-green-400'
      : props.tone === 'red'
        ? 'text-red-400 hover:bg-ink-700 hover:text-red-300'
        : props.danger
          ? 'text-jb-muted hover:bg-ink-700 hover:text-red-400'
          : 'text-jb-muted hover:bg-ink-700 hover:text-jb-text'
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation() // 不触发行选中
        props.onClick()
      }}
      className={`flex h-5 w-5 items-center justify-center rounded text-[12px] ${
        props.disabled ? 'cursor-not-allowed text-ink-600' : toneCls
      }`}
    >
      {props.children}
    </button>
  )
}

interface Props {
  /** ▶ 启动:选中该档案并构建运行(App 的 handleRun 流程) */
  onLaunch: (p: DeviceProfile) => void
  /** 当前工程可否运行应用(§5 门控:app 工程与传统目录;false 时 ▶ 禁用) */
  canRun: boolean
  /** 构建进行中:全部 ▶ 置灰(与标题栏 ▶ 同源禁用态) */
  building: boolean
}

export function DeviceManagerPanel({ onLaunch, canRun, building }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { profiles } = useDeviceProfiles()
  const dev = useShellDevices()
  const runningKeys = useRunningSimKeys()
  const [deleting, setDeleting] = useState<DeviceProfile | null>(null)

  /** 复制档案:直接落一份「xxx 副本」 */
  const copyProfile = async (p: DeviceProfile): Promise<void> => {
    const err = await saveDeviceProfile({
      ...p,
      id: '', // 空 id = 新建
      name: `${p.name}${t('deviceManager.copySuffix')}`,
      createdAt: 0
    })
    if (err) showToast(t('deviceManager.errors.saveFailed'), 'error')
    else showToast(t('deviceManager.copied', { name: p.name }), 'success')
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    const err = await deleteDeviceProfile(deleting.id)
    if (err) {
      showToast(t('deviceManager.errors.deleteFailed'), 'error')
    } else {
      // 档案已不存在:连带关闭其模拟器会话(引擎停止 + tab 移除),
      // 否则会话成孤儿——表格行消失但设备仍在跑,管理器再无法控制它
      closeSession(simDeviceKey(deleting.id))
      showToast(t('deviceManager.deleted', { name: deleting.name }), 'success')
    }
    setDeleting(null)
  }

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {/* 工具行 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-2">
        <button
          onClick={() => openDeviceWizard()}
          className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-xs text-white hover:bg-accent-dim"
        >
          <LuPlus />
          {t('deviceManager.new')}
        </button>
        <span className="ml-auto text-[11px] text-ink-500">
          {t('deviceManager.count', { count: profiles.length })}
        </span>
      </div>

      {/* 表格 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          {/* 表头纵向 sticky;z-[2] 盖住数据行的横向 sticky 操作格(后者 DOM 在后,positioned 同级会盖前者) */}
          <thead className="sticky top-0 z-[2] bg-ink-850 text-jb-muted">
            <tr className="border-b border-ink-700 text-left">
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.name')}</th>
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.chip')}</th>
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.screen')}</th>
              <th className="px-2 py-1.5 font-medium">PSRAM</th>
              {/* 操作列横向固定(面板窄、表格横向滚动时恒在右缘);左缘 1px 分隔线用
                  inset shadow 画(border-collapse 下 border 不随 sticky 格移动) */}
              <th className="sticky right-0 bg-ink-850 px-2 py-1.5 text-right font-medium shadow-[inset_1px_0_0_0_rgb(var(--pb-border))]">
                {t('deviceManager.col.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const builtin = p.id === BUILTIN_PROFILE_ID
              const cap = chipCapability(p.chip)
              const key = simDeviceKey(p.id)
              const selected = dev.selectedKey === key
              const running = runningKeys.has(key)
              return (
                <tr
                  key={p.id}
                  onClick={() => shellDeviceStore.set({ selectedKey: key })}
                  title={p.note || undefined}
                  className={`group cursor-pointer border-b border-ink-700/50 ${
                    selected ? 'bg-jb-selection/70' : 'hover:bg-ink-800'
                  }`}
                >
                  <td className="max-w-[120px] truncate px-2 py-1.5 text-jb-text">
                    <span className="flex items-center gap-1">
                      {selected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      <span className="truncate">{p.name}</span>
                      {running && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
                          title={t('deviceManager.running')}
                        />
                      )}
                      {builtin && (
                        <LuLock
                          className="shrink-0 text-[10px] text-ink-500"
                          title={t('deviceManager.builtinHint')}
                        />
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-jb-muted">
                    <span className="flex items-center gap-1">
                      {chipLabel(p.chip)}
                      {cap.hintKey && (
                        <LuInfo
                          className="shrink-0 text-[10px] text-yellow-300/80"
                          title={t(`deviceManager.chipHint.${cap.hintKey}`)}
                        />
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-jb-muted">
                    {p.screenW}×{p.screenH}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-jb-muted">
                    {p.psramMB > 0 ? `${p.psramMB} MB` : t('deviceManager.wizard.psramNone')}
                  </td>
                  {/* 操作格横向固定:背景须不透明(下方滚过的内容不能透出),选中态用
                      color-mix 复刻「jb-selection/70 叠加编辑器底色」的等效实色(双主题成立),
                      悬停态经 tr 的 group 联动;左缘分隔线同表头 */}
                  <td
                    className={`sticky right-0 px-2 py-1.5 shadow-[inset_1px_0_0_0_rgb(var(--pb-border))] ${
                      selected
                        ? 'bg-[color-mix(in_srgb,rgb(var(--pb-selection))_70%,rgb(var(--pb-bg-editor)))]'
                        : 'bg-ink-900 group-hover:bg-ink-800'
                    }`}
                  >
                    <div className="flex items-center justify-end gap-0.5">
                      {/* ▶/⏹(AVD Manager 的启动列):运行中变停止;非可运行工程禁用 ▶ */}
                      {running ? (
                        <RowButton
                          title={t('deviceManager.stop')}
                          tone="red"
                          onClick={() => stopSession(key)}
                        >
                          <LuSquare className="fill-current text-[10px]" />
                        </RowButton>
                      ) : (
                        <RowButton
                          title={canRun ? t('deviceManager.launch') : t('deviceManager.launchUnavailable')}
                          disabled={!canRun || building}
                          tone="green"
                          onClick={() => onLaunch(p)}
                        >
                          <LuPlay className="fill-current" />
                        </RowButton>
                      )}
                      <RowButton
                        title={builtin ? t('deviceManager.builtinHint') : t('deviceManager.edit')}
                        disabled={builtin}
                        onClick={() => openDeviceWizard(p)}
                      >
                        <LuPencil />
                      </RowButton>
                      <RowButton title={t('deviceManager.copy')} onClick={() => void copyProfile(p)}>
                        <LuCopy />
                      </RowButton>
                      <RowButton
                        title={builtin ? t('deviceManager.builtinHint') : t('deviceManager.delete')}
                        disabled={builtin}
                        danger
                        onClick={() => setDeleting(p)}
                      >
                        <LuTrash2 />
                      </RowButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 删除确认 */}
      {deleting && (
        <ConfirmModal
          message={t('deviceManager.deleteConfirm', { name: deleting.name })}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
