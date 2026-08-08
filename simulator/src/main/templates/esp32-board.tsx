/**
 * __PROJECT_NAME__ —— 默认硬件工程:微雪 ESP32 One 复刻板(tscircuit)
 *
 * 依据微雪官方原理图(ESP32_One_Sch.pdf,3 页:电路/尺寸/背面丝印)1:1 归纳:
 * 板 65×30.5mm(圆角 R1.5);板上沿 40PIN 树莓派 HAT 排针(2×20),TF 卡座在
 * 左缘、OV2640 摄像头座在右缘、Micro USB 与 RST 键在底边、PH2.0 电池座右下,
 * 背面为 I2S 麦克风 / SPI Flash / PSRAM。无屏产品,正面无 SCREEN 元件。
 *
 * 主控取舍:实板为 ESP32-D0WDQ6-V3 裸片 + 40MHz 晶振 + IPEX 天线(Flash/PSRAM
 * 板级外挂),复刻用真实 ESP32-WROOM-32E 模组封装等效(./esp32-wroom-32e,
 * 38 引脚 + GND 散热盘 3×3 阵列共 47 焊盘,IO 可按名连线,如 .U1 > .IO0)。
 * 模组 courtyard 达 19.6×26.6mm(北端含天线净空区),板高仅 30.5mm 放不下竖置
 * 模组 + 顶排 40PIN,故模组旋转 90°(天线朝西,与实板 IPEX 在左上一致),
 * 置于 (-2,-1.5) 后 courtyard 占 x∈[-16.8,9.8]、y∈[-11.3,8.3],其余正面元件
 * 环绕其外(courtyard 重叠会 DRC 报错并跳过自动布线,两两留 ≥0.4mm 间隙)。
 *
 * 其余元件用 footprinter 参数化封装(soicN_w宽mm_p脚距mm 等)拟合真实外形,
 * 离线可评估;实板背面件(Flash/PSRAM/麦克风)置 layer="bottom" 还原丝印观感。
 * 40PIN 排针与 RST 键为通孔件贯穿两层,背面元件须避开其 courtyard。
 *
 * 原理图布局(schX/schY,与 pcbX/pcbY 相互独立):不写则被 tscircuit 自动
 * 摊成一长条,故全部元件显式定位,分区镜像 PCB 物理布局,主控 U1 居中:
 * 东侧 40PIN / 西侧摄像头座 / 北排下载电路 / 南排背面件·USB / 远东西列电源与杂件。
 */
import { ESP32_WROOM_32E } from './esp32-wroom-32e'

