/**
 * __PROJECT_NAME__ —— 默认硬件工程:微雪 ESP32-C3-LCD-1.47 复刻板(tscircuit)
 *
 * 依据微雪官方原理图(waveshareteam/ESP32-C3-LCD-1.47 GitHub 仓库 PDF)与
 * 官方尺寸图 1:1 归纳:板 20.32×36.37mm,正面为 1.47" IPS 屏(ST7789T,
 * 172×320,可视区约 17.39×32.35mm,几乎盖满正面),顶边 USB-C、左右侧边
 * BOOT/RESET 侧按键、底端为主控模组的板载天线区,两长边各一列 1×9 P2.54
 * 排针焊盘(P1/P2)。
 *
 * 主控 U1 为真实 ESP32-C3-MINI-1 模组封装(./esp32-c3-mini,53 个 datasheet
 * 引脚 + EPAD 阵列共 61 焊盘,IO 引脚可按名字连线,如 .U1 > .IO9)。
 * 取舍:实板是 ESP32-C3FH4 裸片 + X1 40MHz 晶振 + J1 陶瓷天线 + π 匹配
 * L1/L2/L3 的裸片方案,模板以官方模组等代 —— 晶振/RF/4MB Flash 全部被模组
 * 吸收,实板用到的 IO(GPIO0..10/18/19、EN、TXD0/RXD0)模组均引出。
 * 模组 courtyard 13.6×17mm(北端含板载天线区),放背面南半部并旋转 180°,
 * 让天线区朝向板底端 —— 与实板陶瓷天线位置一致。
 *
 * 板面奇窄(20.32mm),背面元件全部在模组 courtyard 之外见缝插针,
 * 两两 courtyard 间隙 ≥0.4mm(重叠会报 pcb_courtyard_overlap_error
 * 并跳过自动布线);排针为通孔件,其孔与顶层屏幕焊盘行错位摆放
 * (跨层 pad-hole 间隙 ≥0.1mm,否则报 pcb_footprint_overlap_error)。
 *
 * 约定:名字以 SCREEN/DISPLAY/LCD/AMOLED/OLED 开头的元件会被识别为屏幕
 * (3D 视图把模拟器画面贴到该区域;外壳顶盖按它开窗)。
 *
 * 原理图布局(schX/schY,与 pcbX/pcbY 相互独立):不写则由 tscircuit 自动
 * 摊成一长条,故全部元件显式定位,分区镜像 PCB 物理布局,主控 U1 居中:
 * 北排按键·USB / 西列屏·TF·电源 / 东列 EXIO·IMU·DCDC·背光 / 南排排针。
 */
import { ESP32_C3_MINI_1 } from './esp32-c3-mini'

