/**
 * 文件类型图标集(手绘 16×16 SVG,风格贴近 JetBrains 线性图标,未拷贝其资产)
 *
 * 约定:
 * - viewBox 统一 0 0 16 16,描边 1.2px、圆角端点/拐角(linecap/linejoin round)
 * - 语言方块类(TS/JS/C/C++/H)为品牌色圆角方块 + 粗体字母
 * - 文档类共用「折角纸张」轮廓 + 类型色内容线
 * - 字形/描边色经 CSS 变量承载(--pb-fi-*,深浅两组值见 assets/main.css):
 *   dark 与 v2.3 观感一致,light 档加深保白底辨识,主题切换零 JS 即时跟随;
 *   语言方块的徽标底 + 徽标内文字为品牌色,两主题保持静态
 */

// ---- 公共色板(字形/描边:主题变量;徽标:静态品牌色) ----
const GRAY = 'var(--pb-fi-gray)'
const DIM = 'var(--pb-fi-dim)'
const BLUE = 'var(--pb-fi-blue)'
const YELLOW = 'var(--pb-fi-yellow)'
const GREEN = 'var(--pb-fi-green)'
const ORANGE = 'var(--pb-fi-orange)'
const PURPLE = 'var(--pb-fi-purple)'
const CYAN = 'var(--pb-fi-cyan)'
const FOLDER = 'var(--pb-fi-folder)' // 文件夹灰蓝描边
/** 语言方块徽标底(静态品牌色,徽标内深色文字两主题对比不变) */
const BADGE_YELLOW = '#E2C55A'
const BADGE_PURPLE = '#B387D7'
/** 徽标内文字深色(非主题色:徽标底静态,文字对比恒定) */
const DARK = '#1E1F22'
/** 根项目徽标底衬(镂空模拟:同文件树面板背景,随主题) */
const CUTOUT = 'rgb(var(--pb-bg-editor))'

const FONT = 'ui-sans-serif, system-ui, sans-serif'

interface IconProps {
  size?: number
  className?: string
}

/** svg 外框(统一尺寸与 class) */
function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className ?? 'shrink-0'}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 折角纸张轮廓(文档类共用底) */
function Sheet({ color = GRAY }: { color?: string }): React.JSX.Element {
  return (
    <>
      <path
        d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 1.75v3.5h3.5" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </>
  )
}

/** 语言方块(圆角色块 + 粗体字母) */
function Badge({
  bg,
  fg,
  label,
  fontSize = 7,
  ...p
}: IconProps & { bg: string; fg: string; label: string; fontSize?: number }): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill={bg} />
      <text
        x="8"
        y="11"
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight="700"
        fontFamily={FONT}
        fill={fg}
      >
        {label}
      </text>
    </Svg>
  )
}

// ---------------------------------------------------------------
// 文件夹
// ---------------------------------------------------------------

/** 闭合文件夹(灰蓝描边、圆角、带页签折角) */
export function FolderClosedIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path
        d="M1.75 4.25a1 1 0 0 1 1-1h3.31a1 1 0 0 1 .77.36l1.07 1.28h5.35a1 1 0 0 1 1 1v6.86a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1V4.25Z"
        stroke={FOLDER}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** 展开文件夹(前盖斜开) */
export function FolderOpenIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path
        d="M1.75 12.5V4.25a1 1 0 0 1 1-1h3.31a1 1 0 0 1 .77.36l1.07 1.28h5.35a1 1 0 0 1 1 1v.86"
        stroke={FOLDER}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.4 6.75h9.42a.9.9 0 0 1 .87 1.13l-1.2 4.5a.9.9 0 0 1-.87.67H3.05a.9.9 0 0 1-.87-1.13l1.35-5.17Z"
        stroke={FOLDER}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** 根项目文件夹(闭合文件夹 + 右下角强调蓝小徽标) */
export function FolderRootIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path
        d="M1.75 4.25a1 1 0 0 1 1-1h3.31a1 1 0 0 1 .77.36l1.07 1.28h5.35a1 1 0 0 1 1 1v6.86a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1V4.25Z"
        stroke={FOLDER}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* 徽标底衬(镂空)+ 强调蓝方块 */}
      <rect x="8.4" y="7.9" width="7" height="7" rx="2" fill={CUTOUT} />
      <rect x="9.65" y="9.15" width="4.5" height="4.5" rx="1.2" fill={BLUE} />
    </Svg>
  )
}

// ---------------------------------------------------------------
// 语言方块类
// ---------------------------------------------------------------

export function TsIcon(p: IconProps): React.JSX.Element {
  return <Badge bg="#3178C6" fg="#FFFFFF" label="TS" {...p} />
}

export function JsIcon(p: IconProps): React.JSX.Element {
  return <Badge bg={BADGE_YELLOW} fg={DARK} label="JS" {...p} />
}

export function CIcon(p: IconProps): React.JSX.Element {
  return <Badge bg={BADGE_PURPLE} fg={DARK} label="C" {...p} />
}

export function CppIcon(p: IconProps): React.JSX.Element {
  return <Badge bg={BADGE_PURPLE} fg={DARK} label="C++" fontSize={6} {...p} />
}

