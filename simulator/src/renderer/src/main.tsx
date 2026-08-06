import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './i18n'
import './assets/main.css'
import { setupMonaco } from './editor/monacoSetup'
import { StandaloneToolWindow } from './shell/StandaloneToolWindow'

// 独立工具窗分流(视图模式 Window):main 进程以 ?toolwindow=<id> 打开的窗口
// 只渲染对应工具窗的深色壳,不加载 Monaco / device-sim 等主窗重资产
const standaloneToolId = new URLSearchParams(window.location.search).get('toolwindow')

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

if (standaloneToolId) {
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
