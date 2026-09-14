/** 从实际铜形状恢复连接，不用 source_trace_id 或路由器的端点声明代替连通验证。 */
import type { AnyCircuitElement } from 'circuit-json'
type Row = Record<string, any>
type P = { x: number; y: number }
type Copper = { id: string; net: string; layers: string[]; points: P[]; radius: number; polygon: boolean; sourcePort?: string; bounds: number[] }
const EPS = 1e-6
class Groups {
  private p = new Map<string, string>()
  find(id: string): string {
    if (!this.p.has(id)) this.p.set(id, id)
    const parent = this.p.get(id)!
    if (parent !== id) this.p.set(id, this.find(parent))
    return this.p.get(id)!
  }
  join(a: string, b: string): void { this.p.set(this.find(a), this.find(b)) }
}
function pointSegment(p: P, a: P, b: P): number {
  const dx = b.x-a.x, dy = b.y-a.y
  const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy || 1)))
  return Math.hypot(p.x-a.x-t*dx, p.y-a.y-t*dy)
}
function segmentDistance(a: P, b: P, c: P, d: P): number {
  const cross = (p: P, q: P, r: P): number => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
  if (cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0) return 0
  return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b))
}
function inside(p: P, points: P[]): boolean {
  let result = false
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const a=points[i],b=points[j]
    if ((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) result=!result
  }
  return result
}
function gap(a: Copper, b: Copper): number {
  if ((a.polygon && b.points.some(p=>inside(p,a.points))) || (b.polygon && a.points.some(p=>inside(p,b.points)))) return -a.radius-b.radius
  const edges = (s: Copper): [P,P][] => s.polygon ? s.points.map((p,i)=>[p,s.points[(i+1)%s.points.length]]) : [[s.points[0],s.points.at(-1)!]]
  let dist=Infinity
  for (const [p,q] of edges(a)) for (const [r,s] of edges(b)) dist=Math.min(dist,segmentDistance(p,q,r,s))
  return dist-a.radius-b.radius
}
export function checkCopperConnectivity(circuit: AnyCircuitElement[]): { unrouted: number; errors: string[] } {
  const rows=circuit as Row[], intent=new Groups(), copperGroups=new Groups(), errors:string[]=[]
  const sourceTraces=rows.filter(e=>e.type==='source_trace')
  for (const t of sourceTraces) {
    const ids:string[]=[...(t.connected_source_port_ids??[]),...(t.connected_source_net_ids??[])]
    for (const id of ids.slice(1)) intent.join(ids[0],id)
  }
  const traceById=new Map(sourceTraces.map(t=>[t.source_trace_id,t]))
  const pcbPorts=new Map(rows.filter(e=>e.type==='pcb_port').map(p=>[p.pcb_port_id,p]))
  const shapes:Copper[]=[]
  const add=(id:string,net:string,layers:string[],points:P[],radius=0,polygon=false,sourcePort?:string): void => {
    if (!points.length || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)) || !Number.isFinite(radius)) { errors.push(`铜几何无效：${id}`);return }
    shapes.push({id,net,layers,points,radius,polygon,sourcePort,bounds:[Math.min(...points.map(p=>p.x))-radius, Math.min(...points.map(p=>p.y))-radius,Math.max(...points.map(p=>p.x))+radius,Math.max(...points.map(p=>p.y))+radius]})
  }
  const traceNet=(t:Row):string => {
    const source=traceById.get(t.source_trace_id)
    return intent.find(source?.connected_source_port_ids?.[0] ?? source?.connected_source_net_ids?.[0] ?? t.connection_name ?? t.pcb_trace_id)
  }
  for (const e of rows) {
    if (e.type==='pcb_smtpad'||e.type==='pcb_plated_hole') {
      const port=pcbPorts.get(e.pcb_port_id), id=e.pcb_smtpad_id??e.pcb_plated_hole_id
      const net=intent.find(port?.source_port_id??id), layers=e.layers??[e.layer??'top']
      if (e.shape==='rect'||e.shape==='rotated_rect') {
        const angle=(e.ccw_rotation??0)*Math.PI/180, w=e.width??e.rect_pad_width, h=e.height??e.rect_pad_height
        add(id,net,layers,[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([x,y])=>({x:e.x+x*Math.cos(angle)-y*Math.sin(angle),y:e.y+x*Math.sin(angle)+y*Math.cos(angle)})),0,true,port?.source_port_id)
      } else if (e.shape==='circle') add(id,net,layers,[{x:e.x,y:e.y}],(e.radius??e.outer_diameter/2),false,port?.source_port_id)
      else errors.push(`尚不支持制造连通检查的焊盘形状：${id} (${e.shape})`)
    } else if (e.type==='pcb_trace') {
      const net=traceNet(e), route:Row[]=e.route??[]
      for (let i=1;i<route.length;i++) {
        const a=route[i-1],b=route[i]
        if (a.route_type==='wire'&&b.route_type==='wire'&&a.layer===b.layer) add(`${e.pcb_trace_id}:${i}`,net,[a.layer],[a as P,b as P],Math.min(a.width,b.width)/2)
      }
    } else if (e.type==='pcb_via') {
      const t=rows.find(t=>t.type==='pcb_trace'&&t.pcb_trace_id===e.pcb_trace_id)
      add(e.pcb_via_id,t?traceNet(t):intent.find(e.source_net_id??e.pcb_via_id),e.layers??[e.from_layer,e.to_layer],[{x:e.x,y:e.y}],e.outer_diameter/2)
    } else if (e.type==='pcb_copper_pour') errors.push('铜皮需要多边形连通检查，当前不能仅凭网络标签放行制造')
  }
  // 层相同且铜实际相接才合并。异网碰铜必须报短路，未接引脚也不能被别的网络穿过。
  const shorts=new Set<string>()
  for (let i=0;i<shapes.length;i++) for(let j=i+1;j<shapes.length;j++) {
    const a=shapes[i],b=shapes[j]
    if (!a.layers.some(l=>b.layers.includes(l))||a.bounds[0]>b.bounds[2]+EPS||b.bounds[0]>a.bounds[2]+EPS||a.bounds[1]>b.bounds[3]+EPS||b.bounds[1]>a.bounds[3]+EPS) continue
    if (gap(a,b)>EPS) continue
    copperGroups.join(a.id,b.id)
    if(a.net!==b.net) shorts.add([a.net,b.net].sort().join(' / '))
  }
  errors.push(...[...shorts].map(n=>`PCB 实际铜短路：${n}`))
  const wanted=new Map<string,Set<string>>()
  for (const t of sourceTraces) for (const id of t.connected_source_port_ids??[]) {
    const net=intent.find(id), set=wanted.get(net)??new Set<string>();set.add(id);wanted.set(net,set)
  }
  let unrouted=0
  for (const [net,ports] of wanted) {
    const roots=new Map<string,Set<string>>()
    let missing=0
    for(const port of ports) {
      const pads=shapes.filter(s=>s.sourcePort===port)
      if(!pads.length){missing++;continue}
      for(const pad of pads) {
        const root=copperGroups.find(pad.id),set=roots.get(root)??new Set<string>();set.add(port);roots.set(root,set)
      }
    }
    const disconnected=missing+(roots.size>1?Math.max(1,ports.size-Math.max(...[...roots.values()].map(s=>s.size))):0)
    if(disconnected){unrouted+=disconnected;errors.push(`PCB 网络 ${net} 未连通：${disconnected} 个引脚/焊盘组`)}
  }
  return {unrouted,errors}
}
