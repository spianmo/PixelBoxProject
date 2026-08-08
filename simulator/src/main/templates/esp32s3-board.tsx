/**
 * __PROJECT_NAME__ —— 默认硬件工程:微雪 ESP32-S3-Touch-AMOLED-2.16 复刻板(tscircuit)
 *
 * 依据微雪官方原理图(ESP32-S3-Touch-AMOLED-2.16)与外壳尺寸图 1:1 归纳:
 * 板 40×40mm(装入 46×46×22.5mm 白色圆角外壳:40 + 2×1 间隙 + 2×2 壁厚 = 46)。
 * 正面为 2.16" AMOLED 触摸屏(480×480,可视区约 39×39mm,占满整个正面),
 * 主控与电源/音频/传感器集中在背面(layer="bottom";按键为通孔件、侧向按压,
 * 同样放背面 —— 正面已被屏幕 courtyard 整块占用,顶层再放元件会 DRC 报错)。
 *
 * 主控 U1 为真实 ESP32-S3-MINI-1-N8 模组封装(./esp32-s3-mini,65 引脚 +
 * GND 散热盘共 73 焊盘,IO 引脚可按名字连线,如 .U1 > .IO0);其余元件用
 * footprinter 参数化封装(soicN_w宽mm_p脚距mm)拟合真实外形,离线可评估。
 * 注意:模组 courtyard 约 16.6×21mm(北端含 PCB 天线区),背面其余元件
 * 须环绕其外,courtyard 重叠会 DRC 报错并跳过自动布线。
 *
 * 约定:名字以 SCREEN/DISPLAY/LCD/AMOLED/OLED 开头的元件会被识别为屏幕
 * (3D 视图把模拟器画面贴到该区域;外壳顶盖按它开窗)。
 *
 * 原理图布局(schX/schY,与 pcbX/pcbY 相互独立):不写则由 tscircuit 自动
 * 摊成一长条,故全部元件显式定位,分区镜像 PCB 物理布局,主控 U1 居中:
 * 北排按键 / 西列电源·SD·ADC / 东列存储·RF·传感·功放 / 南排 MIC·电池·USB·Codec。
 */
import { ESP32_S3_MINI_1_N8 } from './esp32-s3-mini'

