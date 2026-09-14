/** 制造连接回归：标签分支、断线中段、异网短路、过孔换层与复合焊盘。 */
import {build} from 'esbuild'
import assert from 'node:assert/strict'
const {outputFiles}=await build({entryPoints:[new URL('../src/renderer/src/hardware/connectivity.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm'})
const {checkCopperConnectivity:check}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const pad=(id,x,net='N')=>[
 {type:'source_trace',source_trace_id:`s${id}`,connected_source_port_ids:[id],connected_source_net_ids:[net]},
 {type:'pcb_port',pcb_port_id:id,source_port_id:id},
 {type:'pcb_smtpad',pcb_smtpad_id:`p${id}`,pcb_port_id:id,x,y:0,shape:'rect',width:1,height:1,layer:'top'}
]
const line=(id,source,x1,x2,layer='top',y=0)=>({type:'pcb_trace',pcb_trace_id:id,source_trace_id:source,route:[{route_type:'wire',x:x1,y,width:.25,layer},{route_type:'wire',x:x2,y,width:.25,layer}]})
const base=[...pad('A',0),...pad('B',4),...pad('C',8),line('t','sA',0,8)]
assert.deepEqual(check(base),{unrouted:0,errors:[]}) // 一条真实铜线连接三条网络标签
const broken=[...base.slice(0,-1),line('a','sA',0,2),line('b','sA',3,8)]
assert(check(broken).unrouted>0)
assert(check([...base,...pad('D',6,'OTHER')]).errors.some(e=>e.includes('短路')))
const changedLayer=[...base.slice(0,-1),line('a','sA',0,4),line('b','sA',4,8,'bottom')]
assert(check(changedLayer).unrouted>0)
const through=(id,x)=>({type:'pcb_via',pcb_via_id:id,pcb_trace_id:'b',x,y:0,layers:['top','bottom'],outer_diameter:.6,hole_diameter:.3})
assert.equal(check([...changedLayer,through('v1',4),through('v2',8)]).unrouted,0)
const compound=[...base,{type:'pcb_smtpad',pcb_smtpad_id:'extra',pcb_port_id:'A',x:0,y:3,shape:'rect',width:1,height:1,layer:'top'}]
assert(check(compound).unrouted>0)
console.log('PASS: 网络标签连通、中段断线、异网短路、换层过孔、同端口多焊盘')
