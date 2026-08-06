/**
 * i18next 初始化:zh-CN 默认,en 备选;语言选择持久化到 localStorage
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'

const STORAGE_KEY = 'pixelbox-sim.lang'

const saved = localStorage.getItem(STORAGE_KEY)

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en }
  },
  lng: saved ?? 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false }
})

/** 切换语言并持久化 */
export function toggleLanguage(): void {
  const next = i18n.language === 'zh-CN' ? 'en' : 'zh-CN'
  setLanguage(next)
}

/** 设置指定语言并持久化(设置菜单) */
export function setLanguage(lang: 'zh-CN' | 'en'): void {
  void i18n.changeLanguage(lang)
  localStorage.setItem(STORAGE_KEY, lang)
}

export default i18n
