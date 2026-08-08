/**
 * __PROJECT_NAME__ —— 默认硬件工程:微雪 ESP32-C6-Touch-AMOLED-2.16 复刻板(tscircuit)
 *
 * 依据微雪官方原理图(ESP32-C6-Touch-AMOLED-2.16-Schematic.pdf)与结构图 1:1 归纳:
 * 板 43×43mm(估算:官方只公布成品外壳外形 46×46×22.5、圆角 R5.8,未公布裸 PCB
 * 尺寸;屏模组外形 OD 43.30mm 是板上最大刚性件,按其取整 43×43,并恰与外壳参数
 * 还原外形:板 43 + 2×间隙 0.5 + 2×壁厚 1 = 46)。正面为 2.16" AMOLED 触摸屏(480×480,
 * 可视区 38.99×38.99mm ≈ 39×39,占满正面),主控与电源/音频/传感集中在背面
 * (layer="bottom";三颗侧按键对应外壳右墙三个 Φ5.3 圆孔,为通孔件同样放背面 ——
 * 正面已被屏幕 courtyard 整块占用,顶层再放元件会 DRC 报错)。
 *
 * 主控取舍:实板为裸 ESP32-C6 QFN40(U2 丝印 esp32-c6)+ 外置 XM25QH128D 16MB
 * Flash + 40MHz 晶振 + RF 匹配,复刻用真实 ESP32-C6-MINI-1 模组封装等效
 * (./esp32-c6-mini,31 信号引脚 + GND 散热盘/角盘共 61 焊盘,IO 可按名连线,
 * 如 .U1 > .IO9);模组自带 4MB Flash 与天线,U2/X1/ANT1 仍按原理图落件作背面
 * 陪衬,还原丝印观感。模组 courtyard 13.6×17mm(北端含天线净空区),置于 (0,2)
 * 后占 x∈[-6.8,6.8]、y∈[-6.5,10.5],其余背面元件环绕其外(courtyard 重叠会
 * DRC 报错并跳过自动布线,两两留 ≥0.4mm 间隙)。
 *
 * 关键 GPIO(与官方 gitee demo user_config.h 交叉核对):BOOT=GPIO9、用户键
 * KEY=GPIO10、PWR 键状态=GPIO18(经 BSS138 反相)、I2C=GPIO7(SCL)/GPIO8(SDA)、
 * LCD QSPI CS=GPIO15/PCLK=GPIO0/D0..D3=GPIO1/2/3/4(PCLK/D0/D1 与 SD 卡
 * CLK/MOSI/MISO 共享,SD CS=GPIO6)、触摸 INT=GPIO5/RST=GPIO11、
 * I2S=GPIO19/20/21/22/23、UART0=GPIO16/17(背面焊盘,兼 QMI8658 INT)、
 * USB=GPIO12/13。LCD 无复位 GPIO(LCD_RESET 仅 10K 上拉到 AXP ALDO3)。
 *
 * 原理图布局(schX/schY,与 pcbX/pcbY 相互独立):不写则被 tscircuit 自动
 * 摊成一长条,故全部元件显式定位,分区镜像 PCB 物理布局,主控 U1 居中:
 * 北排按键·晶振 / 东列存储·传感·音频 / 远东列 FPC·天线·扩展 / 西列屏·电源·SD·ADC /
 * 南排麦克·电池·USB·喇叭。
 */
import { ESP32_C6_MINI_1 } from './esp32-c6-mini'

