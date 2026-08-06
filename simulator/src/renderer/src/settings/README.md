# IDE 设置框架(settings-window)

完全复刻 JetBrains 设置窗口的独立窗口设置系统。本目录是 renderer 侧框架,
main 侧持久化在 `src/main/settings.ts`(SettingsService),schema 单一数据源在
`src/shared/settingsSchema.ts`。

## 架构总览

```
main 进程
  src/main/settings.ts        SettingsService:settings.json 单一落盘 + IPC + 广播
  src/main/settingsWindow.ts  独立设置窗口(?window=settings 单例,980×700 记忆位置)

shared
  src/shared/ipc-types.ts       AppSettings 类型(纯类型)
  src/shared/settingsSchema.ts  默认值 + 逐项校验 + dot-path 补丁工具(单一数据源)

renderer(本目录)
  store.ts            设置镜像:get-all 拉取 + settings:changed 订阅 + 语言同步/预览
  registry.tsx        设置页注册表:import.meta.glob 自动收集 pages/*.tsx
  draft.tsx           草稿层:页面读写草稿,Apply/OK 才落盘,Cancel 丢弃
  controls.tsx        JetBrains 表单控件(分节/勾选/下拉/文本,均接草稿)
  categories.ts       共享分类引用(外观与行为 / 工具)
  SettingsWindow.tsx  窗口壳:搜索/分类树/面包屑/历史/底部按钮/关窗确认
  pages/*.tsx         具体设置页(每页一个文件,自动注册)
```

数据流:

```
设置页控件 → useDraftValue(草稿) → Apply/OK → settings:set-many(IPC)
  → SettingsService 校验/落盘/广播 settings:changed
  → 各窗口 settings/store.ts 镜像更新
  → 消费方(EditorHost / xtermRegistry / i18n / 标题栏芯片 / PtyService / Toolchain)即时生效
```

## 新增一个设置页(框架零改动)

只需要在 `pages/` 下新增一个文件,导出 `page`:

```tsx
// pages/network.tsx
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, CheckboxField } from '../controls'

function NetworkPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('settings.page.network')}>
      <CheckboxField path="network.proxyEnabled" label={t('settings.network.proxy')} />
    </SettingsSection>
  )
}

export const page: SettingsPage = {
  id: 'network',                       // 稳定 id(选中态/历史栈)
  category: [CAT_TOOLS],               // 分类树路径;[] = 顶层;新分类可内联声明
  titleKey: 'settings.page.network',   // 标题 i18n key(左树/面包屑)
  keywords: ['网络', '代理', 'network', 'proxy'], // 搜索关键词(中英)
  order: 30,                           // 同层排序(小在前)
  Component: NetworkPage
}
```

配套改动(均为「数据登记」,不改框架代码):

1. **schema 登记**:若页面引入了新设置项,在 `src/shared/settingsSchema.ts` 的
   `SETTINGS_DEFAULTS` 与 `SANITIZERS` 各加一行(默认值 + 校验器),并在
   `src/shared/ipc-types.ts` 的 `AppSettings` 补类型字段。
   未登记的 dot-path 会被 set-many 静默丢弃(白名单机制)。
2. **i18n**:`src/renderer/src/i18n/locales/{zh-CN,en}.json` 补标题/说明文案。
3. **消费方**(可选):需要即时生效的地方 `subscribeSettings(cb)` +
   `getAppSettings()` 读新值(renderer),或 main 侧 `getSettings()`。

不需要动:registry.tsx(glob 自动收集)、SettingsWindow.tsx、draft.tsx、
main 的 IPC/落盘/广播。

## 草稿 / 应用语义

- 页面组件一律经 `useDraftValue(path)` 读写,**不要**直接调 `settingsSetMany`;
- 草稿只存「与已保存值不同」的键,改回原值自动出栈,`dirty = 草稿非空`;
- Apply:落盘并广播,窗口保持打开;OK = Apply + 关窗;Cancel/Esc = 丢弃 + 关窗;
- ✕ 关窗且 dirty:确认框(main 的 close 事件被拦截转发 `settings:close-request`);
- 切页不清草稿(未应用修改跨页保留)。

需要「选择即预览」的项(如界面语言)参照 SettingsWindow.tsx 中
`setLanguagePreview` 的做法:监听草稿值做临时预览,Cancel/落盘后自然回落。

## 持久化与迁移

- 落盘:`userData/pixelbox-sim/settings.json`(全量嵌套 JSON,损坏字段逐项回退默认值);
- 旧源迁移(均一次性,迁移后标记弃用):
  - `toolchain.json`(v2.2 SettingsModal)→ main 首启迁移,旧文件写 `deprecated: true`;
  - localStorage `pixelbox-sim.lang` / `pixelbox-sim.editor.minimap` → renderer 首启推送,
    写 `pixelbox-sim.settings-migrated` 标记;lang 键降级为冷启动语言镜像缓存。

## 自检

`npm run check:settings`(scripts/settings-check.mjs):electron 桩驱动真实
SettingsService,断言 默认值 / set-many 落盘 / 冷启动回读 / toolchain.json 迁移 /
settings:changed 广播 / 坏值拒绝 / reset。