export default () => (
  <board width="65mm" height="30.5mm">
    {/* ================= MCU 块:主控模组 ================= */}
    {/* 实板 ESP32-D0WDQ6-V3 裸片 + X1 40MHz 晶振 + W25Q32 4MB Flash +
        ESP-PSRAM64H 8MB PSRAM,此处以 ESP32-WROOM-32E 模组占位(内含 4MB
        Flash,不含 PSRAM —— 固件若依赖 8MB PSRAM,语义更接近 WROVER-E,见 README)。
        旋转 90° 天线朝西(实板 IPEX 天线座在左上角);courtyard 见文件头注释 */}
    <ESP32_WROOM_32E name="U1" pcbX={-2} pcbY={-1.5} pcbRotation={90} schX={0} schY={0} />

    {/* ================= RPI_HEADER 块:板上沿 40PIN ================= */}
    {/* 2×20 树莓派 HAT 排针(2.54mm),插针行距板顶约 3.5mm、整排偏右
        (原理图尺寸页:距右边 3.5mm);引出 I2C(IO18/IO23)/SPI/UART/I2S 等,
        可直插 e-Paper Driver HAT。通孔件贯穿两层 */}
    <chip name="P3" footprint="pinrow40_rows2" pcbX={3} pcbY={11.75} schX={7} schY={0} />

    {/* ================= MICROSD 块:左缘 TF 卡座 ================= */}
    {/* SPI 模式(CLK=IO14/MISO=IO12/MOSI=IO13/CS=IO15),VDD_SDIO 域 4×10K
        上拉(R21-R24 略);竖放(旋转 90°)贴左板缘,还原推推式卡座朝向 */}
    <chip name="SD1" footprint="soic14_w12mm_p1.4mm" pcbRotation={90} pcbX={-26} pcbY={0.3} schX={11.5} schY={2.2} />

    {/* ================= RF 块:IPEX 天线座 ================= */}
    {/* 实板裸片 LNA_IN 经 R36 0R 出 IPEX 外接天线;WROOM-32E 占位后天线在模组
        上,此件仅外观复刻(置模组天线端下方,近实板左上 IPEX 位) */}
    <chip name="ANT1" footprint="soic4_w3.5mm_p1.6mm" pcbX={-28} pcbY={-9.5} schX={11.5} schY={0} />

    {/* ================= DVP 块:右缘 OV2640 摄像头座 ================= */}
    {/* 24PIN 连接座竖置贴右板缘;Y2-Y9 8bit 数据(Y0/Y1 未接),XCLK=IO4/
        PCLK=IO25/VSYNC=IO5/HREF=IO27;PWDN 经 R12 10K 固定拉低、RESET 并入
        系统复位,均不占 GPIO;SCCB(I2C)= SDA IO18 / SCL IO23,各 3.3K 上拉 */}
    <chip name="CN1" footprint="soic24_w5.3mm_p1mm" pcbX={29} pcbY={0} schX={-7} schY={0} />

    {/* ================= DOWNLOAD 块:USB 转串口 + 自动下载 ================= */}
    {/* U4 CP2102(实板 QFN-28 5×5,QFN 参数化封装角部焊盘会撞 DRC 最小间距,
        以 soic14_w5mm_p0.8mm 拟合体量);U0TXD=IO1/U0RXD=IO3,DTR/RTS 经
        Q1/Q2 SS8050 组成 AUTO PROGRAM 电路拉 RESET 与 IO0,板上无实体 BOOT 键 */}
    <chip name="U4" footprint="soic14_w5mm_p0.8mm" pcbX={13.2} pcbY={4.8} schX={-3} schY={6.2} />
    <chip name="Q1" footprint="sot23" pcbX={18.8} pcbY={6} schX={0} schY={6.2} />
    <chip name="Q2" footprint="sot23" pcbX={23.4} pcbY={6} schX={2.3} schY={6.2} />
    {/* SW1:RST 轻触侧按键(K1,全板唯一实体按键,实板在底边 USB 左侧;
        通孔件 6×8 且 courtyard 外扩 0.5,底边中段被模组 courtyard(y 至 -11.3)
        占用放不下,移至西南角(仍在底边、USB 之西,方位与实板一致) */}
    <pushbutton name="SW1" footprint="pushbutton" pcbX={-21.5} pcbY={-11.2} schX={4.8} schY={6.2} />

    {/* ================= USB 块:底边 Micro USB ================= */}
    {/* Micro-B 5P 卧贴(原理图 U9),D+/D- 串 22R(R33/R34)接 CP2102,
        兼供电输入;实板在底边中部,但模组 courtyard 下缘(-11.3)到板缘仅
        3.95mm 放不下(焊盘出板缘会报 pcb_component_outside_board_error),
        故移至模组东侧底边,对应外壳南壁开孔 */}
    <chip name="USB1" footprint="soic6_w6mm_p1.3mm" pcbX={13.8} pcbY={-13.3} schX={3.5} schY={-6.2} />

    {/* ================= BATTERY 块:充电升压 + 电池座 ================= */}
    {/* U5 CS8501 单节锂电充电+同步升压一体(ESOP-8,外围 D1/D2 SS14 + L1
        4.7uH 略);J1 PH2.0 锂电池座在板右下(实板 P1) */}
    <chip name="U5" footprint="soic8_w5.2mm_p1.27mm" pcbX={13.2} pcbY={-6.1} schX={-11.5} schY={4} />
    <chip name="J1" footprint="soic2_w4mm_p2mm" pcbX={28.5} pcbY={-12.5} schX={-11.5} schY={2} />

    {/* ================= POWER 块:降压与摄像头 LDO ================= */}
    {/* U6 MP2128DT 5V→3.3V 同步降压(TSOT23-8,L2 1uH 略);
        U7/U8 RT9166A-28/-12 LDO(SOT-89)专供摄像头 AVDD 2.8V / DVDD 1.2V。
        东区元件按实测 courtyard(soic/sot 均外扩 ≥0.4)错行摆放留 ≥0.4 间隙 */}
    <chip name="U6" footprint="soic8_w3mm_p0.8mm" pcbX={12.2} pcbY={-0.75} schX={-11.5} schY={0} />
    <chip name="U7" footprint="sot89" pcbX={19.3} pcbY={1.3} schX={-11.5} schY={-2} />
    <chip name="U8" footprint="sot89" pcbX={19.5} pcbY={-4.2} schX={-11.5} schY={-4} />

    {/* ================= MCU 块:预留 32.768kHz RTC 晶振 ================= */}
    {/* Y1 3215 封装(以 1206 两焊盘拟合),接 IO32/IO33 的 RTC 慢钟预留位;
        实板串阻 R29/R31 为 NC 默认未启用(IO32/33 让位给 I2S 麦克风) */}
    <chip name="Y1" footprint="1206" pcbX={24.3} pcbY={-8.6} schX={6} schY={-6.2} />

    {/* ================= LED 块 ================= */}
    {/* LED1 用户 LED(L4 红,GPIO21 经 R20 1.5K 接 3V3,低电平点亮,wiki Blink
        例程 Pin21);LED2 电源 LED(L3,5V 经 R19 4.7K 常亮) */}
    <led name="LED1" footprint="0603" pcbX={19} pcbY={-8.6} schX={11.5} schY={-2} />
    <led name="LED2" footprint="0603" pcbX={19.5} pcbY={-11.3} schX={11.5} schY={-3.5} />
    {/* LED3/LED4 充电指示灯(实板丝印 Led1/CHG、Led2/DONE,红;原理图 Battery 块
        CS8501 的 CHRG/STDBY 各驱一颗)—— 位号避让本文件已按 spec 占用的
        LED1/LED2,置于 LED2 下方一排(实板丝印即在 PWR/用户灯旁) */}
    <led name="LED3" footprint="0603" pcbX={19.5} pcbY={-13.6} schX={11.5} schY={-5} />
    <led name="LED4" footprint="0603" pcbX={23.2} pcbY={-13.6} schX={11.5} schY={-6.5} />

    {/* ================= 背面(bottom):FLASH / PSRAM / MICROPHONE ================= */}
    {/* U2 W25Q32JVSSIQ 4MB SPI Flash(SOIC-8 208mil,F_CS=IO11 等六线):
        WROOM-32E 占位后模组已内置同容量 Flash,此件作背面陪衬件还原丝印观感 */}
    <chip name="U2" footprint="soic8_w5.2mm_p1.27mm" layer="bottom" pcbX={-8} pcbY={-5} schX={-4} schY={-6.2} />
    {/* U3 ESP-PSRAM64H 8MB PSRAM(SR_CS=IO16/SR_CK=IO17,数据线与 Flash 共享
        IO7-IO10);同为背面陪衬件 —— WROOM-32E 不含 PSRAM,见文件头取舍说明 */}
    <chip name="U3" footprint="soic8_w5.2mm_p1.27mm" layer="bottom" pcbX={-1} pcbY={-5} schX={-1.5} schY={-6.2} />
    {/* MIC1 MSM261S4030H0R I2S 数字麦克风(LGA 8pin,SCK=IO26/WS=IO32/SDO=IO33
        各串 33R,L/R 接 GND);实板即在背面拾音 */}
    <chip name="MIC1" footprint="soic4_w3.5mm_p2mm" layer="bottom" pcbX={-4.5} pcbY={-11} schX={1} schY={-6.2} />

    {/* ================= 走线示例(自动布线) ================= */}
    {/* RESET 键 → 模组 EN(CHIP_PU 系统复位网络,短接到 GND 略) */}
    <trace from=".SW1 > .pin1" to=".U1 > .EN" />
    {/* 自动下载(原理图 Download 块):Q1(基极 DTR 经 R9 10K)集电极接 RESET,
        Q2(基极 RTS 经 R16 12K)集电极拉低 IO0 进 BOOT —— 板上无实体 BOOT 键,
        走线示例挂 Q2→IO0(Q1→RESET 与 SW1 同网络,略) */}
    <trace from=".Q2 > .pin1" to=".U1 > .IO0" />
    {/* 用户 LED → GPIO21(低电平点亮) */}
    <trace from=".LED1 > .pin1" to=".U1 > .IO21" />
    {/* I2C 一段:摄像头 SCCB(与 40PIN 排针共用总线,3.3K 上拉略):
        连接座脚位按原理图 DVP 块:pin20=SIO_CLK→SCL=IO23、pin22=SIO_DAT→SDA=IO18
        (pin19=RESET 并入系统复位、pin17=PWDN 10K 拉低,均不走 I2C);
        无屏无触摸,I2C 示例以摄像头座代表 */}
    <trace from=".CN1 > .pin20" to=".U1 > .IO23" />
    <trace from=".CN1 > .pin22" to=".U1 > .IO18" />
    {/* UART0 下载链路:CP2102 TXD/RXD ↔ 模组 RXD0(IO3)/TXD0(IO1) */}
    <trace from=".U4 > .pin1" to=".U1 > .TXD0" />
    <trace from=".U4 > .pin2" to=".U1 > .RXD0" />
    {/* TF 卡 SPI 时钟 → IO14(MISO=IO12/MOSI=IO13/CS=IO15 同理) */}
    <trace from=".SD1 > .pin5" to=".U1 > .IO14" />
  </board>
)
