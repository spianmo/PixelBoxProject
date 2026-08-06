import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './i18n'
// 字体随包内嵌(@fontsource,woff2 经 Rsbuild 打包,离线可用;OFL 许可见 README 致谢节):
// UI 字体 Inter(JetBrains New UI 同款)+ 代码字体 JetBrains Mono(Monaco/终端/MD 代码块/日志)
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import './assets/main.css'
import { setupMonaco } from './editor/monacoSetup'
import { installHardwareSmoke } from './hardware/smoke'
import { StandaloneToolWindow } from './shell/StandaloneToolWindow'
import { SettingsWindow } from './settings/SettingsWindow'
import { initSettings } from './settings/store'
import { applyThemeMirrorEarly, initTheme } from './theme'

// 主题首帧防闪:按冷启动镜像同步上屏(真值稍后由 initTheme 经设置镜像 + nativeTheme 校正)
applyThemeMirrorEarly()

// 硬件设计冒烟探针常驻安装(见 hardware/smoke.ts 文档:仅挂 window.__pbHwSmoke 入口,
// eval worker/three 等重资产在被调用时才动态 import,不影响正常启动路径)
installHardwareSmoke()

// 窗口分流(main 进程按 query 参数打开的从属窗口):
// - ?toolwindow=<id>:独立工具窗(视图模式 Window),只渲染对应工具窗深色壳
// - ?window=settings:IDE 设置独立窗口(JetBrains Settings)
// 均不加载 Monaco / device-sim 等主窗重资产
const params = new URLSearchParams(window.location.search)
const standaloneToolId = params.get('toolwindow')
const windowKind = params.get('window')

// 设置镜像:所有窗口统一初始化(get-all + settings:changed 订阅 + 语言同步/旧值迁移)。
// 首帧渲染等镜像就绪(快速 IPC):布局/会话恢复(App)与设置表单据此拿到真实值,
// 避免以默认值初始化后再闪变(IPC 失败时 initSettings 内部落默认值兜底,渲染不被阻塞)
const settingsReady = initSettings()
// 主题:设置镜像就绪后解析有效主题(dark/light/system→nativeTheme)并置 <html data-theme>,
// 全部窗口(主窗 / 设置窗 / 独立工具窗)统一走这一条链路
const themeReady = settingsReady.then(() => initTheme())

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

function render(): void {
  if (windowKind === 'settings') {
    root.render(
      <React.StrictMode>
        <SettingsWindow />
      </React.StrictMode>
    )
  } else if (standaloneToolId) {
    root.render(
      <React.StrictMode>
        <StandaloneToolWindow toolId={standaloneToolId} />
      </React.StrictMode>
    )
  } else {
    // Monaco 环境(worker / 语言服务 / pixelbox.d.ts extraLib)需在首个编辑器创建前就绪
    setupMonaco()
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  }
}

void themeReady.finally(render)
