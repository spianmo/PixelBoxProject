const u8 = value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : (()=>{throw TypeError('binary');})();
const same = (a,b) => a.length===b.length && a.every((value,i)=>value===b[i]);
function invalid(fn, Type) {
  try{fn();}catch(error){ok(error instanceof Type);return;}
  throw Error('expected ADPCM rejection');
}
for(const value of [null,[],new Int16Array(2),new DataView(new ArrayBuffer(2)),'pcm'])
  invalid(()=>n.encodeImaAdpcm(value),TypeError);
for(const length of [0,1,3,8193,8194])invalid(()=>n.encodeImaAdpcm(new Uint8Array(length)),RangeError);
ok(same([...new Uint8Array(n.encodeImaAdpcm(new Uint8Array([0,128])))],[1,0,0,128,0,0]));
let seed=0x95663321;
for(let test=0;test<600;test++) {
  const count=test<12?[1,2,3,4,7,8,31,127,2048,4095,4096,256][test]:1+test*73%4096;
  const offset=1+test%7,owner=new Uint8Array(count*2+offset+5).fill(0xa5),data=owner.subarray(offset,offset+count*2);
  for(let i=0;i<count;i++) {
    seed=(Math.imul(seed,1664525)+1013904223)|0;
    const sample=test%8===0?(i%2?32767:-32768):test%8===1?0:test%8===2?32767:seed>>16;
    data[i*2]=sample;data[i*2+1]=sample>>8;
  }
  const before=owner.slice(),expected=new Uint8Array(referenceCodec.encodeImaAdpcm(data));
  const input=test%2===0?data:data.slice().buffer;
  const actual=new Uint8Array(n.encodeImaAdpcm(input));
  ok(actual.length===6+Math.floor(count/2));ok(same(actual,expected));ok(same(owner,before));
  ok(same(new Uint8Array(n.encodeImaAdpcm(input)),actual));
}
for(const typed of [false,true]) {
  const bytes=new Uint8Array(20),input=typed?bytes:bytes.buffer;n.detach(bytes.buffer);
  invalid(()=>n.encodeImaAdpcm(input),TypeError);
}
const hidden=new Uint8Array([0,0,1,0]);
Object.defineProperty(hidden,'buffer',{get(){throw Error('must read internal buffer');}});
ok(same(new Uint8Array(n.encodeImaAdpcm(hidden)),new Uint8Array(referenceCodec.encodeImaAdpcm(hidden))));
