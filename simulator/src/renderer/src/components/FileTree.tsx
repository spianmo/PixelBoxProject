/**
 * 工作区文件树
 * - 惰性展开:展开目录时才 readDir
 * - chokidar 事件驱动刷新(仅刷新受影响的已加载目录)
 * - 右键菜单:新建文件/文件夹、重命名、删除
 * - 打开且未保存的文件显示修改状态点
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc'
import type { FsEntry } from '../../../shared/ipc-types'
import { FolderIcon, fileIconFor } from './fileIcons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { InputModal, ConfirmModal } from './Modal'
import { showToast } from './toast'

interface Props {
  root: string
  /** 双击/单击文件打开 */
  onOpenFile: (path: string) => void
  /** 未保存文件集合(显示修改点) */
  dirtyPaths: ReadonlySet<string>
  /** 文件被删除/重命名时通知上层(关闭对应标签) */
  onFileRemoved: (path: string) => void
  /** 当前激活文件(选中行高亮) */
  activePath?: string | null
}

interface MenuState {
  x: number
  y: number
  target: FsEntry | null // null = 根目录空白区
}

type ModalState =
  | { kind: 'newFile' | 'newFolder'; dir: string }
  | { kind: 'rename'; entry: FsEntry }
  | { kind: 'delete'; entry: FsEntry }
  | null

/** 条目图标(fileIcons 图标集:目录=灰蓝文件夹,文件按类型) */
function iconFor(entry: FsEntry, expanded: boolean): React.JSX.Element {
  if (entry.isDir) return <FolderIcon open={expanded} />
  return fileIconFor(entry.name)
}

