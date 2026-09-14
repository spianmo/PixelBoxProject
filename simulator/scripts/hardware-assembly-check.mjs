/** 防止参考元件错误尺寸穿壳，也覆盖焊接面引脚和合法接口开孔。 */
import {build} from 'esbuild'
import assert from 'node:assert/strict'
const {outputFiles}=await build({entryPoints:[new URL('../src/renderer/src/hardware/assemblyValidation.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm'})
const {checkAssembly:check}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const comp={id:'R2',name:'R2',x:0,y:0,w:2,h:1,heightMM:1.3,layer:'top'}
const board={widthMM:40,heightMM:40,thicknessMM:1.6,components:[comp]}
const meta={outerW:46,outerD:46,lidTopZ:24,boardTopZ:8,batteryZ:2,design:{ports:[]}}
assert.deepEqual(check(board,meta),[])
assert(check({...board,components:[{...comp,x:-29.96,w:25.1}]},meta).some(e=>e.includes('west')))
assert(check({...board,components:[{...comp,heightMM:17}]},meta).some(e=>e.includes('顶盖')))
assert(check({...board,components:[{...comp,oppositeHeightMM:5}]},meta).some(e=>e.includes('底板')))
const usb={...comp,name:'USB1',x:21,w:8,h:2,heightMM:2}
assert(check({...board,components:[usb]},meta).some(e=>e.includes('侧壁')))
assert.deepEqual(check({...board,components:[usb]},{...meta,design:{ports:[['east',0,7,8,6,0]]}}),[])
const rounded={...meta,design:{...meta.design,cornerR:5.8}}
assert(check({...board,widthMM:42,heightMM:42},rounded).some(e=>e.includes('圆角')))
assert(check({...board,components:[{...comp,x:20,y:20}]},rounded).some(e=>e.includes('圆角')))
const standoffs={...rounded,design:{...rounded.design,standoffs:[[17,18.5]],standoffOuterR:2}}
assert(check({...board,components:[{...comp,x:17,y:18.5}]},standoffs).some(e=>e.includes('螺柱')))
assert(check({...board,components:[comp,{...comp,name:'C1',x:.5}]},meta).some(e=>e.includes('包络重叠')))
assert(check({...board,components:[{...comp,x:19,heightMM:8}]},{...rounded,design:{...rounded.design,lip:[41.5,41.5,3.8,1.2,14.5,17]}}).some(e=>e.includes('内唇')))
// east/west 的 SCAD 开口偏移是 -Y，非零偏移必须与查看器保持同向。
assert.deepEqual(check({...board,components:[{...usb,y:-5}]},{...meta,design:{ports:[['east',5,7,8,6,0]]}}),[])
assert(check({...board,components:[{...usb,y:5}]},{...meta,design:{ports:[['east',5,7,8,6,0]]}}).some(e=>e.includes('侧壁')))
console.log('PASS: 穿壳、圆角、顶盖内唇、螺柱/螺钉头、元件互碰、针脚与接口开口方向')
