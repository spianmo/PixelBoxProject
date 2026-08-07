/**
 * 新建项目向导 — 脚手架生成服务(main 进程)
 *
 * IPC:
 * - project:default-location  默认项目位置 ~/PixelBoxProjects
 * - dialog:choose-directory   系统目录选择(「浏览…」)
 * - project:create            校验参数并按 kind 生成三类项目骨架,
 *                             返回 { root, kind, entryFile }
 * - project:info              读取工作区项目信息(kind/name/chip/manifest;
 *                             显式 type 优先,无 type 走启发式识别)
 *
 * 三类脚手架(契约见 docs/plans/ide-v3-project-types.md §2.7):
 * - app      pixelbox.json(type:'app')/ tsconfig.json / src/main.ts(按模板)/
 *            types/pixelbox.d.ts(IDE 内嵌契约全文)/ README.md / .gitignore / assets/
 * - firmware pixelbox.json(type:'firmware')/ CMakeLists.txt / main/(CMakeLists+main.c)/
 *            sdkconfig.defaults / README.md / .gitignore
 * - hardware pixelbox.json(type:'hardware')/ design/board.tsx(微雪
 *            ESP32-S3-Touch-AMOLED-2.16 复刻板 40×40,含 39×39mm 屏幕元件;
 *            主控 U1 用 design/esp32-s3-mini.tsx 的真实 ESP32-S3-MINI-1-N8
 *            模组封装[73 焊盘];已经 /tmp/tsc-probe 沙箱以多文件 fsMap
 *            实测:1320 元素含 pcb_board + 20 pcb_component,0 DRC error)/
 *            design/enclosure.json(WAVESHARE_216_ENCLOSURE:46×46×22.5 白色圆角壳)/
 *            tsconfig.json(jsx: react-jsx,与 IDE Monaco 对齐;类型由 IDE 注入)/
 *            README.md / .gitignore
 *
 * 错误以 `project:<code>` 前缀抛出,renderer 解析后映射 i18n 文案
 */
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  EnclosureParams,
  PixelboxManifest,
  ProjectCreateOptions,
  ProjectCreateResult,
  ProjectInfo,
  ProjectKind
} from '../shared/ipc-types'
import { CHIP_IDS } from '../shared/chipCapabilities'
import { enclosureScadFromParams } from '../shared/enclosureScadTemplate'
// 唯一契约文件全文(构建期 ?raw 内嵌;生成的项目自带一份,Monaco 与 tsc 共用)
import pixelboxDts from '../../../sdk/types/pixelbox.d.ts?raw'
// hardware 模板的真实 ESP32-S3-MINI-1-N8 模组封装(来源 tscircuit 开源项目,
// 见文件头溯源注释)。?raw 全文内嵌(Rsbuild JS_RAW 规则只认 JS 族扩展名,
// 故保留 .tsx 真实后缀;tsconfig.node include 仅 **/*.ts,不会被当作源码编译),
// 生成工程时与 board.tsx 一同写入 design/,board.tsx 经相对导入引用
import esp32ModuleTsx from './templates/esp32-s3-mini.tsx?raw'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
/** 反域名:至少一个点,各段字母数字/下划线/连字符,首段以字母开头 */
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/

// ---------------------------------------------------------------
// app 模板(现状保留)
// ---------------------------------------------------------------

/** 「像素动画 Hello」模板:弹跳方块 + HSV 彩虹(展示 onFrame / fillRect / color.hsv) */
function helloTemplate(name: string): string {
  return `/**
 * ${name} —— 像素动画 Hello(弹跳方块示例)
 *
 * 演示:
 *   - px.screen.onFrame 逐帧渲染(dt = 与上一帧间隔毫秒,回调返回后自动 flush)
 *   - px.color.hsv 彩虹渐变 + 碰壁反弹
 */

const W = px.screen.width;
const H = px.screen.height;

/** 方块边长(按屏幕短边取值,保像素风) */
const SIZE = Math.max(16, Math.floor(Math.min(W, H) / 5));

let x = (W - SIZE) / 2;
let y = (H - SIZE) / 3;
let vx = 96; // 速度(像素/秒)
let vy = 72;
let hue = 0; // 彩虹色相 0-360

px.screen.setFps(60);

px.screen.onFrame((dt) => {
  const dtSec = dt / 1000;

  // 位置积分 + 碰壁反弹
  x += vx * dtSec;
  y += vy * dtSec;
  if (x <= 0 || x + SIZE >= W) {
    vx = -vx;
    x = Math.min(Math.max(x, 0), W - SIZE);
  }
  if (y <= 0 || y + SIZE >= H) {
    vy = -vy;
    y = Math.min(Math.max(y, 0), H - SIZE);
  }

  // 色相随时间流动
  hue = (hue + dtSec * 90) % 360;

  px.screen.clear(0x000000);
  px.screen.fillRect(Math.round(x), Math.round(y), SIZE, SIZE, px.color.hsv(hue, 100, 100));
  px.screen.drawText('Hello PixelBox', 8, 8, { color: 0xdfe1e5, font: 'pixel12' });
});
`
}

