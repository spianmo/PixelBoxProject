/**
 * tscircuit 类型 extraLib 载荷(惰性 chunk,仅被 tscircuitTypes.ts 动态 import)
 *
 * ?raw 全文内嵌两个 tsup 打包的单文件 d.ts(合计 ~17MB,故独立成异步 chunk,
 * 不进主包;首次打开硬件工程 design/*.tsx 时才加载):
 * - @tscircuit/core:含 `declare module "react"/"react/jsx-runtime"` 的 JSX
 *   IntrinsicElements 扩充(<board>/<chip>/... 全部电路元素)
 * - @tscircuit/props:core 的 JSX 元素属性全部引自此包(ChipProps/BoardProps...,
 *   成员为具体接口字段,不依赖 zod 推断),缺它则属性补全全为 any
 *
 * 导入路径说明(pnpm 布局,不可用裸 specifier):
 * - core 的 exports map 只暴露 "."(无 ./dist 子路径),Rspack 会按 exports 严格
 *   拒绝 `@tscircuit/core/dist/...`;相对路径导入不走 exports map,经
 *   simulator/node_modules/@tscircuit/core 符号链接直达真实文件
 * - props 不是 simulator 的直接依赖,不存在于 simulator/node_modules;取道 pnpm
 *   的隐藏提升目录 node_modules/.pnpm/node_modules(无版本哈希、路径稳定,当前
 *   提升实例 0.0.613 恰为 core@0.0.1607 所链接的同一实例)。若未来 pnpm 布局
 *   变化,此导入会在构建期以「模块找不到」硬失败,便于及时修正
 *
 * core/props d.ts 还引用 zod / circuit-json / 各 solver 包 —— 刻意不注入:
 * 未解析导入产生的诊断只落在 d.ts 自身文件内(冒烟只查 board 模型的诊断),
 * 引用处类型降级为 any,不影响元素/属性补全与模板零报错(已经冒烟实证)。
 */
import tscircuitCoreDts from '../../../../node_modules/@tscircuit/core/dist/index.d.ts?raw'
import tscircuitPropsDts from '../../../../../node_modules/.pnpm/node_modules/@tscircuit/props/dist/index.d.ts?raw'

/**
 * 最小 React 类型桩(@types/react 的 export= 结构):
 * - core/props d.ts 仅引用 ReactElement / ReactNode / FunctionComponent /
 *   JSXElementConstructor / ComponentType / createElement(已 grep 实证),
 *   其余成员一概不需要
 * - 必须存在且可解析:core 的 `declare module "react"` 是模块扩充(augmentation),
 *   目标模块解析失败时整个扩充被 TS 丢弃,<board> 等 IntrinsicElements 随之失效
 */
const REACT_SHIM_DTS = `// 最小 React 类型桩(仅供 tscircuit d.ts 在 Monaco TS worker 内解析)
declare namespace React {
  type Key = string | number
  type ReactNode = ReactElement | string | number | boolean | null | undefined | Iterable<ReactNode>
  type JSXElementConstructor<P> = (props: P) => ReactNode
  interface ReactElement<
    P = any,
    T extends string | JSXElementConstructor<any> = string | JSXElementConstructor<any>
  > {
    type: T
    props: P
    key: Key | null
  }
  type FunctionComponent<P = {}> = (props: P) => ReactNode
  type FC<P = {}> = FunctionComponent<P>
  type ComponentType<P = {}> = FunctionComponent<P>
  function createElement(type: any, props?: any, ...children: any[]): ReactElement
}
export = React
`

/**
 * react/jsx-runtime 类型桩:jsx: ReactJSX 模式下 TS 自动解析此模块并取其导出的
 * JSX 命名空间;core 的 \`declare module "react/jsx-runtime"\` 扩充在此合并出
 * 全部 tscircuit 元素。刻意不声明 ElementChildrenAttribute(不检查 children,
 * 电路元素嵌套无需类型约束)
 */
const REACT_JSX_RUNTIME_SHIM_DTS = `// 最小 react/jsx-runtime 类型桩(ReactJSX 模式的 JSX 命名空间宿主)
import type * as React from 'react'
export declare function jsx(type: any, props: any, key?: React.Key): React.ReactElement
export declare function jsxs(type: any, props: any, key?: React.Key): React.ReactElement
export declare function Fragment(props: { children?: React.ReactNode }): React.ReactNode
export declare namespace JSX {
  type ElementType = string | React.JSXElementConstructor<any>
  interface Element extends React.ReactElement<any, any> {}
  interface IntrinsicAttributes {
    key?: React.Key | null
  }
  // tscircuit 元素经 @tscircuit/core 的模块扩充合并进来
  interface IntrinsicElements {}
}
`

export interface TscircuitExtraLib {
  content: string
  /** Monaco extraLib 虚拟路径(worker 内按 node 规则从此解析模块) */
  filePath: string
}

/** 注入顺序无关(extraLibs 同批加入 worker 程序);路径即 worker 内虚拟 node_modules */
export const TSCIRCUIT_EXTRA_LIBS: TscircuitExtraLib[] = [
  { content: REACT_SHIM_DTS, filePath: 'file:///node_modules/react/index.d.ts' },
  { content: REACT_JSX_RUNTIME_SHIM_DTS, filePath: 'file:///node_modules/react/jsx-runtime.d.ts' },
  { content: tscircuitPropsDts, filePath: 'file:///node_modules/@tscircuit/props/index.d.ts' },
  { content: tscircuitCoreDts, filePath: 'file:///node_modules/@tscircuit/core/index.d.ts' }
]
