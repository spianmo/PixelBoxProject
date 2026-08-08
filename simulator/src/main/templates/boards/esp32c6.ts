/**
 * esp32c6 → 微雪 ESP32-C6-Touch-AMOLED-2.16 复刻板模板
 *
 * 板模板正文在 ../esp32c6-board.tsx(静态 .tsx,头注释含 __PROJECT_NAME__
 * 占位;已经 /tmp/tsc-probe 沙箱以多文件 fsMap 实测:1534 元素含 pcb_board
 * 43×43 + 25 pcb_component,U1 61 焊盘,SCREEN1 39×39 被识别为屏幕,
 * 0 DRC error,schematic 包围盒两两重叠 0)。
 * 主控 U1 用 ../esp32-c6-mini.tsx 的真实 ESP32-C6-MINI-1 模组封装(61 焊盘;
 * 实板为裸 C6 QFN40 + 外置 16MB Flash,模组等代,见板模板文件头取舍)。
 *
 * 布局经验(DRC 教训):正面被屏幕整块占满 —— 其余元件(含三颗侧按键)必须放
 * layer="bottom",否则与 SCREEN1 的 courtyard 重叠报错;按键为通孔件,孔贯穿
 * 两层,背面元件须与按键 courtyard(x∈[14.7,21.7])保持净空,且按键通孔列
 * 不得压上 SCREEN1 东侧焊盘列 x∈[18.5,19.5](跨层冲突,见板模板注释)。U1 模组 courtyard
 * 13.6×17mm(北端含 PCB 天线丝印区),置于 (0,2) 后占 x∈[-6.8,6.8]、
 * y∈[-6.5,10.5],背面其余元件按「东列/北排/西列/南排」环绕其外,彼此 courtyard
 * 留 ≥0.4mm 间隙(tscircuit 对 courtyard 重叠报 pcb_courtyard_overlap_error
 * 并跳过自动布线;pinrow9 焊盘排的 courtyard 上下各外扩约 1mm,尤须注意)。
 */
import type { HardwareBoardTemplate } from './types'
// 板模板正文与真实模组封装均为构建期 ?raw 内嵌(Rsbuild JS_RAW 规则只认 JS 族
// 扩展名,故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译)
import boardTsxRaw from '../esp32c6-board.tsx?raw'
import moduleTsx from '../esp32-c6-mini.tsx?raw'
import type { EnclosureParams } from '../../../shared/ipc-types'

/**
 * 微雪 ESP32-C6-Touch-AMOLED-2.16 成品外壳参数
 * (依据官方结构图 Struct.zip,文件名沿用 ESP32-S3-...-Dxf —— 两款共用结构件:
 * 圆角壳 46×46×22.5mm、壳圆角 R5.8、正面屏窗 OD 43.30/VA 38.99、窗圆角 R4.70):
 * - 外形还原实物:板 43 + 2×间隙 0.5 + 2×壁厚 1 = 46×46(裸板 43 为按屏模组
 *   OD 43.3 的估算,见板模板文件头)
 * - 总高 = 底板 1(=wall)+ 底盒内腔 17(baseHeightMM)+ 顶盖内腔 3.5(lidHeightMM)
 *   + 顶板 1(=wall)= 22.5mm(壁厚 2→1 后,底盒内腔 15→17 补足总高不变)
 * - 东壁(右墙)三个 Φ5.3 圆按键孔,垂直间距 10mm(顺序推断自北向南
 *   PWR/KEY/BOOT,官方未标注);结构图孔心距正面 9.60mm →
 *   port.y = 距底盒内腔地面高度 = (22.5 − 9.6) − 底板厚 1 = 11.9
 * - 西壁(左墙)USB-C 椭圆开孔(结构图口中心距一侧 8.6mm → 沿壁偏移 -14.4,
 *   偏向方位为推断)+ 麦克风拾音小孔;孔心近板面:板底面 = 柱高 9.5 − 板厚 1.6
 *   = 7.9,Type-C 母座(高≈3.2)贴板底朝下 → y = 7.9 − 3.2/2 ≈ 6.3
 * - 北壁(顶墙)microSD 插槽开槽(结构图该面台阶高 8.30)+ 第二麦克风孔;
 *   卡座(高≈1.9)同贴板底 → y = 7.9 − 1.9/2 ≈ 7
 * - 背面扬声器格栅 + 4×沉头螺丝(34.00 见方)为盖面特征,参数化壳无对应字段,略
 * - 壳色官方图未标注(实拍多为深灰/黑,取 #3a3a3c 近似)
 * - batteryMM:底盒内腔 3.7V 锂电占位(30×30×5,带电池版 1000mAh;仅 3D 展示)
 * port 坐标约定见 renderer/hardware/three/enclosureBuilder.ts:
 * port.x = 沿壁自壁中心的偏移,port.y = 距底盒内腔地面的高度
 */
