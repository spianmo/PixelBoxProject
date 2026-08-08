/**
 * __PROJECT_NAME__ —— 默认硬件工程:微雪 ESP32-P4-WIFI6-Touch-LCD-4.3 复刻板(tscircuit)
 *
 * 依据微雪官方原理图(ESP32-P4-WIFI6-Touch-LCD-4.3)与尺寸图 1:1 归纳:
 * 板 114.4×66.8mm(官方盖板玻璃外形 LENS OD,PCB 与玻璃基本同外形、圆角 R2.5)。
 * 正面为 4.3" IPS 触摸屏(MIPI-DSI 2-lane,480×800 竖屏,横放可视区约
 * 94.4×56.96mm,几乎占满正面),主控与电源/音频/接口全部在背面
 * (layer="bottom";按键为通孔件,同放背面 —— 正面已被屏幕 courtyard 占用)。
 *
 * 主控 U1 为真实 ESP32-P4 QFN104 芯片封装(./esp32-p4,104 引脚 + EP 3×3
 * 共 113 焊盘;P4 无官方 RF 模组,微雪实板同为裸片直贴,GPIO 可按名连线,
 * 如 .U1 > .GPIO35);P4 无片上 WiFi,U2 ESP32-C6-MINI-1 经 SDIO 做
 * ESP-Hosted 协处理器,是功能必需件不可省。其余元件用 footprinter 参数化
 * 封装(soicN_w宽mm_p脚距mm / sot23_6 / pinrowN)拟合真实外形,离线可评估。
 * 注意:U1 courtyard ±5.6mm、屏/CSI 两个 FPC 座横贯板中北部,背面元件环绕
 * 其外,courtyard 重叠会 DRC 报错并跳过自动布线(两两间隙 ≥0.4mm)。
 *
 * 约定:名字以 SCREEN/DISPLAY/LCD/AMOLED/OLED 开头的元件会被识别为屏幕
 * (3D 视图把模拟器画面贴到该区域;外壳顶盖按它开窗)。
 *
 * 原理图布局(schX/schY,与 pcbX/pcbY 相互独立):不写则由 tscircuit 自动
 * 摊成一长条,故全部元件显式定位,分区镜像 PCB 物理布局,主控 U1 居中
 * (符号约 2.6×11.6 单位):北排按键/晶振,西外列电源链,西内列 C6·USB·存储,
 * 东内列屏/摄像头座·Flash·音频,东外列排针·杂件,南排 MIC·喇叭·屏幕。
 */
import { ESP32_P4 } from './esp32-p4'

