/**
 * 硬件设计链路冒烟探针(PIXELBOX_SMOKE_HW,无 UI 驱动环境)
 *
 * main 侧钩子(main/index.ts)创建临时 hardware 工程后,经 executeJavaScript 调用
 * window.__pbHwSmoke(root),在真实 renderer 里走完整生产链路:
 *   watchWorkspace → evaluateDesign(fs IPC 读 design/*.tsx → blob worker eval →
 *   BoardSpec/ScreenPlacement 提炼)→ buildEnclosure 分件 → HardwareViewer
 *   离屏建场景 → exportSTL('assembly') 二进制导出
 * 返回结构化断言数据(ok + 各阶段指标),由 main 侧打印 PASS/FAIL。
 *
 * 本模块常驻安装(main.tsx),但只定义入口函数 —— 重资产(eval worker/three)
 * 在被调用时才动态 import,不影响正常启动路径。
 */

interface HwSmokeResult {
  ok: boolean
  stage?: string
  error?: string
  elements?: number
  boardW?: number
  boardH?: number
  components?: number
  screenFound?: boolean
  baseChildren?: number
  lidChildren?: number
  stlBytes?: number
  ms?: number
}

export function installHardwareSmoke(): void {
  ;(window as unknown as { __pbHwSmoke?: (root: string) => Promise<HwSmokeResult> }).__pbHwSmoke =
    async (root: string): Promise<HwSmokeResult> => {
      const t0 = Date.now()
      try {
        // fs:* IPC 受 watchedRoot 路径牢笼保护,冒烟工程需先纳入监视
        await window.api.watchWorkspace(root)

        const { evaluateDesign, hardwareStore, resetHardware } = await import('./store')
        resetHardware()
        await evaluateDesign(root)
        const st = hardwareStore.get()
        if (st.status !== 'ok' || !st.circuitJson || !st.boardSpec) {
          return { ok: false, stage: 'eval', error: st.error ?? `status=${st.status}` }
        }

        const { buildEnclosure } = await import('./three/enclosureBuilder')
        const parts = buildEnclosure(st.boardSpec, st.enclosure, st.screen)

        const { HardwareViewer } = await import('./three/HardwareViewer')
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 240
        const viewer = new HardwareViewer(canvas, { interactive: false })
        let stlBytes = 0
        try {
          viewer.setHardware({
            board: st.boardSpec,
            enclosure: st.enclosure,
            screen: st.screen ?? undefined
          })
          stlBytes = viewer.exportSTL('assembly').byteLength
        } finally {
          viewer.dispose()
        }

        return {
          // 断言:元素量级正常 / 板尺寸为模板 60×45 / 屏幕占位被识别 /
          // 底盒顶盖分件非空 / 二进制 STL 超过空文件头(80B header + 4B count)
          ok:
            st.circuitJson.length > 50 &&
            Math.round(st.boardSpec.widthMM) === 60 &&
            Math.round(st.boardSpec.heightMM) === 45 &&
            st.boardSpec.components.length >= 4 &&
            st.screen !== null &&
            parts.base.children.length > 0 &&
            parts.lid.children.length > 0 &&
            stlBytes > 84,
          elements: st.circuitJson.length,
          boardW: st.boardSpec.widthMM,
          boardH: st.boardSpec.heightMM,
          components: st.boardSpec.components.length,
          screenFound: st.screen !== null,
          baseChildren: parts.base.children.length,
          lidChildren: parts.lid.children.length,
          stlBytes,
          ms: Date.now() - t0
        }
      } catch (err) {
        return { ok: false, stage: 'exception', error: String(err), ms: Date.now() - t0 }
      }
    }
}
