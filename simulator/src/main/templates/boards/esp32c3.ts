/**
 * esp32c3 → 微雪 ESP32-C3-LCD-1.47 复刻板模板
 *
 * 板模板正文在 ../esp32c3-board.tsx(静态 .tsx,头注释含 __PROJECT_NAME__
 * 占位;已经 /tmp/tsc-probe 沙箱以多文件 fsMap 实测:971 元素含 pcb_board
 * 20.32×36.37 + 14 pcb_component,U1 61 焊盘,SCREEN1 17.39×32.35 被识别为
 * 屏幕,schematic 包围盒 0 重叠,0 error)。
 * 主控 U1 用 ../esp32-c3-mini.tsx 的真实 ESP32-C3-MINI-1 模组封装
 * (乐鑫 kicad-libraries 官方 kicad_mod 转换,53 引脚 + EPAD 阵列共 61 焊盘)。
 *
 * 布局经验(DRC 教训):板奇窄(20.32mm),正面被 1.47" 屏整块占满 ——
 * 其余元件一律 layer="bottom"。三个硬约束互相咬合:
 * - 屏幕拟合封装旋转 90° 让焊盘落在上下短边,否则侧列焊盘与 P1/P2 排针
 *   通孔报跨层 pcb_footprint_overlap(通孔贯穿两层,SMT 顶底之间反而不查);
 * - 排针 y=-4.3 让端部孔与屏幕焊盘行(y≈±15.9)保持 ≥0.1mm 间隙;
 * - BOOT/RESET 用 smdpushbutton(实物本就是贴片侧按)竖贴左右板边,
 *   THT pushbutton 的 7×9 courtyard 在此板宽下与 USB 座无解;
 *   0.4/0.5mm 间距的 QFN/LGA 参数化封装自身撞 pad 间隙 DRC(<0.1mm),
 *   U2/U3 以同外形的 soic8_w3mm_p0.8mm / soic6_w2.5mm_p1mm 拟合。
 */
import type { HardwareBoardTemplate } from './types'
// 板模板正文与真实模组封装均为构建期 ?raw 内嵌(Rsbuild JS_RAW 规则只认 JS 族
// 扩展名,故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译)
import boardTsxRaw from '../esp32c3-board.tsx?raw'
import moduleTsx from '../esp32-c3-mini.tsx?raw'
import type { EnclosureParams } from '../../../shared/ipc-types'

/**
 * ESP32-C3-LCD-1.47 无官方成品外壳(裸板 + 4×M2 安装孔),按通用参数出一个
 * 可打印保护壳:壁厚 2 / 板边间隙 1 / 圆角 3,顶盖按 SCREEN1 开窗。
 * - 北壁 USB-C 开口(9.2×3.6 圆角 1.6,孔心近板面高度)
 * - 东/西壁各一个侧按键开口(4×2.5 圆角 1),对准板上 SW1/SW2(y≈+11,
 *   即沿壁自中心偏移 11;east/west 壁的 port.x 正向取板 +y 方向)
 * port 坐标约定见 renderer/hardware/three/enclosureBuilder.ts:
 * port.x = 沿壁自壁中心的偏移,port.y = 距底盒内腔地面的高度
 */
const WAVESHARE_C3_LCD147_ENCLOSURE: EnclosureParams = {
  wallMM: 2,
  clearanceMM: 1,
  baseHeightMM: 12,
  lidHeightMM: 3,
  standoffHeightMM: 4,
  standoffOuterR: 3,
  standoffInnerR: 1.1,
  cornerR: 3,
  screenWindow: true,
  colorHex: '#f2f2f4',
  ports: [
    { wall: 'north', x: 0, y: 3, w: 9.2, h: 3.6, r: 1.6 },
    { wall: 'west', x: 11, y: 3, w: 4, h: 2.5, r: 1 },
    { wall: 'east', x: 11, y: 3, w: 4, h: 2.5, r: 1 }
  ]
}

