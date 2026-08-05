import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './i18n'
import './assets/main.css'
import { setupMonaco } from './editor/monacoSetup'

// Monaco 环境(worker / 语言服务 / pixelbox.d.ts extraLib)需在首个编辑器创建前就绪
setupMonaco()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