export default () => (
  <board width="20.32mm" height="36.37mm">
    {/* ================= 正面(top):LCD 块 ================= */}
    {/* 1.47" IPS 172×320,驱动 ST7789T(4 线 SPI:DIN=GPIO5 CLK=GPIO7
        DC=GPIO8;CS/RST/背光走 U2 扩展 IO,不占 ESP32 GPIO)。
        可视区 17.39×32.35mm 居中;实物为 12-pin FPC 排线,此处以旋转 90°
        的参数化封装拟合 —— 焊盘落在屏幕上下两短边(6+6),刻意避开左右
        长边:两长边紧贴 P1/P2 排针通孔,侧向摆盘会与孔报跨层重叠。
        (w/p 参数按 pcb_component 上报尺寸恰为 17.39×32.35 反解) */}
    <chip name="SCREEN1" footprint="soic12_w32.75mm_p3.278mm" pcbRotation={90} pcbX={0} pcbY={0} schX={-5.5} schY={3.2} />

    {/* ================= 背面南半:MCU 块 ================= */}
    {/* ESP32-C3-MINI-1 真实模组(等代实板 C3FH4 裸片方案,见文件头);
        旋转 180° 使天线区(courtyard 北端)朝向板底端,与实板一致 */}
    <ESP32_C3_MINI_1 name="U1" layer="bottom" pcbX={0} pcbY={-9.6} pcbRotation={180} schX={0} schY={0} />

    {/* ================= 两长边:GPIO 块(P1/P2 排针焊盘) ================= */}
    {/* 1×9 P2.54 通孔排(标准版 34663 不焊,-M 版 34664 加焊排针);
        P1 = 5V/GND/3V3/GPIO0/1/2/3/4/9,P2 = TXD/RXD/D-/D+/EXIO7/6/5/4/GPIO10
        (wiki 引脚图把 EXIO4~7 误标 GPIO4~7,以原理图/丝印 EX4~EX7 为准)。
        y=-4.3:端部孔与顶层屏幕焊盘行(y≈±15.9)保持 ≥0.1mm 跨层间隙 */}
    <chip name="P1" footprint="pinrow9_p2.54mm" layer="bottom" pcbX={-9.1} pcbY={-4.3} pcbRotation={90} schX={-2.6} schY={-5.8} />
    <chip name="P2" footprint="pinrow9_p2.54mm" layer="bottom" pcbX={9.1} pcbY={-4.3} pcbRotation={90} schX={2.6} schY={-5.8} />

    {/* ================= 背面中部:SD CARD 块 ================= */}
    {/* TF1:MUP-M617-2 短体 microSD push 卡座(SPI 与 LCD 共总线:
        MOSI=GPIO5 MISO=GPIO6 CLK=GPIO7,CS=EXIO2;R12~R15 4×10K 上拉被
        卡座拟合吸收)。实物卡口在正面顶端,正面已被屏幕整块占用,
        与其余元件一致落在背面(取舍) */}
    <chip name="TF1" footprint="soic12_w11mm_p0.8mm" layer="bottom" pcbX={0} pcbY={2.6} schX={-5.5} schY={-0.6} />

    {/* ================= 背面中带:EXIO / IMU / POWER 块 ================= */}
    {/* U2:CH32V003F4U6(QFN-20 3×3,微雪 IO_EXTENSION 固件,I2C 0x24,
        SCL=GPIO3 SDA=GPIO4):EXIO0=LCD_CS,EXIO1=LCD_RST,EXIO2=SD_CS,
        PC3=LCD_BL 背光 PWM,EXIO4~7 引到 P2。QFN-20 0.4/0.5mm 间距的
        参数化封装会报 pad 间隙 DRC(<0.1mm),以同外形 3×3 的
        soic8_w3mm_p0.8mm 拟合(取舍) */}
    <chip name="U2" footprint="soic8_w3mm_p0.8mm" layer="bottom" pcbX={0} pcbY={7.9} schX={5.5} schY={3.6} />
    {/* U3:QMI8658 六轴 IMU(LGA-14 2.5×3,I2C 同总线,INT1→GPIO2);
        LGA-14 0.5mm 间距同样撞 pad 间隙 DRC,以 soic6_w2.5mm_p1mm 拟合
        (与 S3 模板的 QMI8658A 同策略) */}
    <chip name="U3" footprint="soic6_w2.5mm_p1mm" layer="bottom" pcbX={-4.5} pcbY={7.75} schX={5.5} schY={1.4} />
    {/* U4:MP1605GTF-Z DC-DC 降压 VSYS→3V3(TSOT23-6;L4 1uH/分压
        R22 200K+R25 44.2K/D3 保护管被拟合吸收) */}
    <chip name="U4" footprint="sot23_6" layer="bottom" pcbX={4.35} pcbY={7.75} schX={5.5} schY={-0.8} />

    {/* ================= 背面北带:POWER / LCD-BL / KEY / Type-c 块 ================= */}
    {/* D1:MBR230LSFT1G 肖特基 VBUS→VSYS(SOD-123FL;VBUS 上的 TVS1 从略) */}
    <diode name="D1" footprint="sod123" layer="bottom" pcbX={-5.0} pcbY={12.6} pcbRotation={90} schX={-5.5} schY={-3.0} />
    {/* Q1:背光驱动三极管(SOT-23,原理图未标型号;R4 10R 串 LEDK、
        R7 1K/R8 10K 偏置从略),受 U2 的 PC3(LCD_BL)PWM 控制 */}
    <chip name="Q1" footprint="sot23" layer="bottom" pcbX={4.75} pcbY={12.6} pcbRotation={90} schX={5.5} schY={-3.0} />
    {/* R1:BOOT 键 10K 上拉(KEY 块之代表;RESET 侧 R10 10K+C7 1uF 从略) */}
    <resistor name="R1" resistance="10k" footprint="0402" layer="bottom" pcbX={0} pcbY={10.9} schX={-4.9} schY={5.4} />
    {/* SW1/SW2:BOOT(GPIO9)/RESET(CHIP_EN,同时并联复位 U2)侧按开关。
        实物即贴片侧按,用 smdpushbutton 封装并旋转 90° 竖贴左右板边,
        位置与实板左上/右上侧边一致(THT pushbutton 7×9 courtyard 在
        20.32mm 窄板上与 USB 座无解,SMD 侧按才是实物形态) */}
    <pushbutton name="SW1" footprint="smdpushbutton" layer="bottom" pcbX={-8.55} pcbY={11} pcbRotation={90} schX={-2.5} schY={5.4} />
    <pushbutton name="SW2" footprint="smdpushbutton" layer="bottom" pcbX={8.55} pcbY={11} pcbRotation={90} schX={3.5} schY={5.4} />
    {/* USB1:顶边 Type-C 16P 母座(CC1/CC2 各 5.1K 下拉、0R R18/R20、
        D2/D4 ESD 管从略;D-→GPIO18、D+→GPIO19,走芯片内置
        USB-Serial-JTAG)。窄板上以 8 焊盘窄体拟合,居中贴顶边 */}
    <chip name="USB1" footprint="soic8_w4.6mm_p1.2mm" layer="bottom" pcbX={0} pcbY={15.2} schX={0.5} schY={5.4} />

    {/* ================= 走线示例 ================= */}
    {/* BOOT 键上拉:SW1 → R1 10K(按下拉低 GPIO9 进下载模式) */}
    <trace from=".SW1 > .pin1" to=".R1 > .pin1" />
    {/* BOOT 键 → 模组真实 IO9 引脚 */}
    <trace from=".SW1 > .pin1" to=".U1 > .IO9" />
    {/* RESET 键 → 模组 EN(CHIP_EN) */}
    <trace from=".SW2 > .pin1" to=".U1 > .EN" />
    {/* I2C 总线之 SDA 一段:GPIO4 → QMI8658 IMU(与 U2 EXIO 共总线) */}
    <trace from=".U1 > .IO4" to=".U3 > .pin1" />
    {/* I2C 总线之 SCL 一段:GPIO3 → CH32V003 扩展 IO */}
    <trace from=".U1 > .IO3" to=".U2 > .pin1" />
    {/* 屏幕 SPI 之 LCD_DC:GPIO8 → 屏(跨层过孔上正面) */}
    <trace from=".U1 > .IO8" to=".SCREEN1 > .pin7" />
    {/* 背光链路:U2 PC3(LCD_BL PWM)→ Q1 基极 */}
    <trace from=".U2 > .pin5" to=".Q1 > .pin1" />
  </board>
)
