/**
 * Monaco 模型注册表(模块级单例)—— 模型生命周期与编辑器实例解耦
 *
 * 背景:编辑器分屏(IDE v3.x)后同时存在两个 EditorHost(monaco 实例),而
 * monaco model 按 Uri 全局唯一。模型若仍由各实例私有持有(旧 modelsRef 方案),
 * 两实例会在 ensureModel 的孤儿回收处互杀对方的活模型,丢失未保存编辑。
 * 本模块把「模型 + 保存点 + 脏订阅」上收为模块级 Map,按 refCount 管理:
 * 每个编辑器组 acquire 一次 ref++,close 一次 ref--,归零才真正 dispose ——
 * 同一文件在两组同时打开互不影响。
 *
 * 语义保留(自旧 EditorHost.ensureModel / openVirtual 迁入):
 * - Uri 归一化键(monaco.Uri.file(path).toString()):Windows 盘符大小写差异
 *   的路径归并到同一条目;被持有的同 uri 活模型绝不 dispose(先查表命中复用)
 * - 真孤儿(异常关闭残留 / 定义跳转 LibFiles 缓存)在建真实文件模型前回收重建
 * - C/C++ 接 clangd;design/*.ts(x) 注入 tscircuit 类型与兄弟 extraLib;
 *   enclosure.scad 无需特判 —— 硬件面板自己订阅 monaco 模型
 * - 虚拟库模型(acquireVirtual):收养 LibFiles 已建的同 uri model,不重复建
 *
 * 纯逻辑(refCount / 脏判定 / 保存点)经 createModelRegistryCore 依赖注入,
 * 可脱离 monaco 在 node 下跑断言(见 /tmp/tab-split-test 单测)。
 */
import { monaco, languageForPath } from './monacoSetup'
import { editorViewSettings } from './editorSettings'
import { attachClangdModel } from './clangdBridge'
import { injectTscircuitTypes, syncDesignSiblingLibs } from './tscircuitTypes'

/** 注册表关心的最小模型面(monaco.editor.ITextModel 的子集;node 单测用 mock 实现) */
export interface RegistryModelLike {
  getValue(): string
  setValue(value: string): void
  getAlternativeVersionId(): number
  onDidChangeContent(listener: () => void): { dispose(): void }
  dispose(): void
  /** 可选:model 级选项(tabSize);mock 可缺省 */
  updateOptions?(options: { tabSize: number }): void
}

/** 注册表条目(refCount = 持有它的编辑器组数,归零才 dispose) */
export interface RegistryEntry<M extends RegistryModelLike = RegistryModelLike> {
  model: M
  /** 首次 acquire 的原始路径(读写盘 / 脏通知用;归一化键见 keyFor) */
  path: string
  /** 保存点版本号(与 getAlternativeVersionId 比较得脏状态) */
  savedVersionId: number
  refCount: number
  /** 虚拟库条目(extraLib 声明):只读、不落盘、无脏状态 */
  virtual: boolean
}

/** 依赖注入面(生产接 monaco + window.api;单测注入 mock) */
export interface RegistryDeps<M extends RegistryModelLike> {
  /** 路径 → 归一化键(生产 = monaco.Uri.file(path).toString(),Windows 盘符大小写归并) */
  keyFor(path: string): string
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /**
   * 建真实文件模型。生产实现含孤儿回收:同 uri 已有 model 且不被注册表持有
   * (异常关闭残留 / LibFiles 缓存)时 dispose 重建 —— 被持有的活模型不会走到
   * 这里(acquireFile 先查表命中返回)。附带 clangd / tscircuit 注入副作用。
   */
  createFileModel(path: string, content: string): M
  /** 建虚拟库模型。生产实现收养 LibFiles 已建的同 uri model,否则按内容新建 */
  createVirtualModel(path: string, content: string): M
}

