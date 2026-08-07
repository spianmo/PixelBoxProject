# IDE v3:三种项目类型 + 硬件设计(PCB/外壳/3D 打印)设计文档

> 状态:实施中(2026-08-06)。本文档是本次迭代的**唯一契约源** —— 所有 TypeScript 接口、IPC 通道名、
> 文件归属以此为准;实现 agent 不得擅自更改接口签名,发现矛盾以本文档为准并在报告中说明。

## 0. 目标

1. 新建项目支持三种类型:**ESP 应用工程(TS)**、**ESP 固件工程(ESP-IDF)**、**ESP 硬件设计工程(PCB+外壳)**。
2. 固件「编译/烧录/打包/清理」入口只在固件工程下可用,并作用于**当前工作区**(不再硬编码 monorepo firmware/)。
3. 应用工程增加「推送到已连接设备」(devd,复用现有 `devd:discover`/`devd:push`)。
4. 硬件设计工程:tscircuit 写 PCB(`design/board.tsx`),IDE 内 2D PCB/原理图预览 + three.js 3D 板卡
   与**可 3D 打印外壳**参数化设计,一键**爆炸视图**,导出 **STL/Gerber**,联机 **OctoPrint/Moonraker** 打印,
   并可把「板卡+外壳」注册为模拟器设备档案(命名等)。
5. 带 `hardware3d` 的设备档案在模拟运行应用时支持 **3D 视图**(屏幕内容贴图到 3D 模型、可拖动旋转、爆炸视图)。
6. 新建项目对话框重做为 **JetBrains 风格**(左侧类型列表 + 右侧表单,参考 IntelliJ New Project)。

## 1. 技术选型(已调研定案)

| 事项 | 决策 | 理由 |
|---|---|---|
| tsx→Circuit JSON | `@tscircuit/eval` **CircuitWebWorker**,`webWorkerBlobUrl` 用 `@tscircuit/eval/blob-url`(本地),`disableCdnLoading:true`,`projectConfig:{partsEngineDisabled:true}` | 官方三方接入路径;离线;autoroute 不卡 UI;worker 内自带 React,绕开 core 的 react-reconciler(peer React19) |
| 2D PCB | `@tscircuit/pcb-viewer`(PCBViewer, canvas, 离线) | peer react `*`,React18 可用 |
| 原理图 | `@tscircuit/schematic-viewer`(SVG, 离线) | 同上 |
| 3D(板卡+外壳+爆炸+模拟器内嵌) | **自建 three.js 0.185.1**(不用 @tscircuit/3d-viewer) | 3d-viewer peer 锁 react 19.1.0 且默认引擎从 CDN 拉 manifold WASM;自建可统一外壳/爆炸/屏幕贴图场景 |
| 外壳几何 | THREE.Shape+holes+ExtrudeGeometry「2.5D 分面实体」,**零 CSG** | 每个部件闭合防水;切片器(Prusa/Cura/Bambu)会对同一 STL 内重叠闭合壳做 union;确定性、即时重建 |
| 爆炸视图 | 零依赖:部件 userData 存单位方向+距离,`THREE.MathUtils.damp` 动画标量 0→1 | 帧率无关、可中途反转 |
| React 集成 | 命令式 viewer 类(useEffect 创建/销毁),**不用** react-three-fiber | r3f v9 要 React≥19 |
| STL 导出 | `three/addons/exporters/STLExporter.js` binary;导出前 `updateMatrixWorld(true)`、归零爆炸 | |
| Gerber 导出 | `circuit-json-to-gerber`(纯 JS 离线) | PCB 可交付制造 |
| 打印机 | Electron main 用 Node20 内置 fetch/FormData/`fs.openAsBlob`;驱动 **OctoPrint**(`X-Api-Key`,`POST /api/files/local`,`GET /api/job`)+ **Moonraker**(`POST /server/files/upload` 字段必须叫 `file`,`GET /printer/objects/query?print_stats&virtual_sdcard&display_status`) | 打印机只吃 G-code:UX 为「导出 STL → 用户切片 → IDE 上传 .gcode 开打+进度轮询」,**不宣传直接打 STL** |
| 版本 | 全部 **精确锁版**(tscircuit 生态 0.0.x 日更) | 已用 pnpm -E 安装 |

