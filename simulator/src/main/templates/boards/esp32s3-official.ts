/** 官方 PDF/DXF 重建；制造源数据缺失，状态随工程保存到 reference.json。 */
import type { HardwareBoardTemplate } from './types'
import { centers, ports, enclosure, screenRect } from './esp32s3-exterior'
import boardTsxRaw from '../esp32s3-official-board.tsx?raw'
import data from '../../../../../docs/hardware/reference/ESP32-S3-Touch-AMOLED-2.16/official-netlist.json'

const xs = data.outline.map((p) => p[0])
const ys = data.outline.map((p) => p[1])
const boardSizeMM = { widthMM: Math.max(...xs) - Math.min(...xs), heightMM: Math.max(...ys) - Math.min(...ys), thicknessMM: 1.6 }
export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip: 'esp32s3', boardName: 'ESP32-S3-Touch-AMOLED-2.16',
  docsUrl: 'https://docs.waveshare.net/ESP32-S3-Touch-AMOLED-2.16',
  schematicUrl: 'https://www.waveshare.net/w/upload/1/14/ESP32-S3-Touch-AMOLED-2.16-Schematic.pdf',
  moduleFile: { fileName: 'official-data.ts', content: `// PDF 书签与打印页恢复数据；引脚标记不是制造焊盘。\nexport default ${JSON.stringify(data, null, 2)}\n` },
  extraFiles: [{ fileName: 'official-netlist.json', content: JSON.stringify(data, null, 2) + '\n' }],
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure, boardSizeMM, screenRect, screenResolution: { w: 480, h: 480 },
  reference: {
    schemaVersion: 1,
    source: 'Waveshare ESP32-S3-Touch-AMOLED-2.16 Schematic.pdf / Dxf.pdf / Dxf.dxf',
    board: { ...boardSizeMM, status: '打印页按 10mm 键距标定恢复；板厚 1.6mm 为假设' },
    enclosure: { widthMM: 46, depthMM: 46, heightMM: 22.5, cornerRMM: 5.8 },
    screen: { ...screenRect, outerMM: 43.3, visibleCornerRMM: 4.7 },
    mounting: { centers, target: 'enclosure', status: '后壳螺钉中心距 34×37mm；非 PCB 钻孔证据' },
    ports: ports.map((p, i) => ({ ...p, name: i < 3 ? `button${i + 1}` : i === 3 ? 'USB-C' : i === 4 ? 'microSD' : `speaker${i - 4}`, status: i < 3 ? '尺寸标注；孔形按按钮外形重建' : '方位/基准按视图；孔宽高按比例重建待试装' })),
    electrical: { components: data.components.length, nets: data.nets.length, pins: data.components.reduce((n, c) => n + c.pins.length, 0), sha256: data.sha256 },
    fabrication: { footprints: 'unverified', routing: 'unavailable', drills: 'unavailable' },
    unverified: ['制造封装与铜箔走线、层叠、阻抗、净空未提供', 'PCB 钻孔直径/镀层及板厚未标注', '元件值的文字邻域提取需逐项核对', '屏幕台阶深度、卡合结构、螺孔直径、电池尺寸与板卡高度为重建参数，需实物试装']
  },
  readme: (name, chip) => `# ${name}\n\n芯片 ${chip}，按微雪 ESP32-S3-Touch-AMOLED-2.16 官方 PDF/DXF 重建。\n\n包含 213 个元件、642 个引脚、181 个网络；U1 对应 ESP32-S3R8 裸芯片。\n\n- design/board.tsx：可编辑电路，默认关闭 PCB 布线，定位标记不能用于制板。\n- design/official-data.ts：电路的可编辑数据（元件/引脚/网络/打印页轮廓）。\n- design/official-netlist.json：官方 PDF 提取基准，附来源 SHA256。\n- design/reference.json：尺寸、来源及未验证项。\n- design/enclosure.scad：可编辑外壳，外形 46×46×22.5mm、R5.8、VA 38.99mm、OD 台阶 43.3mm、右侧三键、左 USB、上侧 SD、下侧透声孔。\n\nIDE 中运行设计 → 查看原理图/PCB/3D → 导出校验报告 → 分件导出 STL → 切片生成 G-code 后上传打印。\nSTL 是试装原型；台阶、壁厚、卡合、螺钉和电池尺寸仍需实物验证。外壳几何的预览与打印使用同一份 SCAD。\n\nGerber 导出检查 DRC、未布线连接、完整引脚网络和制造资料状态。当前模板缺正式封装/走线/钻孔数据，因此阻止制造导出。完成这些设计并验证后，在 reference.json 更新 fabrication 状态再检查。不能仅靠修改状态宣称与官方制造文件一致。\n\n原始资料：${data.source}，SHA256 ${data.sha256}。DXF INSUNITS 错标英寸，实际实体单位为毫米。\n`
}
