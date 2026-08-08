/**
 * esp32s3 → 微雪 ESP32-S3-Touch-AMOLED-2.16 复刻板模板
 *
 * 板模板正文在 ../esp32s3-board.tsx(静态 .tsx,头注释含 __PROJECT_NAME__
 * 占位;已经 /tmp/tsc-probe 沙箱以多文件 fsMap 实测:1321 元素含 pcb_board
 * 40×40 + 20 pcb_component,U1 73 焊盘,SCREEN1 39×39 被识别为屏幕,0 DRC error)。
 * 主控 U1 用 ../esp32-s3-mini.tsx 的真实 ESP32-S3-MINI-1-N8 模组封装(73 焊盘)。
 *
 * 布局经验(DRC 教训):正面被屏幕整块占满 —— 其余元件(含三颗侧按键)必须放
 * layer="bottom",否则与 SCREEN1 的 courtyard 重叠报错;按键为通孔件,孔贯穿两层,
 * 背面元件须与按键 courtyard(y≥11.5)保持净空。U1 模组 courtyard 达
 * 16.6×21mm(北端含 PCB 天线丝印区,y 至 +13,置于 (0,-2) 后占 x∈[-8.05,8.58]、
 * y∈[-9.97,11.05]),背面其余元件按「东列/西列/南排」环绕其外,彼此 courtyard
 * 留 ≥0.4mm 间隙(tscircuit 会对 courtyard 重叠报 pcb_courtyard_overlap_error
 * 并跳过自动布线)。
 */
import type { HardwareBoardTemplate } from './types'
// 板模板正文与真实模组封装均为构建期 ?raw 内嵌(Rsbuild JS_RAW 规则只认 JS 族
// 扩展名,故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译)
import boardTsxRaw from '../esp32s3-board.tsx?raw'
import moduleTsx from '../esp32-s3-mini.tsx?raw'
import type { EnclosureParams } from '../../../shared/ipc-types'

/**
 * 微雪 ESP32-S3-Touch-AMOLED-2.16 成品外壳参数
 * (依据官方尺寸图:白色圆角壳 46×46×22.5mm、圆角 R5.8;
 * 总高 = 底板 2 + 底盒内腔 15 + 顶盖内腔 3.5 + 顶板 2 = 22.5mm):
 * - 北壁三个 Φ5.3 按钮孔,间距 10mm(+/KEY、PWR、BOOT/-),孔心取壁中高
 * - 南壁 USB-C 开口(9.2×3.6 圆角 1.6),孔心近板面高度
 * - 西壁 microSD 卡槽(12×2.4 圆角 1),孔心近板面高度
 * - batteryMM:底盒内腔 3.7V 锂电占位(30×30×5,仅 3D 展示,不参与 STL 打印;
 *   实物堆叠:屏幕贴顶盖窗口 → PCB → 电池在底盒剩余空腔)
 * port 坐标约定见 renderer/hardware/three/enclosureBuilder.ts:
 * port.x = 沿壁自壁中心的偏移,port.y = 距底盒内腔地面的高度
 */