已知坑(实现时必须遵守):
- **【实测确认】渲染进程严禁 import `@tscircuit/eval` 包根或 `@tscircuit/core`**:包根顶层 import core →
  react-reconciler@0.32(要求 React19 内部结构)在 React18 下 **import 即崩**(`ReactSharedInternals.S` TypeError)。
  唯一安全入口:`import { createCircuitWebWorker } from '@tscircuit/eval/worker'`(只依赖 comlink,已加入 devDeps)+
  `import evalWorkerBlobUrl from '@tscircuit/eval/blob-url'`(14MB 自包含 worker,内置自己的 React)。
- eval 包存在**幽灵依赖**(comlink/@tscircuit/krt-wasm 等未声明):pnpm 隐藏提升目录(.pnpm/node_modules)已兜住,
  但不要新增对 eval 包根的任何 import 路径。
- 模板预验证沙箱:`/tmp/tsc-probe`(react19 + @tscircuit/eval,npm 布局)已就绪,验证命令:
  `cd /tmp/tsc-probe && node --input-type=module -e "import('@tscircuit/eval').then(async m => { const j = await m.runTscircuitCode(TSX源码字符串); ... })"`,
  断言含 `pcb_board` 且 pcb_component 数量正确。本文 §2.7 示例板已实测通过(209 元素)。
- `@tscircuit/eval/blob-url` ~14MB,electron.vite.config 需 `optimizeDeps.exclude` 并动态 `import()` 懒加载。
- 用户电路只允许**内置元素**(board/chip/resistor/led/pinheader/footprinter 内置封装);`@tsci/*` 导入需联网,模板不用。
- eval 可能卡死:worker 带超时(30s)+ kill/重建;`createCircuitWebWorker` 是全局单例。
- PCBViewer 每次成功 eval 后传**新数组引用**;CadViewer 不用(自建)。
- CanvasTexture:`generateMipmaps=false`+`NearestFilter`,仅在新帧到达时置 `needsUpdate`(脏标记,勿每 rAF)。
- OrbitControls `enableDamping` 需要 rAF 循环里 `controls.update()`。
- STLExporter 输出 DataView;写文件走 main(`Buffer.from(dv.buffer, dv.byteOffset, dv.byteLength)`)。
- OctoPrint 上传后必须检查 `effectivePrint`;Moonraker 检查 `print_started`;409/415 单独报错;进度归一化 0..1。
- 仓库是 **pnpm workspace**(不是 npm);任何 agent **禁止**执行 install。

## 2. 冻结契约(TypeScript)

### 2.1 `src/shared/ipc-types.ts` 追加(owner: main-services)

