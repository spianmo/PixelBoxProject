/**
 * 文件类型 → 图标映射(文件树 / 编辑器标签 / 快速打开 ⌘P 三处统一入口)
 *
 * - fileIconFor(name):按文件名(特殊名优先,其次扩展名)返回 16×16 图标
 * - FolderIcon:目录图标(闭合/展开/根项目)
 * 图标绘制见 ./icons.tsx(手绘 SVG,贴近 JetBrains 线性风格)
 */
import {
  CIcon,
  CmakeIcon,
  CppIcon,
  CssIcon,
  CsvIcon,
  DefaultFileIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  FolderRootIcon,
  GitFileIcon,
  HIcon,
  HtmlIcon,
  ImageIcon,
  JsIcon,
  JsonIcon,
  JsxIcon,
  MdIcon,
  ShIcon,
  TsIcon,
  TsxIcon,
  TxtIcon,
  YamlIcon
} from './icons'

interface FolderIconProps {
  /** 是否展开 */
  open?: boolean
  /** 根项目文件夹(带徽标) */
  root?: boolean
  size?: number
  className?: string
}

export function FolderIcon({ open, root, size, className }: FolderIconProps): React.JSX.Element {
  if (root) return <FolderRootIcon size={size} className={className} />
  return open ? (
    <FolderOpenIcon size={size} className={className} />
  ) : (
    <FolderClosedIcon size={size} className={className} />
  )
}

/** 图片扩展名(紫色山形图) */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

/** 按扩展名映射(小写,不含点) */
function byExt(ext: string, size?: number): React.JSX.Element | null {
  if (IMAGE_EXTS.has(ext)) return <ImageIcon size={size} />
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return <TsIcon size={size} />
    case 'js':
    case 'mjs':
    case 'cjs':
      return <JsIcon size={size} />
    case 'tsx':
      return <TsxIcon size={size} />
    case 'jsx':
      return <JsxIcon size={size} />
    case 'md':
    case 'markdown':
      return <MdIcon size={size} />
    case 'json':
    case 'jsonc':
      return <JsonIcon size={size} />
    case 'html':
    case 'htm':
      return <HtmlIcon size={size} />
    case 'css':
      return <CssIcon size={size} />
    case 'sh':
    case 'bash':
    case 'zsh':
      return <ShIcon size={size} />
    case 'yml':
    case 'yaml':
      return <YamlIcon size={size} />
    case 'csv':
    case 'tsv':
      return <CsvIcon size={size} />
    case 'c':
      return <CIcon size={size} />
    case 'cpp':
    case 'cc':
    case 'cxx':
      return <CppIcon size={size} />
    case 'h':
    case 'hpp':
      return <HIcon size={size} />
    case 'cmake':
      return <CmakeIcon size={size} />
    case 'txt':
    case 'log':
      return <TxtIcon size={size} />
    default:
      return null
  }
}

/** 文件名 → 图标(特殊文件名优先于扩展名,如 CMakeLists.txt / .gitignore) */
export function fileIconFor(name: string, size?: number): React.JSX.Element {
  const n = name.toLowerCase()
  // 特殊文件名(注意 CMakeLists.txt 以 .txt 结尾,须先于扩展名判断)
  if (n === 'cmakelists.txt') return <CmakeIcon size={size} />
  if (n === '.gitignore' || n === '.gitattributes' || n === '.gitmodules') return <GitFileIcon size={size} />
  const dot = n.lastIndexOf('.')
  const ext = dot >= 0 ? n.slice(dot + 1) : ''
  return byExt(ext, size) ?? <DefaultFileIcon size={size} />
}