export default () => (
  <board width="43mm" height="43mm">
    {/* ================= 正面(top):LCD 块 ================= */}
    {/* 屏幕:2.16" AMOLED 480×480,驱动 CO5300(QSPI,SH8601 寄存器兼容)+
        触摸 CST9220(I2C 0x5A 族,INT=GPIO5/RST=GPIO11);可视区 38.99×38.99
        ≈ 39×39mm 居中占满正面(对应外壳正面屏窗 OD 43.30 / VA 38.99) */}
    <chip name="SCREEN1" footprint="soic14_w39mm_p6.4mm" pcbX={0} pcbY={0} schX={-5.5} schY={3.4} />

    {/* ================= 东侧板边:KEYS 块(外壳右墙三孔) ================= */}
    {/* 三颗侧按轻触开关,间距 10mm,对应外壳右墙 3×Φ5.3 圆孔(结构图垂直间距
        10.00;壳上三键顺序官方未标注,此处自北向南 PWR/KEY/BOOT 为推断):
        SW2 = PWR(接 AXP2101 PWRON,经 RP7 510R,长按关机;键态经 Q1 BSS138
        反相后由 GPIO18 读取)、SW3 = KEY 用户键(GPIO10,R18 10K 上拉)、
        SW1 = BOOT(只接 GPIO9;网表 CHIP_PU 网络 = C15/R9/TP17/U2.EN/AXP PWROK,
        不含任何按键引脚)。通孔件贯穿两层;x=18.2 为板缩 43 后的物理下限——
        按键通孔列在 pcbX±2.25、铜环 Φ1.5,SCREEN1 东侧焊盘列 x∈[18.5,19.5](顶层,
        通孔跨层冲突),内列须整体让到焊盘列以东:18.2+2.25−0.75=19.7 ≥ 19.5+0.1
        清距;courtyard 右缘 21.7 略出板缘 0.2(实物侧键本就探出板缘顶住壳孔) */}
    <pushbutton name="SW2" footprint="pushbutton" layer="bottom" pcbX={18.2} pcbY={10} schX={-1.6} schY={5.6} />
    <pushbutton name="SW3" footprint="pushbutton" layer="bottom" pcbX={18.2} pcbY={0} schX={0.4} schY={5.6} />
    <pushbutton name="SW1" footprint="pushbutton" layer="bottom" pcbX={18.2} pcbY={-10} schX={-3.6} schY={5.6} />
    {/* R1:用户键 KEY 上拉 10kΩ(原理图 KEYS 块 R18) */}
    <resistor name="R1" resistance="10k" footprint="0402" layer="bottom" pcbX={10} pcbY={14} schX={-5.6} schY={5.6} />

    {/* ================= 背面(bottom)中央:MCU 块 ================= */}
    {/* 主控:ESP32-C6-MINI-1 真实模组占位(实板为裸 C6 QFN40 + 外置 16MB Flash,
        C6 无 PSRAM;引脚名与原理图一致:IO0..IO23 / EN / TXD0/RXD0 / 3V3 / GND);
        实板 EN=CHIP_PU 由 AXP2101 PWROK 驱动(该网络另含 C15/R9/TP17,不接按键) */}
    <ESP32_C6_MINI_1 name="U1" layer="bottom" pcbX={0} pcbY={2} schX={0} schY={0} />

    {/* ================= 背面东列(x≈11,自北向南) ================= */}
    {/* FLASH 块:XM25QH128DHIQT 16MB QSPI NOR(SOP8,挂 C6 专用 SPI 引脚;
        模组占位已内置 Flash,此件按原理图落件作陪衬) */}
    <chip name="U2" footprint="soic8_w5.2mm_p1.27mm" layer="bottom" pcbX={11} pcbY={8} schX={5.5} schY={4.2} />
    {/* IMU 块:QMI8658 六轴(LGA14 以 soic6 拟合体量;I2C 0x6B,INT1/INT2 经
        0R 接 GPIO16/17,与 UART0 背面焊盘复用) */}
    <chip name="U5" footprint="soic6_w2.5mm_p1mm" layer="bottom" pcbX={11} pcbY={2} schX={5.5} schY={2.7} />
    {/* RTC 块:PCF85063ATL(HVSON10 3×3 以 soic8 3×3 拟合,省去 EP;I2C,
        VCC-RTC 由 AXP RTCLDO 供电;RTC_INT 仅到测试点未接 GPIO,Y1 32.768kHz 略) */}
    <chip name="U4" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={11} pcbY={-3} schX={5.5} schY={1.2} />
    {/* MCU 块:X1 40MHz 主晶振(2016 封装以 0805 两焊盘拟合;模组内置后作陪衬);
        与 Q1 一同北移 0.3/0.5,给南端 MIC2(随南排上抬)让出 ≥0.4 courtyard 净空 */}
    <chip name="X1" footprint="0805" layer="bottom" pcbX={11} pcbY={-7.7} schX={4.4} schY={5.6} />
    {/* KEYS 块:Q1 BSS138(SOT-23)—— PWR 键(AXP PWRON)状态反相后供 GPIO18 读取 */}
    <chip name="Q1" footprint="sot23" layer="bottom" pcbX={11} pcbY={-11} schX={2.4} schY={5.6} />

    {/* ================= 背面北排(y≥13,自西向东) ================= */}
    {/* LCD 块:CN1 24P FPC 连接器(J4,0.5mm;以 soic24 拟合,竖放贴屏排线出口),
        承载 QSPI 6 线 + TE(仅测试点)+ 触摸 I2C/INT/RST + LCD_RESET(RC 上拉到
        AXP ALDO3,无 GPIO)+ DSI_PWR_EN(10K 上拉常开) */}
    <chip name="CN1" footprint="soic24_w5.3mm_p1mm" layer="bottom" pcbX={-13.5} pcbY={13.4} pcbRotation={90} schX={8} schY={3} />
    {/* RF 块:ANT1 板载 PCB 天线 + IPEX Gen1 座(J2,R48 0R 切换内外天线;
        模组占位后天线在模组上,此件仅外观复刻,置北板缘) */}
    <chip name="ANT1" footprint="soic4_w3.5mm_p1.6mm" layer="bottom" pcbX={-12} pcbY={18.5} schX={8} schY={0.5} />
    {/* SD-CARD 块:microSD 推推式卡座,贴北板缘(对应外壳顶墙插槽开槽);
        SPI 模式 CLK=GPIO0/MOSI=GPIO1/MISO=GPIO2/CS=GPIO6(4 路 10K 上拉,
        与 LCD QSPI 共享 GPIO0/1/2,各自 CS 分离) */}
    <chip name="SD1" footprint="soic14_w12mm_p1.4mm" layer="bottom" pcbX={0} pcbY={16} schX={-5.5} schY={-1.1} />

    {/* ================= 背面西列(x≤-10,自北向南) ================= */}
    {/* POWER 块:U3 AXP2101 PMU(QFN40 4×4 以 soic10 拟合):DCDC1=3.3V 主电、
        ALDO2/3/4 屏电、BLDO2 2.8V;I2C 共享总线;IRQ 仅上拉未接 MCU;
        PWROK→CHIP_PU;充电+电量计(LP1/LP2 1uH、RP2 NTC 10K 略) */}
    <chip name="U3" footprint="soic10_w4mm_p0.8mm" layer="bottom" pcbX={-12} pcbY={6} schX={-5.5} schY={1.2} />
    {/* POWER 块:BAT1 MX1.25(GH1.25)2P 电池座(3.7V 锂电,带电池版 1000mAh) */}
    <chip name="BAT1" footprint="soic2_w4mm_p2mm" layer="bottom" pcbX={-12} pcbY={1} schX={-1.9} schY={-5.8} />
    {/* AUDIO-ADC 块:U7 ES7210 四通道回声消除 ADC(QFN32 5×5 以 soic10 拟合;
        I2C 0x40,接双模拟硅麦差分 + MICBIAS) */}
    <chip name="U7" footprint="soic10_w5mm_p1mm" layer="bottom" pcbX={-12} pcbY={-4} schX={-5.5} schY={-3.3} />
    {/* USB 块:TVS1 LTVS16H5.0ET5G USB 口防护(小封装以 sot23 拟合;东移 1,
        与内收后的 USB1 courtyard 保持 ≥0.4 净空) */}
    <chip name="TVS1" footprint="sot23" layer="bottom" pcbX={-11} pcbY={-9.5} schX={5.5} schY={-0.3} />
    {/* USB 块:Type-C 16P 母座,竖放贴西板缘(对应外壳左墙椭圆开孔;结构图口中心
        距一侧 8.6mm 系按 46 外形量得,即距中心 -14.4 —— 板缩 43 后保持中心系
        pcbY=-14.4 不变,与外壳开孔 x=-14.4 对齐);CC 5.1K 下拉,D+/D- 经 22R 接
        GPIO13/12(C6 内置 USB-Serial-JTAG,烧录调试免转换芯片) */}
    <chip name="USB1" footprint="soic12_w9mm_p1.2mm" layer="bottom" pcbX={-17.5} pcbY={-14.4} pcbRotation={90} schX={0.2} schY={-5.8} />

    {/* ================= 背面南排(y≤-13,自西向东;随 PADS1 内收整排上抬 1.5) ================= */}
    {/* AUDIO-MIC 块:双模拟硅麦 MIC1/MIC2(差分进 ES7210;对应外壳左墙+顶墙
        两个拾音孔,此处沿南缘排布还原双麦阵列间距) */}
    <chip name="MIC1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={-10} pcbY={-15.4} schX={-5.5} schY={-5.8} />
    {/* AUDIO-PA 块:U8 NS4150B 3W D 类功放(SOP8;CTRL 经 R14 10K 由 AXP
        ALDO2 使能,非 GPIO;输出到 SPK1 喇叭焊盘 P10);横放(旋转 90°)压缩
        南北向 courtyard,与 PADS1 焊盘排留 ≥0.4mm 净空 */}
    <chip name="U8" footprint="soic8_w3.9mm_p1.27mm" layer="bottom" pcbX={-4} pcbY={-15.3} pcbRotation={90} schX={5.5} schY={-3.3} />
    <chip name="SPK1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={2} pcbY={-15.4} schX={2.4} schY={-5.8} />
    {/* AUDIO-CODEC 块:U6 ES8311 低功耗 codec(QFN20 3×3 以 soic8 拟合;放音走
        I2S DSDIN=GPIO23,MCLK/BCLK/LRCK=GPIO19/20/22,配置走共享 I2C) */}
    <chip name="U6" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={6.5} pcbY={-15.4} schX={5.5} schY={-1.8} />
    {/* MIC2 居南排最右(x=11,循实板双麦分置两侧):右侧被 SW1(BOOT)courtyard
        (x≥14.7)、下方被 PADS1 焊盘排(courtyard 顶 -17.93)夹住,上方 Q1/X1
        为此北移让位,各向净空 ≥0.4 */}
    <chip name="MIC2" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={11} pcbY={-15.4} schX={-3.7} schY={-5.8} />
    {/* EXPANSION 块:PADS1 背面扩展焊盘 ×9(VBUS/GND/VCC3V3/GPIO17/GPIO16/
        ESP32_SCL/ESP32_SDA/USB_N/USB_P,即 wiki 所述 1×UART+1×I2C+1×USB;
        以 pinrow9 拟合,沿南板缘;pinrow courtyard 上下各外扩约 1mm,南排
        元件须与其留净空) */}
    <chip name="PADS1" footprint="pinrow9" layer="bottom" pcbX={0} pcbY={-19.7} schX={8} schY={-1.5} />

    {/* ================= 走线示例(自动布线) ================= */}
    {/* BOOT 键 → 模组真实 IO9 引脚(按住上电进下载模式;BOOT 键只接 GPIO9 一路) */}
    <trace from=".SW1 > .pin1" to=".U1 > .IO9" />
    {/* 用户键 KEY:实板接 GPIO10(R18 10K 上拉,按下拉低;原理图 GPIO 总表误标
        GPIO10 为 LCD_RESET,实际走线只接 Key3,以走线为准)—— 占位模组
        ESP32-C6-MINI-1 未引出 IO10/IO11,以空闲 IO14 代位示意(整板唯一未占用段) */}
    <trace from=".SW3 > .pin1" to=".U1 > .IO14" />
    {/* 用户键上拉:SW3 → R1 10kΩ */}
    <trace from=".SW3 > .pin2" to=".R1 > .pin1" />
    {/* 共享 I2C 总线(GPIO8 SDA / GPIO7 SCL,2.2K 上拉)之一段:RTC ↔ IMU */}
    <trace from=".U4 > .pin1" to=".U5 > .pin1" />
    {/* 屏:LCD QSPI 片选 → IO15(PCLK/D0..D3 = IO0/1/2/3/4 同理,经 CN1 排线) */}
    <trace from=".CN1 > .pin1" to=".U1 > .IO15" />
    {/* 触摸:CST9220 中断 → IO5(触摸复位 = IO11,同走 CN1 排线) */}
    <trace from=".CN1 > .pin10" to=".U1 > .IO5" />
    {/* PWR 键状态:BSS138 反相输出 → IO18(GPIO18 读取 AXP PWRON 键态) */}
    <trace from=".Q1 > .pin1" to=".U1 > .IO18" />
    {/* 音频链路示意:ES8311 codec → NS4150B 功放 */}
    <trace from=".U6 > .pin1" to=".U8 > .pin1" />
  </board>
)
