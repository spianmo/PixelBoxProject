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

export function setupMonaco(): void {
  if (initialized) return
  initialized = true

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