```ts
/** 项目类型 */
export type ProjectKind = 'app' | 'firmware' | 'hardware'

// PixelboxManifest 追加可选字段(向后兼容,旧工程无 type 视为 app):
//   type?: ProjectKind
//   chip?: string        // firmware/hardware 工程记录默认目标芯片(ChipId)

/** 工作区项目信息(project:info) */
export interface ProjectInfo {
  kind: ProjectKind | null       // null = 非 pixelbox 工程(普通目录,隐藏所有类型化动作)
  name: string | null
  chip: string | null            // manifest.chip ?? null
  manifest: PixelboxManifest | null
}

// ProjectCreateOptions 重构(NewProjectModal/projectScaffold 同步):
export interface ProjectCreateOptions {
  kind: ProjectKind
  name: string                   // [a-zA-Z0-9_-]+
  location: string
  appId?: string                 // kind=app 必填,反向域名
  template?: ProjectTemplate     // kind=app:'hello'|'blank'
  chip?: string                  // kind=firmware|hardware,ChipId,默认 'esp32s3'
}
// ProjectCreateResult 追加: kind: ProjectKind; entryFile: string(创建后要在编辑器打开的文件绝对路径;
//   app=src/main.ts, firmware=main/main.c, hardware=design/board.tsx)。保留 root;mainTs 字段删除(全仓改引用)。

/** ---- 硬件设计 3D 契约(挂在 DeviceProfile 上,亦被 hardware 面板使用) ---- */
/** 板上元件盒(简化 3D:挤出盒体) */
export interface BoardComponentBox {
  id: string
  name?: string
  x: number; y: number           // 中心,mm,板中心为原点,Y 向上(Circuit JSON 坐标)
  w: number; h: number           // mm
  heightMM: number               // 挤出高度,默认 2.5
  layer: 'top' | 'bottom'
}
/** 板卡简化 3D 规格(从 Circuit JSON 提炼,自包含 —— 档案脱离工程也能渲染) */
export interface BoardSpec {
  widthMM: number; heightMM: number
  thicknessMM: number            // pcb_board.thickness,默认 1.4
  outline?: { x: number; y: number }[]   // 多边形板轮廓(可选,覆盖 width/height)
  components: BoardComponentBox[]
  color?: string                 // 阻焊色,默认 '#1a7f37'
}
/** 屏幕在板上的放置(屏幕内容贴图 + 触摸映射) */
export interface ScreenPlacement {
  x: number; y: number           // 屏幕中心相对板中心,mm
  w: number; h: number           // 屏幕可视区,mm
  rotationDeg?: 0 | 90 | 180 | 270
}
/** 参数化外壳 */
export interface EnclosurePort { wall: 'north' | 'south' | 'east' | 'west'; x: number; y: number; w: number; h: number; r?: number }
export interface EnclosureParams {
  wallMM: number                 // 壁厚,默认 2
  clearanceMM: number            // 板与内壁间隙,默认 1
  baseHeightMM: number           // 底盒内腔高(板下表面以上),默认 12
  lidHeightMM: number            // 顶盖内腔高,默认 3
  standoffHeightMM: number       // 支撑柱高,默认 4
  standoffOuterR: number         // 默认 3
  standoffInnerR: number         // 螺孔半径,默认 1.1(M2 自攻)
  cornerR: number                // 外壳圆角,默认 2
  screenWindow: boolean          // 顶盖开屏幕窗(需 screen 放置)
  ports: EnclosurePort[]
  colorHex?: string              // 外壳颜色 '#rrggbb'(base+lid 材质色;缺省回退查看器内置灰)
}
// DEFAULT_ENCLOSURE 常量放 `src/shared/hardwareDefaults.ts`(新文件,owner: main-services;
// ipc-types.ts 保持纯类型零运行时代码的约定)
// export const DEFAULT_ENCLOSURE: EnclosureParams  // 上述默认值,ports: []
/** 设备档案携带的完整硬件外观 */
export interface Hardware3D {
  board: BoardSpec
  enclosure: EnclosureParams
  screen?: ScreenPlacement
  designRoot?: string            // 来源工程(仅提示用)
}
// DeviceProfile 追加可选字段: hardware3d?: Hardware3D (deviceProfiles.ts isProfileShape 已容忍额外字段)

/** ---- 打印机 ---- */
export type PrinterType = 'octoprint' | 'moonraker'
export interface PrinterJobStatus {
  state: string                  // 'printing'|'operational'|'paused'|'complete'|'error'|... 原样透传
  completion: number             // 0..1
  printTimeLeftSec?: number
  fileName?: string
}
export interface PrinterUploadResult { printStarted: boolean; remoteName: string }

/** ---- 硬件导出 ---- */
export interface HardwareExportFile { name: string; dataB64: string }
export interface HardwareExportResult { dir: string; files: string[] }
```

### 2.2 IPC 通道(owner: main-services 实现 + preload 封装)

| 通道 | 类型 | 签名 |
|---|---|---|
| `project:info` | handle | `(root: string) => ProjectInfo`(读 pixelbox.json;无 type 时启发:合法 app manifest→app;CMakeLists.txt+main/→firmware;否则 kind:null) |
| `project:create` | handle | `(opts: ProjectCreateOptions) => ProjectCreateResult`(已存在,扩展) |
| `hardware:export` | handle | `({ root, kind: 'print'|'gerber', files: HardwareExportFile[] }) => HardwareExportResult`;写入 `<root>/export/<kind>/`,完成后 `shell.showItemInFolder` |
| `printer:test` | handle | `() => string`(读 settings,返回版本/状态描述;失败 throw `printer:<code>`) |
| `printer:pick-gcode` | handle | `() => string \| null`(打开文件对话框,过滤 .gcode/.gco/.g) |
| `printer:upload` | handle | `({ path, startPrint }: { path: string; startPrint: boolean }) => PrinterUploadResult` |
| `printer:job` | handle | `() => PrinterJobStatus` |
| `toolchain:start` | handle | **扩展** `StartTaskOptions` 增加 `cwd?: string`:有 cwd 时 idf.py 在该目录执行(校验存在 CMakeLists.txt,否则 throw `toolchain:notFirmwareProject`);无 cwd 保持旧行为(monorepo firmware/) |

