// 从真实Canvas类与图片prelude加载代码，以可控时钟检验像素、所有权及动画生命周期。
import assert from 'node:assert/strict';
import fs from 'node:fs';
const prelude = fs.readFileSync(new URL('../src/prelude.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/prelude_image.js', import.meta.url), 'utf8');
const canvasSource = prelude.slice(prelude.indexOf('  class Canvas {'), prelude.indexOf('  const drawMethods ='));
const subscriptions = new Set(), reads = [];
const image = (pixels, width, alpha = null, duration = 0) => ({
  width, height: pixels.length / width, pixels: new Uint32Array(pixels).buffer,
  alpha: alpha ? new Uint8Array(alpha).buffer : null, duration
});
const fixtures = new Map([
  [1, image([0xff0000,0x00ff00,0x0000ff,0xffffff],2,[0x80,0x40])],
  [2, image([1,2,3,4,5,6,7,8],4)],
]);
let gif = [image([1,2,3,4],2,null,20),image([5,6,7,8],2,null,50),image([1,2,3,4],2,null,30)];
const native = {
  // 此替身只验证JS选路；真实C拷贝/裁剪/脏块由test_canvas.py联合覆盖入口验证。
  blitCanvas(out,w,h,src,sw,sh,x,y,sx,sy,bw,bh) {
    for(let row=0;row<bh;row++)for(let col=0;col<bw;col++)out[(y+row)*w+x+col]=src[(sy+row)*sw+sx+col];
  },
  fs:{readBytes:path=>{reads.push(path);return new Uint8Array([1]);}},
  decodeImage:data=>{const result=fixtures.get(data[0]);if(!result)throw new Error('bad image');return structuredClone(result);},
  loadGifFrames:()=>structuredClone(gif)
};
const runtime = new Function('native','source','subscriptions',`
  const unsupported = () => {throw new Error('ENOTSUP');};
  const u8 = x => x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : (()=>{throw new TypeError('binary');})();
  ${canvasSource}
  const screen = new Canvas(8,8);
  screen.onFrame = cb => {subscriptions.add(cb);return ()=>subscriptions.delete(cb);};
  eval(source);
  return {Canvas,screen};
`)(native,source,subscriptions);
const {Canvas,screen} = runtime;
const target = new Canvas(5,5);
target.clear(0x222222);
target.drawImage(new Uint8Array([1]),1,1);
assert.equal(target.getPixel(1,1),0xff0000);
assert.equal(target.getPixel(2,1),0x222222);
assert.equal(target.getPixel(1,2),0x222222);
assert.equal(target.getPixel(2,2),0xffffff);
target.drawImage('/app/assets/icon.png',0,0,{colorKey:0xff0000});
assert.deepEqual(reads,['/app/assets/icon.png']);
assert.equal(target.getPixel(0,0),0x222222);
const strip=new Canvas(4,1);[1,2,3,4].forEach((v,x)=>strip.setPixel(x,0,v));
const scaled=new Canvas(6,1);scaled.drawImage(strip,0,0,{w:6});
assert.deepEqual([...scaled._pixels],[1,1,2,2,3,4]);
scaled.clear();scaled.drawImage(strip,-1,0,{sx:-1,sw:3,w:4});
assert.deepEqual([...scaled._pixels],[1,2,2,0,0,0]);
strip.drawImage(strip,1,0,{sw:3});assert.deepEqual([...strip._pixels],[1,1,2,3]);
const disposed=new Canvas(1,1);disposed.dispose();assert.throws(()=>target.drawImage(disposed,0,0),/disposed/);
const getterTarget=new Canvas(1,1);
assert.throws(()=>getterTarget.drawImage(strip,0,0,{get w(){getterTarget.dispose();return 1;}}),/disposed/);

// 图片覆盖实现直接写像素；干净画布必须收到裁剪后的dirty，屏外图片保持干净。
const imageDirty=new Canvas(5,5);
imageDirty.drawImage(new Uint8Array([1]),-1,1);
assert.deepEqual(imageDirty._dirty,{x:0,y:1,right:1,bottom:3});
imageDirty._dirty=null;
imageDirty.drawImage(new Uint8Array([1]),7,7);
assert.equal(imageDirty._dirty,null);
// 在第一像素写入后注入异常，模拟循环中途退出，必须保留异常身份并全屏标脏。
const imageFailure=new Canvas(5,5),imageMarker=new Error('image interrupted');
const originalFloor=Math.floor;let floorCalls=0;
try {
  Math.floor=value=>{if(++floorCalls===5)throw imageMarker;return originalFloor(value);};
  assert.throws(()=>imageFailure.drawImage(strip,0,0,{colorKey:0xffffff}),error=>error===imageMarker);
} finally {Math.floor=originalFloor;}
assert.equal(imageFailure.getPixel(0,0),1);
assert.equal(imageFailure.getPixel(1,0),0);
assert.deepEqual(imageFailure._dirty,{x:0,y:0,right:5,bottom:5});