export default () => (
  <board width="114.4mm" height="66.8mm">
    {/* ================= 正面(top):显示 ================= */}
    {/* 显示块:4.3" IPS 480×800,ST7701S 驱动 + GT911 触摸(两颗 IC 均在屏 FPC
        模组上,PCB 侧对应元件是背面的 30PIN FPC 座 P2);横放可视区 94.4×56.96mm
        (官方尺寸图 AA 区,竖屏分辨率 480(W)×800(H)) */}
    <chip name="SCREEN1" footprint="soic14_w94.4mm_p9.4mm" pcbX={0} pcbY={0} schX={-4.5} schY={-9.2} />

    {/* ================= 背面中央:主控块(原理图 U8)================= */}
    {/* ESP32-P4NRW32 裸片直贴(QFN104 10×10,SiP 叠封 32MB PSRAM):
        乐鑫无官方 P4 RF 模组,用 espressif/kicad-libraries 官方芯片 footprint;
        引脚名以 datasheet v0.7 为准(GPIO0..54 / CHIP_PU / FLASH_* / DSI_* / CSI_* /
        USB_DM/DP / EN_DCDC/FB_DCDC / XTAL_P/N,与微雪原理图符号名有差异见模组文件头) */}
    <ESP32_P4 name="U1" layer="bottom" pcbX={0} pcbY={0} schX={0} schY={0} />

    {/* 时钟块:Y1 40MHz 主晶振(2016 四焊盘,接 XTAL_P/N;soic4 拟合略放大)、
        Y2 32.768kHz RTC 晶振(两焊盘,接 GPIO0/1 = XTAL_32K_N/P,1206 拟合)。
        贴主控西侧短走线;U10 为核压 buck 也须近 U1(EN_DCDC/FB_DCDC 闭环) */}
    <chip name="Y1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={-9.5} pcbY={4} schX={3} schY={7.4} />
    <chip name="Y2" footprint="1206" layer="bottom" pcbX={-9.5} pcbY={-3} schX={6} schY={7.4} />
    {/* 电源块-核心电压(原理图 U5):MP1605GTF-Z buck,产生 ESP_VDD_HP ≈1.2V,
        受 P4 EN_DCDC/FB_DCDC 引脚闭环控制 —— 主控供电环路的一部分,不可省 */}
    <chip name="U10" footprint="sot23_6" layer="bottom" pcbX={-9.5} pcbY={0} schX={-15} schY={-3.6} />

    {/* 存储块-NOR Flash(原理图 U10):GD25Q256EYIGR 32MB,WSON8 8×6,
        接 P4 专用 FLASH_CS/Q/WP/HOLD/CK/D 引脚(非 GPIO 复用),贴主控东侧 */}
    <chip name="U4" footprint="soic8_w6mm_p2.4mm" layer="bottom" pcbX={10} pcbY={0} schX={6.5} schY={-1.8} />

    {/* ================= 背面中北部:屏/摄像头 FPC 座 ================= */}
    {/* 显示-DSI 屏接口:P2 30PIN 0.5mm 后翻盖 FPC 座(MIPI-DSI 2-lane +
        TP I2C/INT/RST + 背光;LCD RESET=GPIO27 经 R60 0R);横放(旋转 90°) */}
    <chip name="P2" footprint="soic30_w5mm_p1.1mm" layer="bottom" pcbX={0} pcbY={11} pcbRotation={90} schX={6.5} schY={4.5} />
    {/* 摄像头接口:J1 15PIN 0.5mm FPC 座(MIPI-CSI,树莓派 OV5647 线序;
        soic16 拟合 15+1 脚差一脚,I2C 经 2.2K 接 GPIO7/8) */}
    <chip name="J1" footprint="soic16_w5mm_p1.4mm" layer="bottom" pcbX={0} pcbY={18.5} pcbRotation={90} schX={6.5} schY={0.5} />
    {/* R1:TP_INT—GPIO2 间的 R35(丝印 NC/0R,默认焊态未确认,GT911 可轮询兜底) */}
    <resistor name="R1" resistance="0" footprint="0402" layer="bottom" pcbX={10.5} pcbY={7} schX={11} schY={-3.5} />
    {/* 电源块-1.8V LDO:RT9193-18GB,VCC_1.8V 供屏 IOVCC,贴屏座旁 */}
    <chip name="U12" footprint="sot23_5" layer="bottom" pcbX={13} pcbY={12} schX={-15} schY={-8.4} />
    {/* 显示-背光升压(原理图 U9):AP3032KTR-G1,BL_EN=GPIO33(R32 0R),
        亮度 LCD_BL_PWM=GPIO26(R43 0R)注入 FB;原理图归东列显示区 */}
    <chip name="U8" footprint="sot23_6" layer="bottom" pcbX={13} pcbY={17} schX={11} schY={5.3} />
    {/* 指示灯:电源 LED,接 3.3V 轨常亮 */}
    <led name="LED1" footprint="0603" layer="bottom" pcbX={20} pcbY={10} schX={11} schY={-6.5} />

    {/* ================= 背面北缘:GPIO 扩展排针 ================= */}
    {/* J3 40PIN 2×20 2.54mm(兼容部分树莓派 HAT:GPIO2-5/7/8/21/22/24/25/28-32/
        34/35/37/38/46-52、USBD±、USB1P1±、5V/3V3);通孔件,置于屏幕可视区外北缘 */}
    <chip name="J3" footprint="pinrow40_rows2" layer="bottom" pcbX={0} pcbY={30.5} schX={11} schY={2} />
    {/* P1 4PIN C6 调试口(TX/RX/IO9/GND,直连 ESP32-C6-MINI-1 的 UART0) */}
    <chip name="P1" footprint="pinrow4" layer="bottom" pcbX={35} pcbY={30.5} schX={11} schY={6.8} />

    {/* ================= 背面西区:无线/电池/电源链 ================= */}
    {/* WIFI6/BLE 块(原理图 U1):ESP32-C6-MINI-1-N4 模组(13.2×12.5 PCB 天线),
        P4 无片上 WiFi,经 SDIO 挂接做 ESP-Hosted 协处理器(CLK=18 CMD=19
        D0-D3=14-17),复位受 P4 GPIO54,GPIO6↔C6_IO2 联络 */}
    <chip name="U2" footprint="soic14_w13.2mm_p2mm" layer="bottom" pcbX={-25} pcbY={8} schX={-10} schY={5.5} />
    {/* 电池接口:J2 MX1.25 2P 锂电池座(3.7V;电量检测 BAT_ADC=GPIO20 1/3 分压) */}
    <chip name="J2" footprint="soic4_w4mm_p2.5mm" layer="bottom" pcbX={-40} pcbY={8} schX={-10} schY={-3.8} />
    {/* RTC 备电:H8 2P 焊盘座,经 B5819WS 肖特基接 P4 VBAT(pin102),仅可充电电池 */}
    <chip name="H8" footprint="pinrow2" layer="bottom" pcbX={-40} pcbY={14} schX={-10} schY={-5.8} />
    {/* 电源块-3.3V 主轨(原理图 U2):MP1658GTF-Z 3A buck,系统 ESP_3V3 */}
    <chip name="U9" footprint="sot23_6" layer="bottom" pcbX={-48} pcbY={2} schX={-15} schY={-1.2} />
    {/* 电源块-锂电充电(原理图 U19):ETA6098 开关型充电(DFN11 以 soic10 拟合) */}
    <chip name="U13" footprint="soic10_w4mm_p0.8mm" layer="bottom" pcbX={-48} pcbY={8} schX={-15} schY={6} />
    {/* 电源块-5V 升压(原理图 U17):SCT12A0DHKR,电池升压 Boost_5V 供 USB OTG/整机
        (QFN21 焊盘,精确封装名未核实,soic10 拟合) */}
    <chip name="U14" footprint="soic10_w4mm_p0.8mm" layer="bottom" pcbX={-48} pcbY={14} schX={-15} schY={3.6} />
    {/* 电源块-开关机(原理图 U20):ECJ23001-4FCBD6,POWER 键长按开关机,
        经 DMP2066LSN 切断 Core_5V(SOT23-6 推测) */}
    <chip name="U15" footprint="sot23_6" layer="bottom" pcbX={-48} pcbY={20} schX={-15} schY={1.2} />

    {/* ================= 背面西南:TF 卡与 USB 转串 ================= */}
    {/* 存储-TF 卡:SD1 推推式卡座(SDIO 3.0:CLK=43 CMD=44 D0-D3=39..42;
        供电经 Q1 AO3401 由 GPIO45 低有效控制),置西板边镜像实板卡槽 */}
    <chip name="SD1" footprint="soic14_w14mm_p2.3mm" layer="bottom" pcbX={-49} pcbY={-15} schX={-10} schY={-8.2} />
    {/* USB to UART 块(原理图 U6):CH343P(QFN16 4×4 以 soic8 拟合),接 P4
        UART0(TXD=GPIO37 RXD=GPIO38),DTR/RTS 经 EMH4T2R 自动下载 */}
    <chip name="U3" footprint="soic8_w4mm_p1mm" layer="bottom" pcbX={-30} pcbY={-20} schX={-10} schY={2.8} />

    {/* ================= 背面南缘:USB 口与按键 ================= */}
    {/* USB-调试口(原理图 H1):Type-C 母座 → CH343P,VBUS 带 LTVS16H5.0 TVS */}
    <chip name="USB1" footprint="soic12_w9mm_p1.2mm" layer="bottom" pcbX={-20} pcbY={-29.5} schX={-10} schY={0.6} />
    {/* 防护块:TVS1 为两 USB VBUS 的 LTVS16H5.0 ×2 + ESD5451N ×3 + SMF5.0CA
        之代表件(0603 示意,实板分散于各接口) */}
    <chip name="TVS1" footprint="0603" layer="bottom" pcbX={-13} pcbY={-29.5} schX={11} schY={-5} />
    {/* USB-OTG(原理图 H2):Type-C 母座,接 P4 专用 USB_DM/DP(pin49/50)高速
        PHY —— 与 S3 板不同,不占 GPIO */}
    <chip name="USB2" footprint="soic12_w9mm_p1.2mm" layer="bottom" pcbX={-6} pcbY={-29.5} schX={-10} schY={-1.6} />
    {/* 按键块:SW1 RESET(拉低 CHIP_PU)、SW2 BOOT(拉低 GPIO35 = P4 下载
        strapping,可兼作用户键,非 S3 的 GPIO0!)、SW3 POWER(接 ECJ23001 KEY
        脚软开关机,不占 GPIO)。通孔件贯穿两层,放背面南缘避开北缘排针 */}
    <pushbutton name="SW1" footprint="pushbutton" layer="bottom" pcbX={10} pcbY={-29} schX={-6} schY={7.4} />
    <pushbutton name="SW2" footprint="pushbutton" layer="bottom" pcbX={20} pcbY={-29} schX={-3} schY={7.4} />
    <pushbutton name="SW3" footprint="pushbutton" layer="bottom" pcbX={30} pcbY={-29} schX={0} schY={7.4} />

    {/* ================= 背面东南:音频链 ================= */}
    {/* 音频-Codec(原理图 U12):ES8311(QFN20 3×3 以 soic8 拟合;I2S MCLK=13
        SCLK=12 LRCK=10 DSDIN=9,控制走共享 I2C GPIO7/8) */}
    <chip name="U5" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={20} pcbY={-8} schX={6.5} schY={-3.8} />
    {/* 音频-AEC ADC(原理图 U14):ES7210 四通道(QFN32 5×5 以 soic10 拟合;
        双麦回声消除,I2S ASDOUT=GPIO11,I2C 地址 0x40) */}
    <chip name="U6" footprint="soic10_w5mm_p1mm" layer="bottom" pcbX={27} pcbY={-8} schX={6.5} schY={-5.8} />
    {/* 音频-功放(原理图 U15):NS4150B 3W D 类,使能 PA_CTRL=GPIO53(高有效) */}
    <chip name="U7" footprint="soic8_w3.9mm_p1.27mm" layer="bottom" pcbX={35} pcbY={-8} schX={6.5} schY={-7.8} />
    {/* 电源块-音频 LDO:RT9193-33PB,A3V3 音频模拟供电 */}
    <chip name="U11" footprint="sot23_5" layer="bottom" pcbX={20} pcbY={-15} schX={-15} schY={-6} />
    {/* 音频-双麦阵列:模拟硅麦 ×2,接 ES7210 MIC1/MIC2 输入,MICBIAS 供电 */}
    <chip name="MIC1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={27} pcbY={-15} schX={-1.5} schY={-9.2} />
    <chip name="MIC2" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={34} pcbY={-15} schX={1.5} schY={-9.2} />
    {/* 音频-扬声器接口:H4 喇叭焊盘/端子 2P(8Ω 2W) */}
    <chip name="H4" footprint="pinrow2" layer="bottom" pcbX={43} pcbY={-15} schX={4.5} schY={-9.2} />

    {/* ================= 走线示例 ================= */}
    {/* BOOT 键 → P4 真实 GPIO35(下载模式 strapping;S3 习惯的 GPIO0 在 P4 上
        是 32.768kHz 晶振脚,勿混淆) */}
    <trace from=".SW2 > .pin1" to=".U1 > .GPIO35" />
    {/* RESET 键:实板拉低 CHIP_PU 且经 ESD5451N 防护 —— CHIP_PU(pin103)与
        GPIO0(pin104)是 QFN104 0.35mm 相邻焊盘,自动布线出线会擦到邻盘报 DRC,
        故示例走线取防护件一段(SW1 → TVS1),CHIP_PU 端留给实际布线时手工处理 */}
    <trace from=".SW1 > .pin1" to=".TVS1 > .pin1" />
    {/* 共享 I2C 总线(触摸/Codec/ADC/摄像头/40PIN 共用)之 SDA 一段:P4 → ES8311 */}
    <trace from=".U1 > .GPIO7" to=".U5 > .pin1" />
    {/* 屏:LCD 复位 GPIO27(经 R60 0R)→ DSI 屏座(引脚序为拟合示意) */}
    <trace from=".U1 > .GPIO27" to=".P2 > .pin7" />
    {/* 触摸:TP_INT 从屏座经 R35(0R/NC)→ GPIO2 */}
    <trace from=".P2 > .pin25" to=".R1 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .GPIO2" />
    {/* UART0 TXD=GPIO37 → CH343P(USB 调试下载链路) */}
    <trace from=".U1 > .GPIO37" to=".U3 > .pin2" />
    {/* 功放使能 PA_CTRL=GPIO53(高有效)→ NS4150B */}
    <trace from=".U1 > .GPIO53" to=".U7 > .pin1" />
    {/* SDIO CLK=GPIO18 → ESP32-C6(ESP-Hosted 协处理器链路) */}
    <trace from=".U1 > .GPIO18" to=".U2 > .pin1" />
  </board>
)