preload `window.api` 新增(命名与通道一一对应):`projectInfo(root)`, `hardwareExport(opts)`, `printerTest()`,
`printerPickGcode()`, `printerUpload(opts)`, `printerJob()`;`firmwareStart(opts)` 类型更新。

错误码约定沿用 `Error('<domain>:<code>')`:`printer:unreachable|badKey|conflict|unsupportedFile|notConfigured`、
`project:*` 沿用、`toolchain:notFirmwareProject`。

### 2.3 settings(owner: main-services 加 schema;Stage2 加设置页)

`settingsSchema.ts` 新增组 `printer`:`printer.type`('octoprint'|'moonraker',默认 'octoprint')、
`printer.baseUrl`(string,默认 '')、`printer.apiKey`(string,默认 '')。AppSettings 同步。

### 2.4 渲染器 hardware 模块契约(owner: hardware-three / hardware-ui)

```ts
// renderer/src/hardware/types.ts (owner: hardware-three,先建)
export type { BoardSpec, EnclosureParams, Hardware3D, ScreenPlacement, EnclosurePort, BoardComponentBox } from '../../../shared/ipc-types'
export type ExplodeTarget = 0 | 1
export type HardwarePartId = 'base' | 'lid' | 'board'

// renderer/src/hardware/three/boardBuilder.ts
export function buildBoardSpec(circuitJson: AnyCircuitElement[]): BoardSpec          // su().pcb_board/pcb_component 提炼;无 pcb_board 时 throw
export function detectScreenPlacement(circuitJson: AnyCircuitElement[]): ScreenPlacement | null
//   约定:元件名匹配 /^(screen|display|lcd|amoled|oled)/i 时视为屏幕,用其外形做可视区
export function buildBoardGroup(spec: BoardSpec): THREE.Group                        // name:'board';板体+元件盒

// renderer/src/hardware/three/enclosureBuilder.ts
export interface EnclosureParts { base: THREE.Group; lid: THREE.Group; display: THREE.Group | null; battery: THREE.Group | null }  // name:'base'/'lid'/'display'/'battery'
export function buildEnclosure(spec: BoardSpec, params: EnclosureParams, screen: ScreenPlacement | null): EnclosureParts
//   世界坐标系:mm,Y 轴向上(three 默认),板顶面为 y=standoffHeight+底板厚;XZ 平面对应板 XY(Circuit Y→three -Z)

// renderer/src/hardware/three/HardwareViewer.ts —— 命令式 viewer(hardware 面板与 Sim 3D 共用)
export interface HardwareViewerOptions {
  interactive?: boolean                    // OrbitControls,默认 true
  background?: string | null               // null=透明
  onScreenTouch?: (type: 'down'|'move'|'up', u: number, v: number) => void  // 屏幕面 raycast UV(0..1)
}
export class HardwareViewer {
  constructor(canvas: HTMLCanvasElement, opts?: HardwareViewerOptions)
  setHardware(hw: Hardware3D): void        // 重建 board/base/lid 组 + 爆炸向量(lid +Y,base -Y,board 原位)
  setExplode(target: 0 | 1): void          // damp 动画
  getExplode(): 0 | 1
  attachScreenCanvas(src: HTMLCanvasElement | null, placement: ScreenPlacement): void  // CanvasTexture 贴屏幕面
  markScreenDirty(): void                  // 新帧到达时由外部调用 → texture.needsUpdate
  exportSTL(part: HardwarePartId | 'assembly'): ArrayBuffer  // 归零爆炸+bake 变换,binary
  resize(): void
  dispose(): void
}
```

