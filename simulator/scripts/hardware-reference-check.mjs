/** 官方基准回归：使用实际提取 fixture，检查漏连、错连、尺寸漂移与安装孔几何。 */
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'pb-reference-check-'))
await build({ stdin: { contents: `export { BOARD_TEMPLATE } from './src/main/templates/boards/esp32s3-official'; export { validateHardware } from './src/renderer/src/hardware/validation'; export { buildBoardSpec, buildBoardGroup } from './src/renderer/src/hardware/three/boardBuilder'; export { placeStlOnBed, stlBounds } from './src/shared/stlGeometry'; export { enclosureScadFromParams } from './src/shared/enclosureScadTemplate';`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: join(temp, 'check.cjs'), plugins: [{ name: 'raw', setup(b) { b.onResolve({filter:/\?raw$/}, a=>({path:resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'})); b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:`export default ${JSON.stringify(await readFile(a.path,'utf8'))}`,loader:'js'})) } }] })
const require=createRequire(import.meta.url)
const {BOARD_TEMPLATE:tpl, validateHardware, buildBoardSpec, buildBoardGroup, enclosureScadFromParams, placeStlOnBed, stlBounds}=require(join(temp,'check.cjs'))
const fixture=JSON.parse(tpl.extraFiles[0].content)
const cj=[{type:'pcb_board',pcb_board_id:'board',center:{x:0,y:0},width:tpl.boardSizeMM.widthMM,height:tpl.boardSizeMM.heightMM,thickness:1.6,outline:fixture.outline.map(([x,y])=>({x,y}))}]
fixture.components.forEach(c=>{cj.push({type:'source_component',source_component_id:c.name,name:c.name}); c.pins.forEach((pin,i)=>cj.push({type:'source_port',source_port_id:`${c.name}-${pin}`,source_component_id:c.name,pin_number:i+1,port_hints:[pin]}))})
fixture.nets.forEach((n,i)=>{cj.push({type:'source_net',source_net_id:`n${i}`});n.pins.forEach(pin=>cj.push({type:'source_trace',source_trace_id:pin,connected_source_port_ids:[pin],connected_source_net_ids:[`n${i}`]}))})
const meta={boardTopZ:11.5,batteryZ:2,outerW:46,outerD:46,lidTopZ:22.5,design:{board:[tpl.boardSizeMM.widthMM,tpl.boardSizeMM.heightMM,1.6],cornerR:5.8,screen:[0,0,38.99,38.99,4.7],screenSeat:[43.3,43.3,1],standoffs:tpl.enclosure.standoffCenters.map(p=>[p.x,p.y]),ports:tpl.enclosure.ports.map(p=>[p.wall,p.x,p.y,p.w,p.h,p.r])}}
const board=buildBoardSpec(cj)
const check=(rows=cj, m=meta, reference=tpl.reference)=>validateHardware(rows,board,tpl.screenRect,m,reference,fixture)
const base=check()
assert.equal(base.printErrors.length,0)
assert.equal(base.counts.pins,642)
assert.equal(base.counts.components,213)
assert.equal(base.counts.nets,181)
assert.equal(base.counts.unroutedConnections,642)
assert(!base.errors.some(e=>e.includes('拓扑')))
assert(base.errors.some(e=>e.includes('制造封装未验证')))
const disconnected=cj.filter(e=>e.source_trace_id!=='U1-1')
assert(check(disconnected).errors.some(e=>e.includes('拓扑')))
const shorted=[...cj,{type:'source_trace',source_trace_id:'short',connected_source_port_ids:[],connected_source_net_ids:['n0','n1']}]
assert(check(shorted).errors.some(e=>e.includes('拓扑')))
assert(check(cj,{...meta,outerW:47}).printErrors.some(e=>e.includes('外壳宽')))
assert(check(cj,{...meta,design:{...meta.design,standoffs:[[0,0]]}}).printErrors.some(e=>e.includes('螺柱')))
assert(check(cj,meta,{}).errors.some(e=>e.includes('格式无效')))
const holes=buildBoardSpec([...cj,{type:'pcb_hole',x:0,y:0,hole_diameter:2},{type:'pcb_plated_hole',x:1,y:1,hole_diameter:1,pcb_component_id:'connector'}])
assert.equal(holes.mountingHoles.length,1)
assert(buildBoardGroup(holes).children[0].geometry.parameters.shapes.holes.length===1)
// 用不在床面的四面体校验落床，不能只检查字节数。
const triangleBuffer = new ArrayBuffer(84 + 4 * 50)
const dv = new DataView(triangleBuffer); dv.setUint32(80,4,true)
const vertices=[[0,0,10],[2,0,10],[0,2,10],[0,0,12]]
;[[0,2,1],[0,1,3],[1,2,3],[2,0,3]].forEach((ids,i)=>ids.forEach((id,j)=>vertices[id].forEach((v,k)=>dv.setFloat32(84+i*50+12+j*12+k*4,v,true))))
const bed=stlBounds(placeStlOnBed(triangleBuffer))
assert.equal(bed.min[2],0);assert.equal(bed.max[2],2)
assert.equal(stlBounds(triangleBuffer).min[2],10)
assert.throws(()=>stlBounds(new ArrayBuffer(84)))
await writeFile(join(temp,'enclosure.scad'),enclosureScadFromParams(tpl.enclosure,tpl.boardSizeMM,tpl.screenRect))
await writeFile(join(temp,'template.json'),JSON.stringify(tpl))
console.log(`PASS: 官方完整网表、漏连/误短接、尺寸漂移、无效基准、安装孔回归。SCAD: ${temp}/enclosure.scad`)
