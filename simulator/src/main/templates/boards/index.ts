/**
 * 硬件工程按芯片选板注册表 —— ChipId → 微雪参考板卡模板(单一数据源)
 *
 * createHardwareProject 按 manifest.chip 取模板;未收录的芯片回退 esp32s3
 * (与 chipCapabilities.chipCapability 的回退语义一致,保证永不缺模板)。
 *
 * 收录板卡(均经 /tmp/tsc-probe 多文件 fsMap 评估 0 DRC error + 对抗校验):
 * - esp32s3 → ESP32-S3-Touch-AMOLED-2.16(2.16" AMOLED 480×480,46 壳)
 * - esp32c6 → ESP32-C6-Touch-AMOLED-2.16(同族 AMOLED 板,C6 裸片 + 16MB Flash)
 * - esp32c3 → ESP32-C3-LCD-1.47(1.47" LCD 172×320,U 盘造型)
 * - esp32p4 → ESP32-P4-WIFI6-Touch-LCD-4.3(4.3" 触摸屏 + C6 hosted WiFi6)
 * - esp32   → ESP32 One(经典 WROOM-32E 底板 + DVP 摄像头,无屏)
 */
import type { ChipId } from '../../../shared/chipCapabilities'
import type { HardwareBoardTemplate } from './types'
import { BOARD_TEMPLATE as ESP32S3_BOARD } from './esp32s3'
import { BOARD_TEMPLATE as ESP32C6_BOARD } from './esp32c6'
import { BOARD_TEMPLATE as ESP32C3_BOARD } from './esp32c3'
import { BOARD_TEMPLATE as ESP32P4_BOARD } from './esp32p4'
import { BOARD_TEMPLATE as ESP32_BOARD } from './esp32'

export const HARDWARE_BOARD_TEMPLATES: Partial<Record<ChipId, HardwareBoardTemplate>> = {
  esp32s3: ESP32S3_BOARD,
  esp32c6: ESP32C6_BOARD,
  esp32c3: ESP32C3_BOARD,
  esp32p4: ESP32P4_BOARD,
  esp32: ESP32_BOARD
}

/** 按芯片查板卡模板(未知/未收录芯片回退 esp32s3) */
export function hardwareBoardTemplate(chip: string): HardwareBoardTemplate {
  return HARDWARE_BOARD_TEMPLATES[chip as ChipId] ?? ESP32S3_BOARD
}
