/**
 * esp32p4 → 微雪 ESP32-P4-WIFI6-Touch-LCD-4.3 复刻板模板
 *
 * 板模板正文在 ../esp32p4-board.tsx(静态 .tsx,头注释含 __PROJECT_NAME__
 * 占位;已经 /tmp/tsc-probe 沙箱以多文件 fsMap 实测:2611 元素含 pcb_board
 * 114.4×66.8 + 36 pcb_component,U1 113 焊盘,SCREEN1 94.4×57 被识别为屏幕,
 * 0 DRC error,schematic 两两包围盒 0 重叠)。
 * 主控 U1 用 ../esp32-p4.tsx 的真实 ESP32-P4 QFN104 芯片封装(113 焊盘;
 * P4 无官方乐鑫 RF 模组,微雪实板同为裸片直贴方案)。
 *
 * 布局经验(DRC 教训):正面被 4.3" 屏占满 —— 其余元件全部 layer="bottom";
 * U1 courtyard ±5.6mm,屏(P2)/摄像头(J1)两个 FPC 座横放在其北侧,40PIN
 * 排针 J3 贴北板缘(屏可视区外),电源链西缘、音频链东南、USB/按键南缘,
 * 彼此 courtyard 留 ≥0.4mm 间隙。CHIP_PU(pin103)与 GPIO0(pin104)为
 * QFN104 0.35mm 相邻焊盘,自动布线出线会擦邻盘报 DRC,示例走线避开该对。
 */
import type { HardwareBoardTemplate } from './types'
// 板模板正文与真实芯片封装均为构建期 ?raw 内嵌(Rsbuild JS_RAW 规则只认 JS 族
// 扩展名,故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译)
import boardTsxRaw from '../esp32p4-board.tsx?raw'
import moduleTsx from '../esp32-p4.tsx?raw'
import type { EnclosureParams } from '../../../shared/ipc-types'

/**
 * 通用参数化外壳(该产品无官方成品壳 —— 官方形态为裸板 + 整面盖板玻璃,
 * 4×M2.5 螺纹铜柱孔距 92×50mm 自装支架;此处按仓库约定给通用壳参数):
 * - 壁厚 2 / 板壁间隙 1 / 外壳圆角 3(实板 PCB 圆角 R2.5,通用壳稍放大)
 * - standoffInnerR 1.25 对应实板 M2.5 铜柱螺孔
 * - 南壁两个 USB-C 开口(9.2×3.6 圆角 1.6,对应 board.tsx 的 USB1 调试口
 *   x=-20 / USB2 OTG x=-6),西壁 TF 卡槽(12×2.4,对应 SD1 y=-15)
 * - batteryMM:底盒内腔 3.7V 锂电占位(40×30×5,仅 3D 展示;实物经 J2 MX1.25)
 * port 坐标约定见 renderer/hardware/three/enclosureBuilder.ts:
 * port.x = 沿壁自壁中心的偏移,port.y = 距底盒内腔地面的高度
 */
const WAVESHARE_P4_43_ENCLOSURE: EnclosureParams = {
  wallMM: 2,
  clearanceMM: 1,
  baseHeightMM: 12,
  lidHeightMM: 3,
  // 6.5:让 5mm 电池以真实厚度放进板下(净空 = 柱高 − 板厚 1.6 ≈ 4.9 + 背面元件
  // 让位;壳外形高度不受柱高影响,板只是在腔内抬高)
  standoffHeightMM: 6.5,
  standoffOuterR: 3,
  standoffInnerR: 1.25,
  cornerR: 3,
  screenWindow: true,
  colorHex: '#2e2e30',
  batteryMM: { w: 40, h: 30, t: 5 },
  ports: [
    { wall: 'south', x: -20, y: 4, w: 9.2, h: 3.6, r: 1.6 },
    { wall: 'south', x: -6, y: 4, w: 9.2, h: 3.6, r: 1.6 },
    { wall: 'west', x: -15, y: 3.5, w: 12, h: 2.4, r: 1 }
  ]
}

