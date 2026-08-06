/**
 * Monaco 环境初始化
 * - worker 经 vite ?worker 打入本地(离线可用)
 * - TS/JS 语言服务开启,注入 sdk/types/pixelbox.d.ts(?raw 随构建打入)
 *   使 px / pixelbox 全 API 具备补全与 hover
 */
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
// 唯一契约文件:整个仓库的设备 API 类型(禁止修改,只读注入)
import pixelboxDts from '../../../../../sdk/types/pixelbox.d.ts?raw'

let initialized = false

/** 自定义主题:对齐 IDE 外壳的 JetBrains dark 色板(编辑器背景 #1E1F22) */
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
}

export function setupMonaco(): void {
  if (initialized) return
  initialized = true

  definePixelboxTheme()

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

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
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
