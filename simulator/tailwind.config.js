/** @type {import('tailwindcss').Config} */
// PixelBox 模拟器主题(JetBrains/Android Studio New UI dark 风格)
// 色板经 CSS 变量承载(src/renderer/src/assets/main.css 中定义 RGB 分量),
// 便于后续增加亮色主题:换主题只需切换 :root 变量,无需改组件类名。
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 兼容旧组件的 ink 阶梯:映射到 JetBrains 色板变量(dark/light 双主题)
        ink: {
          950: '#141517', // 最深底(遮罩等;未被组件引用,保留兼容)
          900: 'rgb(var(--pb-bg-editor) / <alpha-value>)', // 编辑器背景 #1E1F22 / #FFFFFF
          850: 'rgb(var(--pb-bg-panel) / <alpha-value>)', // 面板/标题栏/工具窗 #2B2D30 / #F7F8FA
          800: 'rgb(var(--pb-bg-hover) / <alpha-value>)', // 悬停 #35373B / #E9EAEC
          700: 'rgb(var(--pb-border) / <alpha-value>)', // 边框分隔线 #393B40 / #EBECF0
          600: 'rgb(var(--pb-border-strong) / <alpha-value>)', // 强分隔/输入框描边 #46484D / #D3D5DB
          500: 'rgb(var(--pb-icon-dim) / <alpha-value>)' // 弱化图标 #5A5D63 / #A8ACB8
        },
        // 强调蓝 #3574F0(两主题一致;dim 为按下/主按钮底)
        accent: {
          DEFAULT: 'rgb(var(--pb-accent) / <alpha-value>)',
          dim: 'rgb(var(--pb-accent-dim) / <alpha-value>)'
        },
        // 语义化别名(新组件使用)
        jb: {
          text: 'rgb(var(--pb-text) / <alpha-value>)', // 主文字 #DFE1E5 / #27282E
          muted: 'rgb(var(--pb-text-muted) / <alpha-value>)', // 次级文字 #9DA0A8 / #6C707E
          selection: 'rgb(var(--pb-selection) / <alpha-value>)' // 选中行/项 #2E436E / #D4E2FF
        },
        // 组件里在用的 tailwind 调色板档位 → 主题化 CSS 变量
        // (dark 值 = tailwind 默认值,dark 观感与 v2.3 一致;light 档加深保白底对比,
        // 变量组见 assets/main.css 的 --pb-c-*;未列出的档位仍是 tailwind 静态值)
        gray: {
          100: 'rgb(var(--pb-c-gray-100) / <alpha-value>)',
          200: 'rgb(var(--pb-c-gray-200) / <alpha-value>)',
          300: 'rgb(var(--pb-c-gray-300) / <alpha-value>)',
          500: 'rgb(var(--pb-c-gray-500) / <alpha-value>)'
        },
        red: {
          300: 'rgb(var(--pb-c-red-300) / <alpha-value>)',
          400: 'rgb(var(--pb-c-red-400) / <alpha-value>)',
          500: 'rgb(var(--pb-c-red-500) / <alpha-value>)',
          600: 'rgb(var(--pb-c-red-600) / <alpha-value>)'
        },
        green: {
          300: 'rgb(var(--pb-c-green-300) / <alpha-value>)',
          400: 'rgb(var(--pb-c-green-400) / <alpha-value>)',
          500: 'rgb(var(--pb-c-green-500) / <alpha-value>)'
        },
        yellow: {
          300: 'rgb(var(--pb-c-yellow-300) / <alpha-value>)',
          400: 'rgb(var(--pb-c-yellow-400) / <alpha-value>)',
          500: 'rgb(var(--pb-c-yellow-500) / <alpha-value>)',
          600: 'rgb(var(--pb-c-yellow-600) / <alpha-value>)'
        },
        orange: {
          300: 'rgb(var(--pb-c-orange-300) / <alpha-value>)',
          400: 'rgb(var(--pb-c-orange-400) / <alpha-value>)'
        },
        purple: { 400: 'rgb(var(--pb-c-purple-400) / <alpha-value>)' },
        cyan: { 400: 'rgb(var(--pb-c-cyan-400) / <alpha-value>)' },
        sky: { 300: 'rgb(var(--pb-c-sky-300) / <alpha-value>)' }
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
