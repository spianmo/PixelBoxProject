/** 制造前检查：完整性、网络拓扑和官方机械基准分别记录，未知数据不当作通过。 */
import type { AnyCircuitElement } from 'circuit-json'
import { checkAssembly } from './assemblyValidation'
import { checkCopperConnectivity } from './connectivity'
import type { BoardSpec, EnclosureScadMeta, ScreenPlacement } from '../../../shared/ipc-types'
import type { HardwareReference, OfficialNetlist } from '../../../shared/hardwareReference'

export interface HardwareValidation {
  generatedAt: string
  ok: boolean
  errors: string[]
  printErrors: string[]
  warnings: string[]
  counts: { components: number; pins: number; nets: number; unroutedConnections: number; drcErrors: number }
  dimensions: { board: BoardSpec; screen: ScreenPlacement | null; enclosure: EnclosureScadMeta | null }
  reference: HardwareReference | null
}

type Row = Record<string, any>
export function validateHardware(circuit: AnyCircuitElement[], board: BoardSpec, screen: ScreenPlacement | null,
  meta: EnclosureScadMeta | null, ref: HardwareReference | null, netlist: OfficialNetlist | null,
  referenceError?: string): HardwareValidation {
  const errors: string[] = []
  const printErrors: string[] = checkAssembly(board, meta)
  const warnings: string[] = []
  const rows = circuit as Row[]
  const components = rows.filter((e) => e.type === 'source_component')
  const ports = rows.filter((e) => e.type === 'source_port')
  const traces = rows.filter((e) => e.type === 'source_trace')
  const nets = rows.filter((e) => e.type === 'source_net')
  const drc = rows.filter((e) => e.type.endsWith('_error'))
  errors.push(...drc.map((e) => `${e.type}: ${e.message ?? e.error_type ?? '设计错误'}`))
  const copper = checkCopperConnectivity(circuit)
  const unrouted = copper.unrouted
  errors.push(...copper.errors)
  if (referenceError) { errors.push(referenceError); printErrors.push(referenceError) }

  if (ref) {
    // 损坏基准不得悄悄当成“无基准”；外部 JSON 先做最小结构检查再访问。
    if (ref.schemaVersion !== 1 || !ref.board || !ref.enclosure || !ref.screen || !ref.fabrication ||
      !ref.mounting || !Array.isArray(ref.mounting.centers) || !Array.isArray(ref.ports) || !ref.electrical || !Array.isArray(ref.unverified)) {
      errors.push('reference.json 格式无效或版本不支持')
      printErrors.push('reference.json 格式无效或版本不支持')
    } else {
      const near = (a: unknown, b: number, label: string, target = printErrors, tol = 0.05): void => {
        if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b) || Math.abs(a - b) > tol) target.push(`${label}: ${a ?? '缺失'}，基准 ${b} mm`)
      }
      near(board.widthMM, ref.board.widthMM, '设计板宽', errors)
      near(board.heightMM, ref.board.heightMM, '设计板深', errors)
      near(board.thicknessMM, ref.board.thicknessMM, '设计板厚', errors)
      if(ref.kind==='functional'&&ref.mounting.centers.some(p=>!board.mountingHoles?.some(h=>
        Math.hypot(h.x-p.x,h.y-p.y)<=.05&&h.diameterMM>=2.2)))errors.push('PCB 安装孔缺失或未与外壳螺柱同轴')
      near(screen?.w, ref.screen.w, '屏幕 VA 宽')
      near(screen?.h, ref.screen.h, '屏幕 VA 高')
      near(meta?.outerW, ref.enclosure.widthMM, '外壳宽')
      near(meta?.outerD, ref.enclosure.depthMM, '外壳深')
      near(meta?.lidTopZ, ref.enclosure.heightMM, '外壳高')
      const d = meta?.design
      near(d?.cornerR, ref.enclosure.cornerRMM, '外角半径')
      near(d?.board?.[0], board.widthMM, '外壳中的板宽')
      near(d?.board?.[1], board.heightMM, '外壳中的板深')
      near(d?.board?.[2], board.thicknessMM, '外壳中的板厚')
      near(d?.screen?.[0], ref.screen.x, '屏幕窗 X')
      near(d?.screen?.[1], ref.screen.y, '屏幕窗 Y')
      near(d?.screen?.[2], ref.screen.w, '屏幕窗宽')
      near(d?.screen?.[3], ref.screen.h, '屏幕窗高')
      near(d?.screen?.[4], ref.screen.visibleCornerRMM, '屏幕窗圆角')
      near(d?.screenSeat?.[0], ref.screen.outerMM, '玻璃 OD 宽')
      near(d?.screenSeat?.[1], ref.screen.outerMM, '玻璃 OD 高')
      const centers = Array.isArray(d?.standoffs) ? d.standoffs : []
      if (centers.length !== ref.mounting.centers.length || ref.mounting.centers.some((p) => !p ||
        !centers.some((c) => Array.isArray(c) && Math.abs(c[0] - p.x) <= .05 && Math.abs(c[1] - p.y) <= .05))) printErrors.push('后壳螺柱数量/位置不符合设计基准')
      const openings = Array.isArray(d?.ports) ? d.ports : []
      if (openings.length !== ref.ports.length || ref.ports.some((p) => !p || !openings.some((o) =>
        Array.isArray(o) && o[0] === p.wall && [p.x, p.y, p.w, p.h, p.r ?? 0].every((v, i) => typeof o[i + 1] === 'number' && Math.abs(Number(o[i + 1]) - v) <= .05)))) printErrors.push('侧壁开口方向/位置/尺寸偏离当前重建基准')
      warnings.push(ref.board.status, ref.mounting.status, ...ref.unverified)
      if (ref.fabrication.footprints !== 'verified') errors.push('制造封装未验证，禁止生成制造 Gerber')
      if (ref.fabrication.routing !== 'reconstructed') errors.push('官方铜箔走线不可得且尚未完成重建布线')
      if (ref.fabrication.drills !== 'verified') errors.push('PCB 钻孔数据未验证')

      if (!netlist || !Array.isArray(netlist.components) || !Array.isArray(netlist.nets)) errors.push('缺少或损坏 网表基准，无法核对完整电路')
      else {
        if (netlist.sha256 !== ref.electrical.sha256) errors.push('官方网表来源 SHA256 与基准不符')
        const expectedNames = netlist.components.map((c) => c.name).sort()
        const actualNames = components.map((c) => c.name).sort()
        if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) errors.push(`元件集合不一致：设计 ${actualNames.length} / 官方 ${expectedNames.length}`)
        // 用并查集恢复 source_trace + source_net 的完整连接分组，能发现漏线和误短接。
        const parent = new Map<string, string>()
        const find = (id: string): string => {
          if (!parent.has(id)) parent.set(id, id)
          if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!))
          return parent.get(id)!
        }
        for (const t of traces) {
          const ids: string[] = [...(t.connected_source_port_ids ?? []), ...(t.connected_source_net_ids ?? [])]
          for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]))
        }
        const nameById = new Map(components.map((c) => [c.source_component_id, c.name]))
        const groups = new Map<string, string[]>()
        for (const p of ports) {
          const key = find(p.source_port_id)
          const name = nameById.get(p.source_component_id)
          const official = netlist.components.find((c) => c.name === name)
          const pin = ref.kind === 'functional' ? String(p.pin_number) : official?.pins.find((n) => (p.port_hints ?? []).includes(n) || (p.port_hints ?? []).includes(n.split('/')[0])) ?? String(p.pin_number)
          const entries = groups.get(key) ?? []
          entries.push(`${name}-${pin}`)
          groups.set(key, entries)
        }
        const canonical = (g: string[][]): string => JSON.stringify(g.map((pins) => pins.sort().join('|')).sort())
        if (canonical([...groups.values()]) !== canonical(netlist.nets.map((n) => [...n.pins]))) errors.push('引脚网络拓扑不符基准（漏连/错连/引脚映射不同）')
      }
    }
  }
  if (ref?.rules) {
    const rules = ref.rules
    if (![rules.minTraceMM, rules.minDrillMM, rules.minAnnularRingMM].every(v=>Number.isFinite(v)&&v>0)) errors.push('制造规则数值无效')
    for (const e of rows) {
      if (e.type === 'pcb_via' || e.type === 'pcb_plated_hole') {
        if (e.hole_diameter < rules.minDrillMM - 1e-6) errors.push(`钻孔小于制造下限：${e.pcb_via_id ?? e.pcb_plated_hole_id}`)
        if ((e.outer_diameter - e.hole_diameter) / 2 < rules.minAnnularRingMM - 1e-6) errors.push(`焊环小于制造下限：${e.pcb_via_id ?? e.pcb_plated_hole_id}`)
      }
      if (e.type === 'pcb_trace' && e.route.some((p: Row) => p.route_type === 'wire' && p.width < rules.minTraceMM - 1e-6)) errors.push(`线宽小于制造下限：${e.pcb_trace_id}`)
    }
    const k = rules.copperKeepout
    if (k && (![k.x,k.y,k.w,k.h].every(Number.isFinite) || k.w<=0 || k.h<=0)) errors.push('天线禁铜区域无效')
    else if (k) {
      const intersects = (ax:number, ay:number, bx:number, by:number, r:number):boolean => {
        // Liang-Barsky：线段与按半线宽扩张后的矩形相交检查，包含穿越区域的长线。
        let low=0, high=1
        const dx=bx-ax,dy=by-ay
        const ps=[-dx,dx,-dy,dy],qs=[ax-(k.x-k.w/2-r),k.x+k.w/2+r-ax,ay-(k.y-k.h/2-r),k.y+k.h/2+r-ay]
        for(let i=0;i<4;i++) {
          if(Math.abs(ps[i])<1e-9){if(qs[i]<0)return false}
          else {const t=qs[i]/ps[i];if(ps[i]<0)low=Math.max(low,t);else high=Math.min(high,t)}
        }
        return low<=high
      }
      for (const e of rows) {
        if(e.type==='pcb_trace') {
          for(let i=1;i<e.route.length;i++) {
            const a=e.route[i-1],b=e.route[i]
            if(a.route_type==='wire'&&b.route_type==='wire'&&a.layer===b.layer&&intersects(a.x,a.y,b.x,b.y,Math.max(a.width,b.width)/2)) {errors.push(`走线进入天线禁铜区：${e.pcb_trace_id}`);break}
          }
        } else if(e.type==='pcb_via' && intersects(e.x,e.y,e.x,e.y,e.outer_diameter/2)) errors.push(`过孔进入天线禁铜区：${e.pcb_via_id}`)
        else if(e.type==='pcb_smtpad'||e.type==='pcb_plated_hole') {
          const w=e.width??e.outer_diameter??2*e.radius,h=e.height??w
          if(Math.abs(e.x-k.x)<(k.w+w)/2 && Math.abs(e.y-k.y)<(k.h+h)/2)errors.push(`焊盘进入天线禁铜区：${e.pcb_smtpad_id??e.pcb_plated_hole_id}`)
        }
      }
    }
  }
  return { generatedAt: new Date().toISOString(), ok: errors.length === 0 && printErrors.length === 0,
    errors, printErrors, warnings,
    counts: { components: components.length, pins: ports.length, nets: nets.length || new Set(traces.map(t=>t.subcircuit_connectivity_map_key)).size, unroutedConnections: unrouted, drcErrors: drc.length },
    dimensions: { board, screen, enclosure: meta }, reference: ref }
}