const WAVESHARE_216_ENCLOSURE: EnclosureParams = {
  wallMM: 2,
  clearanceMM: 1,
  baseHeightMM: 15,
  lidHeightMM: 3.5,
  // 9.5:让 5mm 电池以真实厚度放进板下(净空 = 柱高 − 板厚1.6 − 元件净空2.7 = 5.2;
  // 壳外形高度不受柱高影响,板只是在腔内抬高)
  standoffHeightMM: 9.5,
  standoffOuterR: 3,
  standoffInnerR: 1.1,
  cornerR: 5.8,
  screenWindow: true,
  colorHex: '#f2f2f4',
  batteryMM: { w: 30, h: 30, t: 5 },
  ports: [
    { wall: 'north', x: -10, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
    { wall: 'north', x: 0, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
    { wall: 'north', x: 10, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
    { wall: 'south', x: 0, y: 4, w: 9.2, h: 3.6, r: 1.6 },
    { wall: 'west', x: 0, y: 3.5, w: 12, h: 2.4, r: 1 }
  ]
}

function readme(name: string, chip: string): string {
  return `# ${name}

PixelBox 硬件设计工程(tscircuit PCB + 可 3D 打印参数化外壳;默认目标芯片 \`${chip}\`)。

默认模板 1:1 复刻 **微雪 ESP32-S3-Touch-AMOLED-2.16** 开发板
(官方资料:<https://docs.waveshare.net/ESP32-S3-Touch-AMOLED-2.16>):
2.16 英寸 AMOLED 480×480 触摸屏 + ESP32-S3R8(8MB PSRAM)+ 16MB Flash,
白色圆角成品外壳 46×46×22.5mm(顶面三颗 Φ5.3 按钮、底侧 USB-C、左侧 microSD 卡槽)。

## 目录结构

- \`design/board.tsx\` — PCB 电路(tscircuit;IDE 硬件面板实时预览 PCB / 原理图 / 3D)
- \`design/esp32-s3-mini.tsx\` — 真实 ESP32-S3-MINI-1-N8 模组封装(65 引脚 + GND
  散热盘共 73 焊盘;来源 tscircuit 开源项目,见文件头;board.tsx 相对导入使用)
- \`design/enclosure.scad\` — 外壳源码(OpenSCAD,外壳即代码;IDE 硬件面板即时编译渲染)
- \`tsconfig.json\` — TS 配置(jsx: react-jsx,与 IDE 编辑器一致)
- \`export/\` — STL / Gerber 导出目录(已 .gitignore)

> 编辑 \`design/board.tsx\` 时,\`<board>\`/\`<chip>\` 等 tscircuit 元素与属性的
> 补全 / 悬停 / 类型检查由 IDE 内置注入(无需 \`node_modules\`);
> 若要在 IDE 外独立跑 \`npx tsc\`,需自行安装 \`@tscircuit/core\` 等依赖。

## 默认板卡(微雪 ESP32-S3-Touch-AMOLED-2.16 复刻)

40×40mm 方板(装入 46mm 外壳),元件对照官方原理图各功能块:

| 元件 | 对应原理图块 / 真实硬件 | 位置 |
|---|---|---|
| \`SCREEN1\` | 2.16" AMOLED 480×480(驱动 CO5300,QSPI;可视区约 39×39mm) | 正面 |
| \`SW1\`/\`SW2\`/\`SW3\` | KEYS:+/KEY(BSS138 电平转换)/ PWR / BOOT-(间距 10mm) | 北侧板边 |
| \`U1\` / \`U2\` | ESP32-S3-MINI-1-N8 真实模组封装(73 焊盘,IO 可按名连线,如 \`.U1 > .IO0\`) / XM25QH128 16MB Flash | 背面 |
| \`U3\` / \`J1\` | POWER:AXP2101 PMU / MX1.25 锂电池座 | 背面 |
| \`U4\` / \`U5\` | RTC:PCF85063ATL / 6/9-Axis:QMI8658A IMU(0x6B) | 背面 |
| \`U6\` / \`U7\` / \`U8\` | 音频:ES8311 codec / ES7210 双麦 ADC(AEC)/ NS4150B 功放 | 背面 |
| \`MIC1\`/\`MIC2\` | 双 MEMS 麦克风 | 背面 |
| \`TP1\` / \`SD1\` | CST9220 触摸(FPC 上,示意)/ microSD 卡座 | 背面 / 西侧板边 |
| \`USB1\` / \`J2\` | USB Type-C(TVS ESD)/ IPEX 天线座 | 背面南侧 / 背面 |

名字以 \`SCREEN\` 开头的元件被识别为屏幕:3D 视图把模拟器画面贴到该区域,
外壳顶盖按它开窗;删改元件后保存即自动重新评估。

## 屏幕分辨率对应

实机屏幕为 **480×480**(2.16" AMOLED);「添加到模拟器」注册设备档案时,
建议屏幕宽高填 **480×480**,与实物像素一一对应(对话框默认值即 480×480)。

## 工作流

在 IDE 打开本目录 → 左侧 rail「硬件设计」面板:
运行设计(eval)→ 2D/3D 预览与爆炸视图 → 导出 STL(切片后经 OctoPrint/Moonraker 上传打印)
或导出 Gerber(交付制板);「添加到模拟器」可把板卡+外壳注册为虚拟设备档案。
`
}

export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip: 'esp32s3',
  boardName: 'ESP32-S3-Touch-AMOLED-2.16',
  docsUrl: 'https://docs.waveshare.net/ESP32-S3-Touch-AMOLED-2.16',
  schematicUrl: 'https://www.waveshare.net/w/upload/1/14/ESP32-S3-Touch-AMOLED-2.16-Schematic.pdf',
  moduleFile: { fileName: 'esp32-s3-mini.tsx', content: moduleTsx },
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure: WAVESHARE_216_ENCLOSURE,
  boardSizeMM: { widthMM: 40, heightMM: 40, thicknessMM: 1.6 },
  // 与板模板的 SCREEN1(39×39 可视区居中)一致
  screenRect: { x: 0, y: 0, w: 39, h: 39 },
  screenResolution: { w: 480, h: 480 },
  readme
}
