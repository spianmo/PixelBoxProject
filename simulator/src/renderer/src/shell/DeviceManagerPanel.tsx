/**
 * 设备管理器工具窗(左轨道入口,类 AVD Manager)
 *
 * - 顶部工具行:「新建模拟器」按钮
 * - 表格列:名称 / 芯片 / 分辨率 / PSRAM / 操作(编辑 · 复制 · 删除)
 * - 内置默认档案「PixelBox S3」不可编辑/删除(可复制),行尾锁形提示
 * - 行点击 = 选为当前运行目标(与标题栏设备下拉、状态栏联动)
 * - ESP32-P4 档案在芯片列展示 hosted 提示(无片上 WiFi/BLE)
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCopy, LuInfo, LuLock, LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu'
import type { DeviceProfile } from '../../../shared/ipc-types'
import { BUILTIN_PROFILE_ID, chipCapability } from '../../../shared/chipCapabilities'
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

/** 行内小图标按钮 */
function RowButton(props: {
  title: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation() // 不触发行选中
        props.onClick()
      }}
      className={`flex h-5 w-5 items-center justify-center rounded text-[12px] ${
        props.disabled
          ? 'cursor-not-allowed text-ink-600'
          : props.danger
            ? 'text-jb-muted hover:bg-ink-700 hover:text-red-400'
            : 'text-jb-muted hover:bg-ink-700 hover:text-jb-text'
      }`}
    >
      {props.children}
    </button>
  )
}

export function DeviceManagerPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { profiles } = useDeviceProfiles()
  const dev = useShellDevices()
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
    else showToast(t('deviceManager.copied', { name: p.name }), 'info', 2000)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    const err = await deleteDeviceProfile(deleting.id)
    if (err) showToast(t('deviceManager.errors.deleteFailed'), 'error')
    else showToast(t('deviceManager.deleted', { name: deleting.name }), 'info', 2000)
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
          <thead className="sticky top-0 bg-ink-850 text-jb-muted">
            <tr className="border-b border-ink-700 text-left">
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.name')}</th>
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.chip')}</th>
              <th className="px-2 py-1.5 font-medium">{t('deviceManager.col.screen')}</th>
              <th className="px-2 py-1.5 font-medium">PSRAM</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('deviceManager.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const builtin = p.id === BUILTIN_PROFILE_ID
              const cap = chipCapability(p.chip)
              const key = simDeviceKey(p.id)
              const selected = dev.selectedKey === key
              return (
                <tr
                  key={p.id}
                  onClick={() => shellDeviceStore.set({ selectedKey: key })}
                  title={p.note || undefined}
                  className={`cursor-pointer border-b border-ink-700/50 ${
                    selected ? 'bg-jb-selection/70' : 'hover:bg-ink-800'
                  }`}
                >
                  <td className="max-w-[120px] truncate px-2 py-1.5 text-jb-text">
                    <span className="flex items-center gap-1">
                      {selected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      <span className="truncate">{p.name}</span>
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
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-0.5">
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
