#!/usr/bin/env python3
"""真实QuickJS+C邮箱，BLE无线对端为显式测试替身；每命令最大60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('quickjs_library',type=Path);parser.add_argument('--sanitize',choices=('undefined','address,undefined'));args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];library=args.quickjs_library.resolve();headers=library.parent/'generated/quickjs-ng'
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(root/'include'),'-I'+str(headers)]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-test-') as temp:
        directory=Path(temp);binary=directory/'ble';script=directory/'test.js'
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,*[str(root/name) for name in ('src/ble.c','src/ble_binding.c','tests/test_ble.c')],str(library),'-lm','-lpthread','-o',str(binary)],check=True,timeout=60)
        script.write_text(r"""
globalThis.testComplete=false;globalThis.testError=undefined;const timers=new Map();let timerId=0;
globalThis.setTimeout=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:0});return id;};
globalThis.setInterval=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:Math.max(1,delay)});return id;};
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
globalThis.testTick=()=>{for(const [id,item] of [...timers])if(item.at<=Date.now()&&timers.has(id)){if(item.interval)item.at=Date.now()+item.interval;else timers.delete(id);item.fn();}};
const px={},exitHandlers=new Set();globalThis.console={error(){}};
const u8=value=>{if(value instanceof Uint8Array)return value;if(value instanceof ArrayBuffer)return new Uint8Array(value);throw new TypeError('binary');};
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(fn){let caught=false;try{fn();}catch(_){caught=true;}assert(caught,'expected throw');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bytes=value=>[...new Uint8Array(value)].join(',');
"""+(root/'src/prelude_ble.js').read_text()+r"""
(async()=>{
  assert(native.testControl(10)===0);assert(px.ble.available()&&px.ble.available());assert(native.testControl(10)===0,'available started BLE');
  native.testControl(7);assert(!px.ble.available());native.testControl(8);assert(native.testControl(10)===0);
  throws(()=>px.ble.peripheral.start({name:'test',services:[{uuid:'bad',characteristics:[]}]}));
  throws(()=>px.ble.peripheral.start({name:'test',services:[{uuid:'180d',characteristics:[]},{uuid:'180D',characteristics:[]}]}));
  assert(native.testControl(10)===0,'invalid command started BLE');
  let written,readCount=0,connectCount=0,disconnectCount=0;
  const offConnect=px.ble.peripheral.onConnect(()=>connectCount++),offDisconnect=px.ble.peripheral.onDisconnect(()=>disconnectCount++);
  px.ble.peripheral.start({name:'test',services:[{uuid:'180d',characteristics:[{uuid:'2A37',properties:['read','write','notify'],value:new Uint8Array([1,2]),onRead(){readCount++;return new Uint8Array([5,6,7]);},onWrite(data){written=data;}}]}]});
  assert(native.testControl(10)===1,'first valid command did not start BLE');
  native.testControl(6);native.testControl(2);await delay(20);assert(bytes(native.testControl(3))==='5,6,7'&&readCount===1);assert(connectCount===1&&disconnectCount===1);offConnect();offDisconnect();
  const notifyData=new Uint8Array([9,4,5,9]);px.ble.peripheral.notify('180d','2a37',notifyData.subarray(1,3));notifyData.fill(0);await delay(10);assert(bytes(written)==='4,5');
  throws(()=>px.ble.peripheral.notify('180d','2a37',new Uint8Array(513)));
  let devices=0;const results=await px.ble.central.scan({timeoutMs:20,onDevice(){devices++;}});assert(results.length===2&&devices===2);assert(results[0].name==='first'&&results[0].rssi===-40&&bytes(results[0].manufacturerData)==='1,2');
  const connection=await px.ble.central.connect('01:02:03:04:05:06');const services=await connection.services();assert(services[0].uuid==='0000180d-0000-1000-8000-00805f9b34fb');assert(services[0].characteristics[0].properties.join(',')==='read,write,notify');
  let disconnected=0;connection.onDisconnect(()=>disconnected++);const source=new Uint8Array([3,4,5]);const write=connection.write('180d','2a37',source);source.fill(9);await write;assert(bytes(await connection.read('180d','2a37'))==='3,4,5');
  const writes=[];for(let i=0;i<16;i++)writes.push(connection.write('180d','2a37',new Uint8Array([i])));let full=false;await connection.write('180d','2a37',new Uint8Array([99])).catch(()=>{full=true;});assert(full);await Promise.all(writes);assert(bytes(await connection.read('180d','2a37'))==='15');
  let notices=0;const first=await connection.subscribe('180d','2a37',()=>notices++),second=await connection.subscribe('180d','2a37',()=>notices++);assert(native.testControl(9)===1);native.testControl(1);await delay(10);assert(notices===2);first();native.testControl(1);await delay(10);assert(notices===3);second();second();await delay(20);assert(native.testControl(9)===0);
  await connection.disconnect();assert(disconnected===1);let closed=false;await connection.read('180d','2a37').catch(()=>{closed=true;});assert(closed);await connection.disconnect();
  px.ble.peripheral.stop();assert(timers.size===0,'idle BLE timer leaked');
  const active=await px.ble.central.connect('01:02:03:04:05:06');native.testControl(4);const pending=active.services().then(()=>false,()=>true);await delay(10);for(const handler of exitHandlers)handler();assert(await pending);assert(!px.ble.available()&&timers.size===0);throws(()=>px.ble.peripheral.stop());
})().then(()=>{testComplete=true;},error=>{testError=String(error)+'\n'+error.stack;testComplete=true;});
""")
        subprocess.run([str(binary),str(script)],check=True,timeout=60)
        stub=directory/'unavailable.c';stub.write_text('#include "pixelbox_ble.h"\n#include <assert.h>\nint main(void){struct px_ble *ble=px_ble_create();assert(ble&&!px_ble_available(ble));px_ble_destroy(ble);return 0;}\n')
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,str(root/'src/ble.c'),str(root/'src/ble_nimble.c'),str(stub),'-lpthread','-o',str(directory/'unavailable')],check=True,timeout=60)
        subprocess.run([str(directory/'unavailable')],check=True,timeout=60)
        print('未编译NimBLE时available=false：通过')
if __name__=='__main__':main()