物理模型修正(实物堆叠,微雪 2.16 复刻):`setHardware` 额外组装两个**非打印**部件 ——
`display` 前置显示模组(screenWindow+screen 时:近黑亮面薄块 2.2mm 厚,顶面 = 顶盖外表面 −0.2mm,从内侧正好填住顶盖屏幕窗;屏幕 CanvasTexture 贴片挂其顶面 +0.05,爆炸随之抬升 0.55×lid —— 屏幕在壳体最外侧而非沉在板顶,无顶盖开窗时贴片回退板顶)与
`battery` 电池占位(可选 `EnclosureParams.batteryMM?: {w,h,t}`,底盒内腔地面居中的钢青色圆角扁块,足印避让四角支撑柱、厚度钳制不越过板底面;爆炸小幅 -Y)。
两者不在 `HardwarePartId` 中(无单件导出),`exportSTL('assembly')` 从克隆体剔除后再导出。



### 2.5 hardware UI 模块(owner: hardware-ui)

```ts
// renderer/src/hardware/store.ts —— createStore 模式(同 shell/store.ts)
export interface HardwareState {
  status: 'idle' | 'evaluating' | 'ok' | 'error'
  error: string | null
  circuitJson: AnyCircuitElement[] | null  // 每次成功 eval 换新引用
  boardSpec: BoardSpec | null
  screen: ScreenPlacement | null
  enclosure: EnclosureParams               // 载入 design/enclosure.json,变更 500ms 防抖写回
  explode: 0 | 1
  evalSeq: number
}
export const hardwareStore: Store<HardwareState>
export function useHardware(): HardwareState
export async function evaluateDesign(root: string): Promise<void>   // 读 design/*.tsx(fs IPC)→ worker eval → store
export async function loadEnclosureParams(root: string): Promise<void>
export function setEnclosureParams(root: string, patch: Partial<EnclosureParams>): void

// renderer/src/hardware/evalWorker.ts —— CircuitWebWorker 单例管理(懒加载 blob-url、30s 超时、kill 重建)
export async function evalTsxFsMap(fsMap: Record<string, string>, entry: string): Promise<AnyCircuitElement[]>

// renderer/src/hardware/HardwareDesignPanel.tsx —— 工具窗主组件(Stage2 挂到 rail)
export function HardwareDesignPanel(props: { workspaceRoot: string | null }): React.JSX.Element
// 内部 tabs: 'pcb' | 'schematic' | 'view3d' | 'enclosure' | 'print'
// 顶栏:运行设计(重新 eval)、爆炸视图 toggle(view3d)、导出 STL、导出 Gerber、添加到模拟器、连接打印机

// renderer/src/hardware/AddDeviceDialog.tsx —— 命名+芯片+分辨率(默认 368x448/esp32s3)→ saveDeviceProfile({... hardware3d})
// renderer/src/hardware/PrintDialog.tsx —— 流程:导出 STL 提示切片 → 选 .gcode(printerPickGcode)→ 上传(可选立即打印)→ 2.5s 轮询 printerJob 显示进度条;测试连接按钮
```

### 2.6 Sim 3D(owner: sim-3d)

- `SimPanel.tsx`:`profile.hardware3d` 存在时 ToolStrip 增加 2D/3D 切换钮(`sim.toolbar.view3d`)与爆炸钮(仅 3D);
  视图状态存 `SimSession`(sessions.ts 追加 `viewMode?: '2d' | '3d'`,默认 hardware3d 存在→'3d')。
- 新建 `panel/ScreenView3D.tsx`:隐藏 canvas(`screen.width×screen.height`)`engine.attachScreen(hidden)`;
  `HardwareViewer`(interactive, onScreenTouch → `engine.sendTouch(type, u*screenW, v*screenH)`);
  帧脏标记:engine 新增 **可选** 公开回调 `onFrame?: () => void`(engine.ts paintFrame 里调用,additive,不破坏契约)→ `viewer.markScreenDirty()`。
- 2D/3D 切换互斥使用 attachScreen(单 sink),切换时旧视图卸载先 `attachScreen(null)`。

### 2.7 三类工程脚手架(owner: main-services)