export function HIcon(p: IconProps): React.JSX.Element {
  return <Badge bg={BADGE_PURPLE} fg={DARK} label="H" {...p} />
}

/** React 组件(⚛ 原子轨道):tsx 蓝 / jsx 黄 */
function AtomIcon({ color, ...p }: IconProps & { color: string }): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="1.35" fill={color} />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.5" stroke={color} strokeWidth="1.1" />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.5" stroke={color} strokeWidth="1.1" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.5" stroke={color} strokeWidth="1.1" transform="rotate(-60 8 8)" />
    </Svg>
  )
}

export function TsxIcon(p: IconProps): React.JSX.Element {
  return <AtomIcon color={BLUE} {...p} />
}

export function JsxIcon(p: IconProps): React.JSX.Element {
  return <AtomIcon color={YELLOW} {...p} />
}

// ---------------------------------------------------------------
// 字形类(无纸张底)
// ---------------------------------------------------------------

/** Markdown:蓝色 "M↓" */
export function MdIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <text x="1.4" y="11.6" fontSize="9.5" fontWeight="700" fontFamily={FONT} fill={BLUE}>
        M
      </text>
      <path d="M12.1 4.9v5.4" stroke={BLUE} strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="m9.9 8.4 2.2 2.2 2.2-2.2"
        stroke={BLUE}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** JSON:黄色花括号 */
export function JsonIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path
        d="M6.1 2.4c-1.35 0-2 .65-2 2v1.5c0 .95-.4 1.5-1.35 1.75v.7C3.7 8.6 4.1 9.15 4.1 10.1v1.5c0 1.35.65 2 2 2"
        stroke={YELLOW}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9.9 2.4c1.35 0 2 .65 2 2v1.5c0 .95.4 1.5 1.35 1.75v.7c-.95.25-1.35.8-1.35 1.75v1.5c0 1.35-.65 2-2 2"
        stroke={YELLOW}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </Svg>
  )
}

/** HTML:橙色 </> */
export function HtmlIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5.2 5 2.4 8l2.8 3" stroke={ORANGE} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m10.8 5 2.8 3-2.8 3" stroke={ORANGE} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3.6 7 12.4" stroke={ORANGE} strokeWidth="1.3" strokeLinecap="round" />
    </Svg>
  )
}

/** CSS:蓝色 # */
export function CssIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.5 3.5 5.3 12.5M10.9 3.5 9.7 12.5" stroke={BLUE} strokeWidth="1.25" strokeLinecap="round" />
      <path d="M3.9 6.4h8.8M3.4 9.6h8.8" stroke={BLUE} strokeWidth="1.25" strokeLinecap="round" />
    </Svg>
  )
}

/** 图片(png/jpg/gif/svg/webp):紫色相框 + 山形 + 太阳 */
export function ImageIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" stroke={PURPLE} strokeWidth="1.2" />
      <circle cx="5.7" cy="6.1" r="1.05" fill={PURPLE} />
      <path
        d="m3.6 11.4 2.9-3.1 2.1 2.2 1.9-2 2.9 2.9"
        stroke={PURPLE}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** git 配置(.gitignore/.gitattributes):灰色 ⊘ */
export function GitFileIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.4" stroke={GRAY} strokeWidth="1.2" />
      <path d="M4.2 11.8 11.8 4.2" stroke={GRAY} strokeWidth="1.2" strokeLinecap="round" />
    </Svg>
  )
}

/** Shell 脚本:绿色终端 >_ */
export function ShIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" stroke={GREEN} strokeWidth="1.2" />
      <path d="m4.4 6 2.1 2-2.1 2" stroke={GREEN} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.4 10.4h3.2" stroke={GREEN} strokeWidth="1.2" strokeLinecap="round" />
    </Svg>
  )
}

/** CMake:三角轮廓 + 强调蓝方块(仅形似,不复刻其 logo) */
export function CmakeIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 2.4 14 13.4H2L8 2.4Z" stroke={GRAY} strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="6.9" y="9" width="2.7" height="2.7" fill={BLUE} />
    </Svg>
  )
}

// ---------------------------------------------------------------
// 纸张底文档类
// ---------------------------------------------------------------

/** YAML:纸张 + 青色缩进键值线 */
export function YamlIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <Sheet />
      <path
        d="M5.4 7.6h3M6.8 9.6h3.6M5.4 11.6h4.4"
        stroke={CYAN}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </Svg>
  )
}

/** CSV:绿色表格 */
export function CsvIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" stroke={GREEN} strokeWidth="1.2" />
      <path d="M2.25 6.25h11.5M2.25 9.75h11.5" stroke={GREEN} strokeWidth="1.1" />
      <path d="M6.1 2.75v10.5M9.9 2.75v10.5" stroke={GREEN} strokeWidth="1.1" />
    </Svg>
  )
}

/** 纯文本:纸张 + 灰色内容线 */
export function TxtIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <Sheet />
      <path d="M5.4 8h5.2M5.4 10h5.2M5.4 12h3.4" stroke={DIM} strokeWidth="1.2" strokeLinecap="round" />
    </Svg>
  )
}

/** 默认文件:纯纸张轮廓 */
export function DefaultFileIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <Sheet />
    </Svg>
  )
}