function readme(name: string, chip: string): string {
  return `# ${name}

PixelBox 硬件设计工程(tscircuit PCB + 可 3D 打印参数化外壳;默认目标芯片 \`${chip}\`)。

默认模板 1:1 复刻 **微雪 ESP32-P4-WIFI6-Touch-LCD-4.3** 开发板
(官方资料:<https://docs.waveshare.net/ESP32-P4-WIFI6-Touch-LCD-4.3>):
4.3 英寸 IPS 480×800 触摸屏(MIPI-DSI 2-lane,ST7701S + GT911)+
ESP32-P4NRW32(SiP 32MB PSRAM)+ 32MB NOR Flash + ESP32-C6 WiFi6 协处理器,
板 114.4×66.8mm(官方为裸板 + 整面盖板玻璃形态,无成品壳,外壳参数为通用件)。

## 目录结构

- \`design/board.tsx\` — PCB 电路(tscircuit;IDE 硬件面板实时预览 PCB / 原理图 / 3D)
- \`design/esp32-p4.tsx\` — 真实 ESP32-P4 QFN104 芯片封装(104 引脚 + EP 3×3
  共 113 焊盘;转换自乐鑫官方 kicad 库,见文件头;board.tsx 相对导入使用)
- \`design/enclosure.scad\` — 外壳源码(OpenSCAD,外壳即代码;IDE 硬件面板即时编译渲染)
- \`tsconfig.json\` — TS 配置(jsx: react-jsx,与 IDE 编辑器一致)
- \`export/\` — STL / Gerber 导出目录(已 .gitignore)

> 编辑 \`design/board.tsx\` 时,\`<board>\`/\`<chip>\` 等 tscircuit 元素与属性的
> 补全 / 悬停 / 类型检查由 IDE 内置注入(无需 \`node_modules\`);
> 若要在 IDE 外独立跑 \`npx tsc\`,需自行安装 \`@tscircuit/core\` 等依赖。

## 默认板卡(微雪 ESP32-P4-WIFI6-Touch-LCD-4.3 复刻)

114.4×66.8mm 横板,元件对照官方原理图各功能块(括号内为实板原理图位号):

| 元件 | 对应原理图块 / 真实硬件 | 位置 |
|---|---|---|
| \`SCREEN1\` | 4.3" IPS 480×800(MIPI-DSI 2-lane,ST7701S+GT911 在屏 FPC 模组上;横放可视区约 94.4×56.96mm) | 正面 |
| \`U1\`(U8) | ESP32-P4NRW32 真实 QFN104 封装(113 焊盘,GPIO 可按名连线,如 \`.U1 > .GPIO35\`) | 背面中央 |
| \`U2\`(U1)/ \`P1\` | ESP32-C6-MINI-1-N4 WiFi6/BLE 协处理器(SDIO:CLK=18 CMD=19 D0-D3=14-17,复位 GPIO54)/ C6 UART 4PIN 排针 | 背面西 / 北缘 |
| \`U4\`(U10)/ \`SD1\` | 存储:GD25Q256E 32MB NOR(专用 FLASH_* 脚)/ microSD 卡座(SDIO 3.0,电源开关 GPIO45) | 背面 / 西板边 |
| \`P2\` / \`J1\` | 30PIN DSI 屏 FPC 座(LCD RST=GPIO27,TP RST=GPIO23/INT=GPIO2)/ 15PIN CSI 摄像头 FPC 座(OV5647 线序) | 背面中北 |
| \`U8\`(U9)/ \`U12\` | 显示配套:AP3032 背光升压(BL_EN=GPIO33,PWM=GPIO26)/ RT9193-18 屏 IOVCC 1.8V | 背面 |
| \`U5\`(U12)/ \`U6\`(U14)/ \`U7\`(U15) | 音频:ES8311 codec(I2S 9-13)/ ES7210 双麦 AEC ADC / NS4150B 功放(PA_CTRL=GPIO53) | 背面东南 |
| \`MIC1\`/\`MIC2\`/\`H4\`/\`U11\` | 双硅麦阵列 / 喇叭端子(8Ω 2W)/ RT9193-33 音频 LDO | 背面东南 |
| \`U9\`(U2)/ \`U10\`(U5) | 电源:MP1658 3.3V 主轨 buck / MP1605 核压 buck(EN_DCDC/FB_DCDC 闭环,不可省) | 背面西缘 / 主控旁 |
| \`U13\`(U19)/ \`U14\`(U17)/ \`U15\`(U20) | 电池电源:ETA6098 充电 / SCT12A0 5V 升压 / ECJ23001 软开关机 | 背面西缘 |
| \`J2\` / \`H8\` | MX1.25 锂电池座(BAT_ADC=GPIO20 1/3 分压)/ RTC 备电座(B5819WS → VBAT) | 背面西 |
| \`U3\`(U6)/ \`USB1\`(H1)/ \`USB2\`(H2) | CH343P USB 转串(UART0=GPIO37/38)/ Type-C 调试口 / Type-C OTG(专用 USB_DM/DP,非 GPIO) | 背面南缘 |
| \`J3\` | 40PIN 2×20 排针(兼容部分树莓派 HAT) | 背面北缘 |
| \`SW1\`/\`SW2\`/\`SW3\` | 按键:RESET(CHIP_PU)/ BOOT(GPIO35 strapping,可兼用户键;非 S3 的 GPIO0)/ POWER(接 ECJ23001,不占 GPIO) | 背面南缘 |
| \`Y1\`/\`Y2\`/\`TVS1\`/\`LED1\`/\`R1\` | 40MHz 主晶振 / 32.768kHz RTC 晶振(GPIO0/1)/ USB·ESD 防护代表件 / 电源指示灯 / TP_INT 的 R35(0R/NC) | 背面 |

名字以 \`SCREEN\` 开头的元件被识别为屏幕:3D 视图把模拟器画面贴到该区域,
外壳顶盖按它开窗;删改元件后保存即自动重新评估。

## 屏幕分辨率对应

实机屏幕为 **480×800**(4.3" IPS 竖屏,横放显示时由软件旋转);
「添加到模拟器」注册设备档案时,建议屏幕宽高填 **480×800**,
与实物像素一一对应。

## 工作流

在 IDE 打开本目录 → 左侧 rail「硬件设计」面板:
运行设计(eval)→ 2D/3D 预览与爆炸视图 → 导出 STL(切片后经 OctoPrint/Moonraker 上传打印)
或导出 Gerber(交付制板);「添加到模拟器」可把板卡+外壳注册为虚拟设备档案。
`
}

export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip: 'esp32p4',
  boardName: 'ESP32-P4-WIFI6-Touch-LCD-4.3',
  docsUrl: 'https://docs.waveshare.net/ESP32-P4-WIFI6-Touch-LCD-4.3',
  schematicUrl: 'https://www.waveshare.net/w/upload/b/b8/ESP32-P4-WIFI6-Touch-LCD-4.3-schematic.pdf',
  moduleFile: { fileName: 'esp32-p4.tsx', content: moduleTsx },
  boardTsx: (name) => boardTsxRaw.replace('__PROJECT_NAME__', name),
  enclosure: WAVESHARE_P4_43_ENCLOSURE,
  boardSizeMM: { widthMM: 114.4, heightMM: 66.8, thicknessMM: 1.6 },
  // 与板模板的 SCREEN1(94.4×56.96 可视区居中,横放)一致
  screenRect: { x: 0, y: 0, w: 94.4, h: 56.96 },
  screenResolution: { w: 480, h: 800 },
  readme
}