/** 「空白项目」模板:最小 onFrame 骨架 */
function blankTemplate(name: string): string {
  return `/**
 * ${name} —— PixelBox 应用入口
 *
 * px.screen.onFrame:逐帧回调,回调返回后自动 flush 上屏
 */

px.screen.onFrame(() => {
  px.screen.clear(0x000000);
  // TODO: 在此绘制(px.screen.fillRect / drawText / drawImage …)
});
`
}

/** 生成的项目 tsconfig:include 指向自带的 types/pixelbox.d.ts,独立于仓库可用 */
function projectTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        noFallthroughCasesInSwitch: true
      },
      include: ['src', 'types']
    },
    null,
    2
  )}\n`
}

function appReadme(name: string): string {
  return `# ${name}

PixelBox 像素盒应用(由 IDE「新建项目」向导生成)。

## 目录结构

- \`pixelbox.json\` — 应用清单(id / 名称 / 版本 / 入口)
- \`src/main.ts\` — 应用入口(\`px.screen.onFrame\` 逐帧渲染)
- \`types/pixelbox.d.ts\` — 设备 API 类型契约(编辑器补全与 \`tsc\` 校验共用,随项目自包含)
- \`assets/\` — 静态资源(构建时拷贝到 \`dist/assets/\`)

## 运行

在 PixelBox 模拟器 IDE 中打开本目录,点击标题栏 ▶ 运行到虚拟设备;
独立类型检查:\`npx tsc --noEmit\`。
`
}

// ---------------------------------------------------------------
// firmware 模板(ESP-IDF 标准工程)
// ---------------------------------------------------------------

function firmwareRootCMake(name: string): string {
  return `cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${name})
`
}

function firmwareMainCMake(): string {
  return `idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
`
}

function firmwareMainC(name: string): string {
  return `/**
 * ${name} —— ESP-IDF 固件入口(FreeRTOS)
 *
 * app_main 由 ESP-IDF 启动任务调用;示例每秒打一条心跳日志,
 * 串口监视:idf.py monitor(Ctrl+] 退出)
 */
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"

static const char *TAG = "${name}";

void app_main(void)
{
    ESP_LOGI(TAG, "firmware up, free heap %" PRIu32 " bytes", esp_get_free_heap_size());
    uint32_t tick = 0;
    for (;;) {
        ESP_LOGI(TAG, "heartbeat #%" PRIu32, tick++);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`
}

function firmwareSdkconfigDefaults(name: string): string {
  return `# ${name} — sdkconfig 默认覆盖项
# 在此追加 CONFIG_* 键值(idf.py set-target / 首次构建时吸收到 sdkconfig)
`
}

function firmwareReadme(name: string, chip: string): string {
  return `# ${name}

ESP-IDF 固件工程(由 PixelBox IDE「新建项目」向导生成;默认目标芯片 \`${chip}\`)。

## 目录结构

- \`CMakeLists.txt\` — 工程入口(引 \`$IDF_PATH/tools/cmake/project.cmake\`)
- \`main/main.c\` — 固件入口(\`app_main\`,FreeRTOS 心跳示例)
- \`sdkconfig.defaults\` — sdkconfig 默认覆盖项

## 编译 / 烧录

IDE:标题栏 🔨 构建,⋮ 菜单内 打包 merged.bin / 烧录 / 清理(均作用于本工程目录)。

命令行(先加载 ESP-IDF 环境 \`. $IDF_PATH/export.sh\`):

\`\`\`bash
idf.py set-target ${chip}
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
\`\`\`
`
}

// ---------------------------------------------------------------
// hardware 模板(tscircuit PCB + 参数化外壳)
// ---------------------------------------------------------------