- **app**(现状保留,pixelbox.json 增 `"type":"app"`)。
- **firmware**:`pixelbox.json {type:'firmware', id, name, version:'0.1.0', entry:'', chip}` + `CMakeLists.txt`(cmake 3.16, include $ENV{IDF_PATH}/tools/cmake/project.cmake, project(<name>)) + `main/CMakeLists.txt`(idf_component_register SRCS "main.c") + `main/main.c`(FreeRTOS hello 循环 + ESP_LOGI) + `sdkconfig.defaults`(空注释) + `.gitignore`(build*/、sdkconfig、managed_components/) + `README.md`(编译烧录说明)。
- **hardware**:`pixelbox.json {type:'hardware', id, name, version:'0.1.0', entry:'', chip}` + `design/board.tsx`(**只用内置元素**的**微雪 ESP32-S3-Touch-AMOLED-2.16 复刻板**,按官方原理图/外壳尺寸图 1:1 归纳:board 40×40[装入 46×46×22.5 外壳:40+2×1 间隙+2×2 壁厚],正面 `SCREEN1` 2.16" AMOLED 480×480[参数化封装 `soic14_w39mm_p6.4mm`,可视区 39×39mm,占满正面];北侧板边三颗侧按键 SW1/SW2/SW3[+/KEY、PWR、BOOT/-,间距 10mm,`pushbutton` 通孔件放 layer="bottom" —— 顶层已被屏幕 courtyard 占满,DRC 教训]+上拉 R1;背面 layer="bottom":U1 ESP32-S3R8、U2 XM25QH128 16MB Flash、U3 AXP2101、U4 PCF85063 RTC、U5 QMI8658 IMU、U6 ES8311、U7 ES7210 双麦 ADC、U8 NS4150B 功放、TP1 CST9220 触摸、MIC1/MIC2 双 MEMS 麦、J1 电池座 MX1.25、J2 IPEX 天线座、SD1 microSD[西侧板边]、USB1 Type-C[南侧板边];3 条示例走线[共享 I2C 两段 + 按键上拉]。沙箱实测 1021 元素、20 pcb_component、0 DRC error)。**v3.1 更新**:U1 改用 `design/esp32-s3-mini.tsx` 的真实 ESP32-S3-MINI-1-N8 模组封装(73 焊盘;来源 github.com/tscircuit/motor-controller-pd-stepper,移除 cadModel CDN 引用保持离线),board.tsx 相对导入、走 CircuitRunner.executeWithFsMap 多文件评估,沙箱实测 1320 元素、20 pcb_component、U1 73 焊盘、0 DRC error;Monaco 侧由 syncDesignSiblingLibs 把 design/ 兄弟文件注册为 extraLib 支撑跨文件解析 + `design/enclosure.json`(WAVESHARE_216_ENCLOSURE:wall 2 / clearance 1 / cornerR 5.8 / base 15 + lid 3.5 → 总高 22.5mm、白色 `colorHex:'#f2f2f4'`、北壁 3×Φ5.3 按钮孔 + 南壁 USB-C 9.2×3.6 + 西壁 microSD 12×2.4;**不改** hardwareDefaults 的通用 DEFAULT_ENCLOSURE) + `README.md`(含元件↔原理图块对照表、官方 wiki 链接、480×480 分辨率建议) + `.gitignore`(export/)。EnclosureParams 追加可选 `colorHex?: string`('#rrggbb',enclosureBuilder base+lid 材质色,缺省回退内置灰);EnclosureForm 增「外壳颜色」字段(`hw.enclosure.color`);AddDeviceDialog 分辨率默认 480×480。
- 模板 **必须实测**:`node --input-type=module -e "import('@tscircuit/eval')…runTscircuitCode(源码)"` 在 simulator/node_modules 下跑通并含 pcb_board,再落库。

### 2.8 NewProjectModal(owner: new-project-dialog)

JetBrains 风格(参考 IntelliJ New Project 截图):
- 布局:`w-[720px] h-[480px]` 左右分栏。左栏 190px:标题「新建项目」下三项类型列表(图标+名称:ESP 应用工程 / ESP 固件工程 / ESP 硬件设计工程),选中高亮 `bg-accent`。右栏表单:名称、位置(输入+📁选择,下方灰字「项目将创建于:<location>/<name>」)、分隔线后按类型:app→模板(hello/blank 分段控件)+应用 ID;firmware→目标芯片(CHIP_IDS 分段控件/下拉);hardware→目标芯片。底部右侧 `取消`/`创建`(accent 主按钮),左下帮助图标省略。
- Props 不变:`{ onCreated: (r: ProjectCreateResult) => void; onClose: () => void }`;创建调 `window.api.projectCreate`。
- 校验与错误码映射沿用现有实现(`newProject.errors.*`);组件内所有文案走 i18n key(见 §4)。

## 3. 文件归属(Stage1 并行 agent 严禁越界)

| agent | 独占文件 |
|---|---|
| main-services | `shared/ipc-types.ts`、`shared/settingsSchema.ts`、`main/projectScaffold.ts`、`main/toolchain.ts`、`main/printer.ts`(新)、`main/hardwareExport.ts`(新)、`main/index.ts`、`preload/index.ts` |
| hardware-three | `renderer/src/hardware/types.ts`、`renderer/src/hardware/three/boardBuilder.ts`、`enclosureBuilder.ts`、`HardwareViewer.ts`(均新) |
| hardware-ui | `renderer/src/hardware/store.ts`、`evalWorker.ts`、`HardwareDesignPanel.tsx`、`EnclosureForm.tsx`、`AddDeviceDialog.tsx`、`PrintDialog.tsx`(均新) |
| new-project-dialog | `renderer/src/shell/NewProjectModal.tsx` |
| sim-3d | `renderer/src/device-sim/panel/ScreenView3D.tsx`(新)、`panel/SimPanel.tsx`、`sessions.ts`、`engine.ts`(仅加 onFrame 回调) |
| **Stage2(集成)** | `renderer/src/App.tsx`、`shell/TitleBar.tsx`、`shell/viewMode.ts`、`i18n/locales/*.json`、`settings/pages/printer.tsx`(新)、`settings/categories.ts`、`electron.vite.config.ts` |

规则:Stage1 agent 需要 App.tsx/TitleBar 改动时,只在结构化输出的 `integrationNotes` 里描述,由 Stage2 执行;
i18n 文案不写 locale JSON,在结构化输出 `i18nKeys` 返回 `{key: {zh, en}}`;不运行 install;
typecheck 允许暂红(跨 agent 引用在 Stage2 后统一修复),但**自有文件内部**必须自洽。

## 4. i18n 约定

新增组:`newProject.*`(kind 名称/描述/字段)、`hw.*`(面板 tabs/按钮/状态/错误)、`printer.*`(设置页+对话框)、
`fw.errors.notFirmwareProject`、`titlebar.pushToDevice`、`sim.toolbar.view3d`/`sim.toolbar.explode`。
zh-CN 为源语言,en 同步;两文件 key 树必须一致。

## 5. 门控矩阵(Stage2 实现)

| UI | app | firmware | hardware | kind=null |
|---|---|---|---|---|
| ▶ 运行(模拟器) | ✓ | ✗ | ✗ | ✓(兼容旧行为) |
| 推送到设备(新钮,LuSend,设备下拉旁) | ✓ | ✗ | ✗ | ✗ |
| 🔨 固件构建 | ✗ | ✓ | ✗ | ✗ |
| ⋮ fw-package/flash/clean | ✗ | ✓ | ✗ | ✗ |
| hardware 工具窗 rail 图标 | ✗ | ✗ | ✓ | ✗ |
| 芯片选择下拉 | ✓(保留) | ✓ | ✓ | ✓ |

隐藏而非禁用(JetBrains 惯例);运行中任务的取消入口必须保留(fwBusy 时 ⋮ 里 fw-cancel 始终可见)。
`startFirmwareTask`(App.tsx:729)为唯一渲染端闸口:kind!=='firmware' → toast + return;
main 端 `toolchain:start` 以 `cwd` 校验兜底。项目 kind 由 `project:info` 在 applyWorkspace 时取得,
存 App state 并透传;pixelbox.json 的 fs-event 变更时重取。

## 6. 验证清单(Stage 3)

1. `pnpm --filter pixelbox-simulator run typecheck` 双 tsconfig 全绿。
2. `pnpm --filter pixelbox-simulator run build` 通过(electron-vite build)。
3. 硬件模板 eval 实测(Node)出 pcb_board;Gerber 导出非空;STL 导出头部合法(80B header + tri count)。
4. 评审维度:类型正确性/离线保障(无 CDN URL)/i18n 双语齐全/门控矩阵/资源释放(dispose/unsubscribe)。