function readme(name: string, chip: string): string {
  return `# ${name}

PixelBox 硬件设计工程(tscircuit PCB + 可 3D 打印参数化外壳;默认目标芯片 \`${chip}\`)。

默认模板 1:1 复刻 **微雪 ESP32-C3-LCD-1.47** 开发板
(官方资料:<https://docs.waveshare.net/ESP32-C3-LCD-1.47>):
1.47 英寸 IPS 172×320 屏(ST7789T,无触摸)+ ESP32-C3FH4(叠封 4MB Flash)
+ CH32V003 扩展 IO + QMI8658 六轴 IMU + TF 卡座,板 20.32×36.37mm,
顶边 USB-C、左右侧边 BOOT/RESET 侧按键(无官方成品外壳,模板配通用打印壳)。

## 目录结构

- \`design/board.tsx\` — PCB 电路(tscircuit;IDE 硬件面板实时预览 PCB / 原理图 / 3D)
- \`design/esp32-c3-mini.tsx\` — 真实 ESP32-C3-MINI-1 模组封装(53 个 datasheet
  引脚 + EPAD 阵列共 61 焊盘;由乐鑫官方 kicad_mod 转换,见文件头;
  board.tsx 相对导入使用)
- \`design/enclosure.scad\` — 外壳源码(OpenSCAD,外壳即代码;IDE 硬件面板即时编译渲染)
- \`tsconfig.json\` — TS 配置(jsx: react-jsx,与 IDE 编辑器一致)
- \`export/\` — STL / Gerber 导出目录(已 .gitignore)

> 编辑 \`design/board.tsx\` 时,\`<board>\`/\`<chip>\` 等 tscircuit 元素与属性的
> 补全 / 悬停 / 类型检查由 IDE 内置注入(无需 \`node_modules\`);
> 若要在 IDE 外独立跑 \`npx tsc\`,需自行安装 \`@tscircuit/core\` 等依赖。

## 默认板卡(微雪 ESP32-C3-LCD-1.47 复刻)

20.32×36.37mm 窄长板,元件对照官方原理图各功能块:

| 元件 | 对应原理图块 / 真实硬件 | 位置 |
|---|---|---|
| \`SCREEN1\` | LCD:1.47" IPS 172×320(ST7789T,SPI;可视区约 17.39×32.35mm) | 正面 |
| \`U1\` | MCU:ESP32-C3-MINI-1 真实模组封装(等代实板 C3FH4 裸片+晶振+陶瓷天线,IO 可按名连线,如 \`.U1 > .IO9\`) | 背面南半(天线朝板底) |
| \`U2\` | EXIO:CH32V003F4U6 扩展 IO(I2C 0x24;EXIO0/1=LCD_CS/RST,EXIO2=SD_CS,PC3=背光 PWM) | 背面中带 |
| \`U3\` / \`U4\` | IMU:QMI8658 六轴(INT1→GPIO2)/ POWER:MP1605 DC-DC 5V→3V3 | 背面中带 |
| \`D1\` / \`Q1\` | POWER:MBR230 肖特基 VBUS→VSYS / LCD-BL:背光驱动三极管 | 背面北带 |
| \`TF1\` | SD CARD:microSD 卡座(SPI 与屏共总线,MISO=GPIO6,CS=EXIO2) | 背面中部 |
| \`SW1\` / \`SW2\` | KEY:BOOT(GPIO9,R1 10K 上拉)/ RESET(CHIP_EN) 贴片侧按 | 左/右侧板边 |
| \`USB1\` | Type-c:USB-C 16P(D-→GPIO18,D+→GPIO19,内置 USB-Serial-JTAG) | 顶边 |
| \`P1\` / \`P2\` | GPIO:1×9 P2.54 排针焊盘(P2 右排为 EXIO4~7,wiki 引脚图误标 GPIO4~7) | 两长边 |

I2C 总线(SCL=GPIO3 / SDA=GPIO4)由 U2 与 U3 共用;LCD/SD 共 SPI
(MOSI=GPIO5 / CLK=GPIO7)。名字以 \`SCREEN\` 开头的元件被识别为屏幕:
3D 视图把模拟器画面贴到该区域,外壳顶盖按它开窗;删改元件后保存即自动重新评估。

## 屏幕分辨率对应

实机屏幕为 **172×320**(1.47" IPS,ST7789T;wiki 规格表的 ST7798 为笔误);
「添加到模拟器」注册设备档案时,建议屏幕宽高填 **172×320**,与实物像素一一对应。

## 工作流

在 IDE 打开本目录 → 左侧 rail「硬件设计」面板:
运行设计(eval)→ 2D/3D 预览与爆炸视图 → 导出 STL(切片后经 OctoPrint/Moonraker 上传打印)
或导出 Gerber(交付制板);「添加到模拟器」可把板卡+外壳注册为虚拟设备档案。
`
}

export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip: 'esp32c3',
  boardName: 'ESP32-C3-LCD-1.47',
  docsUrl: 'https://docs.waveshare.net/ESP32-C3-LCD-1.47',
  schematicUrl:
    'https://raw.githubusercontent.com/waveshareteam/ESP32-C3-LCD-1.47/main/schematic/ESP32-C3-LCD-1.47.pdf',
  moduleFile: { fileName: 'esp32-c3-mini.tsx', content: moduleTsx },
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure: WAVESHARE_C3_LCD147_ENCLOSURE,
  boardSizeMM: { widthMM: 20.32, heightMM: 36.37, thicknessMM: 1.6 },
  // 与板模板的 SCREEN1(17.39×32.35 可视区居中)一致
  screenRect: { x: 0, y: 0, w: 17.39, h: 32.35 },
  screenResolution: { w: 172, h: 320 },
  readme
}