/**
 * design/board.tsx —— 微雪 ESP32-S3-Touch-AMOLED-2.16 复刻板(离线可评估;
 * @tsci/* 需联网,模板不用)。主控 U1 采用 design/esp32-s3-mini.tsx 的真实
 * ESP32-S3-MINI-1-N8 模组封装(73 焊盘,溯源见该文件头),经相对导入引用 ——
 * 与生产 evaluateDesign 相同的多文件 fsMap 路径。其余大身体元件仍用 footprinter
 * 参数化封装(soicN_w宽mm_p脚距mm)拟合真实外形。已在 /tmp/tsc-probe
 * (react19 + @tscircuit/eval,CircuitRunner.executeWithFsMap 多文件)实测通过:
 * 1321 元素(显式 schX/schY 布局多 1 个原理图净标签),pcb_board 40×40,
 * 20 个 pcb_component,U1 73 焊盘,SCREEN1 可视区 39×39mm 被识别为屏幕,
 * 0 个 DRC error。
 *
 * 布局经验(DRC 教训):正面被屏幕整块占满 —— 其余元件(含三颗侧按键)必须放
 * layer="bottom",否则与 SCREEN1 的 courtyard 重叠报错;按键为通孔件,孔贯穿两层,
 * 背面元件须与按键 courtyard(y≥11.5)保持净空。U1 模组 courtyard 达
 * 16.6×21mm(北端含 PCB 天线丝印区,y 至 +13,置于 (0,-2) 后占 x∈[-8.05,8.58]、
 * y∈[-9.97,11.05]),背面其余元件按「东列/西列/南排」环绕其外,彼此 courtyard
 * 留 ≥0.4mm 间隙(tscircuit 会对 courtyard 重叠报 pcb_courtyard_overlap_error
 * 并跳过自动布线)。
 */
function hardwareBoardTsx(name: string): string {
  return `/**
 * ${name} —— 默认硬件工程:微雪 ESP32-S3-Touch-AMOLED-2.16 复刻板(tscircuit)
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
`
}

/**
 * design/enclosure.json —— 微雪 ESP32-S3-Touch-AMOLED-2.16 成品外壳参数
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
  standoffHeightMM: 4,
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

/**
 * hardware 工程 tsconfig:jsx 与 IDE Monaco 配置一致(react-jsx,见 monacoSetup.ts)。
 * tscircuit 元素/属性类型由 IDE 编辑器注入(@tscircuit/core d.ts extraLib),
 * 工程本身不带 node_modules —— 独立 `npx tsc` 需自行安装 tscircuit 依赖
 */
function hardwareTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true
      },
      include: ['design']
    },
    null,
    2
  )}\n`
}

function hardwareReadme(name: string, chip: string): string {
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
- \`design/enclosure.json\` — 外壳参数(按官方尺寸图预置:壁厚 2 / 圆角 5.8 /
  总高 22.5mm / 白色 \`#f2f2f4\` / 按钮与 USB-C、microSD 开孔;IDE 表单可视化编辑),
  \`batteryMM\` 为底盒内腔电池占位(30×30×5mm,仅 3D 展示,不参与 STL 打印)
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

// ---------------------------------------------------------------
// 创建
// ---------------------------------------------------------------

async function dirIsEmpty(dir: string): Promise<boolean> {
  const items = await fsp.readdir(dir)
  return items.filter((n) => n !== '.DS_Store').length === 0
}

/** 目录已存在且非空 → 拦截(避免覆盖既有内容) */
async function assertCreatable(root: string): Promise<void> {
  try {
    const st = await fsp.stat(root)
    if (!st.isDirectory()) throw new Error('project:dirNotEmpty')
    if (!(await dirIsEmpty(root))) throw new Error('project:dirNotEmpty')
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('project:')) throw err
    // 不存在:正常流程,继续创建
  }
}

/** manifest 落盘(2 空格缩进 + 尾换行) */
function manifestJson(m: PixelboxManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`
}

async function createAppProject(root: string, name: string, opts: ProjectCreateOptions): Promise<string> {
  const appId = (opts.appId ?? '').trim()
  if (!APP_ID_RE.test(appId)) throw new Error('project:appIdInvalid')
  const manifest: PixelboxManifest = {
    type: 'app',
    id: appId,
    name,
    version: '0.1.0',
    entry: 'main.js',
    assets: [],
    minFirmware: '0.1.0'
  }
  await fsp.mkdir(join(root, 'src'), { recursive: true })
  await fsp.mkdir(join(root, 'types'), { recursive: true })
  await fsp.mkdir(join(root, 'assets'), { recursive: true })
  const entryFile = join(root, 'src', 'main.ts')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(join(root, 'tsconfig.json'), projectTsconfig(), 'utf8'),
    fsp.writeFile(entryFile, opts.template === 'blank' ? blankTemplate(name) : helloTemplate(name), 'utf8'),
    fsp.writeFile(join(root, 'types', 'pixelbox.d.ts'), pixelboxDts, 'utf8'),
    fsp.writeFile(join(root, 'README.md'), appReadme(name), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.ide/\n', 'utf8')
  ])
  return entryFile
}

