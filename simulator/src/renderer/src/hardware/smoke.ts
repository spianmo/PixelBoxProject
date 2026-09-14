/** 硬件链路冒烟：真实脚手架 → Worker 电路求值 → 电气拓扑/制造门禁 →
 * SCAD 编译 → 3D/STL/SVG → Monaco 跨文件诊断；可制造设计必须导出真实铜层与钻孔。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

interface HwSmokeResult {
  ok: boolean
  stage?: string
  error?: string
  elements?: number
  boardW?: number
  boardH?: number
  components?: number
  screenFound?: boolean
  /** 屏幕贴片世界中心契约:x/z 与 placement 对齐,y ≈ 顶盖外表面−0.2(前置显示模组顶面) */
  screenWorldOk?: boolean
  screenWorld?: { x: number; y: number; z: number } | null
  /** 装配体含 battery 电池占位部件(模板 enclosure.json 携带 batteryMM) */
  batteryPart?: boolean
  /**
   * 「编辑外壳」模式手柄数契约:开启后手柄数 = 4 参数手柄 + 每开孔 2
   * (enclosureGizmos.listHandleSpecs;模板 5 开孔 → 14),关闭后回 0
   */
  editHandles?: boolean
  /** 编辑模式开启时的实际手柄数(定位用) */
  editHandleCount?: number
  /** BoardSpec 元件 kind 推断:含 'usb'(USB1 南侧 Type-C 得到专属金属壳外形) */
  gerberExportOk?: boolean
  /** OpenSCAD 外壳:脚手架 enclosure.scad 经 wasm worker 编译出非空 base/lid STL */
  scadOk?: boolean
  /** PB_META 契约:boardTopZ 与参数推导(wall+standoff)一致 */
  scadMetaOk?: boolean
  /** scad 编译耗时 ms(base+lid 两趟预览质量) */
  scadMs?: number
  cancellationOk?: boolean
  evalMs?: number
  moduleOk?: boolean
  topologyOk?: boolean
  manufacturingReady?: boolean
  dimensionsOk?: boolean
  reportExportOk?: boolean
  validationErrors?: string[]
  printErrors?: string[]
  baseChildren?: number
  lidChildren?: number
  stlBytes?: number
  /** circuit-to-svg 转 PCB SVG 字符串长度(断言 > 1000) */
  pcbSvgBytes?: number
  /** circuit-to-svg 转原理图 SVG 字符串长度(断言 > 1000) */
  schSvgBytes?: number
  /** <CircuitSvgView> 真实挂载后容器内出现 <svg> */
  svgMounted?: boolean
  /** Monaco TS worker:`<boa` 处元素补全含 board(tscircuit IntrinsicElements 生效) */
  tsxElementCompletion?: boolean
  /** Monaco TS worker:`<chip ` 处属性补全含 footprint 与 pcbX(@tscircuit/props 解析成功) */
  tsxPropCompletion?: boolean
  /** Monaco TS worker:脚手架 design/board.tsx 全文语义+语法诊断 0 个 error */
  tsxDiagnostics?: boolean
  /** tsx-intellisense 阶段失败时的最后错误/诊断样本 */
  tsxError?: string
  ms?: number
}

/** TS 诊断 messageText 可能是链式对象:取首层文本足够定位 */
function flattenTsMessage(m: unknown): string {
  if (typeof m === 'string') return m
  const chain = m as { messageText?: unknown } | null
  return typeof chain?.messageText === 'string' ? chain.messageText : String(m)
}

interface TsxProbeResult {
  tsxElementCompletion: boolean
  tsxPropCompletion: boolean
  tsxDiagnostics: boolean
  tsxError?: string
}

/**
 * tsx-intellisense 阶段:走真实 Monaco ts.worker 链路(镜像 main/index.ts 的
 * PIXELBOX_SMOKE_MONACO 探针写法),验证 tscircuit TSX 智能提示三件套。
 * 17MB extraLib(core+props d.ts)首次建程序解析耗时数秒 —— 20s 截止前轮询,
 * 各断言先成即锁定,避免对 worker 解析时长做假设
 */