const WAVESHARE_C6_216_ENCLOSURE: EnclosureParams = {
  wallMM: 1,
  clearanceMM: 0.5,
  baseHeightMM: 17,
  lidHeightMM: 3.5,
  // 9.5:让 5mm 电池以真实厚度放进板下(净空 = 柱高9.5 − 板厚1.6 − 元件净空2.7
  // = 5.2 ≥ 电池厚 5;壳外形高度不受柱高影响,板只是在腔内抬高)
  standoffHeightMM: 9.5,
  standoffOuterR: 3,
  standoffInnerR: 1.1,
  cornerR: 5.8,
  screenWindow: true,
  colorHex: '#3a3a3c',
  batteryMM: { w: 30, h: 30, t: 5 },
  ports: [
    // 三键孔:y = (22.5 − 9.6) − 1 = 11.9(孔心距正面 9.60,结构图)
    { wall: 'east', x: -10, y: 11.9, w: 5.3, h: 5.3, r: 2.65 },
    { wall: 'east', x: 0, y: 11.9, w: 5.3, h: 5.3, r: 2.65 },
    { wall: 'east', x: 10, y: 11.9, w: 5.3, h: 5.3, r: 2.65 },
    // USB-C:y = (9.5 − 1.6) − 3.2/2 = 6.3(近板面,座体贴板底朝下)
    { wall: 'west', x: -14.4, y: 6.3, w: 9.2, h: 3.6, r: 1.6 },
    { wall: 'west', x: 5, y: 6, w: 1.8, h: 1.8, r: 0.9 },
    // microSD:y = (9.5 − 1.6) − 1.9/2 ≈ 7(近板面,卡座贴板底朝下)
    { wall: 'north', x: 0, y: 7, w: 12, h: 2.4, r: 1 },
    { wall: 'north', x: 10, y: 6, w: 1.8, h: 1.8, r: 0.9 }
  ]
}