async function createFirmwareProject(root: string, name: string, chip: string): Promise<string> {
  const manifest: PixelboxManifest = {
    type: 'firmware',
    id: name,
    name,
    version: '0.1.0',
    entry: '',
    chip
  }
  await fsp.mkdir(join(root, 'main'), { recursive: true })
  const entryFile = join(root, 'main', 'main.c')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(join(root, 'CMakeLists.txt'), firmwareRootCMake(name), 'utf8'),
    fsp.writeFile(join(root, 'main', 'CMakeLists.txt'), firmwareMainCMake(), 'utf8'),
    fsp.writeFile(entryFile, firmwareMainC(name), 'utf8'),
    fsp.writeFile(join(root, 'sdkconfig.defaults'), firmwareSdkconfigDefaults(name), 'utf8'),
    fsp.writeFile(join(root, 'README.md'), firmwareReadme(name, chip), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'build*/\nsdkconfig\nmanaged_components/\n.ide/\n', 'utf8'),
    // .clangd:IDE 内 C/C++ 智能提示走系统 clangd(见 main/clangd.ts),Apple/主线 clangd
    // 不认识 xtensa/riscv 交叉 gcc 的少数专有 flags,会报「Unknown argument」噪音诊断 —— 移除之
    fsp.writeFile(
      join(root, '.clangd'),
      [
        'CompileFlags:',
        '  Remove:',
        '    - -mlongcalls',
        '    - -mdisable-hardware-atomics',
        '    - -fno-tree-switch-conversion',
        '    - -fno-shrink-wrap',
        '    - -mtext-section-literals',
        '    - -march=*',
        '    - -mabi=*',
        ''
      ].join('\n'),
      'utf8'
    )
  ])
  return entryFile
}

async function createHardwareProject(root: string, name: string, chip: string): Promise<string> {
  const manifest: PixelboxManifest = {
    type: 'hardware',
    id: name,
    name,
    version: '0.1.0',
    entry: '',
    chip
  }
  await fsp.mkdir(join(root, 'design'), { recursive: true })
  const entryFile = join(root, 'design', 'board.tsx')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(entryFile, hardwareBoardTsx(name), 'utf8'),
    // 真实 ESP32-S3-MINI-1-N8 模组封装(board.tsx 相对导入;evaluateDesign 会把
    // design/ 下全部 .ts/.tsx 一并放进 fsMap,多文件工程开箱即用)
    fsp.writeFile(join(root, 'design', 'esp32-s3-mini.tsx'), esp32ModuleTsx, 'utf8'),
    // tsconfig:jsx 配置与 IDE Monaco 对齐;类型由 IDE 注入,不落 8MB d.ts 进工程
    fsp.writeFile(join(root, 'tsconfig.json'), hardwareTsconfig(), 'utf8'),
    // OpenSCAD 外壳源(外壳即代码;IDE 硬件面板即时编译渲染,打印页分件导出;
    // 电池占位等契约经文件尾 PB_META echo 传给 IDE)。enclosure.json 已退役,
    // 新工程不再生成 —— WAVESHARE_216_ENCLOSURE 仅作为本模板的生成参数
    fsp.writeFile(
      join(root, 'design', 'enclosure.scad'),
      enclosureScadFromParams(
        WAVESHARE_216_ENCLOSURE,
        { widthMM: 40, heightMM: 40, thicknessMM: 1.6 },
        // 与模板 board.tsx 的 SCREEN1(39×39 可视区居中)一致
        { x: 0, y: 0, w: 39, h: 39 }
      ),
      'utf8'
    ),
    fsp.writeFile(join(root, 'README.md'), hardwareReadme(name, chip), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'export/\n.ide/\n', 'utf8')
  ])
  return entryFile
}