async function runTsxIntellisense(root: string): Promise<TsxProbeResult> {
  const res: TsxProbeResult = {
    tsxElementCompletion: false,
    tsxPropCompletion: false,
    tsxDiagnostics: false
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  // monaco 常驻主包(EditorHost 启动即用);tscircuit d.ts 大 chunk 在 inject 内惰性拉取
  const { monaco } = await import('../editor/monacoSetup')
  const { injectTscircuitTypes, syncDesignSiblingLibs } = await import('../editor/tscircuitTypes')
  const disposables: Array<{ dispose(): void }> = []
  try {
    await injectTscircuitTypes()
    // 诊断断言对象用脚手架落盘的真实 board.tsx(验收线:模板对 core d.ts 零报错)。
    // board.tsx 相对导入 './official-data' —— 必须走生产同款兄弟文件注册
    // (syncDesignSiblingLibs → official-data.ts 成 extraLib),并用真实路径 uri
    // 建 model(相对导入按 model uri 解析),0 error 即证明跨文件解析生效
    const boardPath = `${root}/design/board.tsx`
    await syncDesignSiblingLibs(boardPath)
    const boardTsx = await window.api.readFile(boardPath)

    const makeModel = (uri: ReturnType<typeof monaco.Uri.parse>, content: string): ReturnType<typeof monaco.editor.createModel> => {
      monaco.editor.getModel(uri)?.dispose() // 防御:同 uri 孤儿 model 先回收
      const m = monaco.editor.createModel(content, 'typescript', uri)
      disposables.push(m)
      return m
    }
    const elementModel = makeModel(
      monaco.Uri.parse('file:///smoke/board-smoke.tsx'),
      'export default () => (<boa'
    )
    const propModel = makeModel(
      monaco.Uri.parse('file:///smoke/chip-smoke.tsx'),
      'export default () => (<chip '
    )
    const fullModel = makeModel(monaco.Uri.file(boardPath), boardTsx)

    const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
    const client = await getWorker(elementModel.uri, propModel.uri, fullModel.uri)
    const completionNames = async (uri: string, offset: number): Promise<string[]> => {
      const info = (await client.getCompletionsAtPosition(uri, offset)) as
        | { entries?: Array<{ name: string }> }
        | undefined
      return (info?.entries ?? []).map((e) => e.name)
    }

    const deadline = Date.now() + 20000
    let lastError = ''
    for (;;) {
      try {
        if (!res.tsxElementCompletion) {
          const names = await completionNames(
            elementModel.uri.toString(),
            elementModel.getValue().length
          )
          res.tsxElementCompletion = names.includes('board')
        }
        if (!res.tsxPropCompletion) {
          const names = await completionNames(propModel.uri.toString(), propModel.getValue().length)
          res.tsxPropCompletion = names.includes('footprint') && names.includes('pcbX')
        }
        if (!res.tsxDiagnostics) {
          const uri = fullModel.uri.toString()
          const all = [
            ...(await client.getSemanticDiagnostics(uri)),
            ...(await client.getSyntacticDiagnostics(uri))
          ] as Array<{ category: number; code: number; messageText: unknown }>
          // 只拦 error(ts.DiagnosticCategory.Error === 1);suggestion/warning 放行
          const errors = all.filter((d) => d.category === 1)
          res.tsxDiagnostics = errors.length === 0
          lastError = errors
            .slice(0, 3)
            .map((d) => `TS${d.code}: ${flattenTsMessage(d.messageText)}`)
            .join(' | ')
        }
      } catch (err) {
        lastError = String(err) // worker 正在解析大 extraLib 时调用可能失败:重试
      }
      if (res.tsxElementCompletion && res.tsxPropCompletion && res.tsxDiagnostics) break
      if (Date.now() > deadline) {
        res.tsxError = lastError || 'tsx 断言 20s 内未收敛'
        break
      }
      await sleep(500)
    }
  } catch (err) {
    res.tsxError = String(err)
  } finally {
    for (const d of disposables) d.dispose()
  }
  return res
}

export function installHardwareSmoke(): void {
  ;(window as unknown as { __pbHwSmoke?: (root: string) => Promise<HwSmokeResult> }).__pbHwSmoke =
    async (root: string): Promise<HwSmokeResult> => {
      const t0 = Date.now()
      try {
        // fs:* IPC 受 watchedRoot 路径牢笼保护,冒烟工程需先纳入监视。
        // App 启动的会话恢复会 watch 上次工作区并覆盖牢笼根(时序不定),
        // 故反复夺回监视权直到本工程可读(恢复只发生一次,稳定后不再被抢)
        // 判据:夺回后 1.5s 仍可读才算稳定(恢复只覆盖一次,存活即不再被抢),
        // 否则 evaluateDesign 中途仍可能被恢复流程抢走牢笼根
        const jailDeadline = Date.now() + 20000
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        for (;;) {
          try {
            await window.api.watchWorkspace(root)
            await window.api.readDir(`${root}/design`)
            await sleep(1500)
            await window.api.readDir(`${root}/design`)
            break
          } catch (err) {
            if (Date.now() > jailDeadline) throw err
            await sleep(500)
          }
        }

        const { evaluateDesign, hardwareStore, resetHardware, compileEnclosureScad } =
          await import('./store')
        resetHardware()
        const evalStart = Date.now()
        await evaluateDesign(root)
        const evalMs = Date.now() - evalStart
        // 热 Worker 中运行死循环，验证取消确实终止线程；随后再次运行真实工程验证可恢复。
        const {evalTsxFsMap} = await import('./evalWorker')
        const abort = new AbortController()
        const cancelTimer = setTimeout(()=>abort.abort(),300)
        let cancellationOk = false
        try { await evalTsxFsMap({'board.tsx':'export default () => { for (;;) {} }'},'board.tsx',abort.signal) }
        catch(err) { cancellationOk = err instanceof Error && err.message === 'hardware:evalCancelled' }
        finally {clearTimeout(cancelTimer)}
        await evaluateDesign(root)
        const st = hardwareStore.get()
        if (st.status !== 'ok' || !st.circuitJson || !st.boardSpec) {
          return { ok: false, stage: 'eval', error: st.error ?? `status=${st.status}` }
        }

        // OpenSCAD 外壳链路(几何唯一真源):脚手架 design/enclosure.scad →
        // wasm worker 编译(base+lid 预览质量)→ PB_META 契约解析。
        // 模板参数基准(微雪 46×46×22.5):boardTopZ = wall2 + standoff9.5 = 11.5
        // (柱高 9.5 让 5mm 电池以真实厚度放进板下);电池钳制后 28×28×5 @ z=2
        const scadT0 = Date.now()
        await compileEnclosureScad(root)
        const scadSt = hardwareStore.get()
        const scadOk =
          scadSt.scadStatus === 'ok' &&
          scadSt.scad !== null &&
          scadSt.scad.baseStlB64.length > 1000 &&
          scadSt.scad.lidStlB64.length > 1000
        const meta = scadSt.scad?.meta ?? null
        const scadMetaOk =
          meta !== null &&
          meta.boardTopZ === 11.5 && meta.outerW === 46 && meta.outerD === 46 && meta.lidTopZ === 22.5 &&
          meta.design?.cornerR === 5.8 && meta.design.screen[0] === 0 && meta.design.screen[1] === 0 &&
          meta.battery?.[0] === 28 && meta.battery[1] === 28 && meta.battery[2] === 5
        const scadMs = Date.now() - scadT0
        if (!scadOk || !scadSt.scad) {
          return {
            ok: false,
            stage: 'scad',
            error: scadSt.scadError ?? 'scad compile failed',
            ms: Date.now() - t0
          }
        }
        const scadPayload = scadSt.scad

        // 旧设备档案的参数化渲染路径回归(enclosure.json 退役后 buildEnclosure
        // 仅服务旧档案):内联微雪参数,分件构建与编辑手柄契约不回归
        const LEGACY_PARAMS = {
          outerSizeMM: { w: 46, d: 46 },
          wallMM: 2,
          clearanceMM: 1,
          baseHeightMM: 15,
          lidHeightMM: 3.5,
          standoffHeightMM: 4,
          standoffOuterR: 3,
          standoffInnerR: 1.1,
          cornerR: 5.8,
          screenWindow: true,
          batteryMM: { w: 30, h: 30, t: 5 },
          ports: [
            { wall: 'north' as const, x: -10, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
            { wall: 'north' as const, x: 0, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
            { wall: 'north' as const, x: 10, y: 7.5, w: 5.3, h: 5.3, r: 2.65 },
            { wall: 'south' as const, x: 0, y: 4, w: 9.2, h: 3.6, r: 1.6 },
            { wall: 'west' as const, x: 0, y: 3.5, w: 12, h: 2.4, r: 1 }
          ]
        }

        // 核对带 PSRAM 的模组型号与 49 个独立检查焊盘。
        const u1 = st.circuitJson.find((e) => e.type === 'source_component' && e.name === 'U1')
        const moduleOk = u1?.type === 'source_component' && u1.manufacturer_part_number === 'ESP32-S3-WROOM-1U-N16R8' &&
          st.circuitJson.filter((e) => e.type === 'source_port' && e.source_component_id === u1.source_component_id).length === 49
        const validation = scadSt.validation
        const topologyOk = Boolean(validation && !validation.errors.some((e) => /拓扑|集合不一致|SHA256|缺少或损坏/.test(e)))
        const manufacturingReady = Boolean(validation && validation.errors.length === 0 && validation.counts.unroutedConnections === 0)
        const dimensionsOk = validation?.printErrors.length === 0
        // 真实导出 IPC + 读回验证，确保检查报告可在工程内独立审阅。
        const reportText = JSON.stringify(validation, null, 2)
        const bytes = new TextEncoder().encode(reportText)
        let reportBinary = ''
        for (const byte of bytes) reportBinary += String.fromCharCode(byte)
        const reportResult = await window.api.hardwareExport({ root, kind: 'validation', files: [{ name: 'report.json', dataB64: btoa(reportBinary) }] })
        const reportExportOk = reportResult.files.includes('report.json') &&
          JSON.parse(await window.api.readFile(`${root}/export/validation/report.json`)).counts.pins === 111


        const { buildEnclosure } = await import('./three/enclosureBuilder')
        const parts = buildEnclosure(st.boardSpec, LEGACY_PARAMS, st.screen)

        const { HardwareViewer } = await import('./three/HardwareViewer')
        const canvas = document.createElement('canvas')
        canvas.width = 900
        canvas.height = 700
        canvas.style.cssText = 'position:fixed;inset:0;width:900px;height:700px;z-index:99999;background:#202326'
        document.body.appendChild(canvas)
        const viewer = new HardwareViewer(canvas, { interactive: false })
        let stlBytes = 0
        let screenWorldOk = false
        let screenWorld: { x: number; y: number; z: number } | null = null
        let batteryPart = false
        let editHandles = false
        let editHandleCount = 0
        let gerberExportOk = false
        try {
          // scad 几何为主路径:base/lid 来自 wasm 编译 STL,battery/display 由
          // PB_META 契约在 TS 侧补齐(电池占位不再依赖任何参数化字段)
          viewer.setHardware({
            board: st.boardSpec,
            scad: scadPayload,
            screen: st.screen ?? undefined
          })
          batteryPart = viewer.getPartNames().includes('battery')
          // 屏幕贴片世界位姿断言(Sim 3D 同款管线):贴一块假屏幕画布。
          // 物理模型契约(实物堆叠):屏幕装在壳体最外侧 —— 前置显示模组顶面
          // = PB_META.screenFaceZ(顶盖外表面 − 0.2)+ 0.05 贴片微抬;
          // x/z 仍与 placement 对齐(circuit y → three -z)
          if (st.screen && meta?.screenFaceZ != null) {
            const fake = document.createElement('canvas')
            fake.width = 64
            fake.height = 64
            viewer.attachScreenCanvas(fake, st.screen)
            screenWorld = viewer.getScreenWorldCenter()
            screenWorldOk =
              screenWorld !== null &&
              Math.abs(screenWorld.x - st.screen.x) <= 0.1 &&
              Math.abs(screenWorld.z - -st.screen.y) <= 0.1 &&
              screenWorld.y > 15 && // 前置安装(微雪模板壳高 22.5;埋底缺陷时 y≈8.6)
              Math.abs(screenWorld.y - (meta.screenFaceZ + 0.05)) <= 0.25
            viewer.attachScreenCanvas(null, st.screen)
          }
          // 旧档案参数化路径:「编辑外壳」手柄契约(enclosureGizmos)——
          // 4 参数手柄 + 每开孔 2(微雪 5 开孔 → 14),关闭清零;scad 硬件下手柄禁用
          viewer.setHardware({
            board: st.boardSpec,
            enclosure: LEGACY_PARAMS,
            screen: st.screen ?? undefined
          })
          viewer.setEnclosureEditMode(true)
          editHandleCount = viewer.getEnclosureHandleCount()
          const expectedHandles = 4 + 2 * LEGACY_PARAMS.ports.length
          viewer.setEnclosureEditMode(false)
          editHandles =
            editHandleCount === expectedHandles &&
            editHandleCount >= 8 &&
            viewer.getEnclosureHandleCount() === 0
          // 回到 scad 硬件:后续爆炸/导出断言以主路径为准
          viewer.setHardware({
            board: st.boardSpec,
            scad: scadPayload,
            screen: st.screen ?? undefined
          })
          // 真实 Gerber + 金属/非金属钻孔导出，并读回确认铜层和孔径。
          const g = await import('circuit-json-to-gerber')
          const cj = st.circuitJson as unknown as Parameters<typeof g.convertSoupToGerberCommands>[0]
          const layers = g.stringifyGerberCommandLayers(g.convertSoupToGerberCommands(cj))
          const files = Object.entries(layers).map(([name, content]) => ({name:`${name}.gbr`,dataB64:btoa(content)}))
          for (const plated of [true,false]) files.push({name:plated?'plated.drl':'unplated.drl', dataB64:btoa(g.stringifyExcellonDrill(g.convertSoupToExcellonDrillCommands({circuitJson:cj,is_plated:plated})))})
          if (manufacturingReady) {
            const out = await window.api.hardwareExport({root,kind:'gerber',files})
            const drilled = await window.api.readFile(`${out.dir}/plated.drl`)
            const mounting = await window.api.readFile(`${out.dir}/unplated.drl`)
            gerberExportOk = out.files.length >= 8 && drilled.includes('C0.3') && drilled.includes('C0.65') && mounting.includes('C2.4')
          }
          viewer.setExplode(1)
          viewer.setExplode(0)
          // exportSTL 在克隆体上把部件与 subExplode 子网格全部归位,爆炸态导出安全
          stlBytes = viewer.exportSTL('assembly').byteLength
          await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
          await window.api.hardwareExport({root,kind:'validation',files:[{name:'assembly.png',dataB64:canvas.toDataURL('image/png').split(',')[1]}]})
        } finally {
          viewer.dispose()
          canvas.remove()
        }

        // 外壳撤销/重做链路:两次相隔 >600ms(跨手势分组窗口)的编辑 = 两条历史;
        // undo×2 回到原值 → redo 前进一步 → 再 undo 恢复。结束态必须与阶段前
        // 快照深等,且恢复只靠 undo(不用 set 回写)—— 证明历史栈自洽
        // (外壳撤销/重做与参数化 CRUD 已随 enclosure.json 退役:.scad 文本
        //  撤销由 Monaco 承接;scad 编译断言已前移到评估段之后)

        // circuit-to-svg 转换链路(CircuitSvgView 同款转换器,同步纯函数)
        const svgLib = await import('circuit-to-svg')
        const pcbSvgBytes = svgLib.convertCircuitJsonToPcbSvg(st.circuitJson).length
        const schSvgBytes = svgLib.convertCircuitJsonToSchematicSvg(st.circuitJson).length

        // 真实挂载 <CircuitSvgView>:组件内动态 import + effect 异步转换,
        // 等 1.5s 后断言容器出现 <svg>(覆盖"viewer import 即白屏"一类回归)
        const { CircuitSvgView } = await import('./CircuitSvgView')
        const host = document.createElement('div')
        const reactRoot = createRoot(host)
        let svgMounted = false
        try {
          reactRoot.render(
            createElement(CircuitSvgView, { circuitJson: st.circuitJson, kind: 'pcb', evalSeq: 1 })
          )
          await sleep(1500)
          svgMounted = host.innerHTML.includes('<svg')
        } finally {
          reactRoot.unmount()
        }

        // tsx-intellisense:Monaco TS worker 真实补全/诊断(tscircuit 类型注入链路)
        const tsx = await runTsxIntellisense(root)

        return {
          // 默认小板必须通过电气与装配检查；软件检查不等于首板通电和实物试装。
          ok:
            st.circuitJson.length > 50 &&
            Math.abs(st.boardSpec.widthMM - 41) < .01 &&
            Math.abs(st.boardSpec.heightMM - 41) < .01 &&
            validation?.counts.components === 17 &&
            validation.counts.pins === 111 &&
            validation.counts.nets === 34 &&
            cancellationOk && moduleOk && topologyOk && manufacturingReady && dimensionsOk && reportExportOk &&
            st.screen !== null &&
            Math.round(st.screen.w) === 39 &&
            Math.round(st.screen.h) === 39 &&
            screenWorldOk &&
            batteryPart &&
            editHandles &&
            gerberExportOk &&

            scadOk &&
            scadMetaOk &&
            parts.base.children.length > 0 &&
            parts.lid.children.length > 0 &&
            stlBytes > 84 &&
            pcbSvgBytes > 1000 &&
            schSvgBytes > 1000 &&
            svgMounted &&
            tsx.tsxElementCompletion &&
            tsx.tsxPropCompletion &&
            tsx.tsxDiagnostics,
          elements: st.circuitJson.length,
          boardW: st.boardSpec.widthMM,
          boardH: st.boardSpec.heightMM,
          components: st.boardSpec.components.length,
          cancellationOk, evalMs, moduleOk, topologyOk, manufacturingReady, dimensionsOk, reportExportOk,
          validationErrors: validation?.errors.slice(-6),
          printErrors: validation?.printErrors,
          screenFound: st.screen !== null,
          screenWorldOk,
          screenWorld,
          batteryPart,
          editHandles,
          editHandleCount,
          gerberExportOk,

          scadOk,
          scadMetaOk,
          scadMs,
          baseChildren: parts.base.children.length,
          lidChildren: parts.lid.children.length,
          stlBytes,
          pcbSvgBytes,
          schSvgBytes,
          svgMounted,
          ...tsx,
          ms: Date.now() - t0
        }
      } catch (err) {
        return { ok: false, stage: 'exception', error: String(err), ms: Date.now() - t0 }
      }
    }
}
