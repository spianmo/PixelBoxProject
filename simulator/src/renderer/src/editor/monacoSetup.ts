/**
 * Monaco 环境初始化
 * - worker 经 Rspack 原生 `new Worker(new URL(...))` 语法打入本地(离线可用;
 *   构建期静态分析拆出独立 worker chunk,dev/prod 均从本地加载)
 * - TS/JS 语言服务开启,注入 sdk/types/pixelbox.d.ts(?raw 随构建打入)
 *   使 px / pixelbox 全 API 具备补全与 hover
 * - 固件工程语言:C/C++/ini 走 monaco 内置 basic-languages(全量 'monaco-editor'
 *   入口已包含全部 contribution);CMake 无内置支持,此处自定义 Monarch 注册
 */
import * as monaco from 'monaco-editor'
// 唯一契约文件:整个仓库的设备 API 类型(禁止修改,只读注入)
import pixelboxDts from '../../../../../sdk/types/pixelbox.d.ts?raw'
import { getEffectiveTheme, subscribeTheme } from '../theme'
import { registerOpenscadLanguage } from './openscadLanguage'

let initialized = false

/** 有效主题 → Monaco 主题名(pixelbox-dark / pixelbox-light 成对定义) */
export function monacoThemeName(): string {
  return getEffectiveTheme() === 'light' ? 'pixelbox-light' : 'pixelbox-dark'
}

/** 自定义主题(深浅成对):对齐 IDE 外壳的 JetBrains 色板,token 规则一一对称 */
function definePixelboxTheme(): void {
  monaco.editor.defineTheme('pixelbox-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // token 配色贴近 JetBrains Darcula(New UI)
      { token: 'comment', foreground: '7A7E85' },
      { token: 'keyword', foreground: 'CF8E6D' },
      { token: 'string', foreground: '6AAB73' },
      { token: 'number', foreground: '2AACB8' },
      { token: 'regexp', foreground: '42C3D4' },
      { token: 'type.identifier', foreground: 'C77DBB' },
      { token: 'delimiter', foreground: 'BCBEC4' }
    ],
    colors: {
      'editor.background': '#1E1F22',
      'editor.foreground': '#DFE1E5',
      'editorLineNumber.foreground': '#4E5157',
      'editorLineNumber.activeForeground': '#A1A3AB',
      'editor.lineHighlightBackground': '#26282E',
      'editor.selectionBackground': '#2E436E',
      'editor.inactiveSelectionBackground': '#2E436E66',
      'editorCursor.foreground': '#CED0D6',
      'editorIndentGuide.background1': '#313438',
      'editorIndentGuide.activeBackground1': '#4E5157',
      'editorWidget.background': '#2B2D30',
      'editorWidget.border': '#393B40',
      'editorSuggestWidget.background': '#2B2D30',
      'editorSuggestWidget.border': '#393B40',
      'editorSuggestWidget.selectedBackground': '#2E436E',
      'editorHoverWidget.background': '#2B2D30',
      'editorHoverWidget.border': '#393B40',
      'scrollbarSlider.background': '#393B4080',
      'scrollbarSlider.hoverBackground': '#4B4E54A0',
      'scrollbarSlider.activeBackground': '#4B4E54C0',
      'editorGutter.background': '#1E1F22',
      'minimap.background': '#1E1F22'
    }
  })

  // 亮色:vs 基底微调,token 规则与暗色一一对称(IntelliJ Light 语法惯例)
  monaco.editor.defineTheme('pixelbox-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8C8C8C' },
      { token: 'keyword', foreground: '0033B3' },
      { token: 'string', foreground: '067D17' },
      { token: 'number', foreground: '1750EB' },
      { token: 'regexp', foreground: '264EFF' },
      { token: 'type.identifier', foreground: '871094' },
      { token: 'delimiter', foreground: '27282E' }
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#27282E',
      'editorLineNumber.foreground': '#ADB1BA',
      'editorLineNumber.activeForeground': '#6C707E',
      'editor.lineHighlightBackground': '#F2F5F9',
      'editor.selectionBackground': '#D4E2FF',
      'editor.inactiveSelectionBackground': '#D4E2FF80',
      'editorCursor.foreground': '#27282E',
      'editorIndentGuide.background1': '#EBECF0',
      'editorIndentGuide.activeBackground1': '#D3D5DB',
      'editorWidget.background': '#F7F8FA',
      'editorWidget.border': '#EBECF0',
      'editorSuggestWidget.background': '#FFFFFF',
      'editorSuggestWidget.border': '#EBECF0',
      'editorSuggestWidget.selectedBackground': '#D4E2FF',
      'editorHoverWidget.background': '#F7F8FA',
      'editorHoverWidget.border': '#EBECF0',
      'scrollbarSlider.background': '#D3D5DB80',
      'scrollbarSlider.hoverBackground': '#B8BCC4A0',
      'scrollbarSlider.activeBackground': '#B8BCC4C0',
      'editorGutter.background': '#FFFFFF',
      'minimap.background': '#FFFFFF'
    }
  })
}

