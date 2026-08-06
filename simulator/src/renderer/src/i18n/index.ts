/**
 * i18next 初始化:zh-CN 默认,en 备选
 *
 * 语言的持久化源是 main SettingsService(settings.json appearance.language,
 * settings/store.ts 镜像同步 + 设置窗口立即预览);localStorage 的
 * pixelbox-sim.lang 键已降级为「冷启动镜像缓存」—— i18n 初始化是同步的,
 * 设置镜像是异步 IPC,同步初读缓存可避免启动语言闪变(缓存由 settings/store.ts
 * 在每次落盘同步后回写,此处只读不写)。
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'

/** 冷启动语言镜像缓存键(写入方:settings/store.ts) */
const MIRROR_KEY = 'pixelbox-sim.lang'

const cached = localStorage.getItem(MIRROR_KEY)

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en }
  },
  lng: cached === 'en' || cached === 'zh-CN' ? cached : 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false }
})

export default i18n