/** 取绝对路径的父目录(与 main 进程同为 POSIX/Win 兼容:按最后一个分隔符截断) */
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function FileTree({ root, onOpenFile, dirtyPaths, onFileRemoved, activePath }: Props): React.JSX.Element {
  const { t } = useTranslation()
  // 已加载目录 → 子项
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [modal, setModal] = useState<ModalState>(null)

  const loadDir = useCallback(async (dir: string): Promise<void> => {
    try {
      const entries = await window.api.readDir(dir)
      setChildren((prev) => {
        const next = new Map(prev)
        next.set(dir, entries)
        return next
      })
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err), 'error')
    }
  }, [])

  // 根目录初次加载
  useEffect(() => {
    setChildren(new Map())
    setExpanded(new Set([root]))
    void loadDir(root)
  }, [root, loadDir])

  // 文件系统变更 → 刷新受影响的已加载目录
  useEffect(() => {
    return window.api.onFsEvent((ev) => {
      const dir = parentDir(ev.path)
      setChildren((prev) => {
        if (prev.has(dir)) void loadDir(dir)
        return prev
      })
      if (ev.type === 'unlink') onFileRemoved(ev.path)
    })
  }, [loadDir, onFileRemoved])

  const toggleDir = (entry: FsEntry): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
        if (!children.has(entry.path)) void loadDir(entry.path)
      }
      return next
    })
  }

  const menuItems = (state: MenuState): MenuItem[] => {
    const targetDir = state.target ? (state.target.isDir ? state.target.path : parentDir(state.target.path)) : root
    const items: MenuItem[] = [
      { label: t('fileTree.newFile'), onClick: () => setModal({ kind: 'newFile', dir: targetDir }) },
      { label: t('fileTree.newFolder'), onClick: () => setModal({ kind: 'newFolder', dir: targetDir }) }
    ]
    if (state.target) {
      const entry = state.target
      items.push(
        { label: t('fileTree.rename'), onClick: () => setModal({ kind: 'rename', entry }) },
        { label: t('fileTree.delete'), danger: true, onClick: () => setModal({ kind: 'delete', entry }) }
      )
    }
    return items
  }

  const handleModalConfirm = async (value?: string): Promise<void> => {
    if (!modal) return
    try {
      if (modal.kind === 'newFile' && value) {
        await window.api.createFile(joinPath(modal.dir, value))
        await loadDir(modal.dir)
        setExpanded((prev) => new Set(prev).add(modal.dir))
      } else if (modal.kind === 'newFolder' && value) {
        await window.api.mkdir(joinPath(modal.dir, value))
        await loadDir(modal.dir)
        setExpanded((prev) => new Set(prev).add(modal.dir))
      } else if (modal.kind === 'rename' && value) {
        const dir = parentDir(modal.entry.path)
        await window.api.rename(modal.entry.path, joinPath(dir, value))
        onFileRemoved(modal.entry.path)
        await loadDir(dir)
      } else if (modal.kind === 'delete') {
        await window.api.remove(modal.entry.path)
        onFileRemoved(modal.entry.path)
        await loadDir(parentDir(modal.entry.path))
      }
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err), 'error')
    } finally {
      setModal(null)
    }
  }

  const renderDir = (dir: string, depth: number): React.JSX.Element[] => {
    const entries = children.get(dir) ?? []
    return entries.flatMap((entry) => {
      const isExpanded = entry.isDir && expanded.has(entry.path)
      const isActive = !entry.isDir && entry.path === activePath
      const row = (
        <div
          key={entry.path}
          style={{ paddingLeft: depth * 14 + 6 }}
          className={`group flex h-6 cursor-pointer items-center gap-1.5 pr-2 text-[13px] ${
            isActive ? 'bg-jb-selection text-jb-text' : 'text-jb-text hover:bg-ink-800'
          }`}
          onClick={() => (entry.isDir ? toggleDir(entry) : onOpenFile(entry.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, target: entry })
          }}
        >
          {entry.isDir ? (
            isExpanded ? (
              <VscChevronDown className="shrink-0 text-gray-500" />
            ) : (
              <VscChevronRight className="shrink-0 text-gray-500" />
            )
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {iconFor(entry, isExpanded)}
          <span className="truncate">{entry.name}</span>
          {!entry.isDir && dirtyPaths.has(entry.path) && (
            <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-accent" title={t('editor.unsaved')} />
          )}
        </div>
      )
      return isExpanded ? [row, ...renderDir(entry.path, depth + 1)] : [row]
    })
  }

  // 根项目行(JetBrains 风格:项目名 + 带徽标的根文件夹图标,可整体折叠)
  const rootExpanded = expanded.has(root)
  const toggleRoot = (): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  }

  return (
    <div
      className="h-full overflow-auto py-1"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, target: null })
      }}
    >
      <div
        className="flex h-6 cursor-pointer items-center gap-1.5 pl-1.5 pr-2 text-[13px] font-medium text-jb-text hover:bg-ink-800"
        onClick={toggleRoot}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY, target: null })
        }}
      >
        {rootExpanded ? (
          <VscChevronDown className="shrink-0 text-gray-500" />
        ) : (
          <VscChevronRight className="shrink-0 text-gray-500" />
        )}
        <FolderIcon root />
        <span className="truncate">{baseName(root)}</span>
      </div>
      {rootExpanded && renderDir(root, 1)}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}

      {modal && modal.kind !== 'delete' && (
        <InputModal
          title={
            modal.kind === 'newFile'
              ? t('fileTree.newFileTitle')
              : modal.kind === 'newFolder'
                ? t('fileTree.newFolderTitle')
                : t('fileTree.renameTitle')
          }
          placeholder={t('fileTree.namePlaceholder')}
          initialValue={modal.kind === 'rename' ? modal.entry.name : ''}
          onConfirm={(v) => void handleModalConfirm(v)}
          onCancel={() => setModal(null)}
        />
      )}
      {modal && modal.kind === 'delete' && (
        <ConfirmModal
          message={t('fileTree.deleteConfirm', { name: modal.entry.name })}
          onConfirm={() => void handleModalConfirm()}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
