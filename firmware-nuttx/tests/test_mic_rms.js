// 与原voice逐样本Double平方和定义对照，整数总和在2^53内，要求完全相等。
function throwsRms(fn, Type) {
  try { fn(); } catch(error) { ok(error instanceof Type); return; }
  throw Error('missing RMS exception');
}
function referenceRms(bytes) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); let sum = 0;
  for(let i=0;i<bytes.length;i+=2) {const sample=view.getInt16(i,true);sum+=sample*sample;}
  return Math.sqrt(sum/(bytes.length/2));
}
for(const value of [null,[],new ArrayBuffer(2),new Int16Array(2),new DataView(new ArrayBuffer(2))])
  throwsRms(()=>n.micPcmRms(value),TypeError);
for(const size of [0,1,3,48002]) throwsRms(()=>n.micPcmRms(new Uint8Array(size)),RangeError);
ok(n.micPcmRms(new Uint8Array([0,128]))===32768);
ok(n.micPcmRms(new Uint8Array([255,127]))===32767);
ok(n.micPcmRms(new Uint8Array(640))===0);
const maximum=new Uint8Array(48000);
for(let i=1;i<maximum.length;i+=2)maximum[i]=128;
ok(n.micPcmRms(maximum)===32768);
let seed=0x754123dd;
for(let test=0;test<500;test++) {
  const size=2*(1+(test*47)%24000),offset=1+test%9,owner=new Uint8Array(size+offset+3).fill(0xa5);
  const bytes=owner.subarray(offset,offset+size);
  for(let i=0;i<size;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;bytes[i]=seed>>>24;}
  const before=owner.slice();ok(n.micPcmRms(bytes)===referenceRms(bytes));
  for(let i=0;i<owner.length;i++)ok(owner[i]===before[i]);
}
const detached=new Uint8Array(640);n.detach(detached.buffer);
throwsRms(()=>n.micPcmRms(detached),TypeError);
const wrapped=new Uint8Array([3,0,4,0]);
Object.defineProperty(wrapped,'buffer',{get(){throw Error('must use internal typed-array owner');}});
ok(n.micPcmRms(wrapped)===Math.sqrt(12.5));
