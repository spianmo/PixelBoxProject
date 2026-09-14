/** 自主主控设计；官方 PDF 重建另存为 esp32s3-official，默认不加载数百个定位标记。 */
import type { HardwareBoardTemplate } from './types'
import { centers, ports, enclosure as originalEnclosure, screenRect } from './esp32s3-exterior'
import boardRaw from '../esp32s3-board.tsx?raw'
import moduleRaw from '../esp32-s3-wroom.tsx?raw'
import routesRaw from '../esp32s3-routes.ts?raw'
import netlist from '../esp32s3-netlist.json'

const boardSizeMM = { widthMM:41, heightMM:41, thicknessMM:1.6 }
// 只调整内部螺柱导孔：原 2.2 mm 通孔无法咬合 M2 自攻螺钉，外形和中心距不变。
const enclosure = { ...originalEnclosure, standoffInnerR: .85 }
export const BOARD_TEMPLATE: HardwareBoardTemplate = {
  chip:'esp32s3', boardName:'PixelBox ESP32-S3 主控扩展板',
  docsUrl:'https://documentation.espressif.com/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf',
  schematicUrl:'https://docs.waveshare.net/ESP32-S3-Touch-AMOLED-2.16',
  moduleFile:{fileName:'esp32-s3-wroom.tsx',content:moduleRaw},
  extraFiles:[{fileName:'routes.ts',content:routesRaw},{fileName:'design-netlist.json',content:JSON.stringify(netlist,null,2)+'\n'}],
  boardTsx:name=>boardRaw.replace('__PROJECT_NAME__',name),
  enclosure, boardSizeMM, screenRect, screenResolution:{w:480,h:480},
  reference:{
    schemaVersion:1,kind:'functional',source:netlist.source,
    board:{...boardSizeMM,status:'自主双层板；所有电源、下载和扩展端口采用可制造封装'},
    enclosure:{widthMM:46,depthMM:46,heightMM:22.5,cornerRMM:5.8},
    screen:{...screenRect,outerMM:43.3,visibleCornerRMM:4.7},
    mounting:{centers,target:'enclosure',status:'PCB 四个直径 2.4 mm 非金属孔，与外壳 M2 螺柱同轴'},
    ports:ports.map((p,i)=>({...p,name:i<3?`button${i+1}`:i===3?'USB-C':i===4?'microSD':`speaker${i-4}`,status:'保留原外观开口；接口小板与按钮需另行装配'})),
    electrical:{components:17,pins:111,nets:netlist.nets.length,sha256:netlist.sha256},
    fabrication:{footprints:'verified',routing:'reconstructed',drills:'verified'},
    componentBodies:{
      U1:{w:18,h:19.2,heightMM:3.2,offsetY:.62,kind:'chip'},
      U2:{heightMM:1.45},
      ...Object.fromEntries(['C1','C2','C3','C4','R1','R2','R3','R4'].map(n=>[n,{heightMM:1.3}])),
      ...Object.fromEntries([4,9,6,9,9,2,2].map((pins,i)=>[`J${i+1}`,{w:i===3||i===4?(pins-1)*1.27+1.8:1.8,h:i===3||i===4?1.8:(pins-1)*1.27+1.8,heightMM:6.5,oppositeHeightMM:1.5,kind:'connector' as const}]))
    },
    rules:{minTraceMM:.2,minDrillMM:.3,minAnnularRingMM:.15},
    unverified:['保留原外观不代表 USB/SD/三键已电气集成；本主控板仍需接口小板、屏幕电源转接与壳内天线，整机功能未验证', '尚未实物制板、焊接与通电验证；软件检查不能代替首板调试', '屏幕窗口按 2.16 英寸玻璃尺寸预留，需带电源的 QSPI 显示转接板及触摸转接线，J2 不能直接接裸 FPC', '未集成音频、IMU、RTC、SD 与电池管理；保留 GPIO/I2C 扩展，不可直接刷官方整机固件', '首次 QSPI 调试从 5 MHz 开始；当前排针与长线不承诺 40 MHz 信号完整性']
  },
  readme:(name)=>`# ${name}

ESP32-S3 主控扩展板：16 MB Flash + 8 MB PSRAM，41×41 mm、R3.3 双层 PCB，保留原先 46×46×22.5 mm、R5.8 外壳。屏幕居中、右侧三键、左 USB、上侧 SD 和下侧六条透声孔不变。

这是自主主控设计，不是微雪整机复刻。包含正式模组焊盘、AP2112K 3.3V 稳压、去耦、EN 的 10k/1uF RC、BOOT 上拉、I2C 上拉、四个安装孔及确定的双层走线。IDE 运行设计后检查真实铜连接、DRC、钻孔和网表，再导出 Gerber/Excellon 与校验报告。

## 接线（从焊盘 pin1 起）

| 接口 | 引脚顺序 | 用途 |
| --- | --- | --- |
| J1 | 5V, GND, TXD, RXD | 5V 稳压输入；TXD 接下载器 RX，RXD 接下载器 TX；UART 电平必须为 3.3V |
| J2 | 5V, GND, IO4, IO5, IO6, IO7, IO38, IO12, IO39 | QSPI 转接板 D0/D1/D2/D3/CLK/CS/RST；5V 只供转接板电源，信号为 3.3V |
| J3 | GND, 3V3, IO15, IO14, IO11, IO40 | I2C SDA/SCL、触摸 INT/RST；上拉已装 |
| J4 | GND, IO16, IO17, IO18, IO8, IO9, IO10, IO13, IO21 | 外设扩展 |
| J5 | GND, IO42, IO45, IO46, IO47, IO48, IO41, IO1, IO2 | 外设扩展，启动绑带 IO45/46 上电时不得被外部拉高 |
| J6 | EN, GND | 瞬间短接复位，可外接常开按钮 |
| J7 | BOOT, GND | 按住 BOOT，再短接/松开 J6，最后松开 BOOT 进入下载 |

## BOM 与装配

- U1：ESP32-S3-WROOM-1U-N16R8；18×19.2 mm，禁止用无 PSRAM 型号或带 PCB 天线的 WROOM-1 替换。IO35/36/37 预留给模组 PSRAM。1U 必须连接兼容 IPEX 的 2.4 GHz 同轴天线；天线型号、壳内固定位置与整机射频性能尚未验证，当前不能视为已完成无线整机。
- U2：AP2112K-3.3TRG1，SOT-25（1 VIN、2 GND、3 EN、4 NC、5 VOUT）。
- C1/C2：10uF，0805，X5R/X7R，额定 10V 或更高；C3：100nF，0603，X7R；C4：1uF，0603，X5R。
- R1/R2：10k，0603；R3/R4：4.7k，0603。
- J1..J7：1.27mm 单排直针，针数 4/9/6/9/9/2/2；方针边长不超过 0.4mm，钻孔 0.65mm，焊盘直径 1.0mm。塑壳宽 1.8mm，含配对插座/线束的板上总高不得超过 6.5mm，板下焊脚剪至 1.5mm 内。J4/J5 横向，其余纵向；不可沿用原大板 2.54mm 排针。
- 双层 FR4 1.6mm，1oz 铜；电源/地线 0.4mm、信号线 0.25mm，制造下限 0.2mm；过孔 0.3/0.6mm，安装孔 2.4mm NPTH。
- 原开口保留：右三键、左 USB、上 SD、下透声孔。当前 PCB 是主控扩展板，这些接口与按钮并未自动变成可工作的整机；需要按原孔位设计接口小板与内部线束。不得为装下这些部件改变外壳。
- 四颗 M2 塑料用自攻螺钉固定 PCB；螺柱中心保持 (±17, ±18.5)mm，内部导孔直径改为 1.7mm，按实际打印材料先试装；头部直径不得超过 4mm、头高不超过 1.6mm。PCB 板底 9.9mm、板顶 11.5mm。板角与壳内圆角同心，轮廓保留 0.5mm 间隙。

## 首板调试

1. 不焊 U1 时检查 5V/GND/3V3 无短路，限流 100mA 上电，测 U2 输出 3.3V、EN 为高。
2. 焊 U1 与其九个散热焊盘，限流提高到 500mA；AP2112K 的持续负载与温升须实测，J3 外设先控制在 50mA 内，屏幕由 J2 的 5V 输入侧供电。
3. 使用 3.3V USB-UART；按 J7/J6 下载时序，运行 esptool 的 chip-id/flash-id，再用 ESP-IDF hello_world 验证启动日志；设置 Flash 16MB、Octal PSRAM 8MB。
4. I2C GPIO15/14 扫描外设。显示信号保留微雪 GPIO，需另外连接包含屏幕供电电路的 CO5300 QSPI 转接板，先从 5MHz 验证色条与触摸，不能把裸屏 FPC 直接接 J2。
5. 音频/IMU/RTC/SD/电池管理未板载；原微雪固件含 AXP2101 等必选初始化，不能作为本板首次启动程序。

## 在 IDE 编辑和导出

- board.tsx：电路与封装位置；routes.ts：路径坐标（相对起点元件原点）、线宽与换层。移动封装后同步调整路径，运行设计会检查断线/短路。
- design-netlist.json：本设计的电气基准；设计变更时审阅并更新，不能为掩盖漏线而直接删基准。
- reference.json：尺寸与制造规则；enclosure.scad：唯一结构源，支持编辑、预览、分件导出 STL、外部切片器生成 G-code 后上传。
- 先导出底壳/顶盖 STL 试装，再配置实际打印机的切片器与 INI。未执行实体打印或首板上电测试。
`
}
