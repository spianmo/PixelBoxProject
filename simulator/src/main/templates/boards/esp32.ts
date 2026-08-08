/**
 * esp32 → 微雪 ESP32 One 复刻板模板
 *
 * 板模板正文在 ../esp32-board.tsx(静态 .tsx,头注释含 __PROJECT_NAME__
 * 占位);主控 U1 用 ../esp32-wroom-32e.tsx 的真实 ESP32-WROOM-32E 模组封装
 * (38 引脚 + GND 散热盘 3×3 阵列共 47 焊盘,乐鑫官方 kicad_mod 转换)。
 *
 * 布局经验(DRC 教训):板高仅 30.5mm,竖置模组(courtyard 19.6×26.6,北端
 * 含天线净空区)与顶排 40PIN 排针放不下同一列 —— 模组旋转 90°(天线朝西,
 * 与实板 IPEX 左上位一致)后 courtyard 占 x∈[-16.8,9.8]、y∈[-11.3,8.3],
 * 其余正面元件按「西列 TF/天线、东区下载/电源/杂件、底边 USB」环绕其外;
 * 40PIN 与 RST 键为通孔件贯穿两层,背面陪衬件(Flash/PSRAM/麦克风)须避开。
 * courtyard 两两间隙 ≥0.4mm,重叠报 pcb_courtyard_overlap_error 并跳过自动布线。
 *
 * 产品无成品外壳(配置清单仅主板+USB线+螺丝包),enclosure 用通用参数:
 * 壁厚 2 / 间隙 1 / 圆角 3,南壁 Micro USB + RST 键孔、西壁 TF 卡槽、
 * 东壁摄像头 FPC 出线口。无屏:screenRect/screenResolution 均为 null。
 */
import type { HardwareBoardTemplate } from './types'
// 板模板正文与真实模组封装均为构建期 ?raw 内嵌(Rsbuild JS_RAW 规则只认 JS 族
// 扩展名,故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译)
import boardTsxRaw from '../esp32-board.tsx?raw'
import moduleTsx from '../esp32-wroom-32e.tsx?raw'
import type { EnclosureParams } from '../../../shared/ipc-types'

/**
 * ESP32 One 无官方成品壳 → 通用可打印外壳参数:
 * - 南壁 Micro USB 开口(8×3.6 圆角 1.2,孔心对 board.tsx 的 USB1 pcbX=13.8 ——
 *   USB/RST 被模组 courtyard 挤出底边中段后孔位必须随元件走,南壁 port.x
 *   正方向 = 世界 +X,即元件 pcbX 原值)与 RST 键孔(4×2.5,对 SW1 pcbX=-21.5)
 * - 西壁 TF 卡槽(12×2.4,对 SD1)、东壁摄像头 FPC 出线口(20×3,对 CN1)
 * - batteryMM:PH2.0 单节锂电占位(34×24×6,仅 3D 展示,不参与 STL 打印)
 * port 坐标约定见 renderer/hardware/three/enclosureBuilder.ts:
 * port.x = 沿壁自壁中心的偏移,port.y = 距底盒内腔地面的高度
 * (支撑柱 4 + 板厚 1.6 → 板面高约 5.6,贴板连接器孔心取 6~7)
 */
const GENERIC_ESP32_ONE_ENCLOSURE: EnclosureParams = {
  wallMM: 2,
  clearanceMM: 1,
  baseHeightMM: 12,
  lidHeightMM: 3,
  standoffHeightMM: 4,
  standoffOuterR: 3,
  standoffInnerR: 1.1,
  cornerR: 3,
  // 无屏产品,顶盖不开窗
  screenWindow: false,
  colorHex: '#f2f2f4',
  batteryMM: { w: 34, h: 24, t: 6 },
  ports: [
    { wall: 'south', x: 13.8, y: 6.5, w: 8, h: 3.6, r: 1.2 },
    { wall: 'south', x: -21.5, y: 6.5, w: 4, h: 2.5, r: 1 },
    { wall: 'west', x: 0, y: 6, w: 12, h: 2.4, r: 1 },
    { wall: 'east', x: 0, y: 7, w: 20, h: 3, r: 1 }
  ]
}