const owned=screen.createAnimation({frames:[new Uint8Array([1]),new Uint8Array([2])],fps:20,loop:false});
let ends=0;const off=owned.onEnd(()=>ends++);
owned.play();assert.equal(subscriptions.size,1);assert.equal(owned.playing,true);
for(const cb of [...subscriptions])cb(50);
assert.equal(owned.currentFrame,1);
for(const cb of [...subscriptions])cb(50);
assert.equal(ends,1);assert.equal(owned.playing,false);assert.equal(subscriptions.size,0);
off();owned.seek(999);assert.equal(owned.currentFrame,1);owned.stop();assert.equal(owned.currentFrame,0);
const ownCanvas=owned._frames[0].canvas;owned.dispose();owned.dispose();assert.equal(ownCanvas._pixels,null);
assert.throws(()=>owned.draw(0,0,target),/disposed/);
const borrowed=screen.createAnimation({frames:[strip]});borrowed.dispose();assert.notEqual(strip._pixels,null);
const sheets=screen.createAnimation({frames:{sheet:new Uint8Array([2]),frameW:2,frameH:1}});
assert.equal(sheets.frameCount,4);sheets.seek(2);target._dirty=null;sheets.draw(0,0,target);
assert.equal(target.getPixel(0,0),5);assert.equal(target.getPixel(1,0),6);sheets.dispose();
assert.deepEqual(target._dirty,{x:0,y:0,right:2,bottom:1});
const transparentSheets=screen.createAnimation({frames:{sheet:new Uint8Array([1]),frameW:1,frameH:1}});
target.clear(99);transparentSheets.seek(1);transparentSheets.draw(0,0,target);assert.equal(target.getPixel(0,0),99);
transparentSheets.seek(3);transparentSheets.draw(0,0,target);assert.equal(target.getPixel(0,0),0xffffff);transparentSheets.dispose();
assert.throws(()=>screen.createAnimation({frames:[]}),/1\.\.256/);
assert.throws(()=>screen.createAnimation({frames:Array(257).fill(strip)}),/1\.\.256/);
const large=new Canvas(1024,1024);assert.throws(()=>screen.createAnimation({frames:[large,large]}),/memory/);large.dispose();
const saved=screen.onFrame;screen.onFrame=()=>{throw new Error('ENOTSUP');};
const unavailable=screen.createAnimation({frames:[strip]});assert.throws(()=>unavailable.play(),/ENOTSUP/);
assert.equal(unavailable.playing,false);screen.onFrame=saved;unavailable.dispose();

const animation=screen.loadGif(new Uint8Array([3]));assert.equal(animation.frameCount,2);
screen._dirty=null;animation.draw(1,2);
assert.deepEqual(screen._dirty,{x:1,y:2,right:3,bottom:4});
animation.play();for(const cb of [...subscriptions])cb(20);assert.equal(animation.currentFrame,1);
for(const cb of [...subscriptions])cb(50);assert.equal(animation.currentFrame,0);animation.dispose();
// 白色外框四连通转黑；封闭红框内部的白点必须保留。
const whites=Array(25).fill(0xffffff);for(const i of [6,7,8,11,13,16,17,18])whites[i]=0xff0000;
gif=[image(whites,5,null,100)];
const removed=screen.loadGif(new Uint8Array([4]),{removeBackground:true,backgroundThreshold:0});
removed.draw(0,0,target);assert.equal(target.getPixel(0,0),0);assert.equal(target.getPixel(2,2),0xffffff);
removed.dispose();assert.equal(subscriptions.size,0);
assert.throws(()=>screen.loadGif(new Uint8Array([3]),{backgroundThreshold:256}),/0\.\.255/);
console.log('图片prelude通过：透明/色键/定点缩放裁剪/路径/所有权/雪碧图/动画计时/去背景/限额');