function readme(name: string, chip: string): string {
  return `# ${name}

PixelBox 硬件设计工程(tscircuit PCB + 可 3D 打印参数化外壳;默认目标芯片 \`${chip}\`)。

默认模板 1:1 复刻 **微雪 ESP32-C6-Touch-AMOLED-2.16** 开发板
(官方资料:<https://docs.waveshare.net/ESP32-C6-Touch-AMOLED-2.16/>):
2.16 英寸 AMOLED 480×480 触摸屏 + 裸 ESP32-C6(QFN40,无 PSRAM)+ 外置 16MB
Flash,圆角成品外壳 46×46×22.5mm(右侧三颗 Φ5.3 按钮、左侧 USB-C、顶侧
microSD 卡槽、背面扬声器格栅)。

## 目录结构

- \`design/board.tsx\` — PCB 电路(tscircuit;IDE 硬件面板实时预览 PCB / 原理图 / 3D)
- \`design/esp32-c6-mini.tsx\` — 真实 ESP32-C6-MINI-1 模组封装(31 信号引脚 +
  GND 散热盘/角盘共 61 焊盘;转换自乐鑫官方 kicad 库,见文件头;board.tsx 相对导入使用)
- \`design/enclosure.scad\` — 外壳源码(OpenSCAD,外壳即代码;IDE 硬件面板即时编译渲染)
- \`tsconfig.json\` — TS 配置(jsx: react-jsx,与 IDE 编辑器一致)
- \`export/\` — STL / Gerber 导出目录(已 .gitignore)

> 编辑 \`design/board.tsx\` 时,\`<board>\`/\`<chip>\` 等 tscircuit 元素与属性的
> 补全 / 悬停 / 类型检查由 IDE 内置注入(无需 \`node_modules\`);
> 若要在 IDE 外独立跑 \`npx tsc\`,需自行安装 \`@tscircuit/core\` 等依赖。

## 默认板卡(微雪 ESP32-C6-Touch-AMOLED-2.16 复刻)

43×43mm 方板(裸板尺寸官方未公布,按屏模组外形 OD 43.3mm 估算;装入
46×46 外壳:板 43 + 2×间隙 0.5 + 2×壁厚 1 = 46),元件对照官方原理图各功能块:

| 元件 | 对应原理图块 / 真实硬件 | 位置 |
|---|---|---|
| \`SCREEN1\` | 2.16" AMOLED 480×480(驱动 CO5300,QSPI;触摸 CST9220;可视区约 39×39mm) | 正面 |
| \`SW2\`/\`SW3\`/\`SW1\` | KEYS:PWR(AXP2101 PWRON)/ KEY 用户键(GPIO10)/ BOOT(仅接 GPIO9)(间距 10mm,自北向南) | 东侧板边 |
| \`R1\` | KEYS:用户键 KEY 的 10K 上拉(原理图 R18) | 背面 |
| \`U1\` / \`U2\` / \`X1\` | ESP32-C6-MINI-1 真实模组封装(61 焊盘,IO 可按名连线,如 \`.U1 > .IO9\`)/ XM25QH128D 16MB Flash / 40MHz 晶振 | 背面 |
| \`U3\` / \`BAT1\` / \`Q1\` | POWER·KEYS:AXP2101 PMU / MX1.25 锂电池座 / BSS138(PWR 键态→GPIO18) | 背面 |
| \`U4\` / \`U5\` | RTC:PCF85063ATL / IMU:QMI8658(0x6B,INT 复用 GPIO16/17) | 背面 |
| \`U6\` / \`U7\` / \`U8\` / \`SPK1\` | 音频:ES8311 codec / ES7210 四通道 ADC(0x40)/ NS4150B 功放 / 喇叭焊盘 | 背面 |
| \`MIC1\`/\`MIC2\` | 双模拟硅麦(差分进 ES7210) | 背面 |
| \`CN1\` / \`SD1\` | 24P FPC 屏排线座(QSPI+触摸 I2C)/ microSD 卡座(SPI,与 LCD 共享 GPIO0/1/2) | 背面 / 北侧板边 |
| \`USB1\` / \`TVS1\` / \`ANT1\` | USB Type-C(GPIO12/13,TVS 防护)/ IPEX 天线座 | 西侧板边 / 背面 |
| \`PADS1\` | 背面扩展焊盘 ×9(1×UART + 1×I2C + 1×USB) | 背面南缘 |

名字以 \`SCREEN\` 开头的元件被识别为屏幕:3D 视图把模拟器画面贴到该区域,
外壳顶盖按它开窗;删改元件后保存即自动重新评估。

注意:占位模组 ESP32-C6-MINI-1 未引出 IO10/IO11(实板为裸片直出),用户键
KEY(GPIO10)与触摸 RST(GPIO11)的走线在模板中以空闲 IO 代位示意,见
\`board.tsx\` 内注释;LCD 无复位 GPIO(LCD_RESET 仅 RC 上拉到 AXP ALDO3)。

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
  chip: 'esp32c6',
  boardName: 'ESP32-C6-Touch-AMOLED-2.16',
  docsUrl: 'https://docs.waveshare.net/ESP32-C6-Touch-AMOLED-2.16/',
  schematicUrl: 'https://www.waveshare.net/w/upload/4/47/ESP32-C6-Touch-AMOLED-2.16-Schematic.pdf',
  moduleFile: { fileName: 'esp32-c6-mini.tsx', content: moduleTsx },
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure: WAVESHARE_C6_216_ENCLOSURE,
  boardSizeMM: { widthMM: 43, heightMM: 43, thicknessMM: 1.6 },
  // 与板模板的 SCREEN1(38.99≈39×39 可视区居中)一致
  screenRect: { x: 0, y: 0, w: 39, h: 39 },
  screenResolution: { w: 480, h: 480 },
  readme
}