/**
 * 注册 CMake 语言(Monaco 无内置 cmake basic-language,此处自定义 Monarch 分词)
 * - 命令词判定:标识符后跟 '('(CMake 命令仅出现在语句首,宽松匹配已足够)
 * - CMake 命令大小写不敏感,但不能开 Monarch 的 ignoreCase(会连带使全大写常量
 *   规则失效),改为关键词表小写维护 + 叠加全大写变体,覆盖两种主流书写惯例
 * - ${VAR} 变量引用用独立状态实现,支持嵌套(如 ${${prefix}_SRCS});
 *   全部规则均为线性匹配,无嵌套回溯风险
 */
function registerCMakeLanguage(): void {
  monaco.languages.register({
    id: 'cmake',
    extensions: ['.cmake'],
    filenames: ['CMakeLists.txt']
  })

  monaco.languages.setLanguageConfiguration('cmake', {
    comments: { lineComment: '#' },
    brackets: [
      ['(', ')'],
      ['[', ']']
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] }
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' }
    ]
  })

  // 流程控制关键词(keyword.control)
  const flowKeywords = [
    'if',
    'elseif',
    'else',
    'endif',
    'foreach',
    'endforeach',
    'while',
    'endwhile',
    'function',
    'endfunction',
    'macro',
    'endmacro'
  ]
  // 高频命令(keyword.control):CMake 官方命令 + ESP-IDF 的 idf_component_register
  const commonCommands = [
    'cmake_minimum_required',
    'project',
    'add_executable',
    'add_library',
    'target_link_libraries',
    'target_include_directories',
    'set',
    'include',
    'idf_component_register',
    'add_subdirectory',
    'message',
    'option',
    'list',
    'string',
    'file',
    'install'
  ]
  const withUpper = (words: string[]): string[] => [...words, ...words.map((w) => w.toUpperCase())]

  monaco.languages.setMonarchTokensProvider('cmake', {
    defaultToken: '',
    flowKeywords: withUpper(flowKeywords),
    commonCommands: withUpper(commonCommands),
    brackets: [
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
      { open: '[', close: ']', token: 'delimiter.square' }
    ],
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        // 命令调用:标识符后跟 '(';不在两张关键词表内的按普通 keyword 着色
        [
          /[A-Za-z_]\w*(?=[ \t]*\()/,
          {
            cases: {
              '@flowKeywords': 'keyword.control',
              '@commonCommands': 'keyword.control',
              '@default': 'keyword'
            }
          }
        ],
        [/\$\{/, { token: 'variable', next: '@variable' }],
        [/"/, { token: 'string.quote', next: '@string' }],
        [/\d+(\.\d+)*/, 'number'],
        // 标识符统一匹配后按形态分流:全大写按 CMake 惯例视为常量/标志位
        // (如 PUBLIC REQUIRED STATUS);$0~ 守卫两端锚定整词比对,无前瞻回溯
        [
          /[A-Za-z_][\w\-.]*/,
          {
            cases: {
              '$0~[A-Z_][A-Z0-9_]*': 'constant',
              '@default': 'identifier'
            }
          }
        ],
        [/[()[\]]/, '@brackets'],
        [/[ \t\r\n]+/, 'white']
      ],
      // 双引号字符串:支持 ${VAR} 插值与 \ 转义
      string: [
        [/\$\{/, { token: 'variable', next: '@variable' }],
        [/[^"\\$]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }],
        [/\$/, 'string']
      ],
      // ${...} 变量引用:遇 ${ 递归进入自身以支持嵌套
      variable: [
        [/\$\{/, { token: 'variable', next: '@variable' }],
        [/\}/, { token: 'variable', next: '@pop' }],
        [/[^${}]+/, 'variable'],
        [/\$/, 'variable']
      ]
    }
  } as monaco.languages.IMonarchLanguage)
}

// ---------------------------------------------------------------
// 跨文件定义跳转(⌘+点击 / F12)落地
// ---------------------------------------------------------------
// standalone Monaco 的 StandaloneCodeEditorService.findModel 对「目标 uri ≠ 当前
// model uri」一律返回 null 并静默放弃 —— 不注册 opener 时任何跨文件跳转(包括
// design/ 兄弟文件之间)都无响应。setupMonaco 注册的 opener 统一接管:真实文件
// 转交 App 走常规页签;extraLib 虚拟库(file:///node_modules/...)取注册内容开
// 只读页签。回调由 App 挂载(setEditorOpenHandler),避免本模块反向依赖 UI。

export interface EditorOpenRequest {
  /** 目标:真实文件为绝对 fs 路径;虚拟库为 uri.path(/node_modules/...) */
  path: string
  /** 是否 extraLib 虚拟库(无对应磁盘文件,须以 content 开只读页签) */
  virtual: boolean
  /** 虚拟库的声明文本(extraLib 注册内容) */
  content?: string
  line?: number
  column?: number
}

let editorOpenHandler: ((req: EditorOpenRequest) => void) | null = null

/** App 挂载页签打开回调(卸载时传 null);opener 拿不到回调时保持默认静默 */
export function setEditorOpenHandler(fn: ((req: EditorOpenRequest) => void) | null): void {
  editorOpenHandler = fn
}

export function setupMonaco(): void {
  if (initialized) return
  initialized = true

  definePixelboxTheme()
  registerCMakeLanguage()
  registerOpenscadLanguage() // 硬件工程 design/enclosure.scad(高亮/补全/hover)

  // 主题热切换:setTheme 全局生效(全部编辑器实例),订阅有效主题即时跟随,无需重启
  monaco.editor.setTheme(monacoThemeName())
  subscribeTheme(() => monaco.editor.setTheme(monacoThemeName()))

  // 代码字体 JetBrains Mono 经 @fontsource 异步加载(woff2):字体就绪后让 Monaco
  // 重新量字,避免编辑器先以回退字体测宽导致光标/选区错位(load 对已就绪字体立即 resolve)
  try {
    void document.fonts
      .load('13px "JetBrains Mono"')
      .then(() => monaco.editor.remeasureFonts())
      .catch(() => undefined)
  } catch {
    // FontFaceSet 不可用的环境(理论上 Chromium 恒有):跳过,回退字体链兜底
  }

  // Rspack 要求 `new Worker(new URL(...))` 为字面量形态才能静态建 worker chunk,
  // 故每个分支各写一遍(不可抽公共函数变量化 URL)
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new Worker(
            new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url)
          )
        case 'css':
        case 'scss':
        case 'less':
          return new Worker(
            new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url)
          )
        case 'html':
        case 'handlebars':
        case 'razor':
          return new Worker(
            new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url)
          )
        case 'typescript':
        case 'javascript':
          return new Worker(
            new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url)
          )
        default:
          return new Worker(
            new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url)
          )
      }
    }
  }

  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    // 设备运行时无 DOM,仅 ES 标准库 + pixelbox.d.ts
    lib: ['es2020'],
    // 硬件设计工程 design/*.tsx(tscircuit):启用 JSX 检查。选 ReactJSX 而非
    // Preserve/React(classic):@tscircuit/core 的 IntrinsicElements 经
    // `declare module "react/jsx-runtime"` 扩充声明,ReactJSX 自动解析该模块取
    // JSX 命名空间,设计文件无需 import React(classic 模式反而要求 React 在
    // 作用域内);类型桩与 d.ts 由 tscircuitTypes.ts 惰性注入(冒烟实证:元素/
    // 属性补全 + 脚手架模板零错误)。对纯 .ts 文件此选项无效果,应用工程不受影响
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    // @tscircuit/core d.ts 含 `import react__default from 'react'`(其编译目标
    // @types/react 是 export= 风格):放行合成默认导入,避免该 d.ts 内部报错降级
    allowSyntheticDefaultImports: true,
    strict: true,
    allowNonTsExtensions: true,
    allowJs: true,
    noEmit: true
  }
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)

  // 注入设备 API 契约 → px 全量补全 / hover
  const dtsUri = 'file:///node_modules/@pixelbox/types/pixelbox.d.ts'
  monaco.languages.typescript.typescriptDefaults.addExtraLib(pixelboxDts, dtsUri)
  monaco.languages.typescript.javascriptDefaults.addExtraLib(pixelboxDts, dtsUri)

  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true)
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true)

  // ⌘+点击 / F12 跨文件跳转(机制见 setEditorOpenHandler 头注释)
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition): boolean {
      if (!editorOpenHandler || resource.scheme !== 'file') return false
      let line: number | undefined
      let column: number | undefined
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber
          column = selectionOrPosition.startColumn
        } else {
          line = selectionOrPosition.lineNumber
          column = selectionOrPosition.column
        }
      }
      // 虚拟库两类:extraLib 注册路径(file:///node_modules/...)与 TS 标准库
      // (worker 返回裸名 lib.es2020.*.d.ts,Uri.parse 规范化为 file:///lib.*.d.ts)。
      // 标准库若误走真实文件分支,readFile 会被工作区路径牢笼拒绝 → 死页签
      if (
        resource.path.startsWith('/node_modules/') ||
        /^\/lib\.[^/]+\.d\.ts$/.test(resource.path)
      ) {
        // 内容优先取 extraLib 注册文本(ts/js 两侧、原始 key 与 Uri 规范化 key
        // 都查),兜底取定义跳转链路(LibFiles)已建的同 uri model(标准库恒走此兜底)
        const keys = [resource.toString(), 'file://' + resource.path]
        const pools = [
          monaco.languages.typescript.typescriptDefaults.getExtraLibs(),
          monaco.languages.typescript.javascriptDefaults.getExtraLibs()
        ]
        let content: string | undefined
        for (const pool of pools) {
          for (const key of keys) content ??= pool[key]?.content
        }
        content ??= monaco.editor.getModel(resource)?.getValue()
        if (content == null) return false
        editorOpenHandler({ path: resource.path, virtual: true, content, line, column })
        return true
      }
      // 真实文件(design/ 兄弟文件等):走 App 常规打开链路(读盘 + 页签)
      editorOpenHandler({ path: resource.fsPath, virtual: false, line, column })
      return true
    }
  })

  // 冒烟钩子配套(PIXELBOX_SMOKE_MONACO,见 main/index.ts):暴露 monaco 顶层 API,
  // 供 main 经 webContents.executeJavaScript 真实驱动 ts.worker 补全链路
  // (断言 px 命名空间补全 → worker 拉起 + pixelbox.d.ts extraLib 注入均未回退)
  ;(window as unknown as { __pixelboxMonaco?: typeof monaco }).__pixelboxMonaco = monaco
}

/** 根据文件名推断 Monaco language id(先看整名再看扩展名:固件工程大量文件按名识别) */
export function languageForPath(path: string): string {
  const name = path.toLowerCase()
  // basename:兼容 '/' 与 '\' 两种分隔符(渲染层可能收到任一平台风格的路径)
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)

  // 按文件名(而非扩展名)识别的固件工程文件
  if (base === 'cmakelists.txt') return 'cmake'
  // sdkconfig / sdkconfig.defaults / sdkconfig.old / Kconfig / Kconfig.projbuild → ini 近似高亮
  if (base.startsWith('sdkconfig') || base.startsWith('kconfig')) return 'ini'

  const ext = base.slice(base.lastIndexOf('.') + 1)
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'css':
      return 'css'
    case 'html':
    case 'htm':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    // 固件工程:C/C++ 用 monaco 内置 basic-languages(全量入口已含 'c'/'cpp' 两个 id)
    case 'c':
    case 'h':
      return 'c'
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'ino':
      return 'cpp'
    case 'cmake':
      return 'cmake'
    case 'scad':
      return 'openscad'
    case 'ini':
      return 'ini'
    default:
      return 'plaintext'
  }
}

export { monaco }