export default () => (
  <board width="40mm" height="40mm">
    {/* ================= 正面(top):显示 ================= */}
    {/* 屏幕块:2.16" AMOLED 480×480,驱动 CO5300(QSPI)+ 触摸 CST9220(I2C);
        可视区约 39×39mm 占满正面(对应外壳尺寸图 38.99×38.99 可视区) */}
    <chip name="SCREEN1" footprint="soic14_w39mm_p6.4mm" pcbX={0} pcbY={0} schX={-5.5} schY={3.4} />

    {/* ================= 北侧板边:按键(KEYS 块) ================= */}
    {/* 三颗侧按键,间距 10mm,对应外壳顶面三个 Φ5.3 圆钮(尺寸图 10.00/10.00):
        SW1 = +/KEY(BSS138 电平转换到 GPIO6),SW2 = PWR(AXP2101 PWRON),
        SW3 = BOOT/-(GPIO0)。通孔件贯穿两层,放背面避开正面屏幕 */}
    {/* 原理图行序 SW1,SW3,SW2(SW3 与 SW2 对调):SW3→IO0 的走线需在 x≈-2.3 净空区
        垂直下行 —— 放最东侧时其拐角会擦过 SW2 引脚端点与 U1 左列 GND/3V3 端点,视觉误读为短接 */}
    <pushbutton name="SW1" footprint="pushbutton" layer="bottom" pcbX={-10} pcbY={16} schX={-3.6} schY={5.4} />
    <pushbutton name="SW2" footprint="pushbutton" layer="bottom" pcbX={0} pcbY={16} schX={0.4} schY={5.4} />
    <pushbutton name="SW3" footprint="pushbutton" layer="bottom" pcbX={10} pcbY={16} schX={-1.6} schY={5.4} />
    {/* R1:按键上拉 10kΩ(原理图 KEYS 块 R4/R9/R10 之代表) */}
    <resistor name="R1" resistance="10k" footprint="0402" layer="bottom" pcbX={-15.6} pcbY={16} schX={-5.6} schY={5.4} />

    {/* ================= 背面(bottom)中央:主控 ================= */}
    {/* 主控块:ESP32-S3-MINI-1-N8 真实模组(内封 S3 + 8MB Flash + PCB 天线;
        实板为 S3R8 裸片方案,此处以官方模组封装等代,引脚名与原理图一致:
        IO0..IO48 / EN / TXD0/RXD0(UART0 烧录调试口)/ 3V3 / GND 散热盘) */}
    <ESP32_S3_MINI_1_N8 name="U1" layer="bottom" pcbX={0} pcbY={-2} schX={0} schY={0} />

    {/* ================= 背面东列(x≥9,自北向南) ================= */}
    {/* 存储块:XM25QH128 16MB QSPI Flash(SOIC8 208mil) */}
    <chip name="U2" footprint="soic8_w5.2mm_p1.27mm" layer="bottom" pcbX={12} pcbY={8.5} schX={5.5} schY={3.9} />
    {/* 射频:J2 IPEX 天线座(与模组板载天线经 RF 开关切换) */}
    <chip name="J2" footprint="soic4_w3.5mm_p1.6mm" layer="bottom" pcbX={17.3} pcbY={8.5} schX={5.5} schY={2.5} />
    {/* 6/9-Axis 块:QMI8658A 六轴 IMU(I2C 地址 0x6B,姿态/敲击检测) */}
    <chip name="U5" footprint="soic6_w2.5mm_p1mm" layer="bottom" pcbX={12} pcbY={3} schX={5.5} schY={1.2} />
    {/* RTC 块:PCF85063ATL 实时时钟 + 32.768kHz 晶振(I2C,VCC-RTC 掉电保持) */}
    <chip name="U4" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={17} pcbY={3} schX={5.5} schY={-0.3} />
    {/* 触摸块:TP1 CST9220 触摸控制器(实物贴在屏幕 FPC 上,I2C GPIO14/15,此处示意) */}
    <chip name="TP1" footprint="soic6_w2.5mm_p1mm" layer="bottom" pcbX={12} pcbY={-2} schX={5.5} schY={-1.8} />
    {/* PA&SPEAKER 块:NS4150B 3W D 类功放(驱动外接喇叭) */}
    <chip name="U8" footprint="soic8_w3.9mm_p1.27mm" layer="bottom" pcbX={12} pcbY={-7.5} schX={5.5} schY={-3.3} />

    {/* ================= 背面西列(x≤-10,自北向南) ================= */}
    {/* 电源块:AXP2101 PMU(QFN32 4×4,锂电充放电/多路 LDO/电量计) */}
    <chip name="U3" footprint="soic10_w4mm_p0.8mm" layer="bottom" pcbX={-13} pcbY={8.7} schX={-5.5} schY={1.2} />
    {/* SD-CARD 块:microSD 卡座(SPI),对应外壳西侧壁卡槽(尺寸图 8.30 基准);
        竖放(旋转 90°)以避开模组 courtyard */}
    <chip name="SD1" footprint="soic14_w12mm_p1.4mm" layer="bottom" pcbX={-14.5} pcbY={-0.5} pcbRotation={90} schX={-5.5} schY={-1.1} />
    {/* ADC 块:ES7210 四通道拾音 ADC(双 MEMS 麦克风 + 回声消除 AEC 参考) */}
    <chip name="U7" footprint="soic10_w4mm_p0.8mm" layer="bottom" pcbX={-16} pcbY={-10} pcbRotation={90} schX={-5.5} schY={-3.3} />

    {/* ================= 背面南排(y≤-12,自西向东) ================= */}
    {/* MIC 块:双 MEMS 麦克风(拾音孔朝背面,左右各一,配合 ES7210 做 AEC) */}
    <chip name="MIC1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={-16} pcbY={-15} schX={-5.5} schY={-5.8} />
    {/* POWER Supply 块:J1 电池座 MX1.25(GH1.25 2P,接 3.7V 锂电,AXP2101 BAT) */}
    <chip name="J1" footprint="soic4_w4mm_p2.5mm" layer="bottom" pcbX={-8} pcbY={-15.5} schX={-3.4} schY={-5.8} />
    {/* USB 块:Type-C(烧录/供电,带 TVS ESD 保护),对应外壳南侧壁开口(尺寸图 8.60 基准);
        UART0 烧录走模组 TXD0/RXD0(经 USB 转串或 S3 内置 USB-JTAG) */}
    <chip name="USB1" footprint="soic12_w9mm_p1.2mm" layer="bottom" pcbX={0} pcbY={-16} schX={-1.2} schY={-5.8} />
    {/* Codec 块:ES8311 音频编解码(I2S 播放 + ADC 参考) */}
    <chip name="U6" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={7.3} pcbY={-14} schX={1.2} schY={-5.8} />
    <chip name="MIC2" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={16} pcbY={-14} schX={3.4} schY={-5.8} />

    {/* ================= 走线示例 ================= */}
    {/* 共享 I2C 总线(ESP32_SDA/SCL)之一段:RTC ↔ IMU */}
    <trace from=".U4 > .pin1" to=".U5 > .pin1" />
    {/* 音频链路示意:ES8311 codec → NS4150B 功放 */}
    <trace from=".U6 > .pin1" to=".U8 > .pin1" />
    {/* 按键上拉:SW1(+/KEY)→ R1 10kΩ */}
    <trace from=".SW1 > .pin1" to=".R1 > .pin1" />
    {/* BOOT 按键 → 模组真实 IO0 引脚(按住上电进下载模式) */}
    <trace from=".SW3 > .pin1" to=".U1 > .IO0" />
    {/* 触摸中断 → 模组 IO15(示意;真实引脚可按名字任选 .U1 > .IOxx) */}
    <trace from=".TP1 > .pin1" to=".U1 > .IO15" />
  </board>
)
