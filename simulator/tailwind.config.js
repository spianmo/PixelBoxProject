/** @type {import('tailwindcss').Config} */
// PixelBox 模拟器主题(JetBrains/Android Studio New UI dark 风格)
// 色板经 CSS 变量承载(src/renderer/src/assets/main.css 中定义 RGB 分量),
// 便于后续增加亮色主题:换主题只需切换 :root 变量,无需改组件类名。
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 兼容旧组件的 ink 阶梯:映射到 JetBrains 色板变量
        ink: {
          950: '#141517', // 最深底(遮罩等)
          900: 'rgb(var(--pb-bg-editor) / <alpha-value>)', // 编辑器背景 #1E1F22
          850: 'rgb(var(--pb-bg-panel) / <alpha-value>)', // 面板/标题栏/工具窗 #2B2D30
          800: 'rgb(var(--pb-bg-hover) / <alpha-value>)', // 悬停 #35373B
          700: 'rgb(var(--pb-border) / <alpha-value>)', // 边框分隔线 #393B40
          600: '#46484D', // 略亮边框(输入框描边)
          500: '#5A5D63' // 弱化图标
        },
        // 强调蓝 #3574F0
        accent: {
          DEFAULT: 'rgb(var(--pb-accent) / <alpha-value>)',
          dim: '#2A5BC0'
        },
        // 语义化别名(新组件使用)
        jb: {
          text: 'rgb(var(--pb-text) / <alpha-value>)', // 主文字 #DFE1E5
          muted: 'rgb(var(--pb-text-muted) / <alpha-value>)', // 次级文字 #9DA0A8
          selection: 'rgb(var(--pb-selection) / <alpha-value>)' // 选中行/项 #2E436E
        }
      },
      fontFamily: {
        // UI 字体:Inter 优先(JetBrains New UI 同款,@fontsource 离线内嵌),
        // 中文回退系统字体(PingFang SC / 微软雅黑);全局 13px 密度见 assets/main.css
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif'
        ],
        // 代码字体:JetBrains Mono(@fontsource 离线内嵌;Monaco/xterm/MD 代码块/日志同链)
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', '"Courier New"', 'monospace']
      }
    }
  },
  plugins: []
}