function readme(name: string, chip: string): string {
  return `# ${name}

PixelBox 硬件设计工程(tscircuit PCB + 可 3D 打印参数化外壳;默认目标芯片 \`${chip}\`)。

默认模板 1:1 复刻 **微雪 ESP32 One** 开发板
(官方资料:<https://www.waveshare.net/wiki/ESP32_One>):
经典 ESP32 + 40PIN 树莓派 HAT 排针 + OV2640 摄像头座 + TF 卡 + I2S 麦克风 +
锂电充电升压,板 65×30.5mm。产品已停产,但 wiki/原理图资料完整,
作为经典 ESP32 参考模板不受影响。

## 目录结构

- \`design/board.tsx\` — PCB 电路(tscircuit;IDE 硬件面板实时预览 PCB / 原理图 / 3D)
- \`design/esp32-wroom-32e.tsx\` — 真实 ESP32-WROOM-32E 模组封装(38 引脚 +
  GND 散热盘阵列共 47 焊盘;乐鑫官方 kicad_mod 转换,见文件头;board.tsx 相对导入使用)
- \`design/enclosure.scad\` — 外壳源码(OpenSCAD,外壳即代码;IDE 硬件面板即时编译渲染)
- \`tsconfig.json\` — TS 配置(jsx: react-jsx,与 IDE 编辑器一致)
- \`export/\` — STL / Gerber 导出目录(已 .gitignore)

> 编辑 \`design/board.tsx\` 时,\`<board>\`/\`<chip>\` 等 tscircuit 元素与属性的
> 补全 / 悬停 / 类型检查由 IDE 内置注入(无需 \`node_modules\`);
> 若要在 IDE 外独立跑 \`npx tsc\`,需自行安装 \`@tscircuit/core\` 等依赖。

## 默认板卡(微雪 ESP32 One 复刻)

65×30.5mm 横板,元件对照官方原理图各功能块:

| 元件 | 对应原理图块 / 真实硬件 | 位置 |
|---|---|---|
| \`U1\` | MCU:实板 ESP32-D0WDQ6-V3 裸片 + 40MHz 晶振,复刻以 ESP32-WROOM-32E 模组等效(IO 可按名连线,如 \`.U1 > .IO0\`) | 正面中部(天线朝西) |
| \`P3\` | RPI_HEADER:40PIN 树莓派 HAT 排针 2×20(I2C=IO18/IO23 等,可插 e-Paper HAT) | 板上沿(通孔) |
| \`CN1\` | DVP:OV2640 24PIN 摄像头座(Y2-Y9 / XCLK=IO4 / PCLK=IO25 / VSYNC=IO5 / HREF=IO27) | 右缘竖置 |
| \`SD1\` | MICROSD:TF 卡座(SPI:CLK=IO14 / MISO=IO12 / MOSI=IO13 / CS=IO15) | 左缘竖置 |
| \`U4\` / \`Q1\`/\`Q2\` / \`SW1\` | DOWNLOAD:CP2102 USB 转串口(UART0=IO1/IO3)/ SS8050 自动下载(无实体 BOOT 键)/ RST 键 | 正面东区 / 底边 |
| \`USB1\` | USB:Micro-B 5P(D+/D- 串 22R 接 CP2102,兼供电) | 底边 |
| \`U5\` / \`J1\` | BATTERY:CS8501 充电升压一体 / PH2.0 锂电池座 | 正面东区 / 右下 |
| \`U6\` / \`U7\` / \`U8\` | POWER:MP2128DT 5V→3.3V / RT9166A-28(摄像头 2.8V)/ RT9166A-12(摄像头 1.2V) | 正面东区 |
| \`ANT1\` / \`Y1\` | RF:IPEX 天线座(模组占位后仅外观)/ 32.768kHz RTC 晶振预留位(默认 NC) | 左下 / 东区 |
| \`LED1\` / \`LED2\` | LED:用户 LED(GPIO21,低电平点亮)/ PWR 电源灯 | 正面东区 |
| \`LED3\` / \`LED4\` | BATTERY:充电指示灯 CHG / DONE(实板丝印 Led1/Led2,CS8501 CHRG/STDBY 驱动) | 正面东区底排 |
| \`U2\` / \`U3\` / \`MIC1\` | FLASH:W25Q32 4MB / PSRAM:ESP-PSRAM64H 8MB / I2S 麦克风 MSM261(SCK=IO26 / WS=IO32 / SDO=IO33) | 背面陪衬 |

注意:WROOM-32E 模组内置 4MB Flash 但**不含 PSRAM**,U2/U3 仅还原背面丝印
观感;固件若依赖 8MB PSRAM,语义更接近 WROVER-E。GPIO 存在设计性复用
(IO13/IO14 同为 TF-SPI 与摄像头 Y3/Y4;IO5 同为摄像头 VSYNC 与 40PIN
SPI_CS0),摄像头与 HAT/TF 分时使用,按原理图连线即可。

## 屏幕分辨率对应

本板**无屏幕**(无 SCREEN 元件,外壳顶盖不开窗);「添加到模拟器」注册
设备档案时按对话框默认分辨率即可,或按外接屏(如 e-Paper HAT)自行填写。

## 工作流

在 IDE 打开本目录 → 左侧 rail「硬件设计」面板:
运行设计(eval)→ 2D/3D 预览与爆炸视图 → 导出 STL(切片后经 OctoPrint/Moonraker 上传打印)
或导出 Gerber(交付制板);「添加到模拟器」可把板卡+外壳注册为虚拟设备档案。
`
}

export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip: 'esp32',
  boardName: 'ESP32 One',
  docsUrl: 'https://www.waveshare.net/wiki/ESP32_One',
  schematicUrl: 'https://www.waveshare.net/w/upload/a/a1/ESP32_One_Sch.pdf',
  moduleFile: { fileName: 'esp32-wroom-32e.tsx', content: moduleTsx },
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure: GENERIC_ESP32_ONE_ENCLOSURE,
  boardSizeMM: { widthMM: 65, heightMM: 30.5, thicknessMM: 1.6 },
  // 无屏产品(原理图/商城均无屏;外接屏经 40PIN HAT)
  screenRect: null,
  screenResolution: null,
  readme
}