export interface ModelRegistry<M extends RegistryModelLike = RegistryModelLike> {
  /** 路径归一化键(EditorHost 持有表与注册表条目对键用) */
  keyFor(path: string): string
  /** 打开真实文件:已注册 ref++,否则读盘建模(并发同路径去重,共享一次读盘) */
  acquireFile(path: string): Promise<RegistryEntry<M>>
  /** 打开虚拟库页签:已注册 ref++,否则收养/新建(refCount 同样适用) */
  acquireVirtual(path: string, content: string): RegistryEntry<M>
  /** 查询(不增引用;未注册返回 null) */
  get(path: string): RegistryEntry<M> | null
  /** 释放一个引用,归零即 dispose 模型并移除条目 */
  release(path: string): void
  /** 脏判定(模型内容版本 vs 保存点;虚拟/未注册恒 false) */
  isDirty(path: string): boolean
  /** 保存指定文件(虚拟条目 / 写盘失败返回 false,失败保持脏状态交上层 toast) */
  saveFile(path: string): Promise<boolean>
  /** 保存全部脏文件 */
  saveAll(): Promise<void>
  /** 外部变更:该文件无未保存修改时从磁盘重载 */
  reloadIfClean(path: string): Promise<void>
  /** 脏状态订阅(内容变化对比保存点即时通知;返回退订函数) */
  onDirty(listener: (path: string, dirty: boolean) => void): () => void
  /** IDE 设置变化:全部模型应用新 Tab 宽度(多实例重复调用幂等) */
  setTabSize(tabSize: number): void
}

/** 纯逻辑核心(refCount / 脏判定 / 保存点 / 并发去重),monaco 无关可单测 */
export function createModelRegistryCore<M extends RegistryModelLike>(
  deps: RegistryDeps<M>
): ModelRegistry<M> {
  interface InternalEntry extends RegistryEntry<M> {
    listener: { dispose(): void }
  }
  const entries = new Map<string, InternalEntry>()
  /** 建模进行中的 acquireFile(同键并发只读盘/建模一次,失败一起失败) */
  const inflight = new Map<string, Promise<InternalEntry>>()
  const dirtyListeners = new Set<(path: string, dirty: boolean) => void>()

  const emitDirty = (path: string, dirty: boolean): void => {
    for (const l of dirtyListeners) l(path, dirty)
  }

  async function saveEntry(entry: InternalEntry): Promise<boolean> {
    if (entry.virtual) return false
    try {
      await deps.writeFile(entry.path, entry.model.getValue())
      entry.savedVersionId = entry.model.getAlternativeVersionId()
      emitDirty(entry.path, false)
      return true
    } catch (err) {
      // 写盘失败保持脏状态,交由上层 toast
      console.error('保存失败', err)
      return false
    }
  }

  return {
    keyFor: (path) => deps.keyFor(path),

    async acquireFile(path) {
      const key = deps.keyFor(path)
      const existing = entries.get(key)
      if (existing) {
        existing.refCount++
        return existing
      }
      const pending = inflight.get(key)
      if (pending) {
        const entry = await pending
        entry.refCount++
        return entry
      }
      const create = (async (): Promise<InternalEntry> => {
        const content = await deps.readFile(path)
        const model = deps.createFileModel(path, content)
        const entry: InternalEntry = {
          model,
          path,
          savedVersionId: model.getAlternativeVersionId(),
          refCount: 1,
          virtual: false,
          listener: model.onDidChangeContent(() => {
            emitDirty(entry.path, entry.model.getAlternativeVersionId() !== entry.savedVersionId)
          })
        }
        entries.set(key, entry)
        return entry
      })()
      inflight.set(key, create)
      try {
        return await create
      } finally {
        inflight.delete(key)
      }
    },

    acquireVirtual(path, content) {
      const key = deps.keyFor(path)
      const existing = entries.get(key)
      if (existing) {
        existing.refCount++
        return existing
      }
      const model = deps.createVirtualModel(path, content)
      const entry: InternalEntry = {
        model,
        path,
        savedVersionId: model.getAlternativeVersionId(),
        refCount: 1,
        virtual: true,
        listener: { dispose(): void {} } // 只读页签无脏状态可跟踪
      }
      entries.set(key, entry)
      return entry
    },

    get(path) {
      return entries.get(deps.keyFor(path)) ?? null
    },

    release(path) {
      const key = deps.keyFor(path)
      const entry = entries.get(key)
      if (!entry) return
      entry.refCount--
      if (entry.refCount > 0) return
      entries.delete(key)
      entry.listener.dispose()
      entry.model.dispose()
    },

    isDirty(path) {
      const entry = entries.get(deps.keyFor(path))
      if (!entry || entry.virtual) return false
      return entry.model.getAlternativeVersionId() !== entry.savedVersionId
    },

    async saveFile(path) {
      const entry = entries.get(deps.keyFor(path))
      if (!entry) return false
      return saveEntry(entry)
    },

    async saveAll() {
      for (const entry of [...entries.values()]) {
        if (entry.virtual) continue
        if (entry.model.getAlternativeVersionId() !== entry.savedVersionId) {
          await saveEntry(entry)
        }
      }
    },

    async reloadIfClean(path) {
      const entry = entries.get(deps.keyFor(path))
      if (!entry || entry.virtual) return
      if (entry.model.getAlternativeVersionId() !== entry.savedVersionId) return // 有本地修改,不覆盖
      try {
        const content = await deps.readFile(entry.path)
        // 读盘 await 期间条目可能被释放重建 / 产生本地编辑:重查再落
        if (entries.get(deps.keyFor(path)) !== entry) return
        if (entry.model.getAlternativeVersionId() !== entry.savedVersionId) return
        if (content !== entry.model.getValue()) {
          entry.model.setValue(content)
          entry.savedVersionId = entry.model.getAlternativeVersionId()
          emitDirty(entry.path, false)
        }
      } catch {
        // 文件可能已被删除,由文件树的 unlink 流程关闭标签
      }
    },

    onDirty(listener) {
      dirtyListeners.add(listener)
      return () => {
        dirtyListeners.delete(listener)
      }
    },

    setTabSize(tabSize) {
      for (const entry of entries.values()) entry.model.updateOptions?.({ tabSize })
    }
  }
}

