/**
 * hardware 模块公共类型 —— 契约见 docs/plans/ide-v3-project-types.md §2.4
 *
 * 全部硬件 3D 数据结构定义在 shared/ipc-types.ts(单一契约源),这里仅 re-export
 * 供 hardware/ 下的构建器、查看器与 UI 组件统一引用;本文件零运行时代码。
 */
export type {
  BoardSpec,
  EnclosureParams,
  Hardware3D,
  ScreenPlacement,
  EnclosurePort,
  BoardComponentBox
} from '../../../shared/ipc-types'

/** 爆炸视图目标状态(0 = 合拢,1 = 展开) */
export type ExplodeTarget = 0 | 1

/** 可单独导出 STL 的部件 id(与 THREE.Group.name 一致) */
export type HardwarePartId = 'base' | 'lid' | 'board'
