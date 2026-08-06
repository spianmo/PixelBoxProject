/**
 * Monaco 环境初始化
 * - worker 经 Rspack 原生 `new Worker(new URL(...))` 语法打入本地(离线可用;
 *   构建期静态分析拆出独立 worker chunk,dev/prod 均从本地加载)
 * - TS/JS 语言服务开启,注入 sdk/types/pixelbox.d.ts(?raw 随构建打入)
 *   使 px / pixelbox 全 API 具备补全与 hover
 */
import * as monaco from 'monaco-editor'
// 唯一契约文件:整个仓库的设备 API 类型(禁止修改,只读注入)
import pixelboxDts from '../../../../../sdk/types/pixelbox.d.ts?raw'
import { getEffectiveTheme, subscribeTheme } from '../theme'

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

export function setupMonaco(): void {
  if (initialized) return
  initialized = true

  definePixelboxTheme()

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

  // 冒烟钩子配套(PIXELBOX_SMOKE_MONACO,见 main/index.ts):暴露 monaco 顶层 API,
  // 供 main 经 webContents.executeJavaScript 真实驱动 ts.worker 补全链路
  // (断言 px 命名空间补全 → worker 拉起 + pixelbox.d.ts extraLib 注入均未回退)
  ;(window as unknown as { __pixelboxMonaco?: typeof monaco }).__pixelboxMonaco = monaco
}

/** 根据文件名推断 Monaco language id */
export function languageForPath(path: string): string {
  const name = path.toLowerCase()
  const ext = name.slice(name.lastIndexOf('.') + 1)
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
    default:
      return 'plaintext'
  }
}

export { monaco }