// ---------------------------------------------------------------
// 生产接线(monaco + window.api;renderer 全局唯一实例)
// ---------------------------------------------------------------

function createFileModel(path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(path)
  // 同 uri 的真孤儿(异常关闭残留 / 定义跳转 LibFiles 缓存)回收重建 ——
  // 被注册表持有的活模型不会走到这里(acquireFile 已按归一化键命中返回),
  // 因此绝不会 dispose 掉带未保存编辑的活模型
  const clash = monaco.editor.getModel(uri)
  if (clash) clash.dispose()
  const model = monaco.editor.createModel(content, languageForPath(path), uri)
  // Tab 宽度是 model 级选项(新建 model 应用当前设置值)
  model.updateOptions({ tabSize: editorViewSettings().tabSize })
  // C/C++ 文件接入 clangd LSP(桥内部按扩展名过滤,惰性启动、model 销毁自动 didClose)
  attachClangdModel(path, model)
  // 硬件设计 design/*.ts(x):惰性注入 tscircuit 类型(幂等;extraLib 变更后 worker 自动重检),
  // 并把同目录其余 design 文件注册为 extraLib —— board.tsx 的相对导入
  // (如 './esp32-s3-mini')才能跨文件解析;已打开 model 恒优先,不会被覆盖
  if (/\.(tsx|ts)$/i.test(path) && path.replace(/\\/g, '/').includes('/design/')) {
    void injectTscircuitTypes()
    void syncDesignSiblingLibs(path)
  }
  return model
}

function createVirtualModel(path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(path)
  // 定义跳转链路(TS worker 的 LibFiles)可能已为该 uri 建过 model:直接收养,
  // 不 dispose 重建(会打断其 model 缓存);否则按传入内容新建
  const model =
    monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageForPath(path), uri)
  // 工作区外的 C/C++ 只读页签(IDF/工具链头文件)同样接入 clangd:didOpen 后
  // 才能在其中继续悬停/⌘+点击深跳(桥按扩展名过滤,TS 库声明页签不受影响)
  attachClangdModel(path, model)
  return model
}

/** 模块级注册表单例(分屏的两个 EditorHost 共享;App 级 dirtyPaths 经 onDirty 订阅) */
export const modelRegistry: ModelRegistry<monaco.editor.ITextModel> = createModelRegistryCore({
  keyFor: (path) => monaco.Uri.file(path).toString(),
  readFile: (path) => window.api.readFile(path),
  writeFile: (path, content) => window.api.writeFile(path, content),
  createFileModel,
  createVirtualModel
})
