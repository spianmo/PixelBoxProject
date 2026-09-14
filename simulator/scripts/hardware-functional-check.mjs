/** 默认功能模板、制造拒绝回归与可打开的独立工程输出。 */
import {build} from 'esbuild'
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'pb-functional-'))
await build({stdin:{contents:`export {BOARD_TEMPLATE} from './src/main/templates/boards/esp32s3';export {validateHardware} from './src/renderer/src/hardware/validation';export {buildBoardSpec} from './src/renderer/src/hardware/three/boardBuilder';export {enclosureScadFromParams} from './src/shared/enclosureScadTemplate';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:join(temp,'check.cjs'),plugins:[{name:'raw',setup(b){b.onResolve({filter:/\?raw$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:`export default ${JSON.stringify(await readFile(a.path,'utf8'))}`,loader:'js'}))}}]})
const require=createRequire(import.meta.url)
const {BOARD_TEMPLATE:t,validateHardware,buildBoardSpec,enclosureScadFromParams}=require(join(temp,'check.cjs'))
// 独立厂商封装核对：EP 的九个铜岛在 KiCad 都叫 41，在 IDE 中独立编号并同接 GND。
const vendor=await readFile(resolve(root,'../docs/hardware/reference/Espressif/ESP32-S3-WROOM-1U.kicad_mod'),'utf8')
const vendorPads=[...vendor.matchAll(/\(pad "(\d+)" smd rect \(at ([\d.-]+) ([\d.-]+)(?: ([\d.-]+))?\) \(size ([\d.-]+) ([\d.-]+)\)/g)].map(m=>{
 const [pin,x,y,angle,w,h]=m.slice(1).map(Number)
 return [pin,x,-y,angle%180?h:w,angle%180?w:h]
})
const footprint=JSON.parse(t.moduleFile.content.match(/const pads = (.+)\n/)[1]).map(([pin,...xy])=>[Math.min(pin,41),...xy])
const canonical=pads=>[...new Set(pads.map(p=>JSON.stringify(p)))].sort()
assert.deepEqual(canonical(footprint),canonical(vendorPads))
const destination=process.argv[2]??join(temp,'project')
// 外观验收使用独立固定值，防止模板和基准一起漂移后出现假通过。
assert.deepEqual(t.enclosure.outerSizeMM,{w:46,d:46})
assert.equal(t.enclosure.cornerR,5.8)
assert.equal(t.enclosure.baseHeightMM+t.enclosure.lidHeightMM+2*t.enclosure.wallMM,22.5)
assert.deepEqual(t.screenRect,{x:0,y:0,w:38.99,h:38.99})
assert.deepEqual(t.enclosure.standoffCenters,[-17,17].flatMap(x=>[-18.5,18.5].map(y=>({x,y}))))
assert.deepEqual(t.enclosure.ports.map(p=>[p.wall,p.x,p.y,p.w,p.h,p.r]),[
 ...[-10,0,10].map(x=>['east',x,10.9,5.3,5.3,2.65]),
 ['west',0,11.9,9.2,3.6,1.6],['north',0,12.2,12,2.4,1],
 ...[2,5.4,3.6,7.4,4.6,2].map((h,i)=>['south',-5+i*2,5,1,h,.5])
])
await mkdir(join(destination,'design'),{recursive:true})
await writeFile(join(destination,'pixelbox.json'),JSON.stringify({type:'hardware',name:'esp32s3-functional',version:'1.0.0',chip:'esp32s3'},null,2))
await writeFile(join(destination,'README.md'),t.readme('esp32s3-functional','esp32s3'))
await writeFile(join(destination,'design/board.tsx'),t.boardTsx('esp32s3-functional'))
await writeFile(join(destination,'design',t.moduleFile.fileName),t.moduleFile.content)
for(const f of t.extraFiles)await writeFile(join(destination,'design',f.fileName),f.content)
await writeFile(join(destination,'design/reference.json'),JSON.stringify(t.reference,null,2))
await writeFile(join(destination,'design/enclosure.scad'),enclosureScadFromParams(t.enclosure,t.boardSizeMM,t.screenRect))
await writeFile(join(destination,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2020',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,noEmit:true,skipLibCheck:true},include:['design']},null,2))
// 使用真实求值产物，非模拟引脚；从环境指定可以验收任意一份候选输出。
const input=process.env.PB_CIRCUIT_JSON
if(input){
 const cj=JSON.parse(await readFile(input,'utf8')),board=buildBoardSpec(cj,t.reference.componentBodies)
 const meta={boardTopZ:11.5,batteryZ:2,outerW:46,outerD:46,lidTopZ:22.5,design:{board:[41,41,1.6],cornerR:5.8,standoffOuterR:2,lip:[41.5,41.5,3.8,1.2,14.5,17],screen:[0,0,38.99,38.99,4.7],screenSeat:[43.3,43.3,1],standoffs:t.enclosure.standoffCenters.map(p=>[p.x,p.y]),ports:t.enclosure.ports.map(p=>[p.wall,p.x,p.y,p.w,p.h,p.r])}}
 const fixture=JSON.parse(t.extraFiles.find(f=>f.fileName==='design-netlist.json').content)
 const check=c=>validateHardware(c,buildBoardSpec(c,t.reference.componentBodies),t.screenRect,meta,t.reference,fixture)
 const result=check(cj)
 assert.deepEqual(result.errors,[])
 assert.deepEqual(result.printErrors,[])
 assert.equal(result.counts.components,17)
 assert.equal(result.counts.pins,111)
 const broken=cj.filter(e=>e.type!=='pcb_trace')
 assert(check(broken).counts.unroutedConnections>0)
 assert(check(cj.map(e=>e.type==='pcb_via'?{...e,hole_diameter:.15}:e)).errors.some(s=>s.includes('钻孔')))
 assert(check(cj.map(e=>e.type==='pcb_hole'?{...e,x:e.x+1}:e)).errors.some(s=>s.includes('安装孔')))
 await mkdir(join(destination,'export/validation'),{recursive:true})
 // 这里只校验机械参数契约，真实 STL 尺寸由 Electron / 全质量导出独立验证。
 await writeFile(join(destination,'export/validation/circuit-check.json'),JSON.stringify({...result,mechanicalEvidence:'SCAD 参数契约；实际 STL 见 full-quality-check.json'},null,2))
 await writeFile(join(destination,'export/validation/circuit.json'),JSON.stringify(cj,null,2))
}
console.log(`PASS: 功能模板输出 ${destination}${input?'，真实铜连通/拓扑/DRC/钻孔下限及拒绝回归通过':''}`)
