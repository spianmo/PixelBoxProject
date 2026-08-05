/** @type {import('tailwindcss').Config} */
// PixelBox 模拟器深色主题配色
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 编辑器深色底
        ink: {
          950: '#0b0d10',
          900: '#0f1115',
          850: '#14171c',
          800: '#191d23',
          700: '#222831',
          600: '#2c333e',
          500: '#3a424f'
        },
        accent: {
          DEFAULT: '#4fc3f7',
          dim: '#2b7ea1'
        }
      },
      fontFamily: {
        mono: ['"SF Mono"', 'Menlo', 'Consolas', '"Courier New"', 'monospace']
      }
    }
  },
  plugins: []
}
