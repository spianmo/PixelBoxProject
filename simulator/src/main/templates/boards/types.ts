/**
 * 硬件工程按芯片选板的模板契约 —— 每颗 ChipId 对应一块微雪(Waveshare)
 * 参考板卡的 1:1 复刻模板(tscircuit board + 真实模组封装 + 参数化外壳)。
 *
 * 实现约定(与 boards/esp32s3.ts 的微雪 ESP32-S3-Touch-AMOLED-2.16 模板一致):
 * - 离线可评估:不引 @tsci/*(CDN 运行时解析)、模组封装不带 cadModel CDN 段
 * - boardTsx 生成的 board.tsx 经相对导入引用 moduleFile(fsMap 多文件评估路径)
 * - 全部元件显式 schX/schY(不写会被 tscircuit 自动摊成一长条)
 * - 名字以 SCREEN/DISPLAY/LCD/AMOLED/OLED 开头的元件被识别为屏幕
 *   (3D 视图贴模拟器画面;外壳顶盖按 screenRect 开窗)
 */
import type { ChipId } from '../../../shared/chipCapabilities'
import type { EnclosureParams } from '../../../shared/ipc-types'

/** 单块参考板卡模板(注册表 boards/index.ts 按 ChipId 索引) */
export interface HardwareBoardTemplate {
  chip: ChipId
  /** 微雪产品名(README/文案展示),如 'ESP32-S3-Touch-AMOLED-2.16' */
  boardName: string
  /** 官方 wiki 页 */
  docsUrl: string
  /** 官方原理图 PDF */
  schematicUrl: string
  /** 主控模组真实封装文件(落盘到 design/<fileName>;content 为 ?raw 内嵌全文) */
  moduleFile: { fileName: string; content: string }
  /** design/board.tsx 全文生成器(name = 项目名,仅用于头注释) */
  boardTsx: (name: string) => string
  /** 外壳参数(enclosureScadFromParams 的第 1 参) */
  enclosure: EnclosureParams
  /** PCB 外形(enclosureScadFromParams 的第 2 参) */
  boardSizeMM: { widthMM: number; heightMM: number; thicknessMM: number }
  /** 屏幕可视区在板上的位置(enclosureScadFromParams 的第 3 参;无屏为 null) */
  screenRect: { x: number; y: number; w: number; h: number } | null
  /** 实机屏幕分辨率(README「添加到模拟器」建议值;无屏为 null) */
  screenResolution: { w: number; h: number } | null
  /** README.md 全文生成器 */
  readme: (name: string, chip: string) => string
}