/** 校验参数并按 kind 生成项目骨架 */
export async function createProject(opts: ProjectCreateOptions): Promise<ProjectCreateResult> {
  const name = opts.name.trim()
  const location = opts.location.trim()
  if (!NAME_RE.test(name)) throw new Error('project:nameInvalid')
  if (location.length === 0) throw new Error('project:locationRequired')
  // 相对路径会被解析到 main 进程 cwd(打包后是 / 或 .app 内),必须拒绝
  if (!isAbsolute(location)) throw new Error('project:locationInvalid')
  const kind: ProjectKind = opts.kind
  if (kind !== 'app' && kind !== 'firmware' && kind !== 'hardware') {
    throw new Error('project:kindInvalid')
  }
  // firmware/hardware 目标芯片:缺省 esp32s3,非法值拦截(单一数据源 CHIP_IDS)
  const chip = (opts.chip ?? 'esp32s3').trim()
  if (!(CHIP_IDS as readonly string[]).includes(chip)) throw new Error('project:chipInvalid')

  const root = resolve(join(location, name))
  await assertCreatable(root)

  let entryFile: string
  if (kind === 'app') entryFile = await createAppProject(root, name, opts)
  else if (kind === 'firmware') entryFile = await createFirmwareProject(root, name, chip)
  else entryFile = await createHardwareProject(root, name, chip)
  return { root, kind, entryFile }
}

// ---------------------------------------------------------------
// project:info(工作区类型识别,门控矩阵的数据源)
// ---------------------------------------------------------------

function isProjectKind(v: unknown): v is ProjectKind {
  return v === 'app' || v === 'firmware' || v === 'hardware'
}

/** 合法 app manifest:id/name/version/entry 均为非空字符串(与 builder.ts readManifest 同判据) */
function isValidAppManifest(m: PixelboxManifest): boolean {
  return (['id', 'name', 'version', 'entry'] as const).every(
    (key) => typeof m[key] === 'string' && (m[key] as string).length > 0
  )
}

/**
 * 读取工作区项目信息:
 * 1. pixelbox.json 有显式合法 type → 直接采信
 * 2. 无 type:合法 app manifest → app(旧应用工程向后兼容)
 * 3. CMakeLists.txt + main/ 目录 → firmware(裸 ESP-IDF 工程,无 manifest 也识别)
 * 4. 其余 kind:null(普通目录,隐藏所有类型化动作)
 */
export async function readProjectInfo(root: string): Promise<ProjectInfo> {
  const abs = resolve(root)
  let manifest: PixelboxManifest | null = null
  try {
    const raw = JSON.parse(await fsp.readFile(join(abs, 'pixelbox.json'), 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null) manifest = raw as PixelboxManifest
  } catch {
    // 无 pixelbox.json / 解析失败:走启发式
  }

  let kind: ProjectKind | null = null
  if (manifest && isProjectKind(manifest.type)) {
    kind = manifest.type
  } else if (manifest && isValidAppManifest(manifest)) {
    kind = 'app'
  } else {
    try {
      const [cmake, mainDir] = await Promise.all([
        fsp.stat(join(abs, 'CMakeLists.txt')),
        fsp.stat(join(abs, 'main'))
      ])
      if (cmake.isFile() && mainDir.isDirectory()) kind = 'firmware'
    } catch {
      // 非固件工程
    }
  }

  return {
    kind,
    name: typeof manifest?.name === 'string' && manifest.name.length > 0 ? manifest.name : null,
    chip: typeof manifest?.chip === 'string' && manifest.chip.length > 0 ? manifest.chip : null,
    manifest
  }
}

export function registerProjectScaffoldIpc(): void {
  // 默认项目位置(不主动创建,创建时 mkdir recursive 兜底)
  ipcMain.handle('project:default-location', (): string => {
    return join(app.getPath('home'), 'PixelBoxProjects')
  })

  // 「浏览…」系统目录选择
  ipcMain.handle('dialog:choose-directory', async (_e, defaultPath?: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      ...(defaultPath ? { defaultPath } : {})
    }
    const ret = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (ret.canceled || ret.filePaths.length === 0) return null
    return ret.filePaths[0]
  })

  ipcMain.handle('project:create', async (_e, opts: ProjectCreateOptions): Promise<ProjectCreateResult> => {
    return createProject(opts)
  })

  // 工作区项目信息(applyWorkspace 时查询;pixelbox.json fs-event 变更时重取)
  ipcMain.handle('project:info', async (_e, root: string): Promise<ProjectInfo> => {
    if (typeof root !== 'string' || root.trim().length === 0) {
      return { kind: null, name: null, chip: null, manifest: null }
    }
    return readProjectInfo(root)
  })
}
