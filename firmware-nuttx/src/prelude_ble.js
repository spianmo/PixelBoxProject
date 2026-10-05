/* BLE事件仅在JS主循环消费；每连接GATT串行，旧VM/连接的迟到事件不进入新会话。 */
const bleNative=native.ble,bleConnections=new Map(),blePeripheralConnect=new Set(),blePeripheralDisconnect=new Set(),blePeripheralPeers=new Set();
let bleLive=true,bleTimer=0,bleRequest=0,bleScan=null,blePeripheral=null;
const bleEmpty=new Uint8Array(0);
const bleError=(message,code=0)=>new Error('BLE '+message+(code?' ('+code+')':''));
const bleRequired=()=>{if(!bleLive)throw bleError('context closed');};
const bleUuid=value=>{
  if(typeof value!=='string')throw new TypeError('BLE UUID must be a string');
  value=value.toLowerCase();if(/^[0-9a-f]{4}$/.test(value))value='0000'+value;
  if(/^[0-9a-f]{8}$/.test(value))value+='-0000-1000-8000-00805f9b34fb';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))throw new TypeError('invalid BLE UUID');
  return value;
};
const bleBytes=value=>{const bytes=u8(value);if(bytes.byteLength>512)throw new RangeError('BLE value exceeds 512 bytes');return new Uint8Array(bytes);};
const bleCallback=callback=>{if(typeof callback!=='function')throw new TypeError('BLE callback must be a function');return callback;};
const bleSubscribe=(set,callback)=>{bleCallback(callback);set.add(callback);return ()=>set.delete(callback);};
const bleDispatch=(set,value)=>{for(const callback of [...set]){if(!bleLive)break;try{callback(value);}catch(error){console.error('BLE callback:',error);}}};
const bleStartTimer=()=>{if(!bleTimer&&bleLive)bleTimer=setInterval(blePump,5);};
const bleIdle=()=>{if(!bleScan&&!blePeripheral&&!bleConnections.size&&!blePeripheralPeers.size&&bleTimer){clearInterval(bleTimer);bleTimer=0;}};
const bleCloseRecord=(record,error)=>{
  if(record.closed)return;record.closed=true;bleConnections.delete(record.id);if(record.timer)clearTimeout(record.timer);
  if(record.reject){record.reject(error||bleError('connection closed'));record.resolve=record.reject=null;}
  for(const pending of record.pending.values()){clearTimeout(pending.timer);pending.reject(error||bleError('disconnected'));}record.pending.clear();
  for(const waiter of record.disconnectWaiters){clearTimeout(waiter.timer);waiter.resolve();}record.disconnectWaiters.clear();
  record.subscriptions.clear();bleDispatch(record.disconnectCallbacks);record.disconnectCallbacks.clear();bleIdle();
};
const bleFatal=error=>{
  bleLive=false;
  if(bleScan){const scan=bleScan;bleScan=null;if(scan.timer)clearTimeout(scan.timer);scan.reject(error);}
  blePeripheral=null;for(const record of [...bleConnections.values()])bleCloseRecord(record,error);
  blePeripheralPeers.clear();if(bleTimer)clearInterval(bleTimer);bleTimer=0;bleNative.shutdown();
};
const bleOperation=(record,operation,service='',characteristic='',data=bleEmpty,flag=false)=>new Promise((resolve,reject)=>{
  bleRequired();if(record.closed)throw bleError('disconnected');
  bleRequest=(bleRequest+1)>>>0;if(!bleRequest)bleRequest=1;const request=bleRequest;
  const pending={resolve,reject,timer:0};record.pending.set(request,pending);
  pending.timer=setTimeout(()=>{if(record.pending.get(request)!==pending)return;record.pending.delete(request);reject(bleError('GATT timeout'));
    try{bleNative.disconnect(record.id);}catch(_){}bleCloseRecord(record,bleError('GATT timeout'));},30000);
  try{bleNative.operate(record.id,request,operation,service,characteristic,data,flag);}
  catch(error){record.pending.delete(request);clearTimeout(pending.timer);reject(error);}
});
const bleQueue=(record,callback)=>{
  if(record.queued>=16)return Promise.reject(bleError('GATT queue full'));
  record.queued++;const work=record.chain.then(()=>{bleRequired();if(record.closed)throw bleError('disconnected');return callback();});
  record.chain=work.then(()=>{record.queued--;},()=>{record.queued--;});return work;
};
const bleDiscover=async record=>{if(!record.discovered){await bleOperation(record,1);record.discovered=true;}};
const bleConnection=id=>{
  const record={id,closed:false,discovered:false,resolve:null,reject:null,timer:0,pending:new Map(),chain:Promise.resolve(),queued:0,subscriptions:new Map(),disconnectCallbacks:new Set(),disconnectWaiters:new Set()};
  record.object={
    services:()=>bleQueue(record,async()=>{const result=await bleOperation(record,1);record.discovered=true;return result;}),
    read(service,characteristic){return Promise.resolve().then(()=>{service=bleUuid(service);characteristic=bleUuid(characteristic);return bleQueue(record,async()=>{await bleDiscover(record);return bleOperation(record,2,service,characteristic);});});},
    write(service,characteristic,data,options={}){
      let bytes;try{service=bleUuid(service);characteristic=bleUuid(characteristic);bytes=bleBytes(data);if(!options||typeof options!=='object')throw new TypeError('BLE write needs options');}catch(error){return Promise.reject(error);}
      const response=options.withResponse===undefined?true:!!options.withResponse;
      return bleQueue(record,async()=>{await bleDiscover(record);await bleOperation(record,3,service,characteristic,bytes,response);});
    },
    subscribe(service,characteristic,callback){
      try{service=bleUuid(service);characteristic=bleUuid(characteristic);bleCallback(callback);}catch(error){return Promise.reject(error);}
      const key=service+'/'+characteristic;
      return bleQueue(record,async()=>{
        await bleDiscover(record);let group=record.subscriptions.get(key);
        if(!group){group=new Set();record.subscriptions.set(key,group);try{await bleOperation(record,4,service,characteristic,bleEmpty,true);}catch(error){record.subscriptions.delete(key);throw error;}}
        const wrapped=data=>callback(data);group.add(wrapped);let removed=false;
        return ()=>{if(removed)return;removed=true;group.delete(wrapped);if(record.closed||group.size)return;
          bleQueue(record,async()=>{if(record.subscriptions.get(key)!==group||group.size)return;await bleOperation(record,4,service,characteristic,bleEmpty,false);record.subscriptions.delete(key);}).catch(error=>{if(!record.closed)console.error('BLE unsubscribe:',error);});};
      });
    },
    disconnect(){
      if(record.closed)return Promise.resolve();return new Promise((resolve,reject)=>{
        const waiter={resolve,reject,timer:0};record.disconnectWaiters.add(waiter);waiter.timer=setTimeout(()=>{record.disconnectWaiters.delete(waiter);reject(bleError('disconnect timeout'));bleCloseRecord(record,bleError('disconnect timeout'));},5000);
        try{bleNative.disconnect(id);}catch(error){record.disconnectWaiters.delete(waiter);clearTimeout(waiter.timer);reject(error);}
      });
    },
    onDisconnect:callback=>bleSubscribe(record.disconnectCallbacks,callback)
  };
  bleConnections.set(id,record);return record;
};
function blePump(){
  if(!bleLive)return;
  for(let i=0;i<32&&bleLive;i++){
    let event;try{event=bleNative.poll();}catch(error){bleFatal(error);return;}if(!event)break;
    const record=bleConnections.get(event.connection);
    if(event.type===1&&bleScan){const scan=bleScan;let device=scan.devices.get(event.id);const first=!device;
      if(!device){if(scan.devices.size>=64)continue;device={id:event.id,name:null,rssi:event.rssi,manufacturerData:null};scan.devices.set(event.id,device);}
      device.rssi=event.rssi;if(event.name!==null)device.name=event.name;if(event.hasManufacturer)device.manufacturerData=event.data;
      if(first&&scan.onDevice){try{scan.onDevice({...device});}catch(error){console.error('BLE onDevice:',error);}}
    }else if(event.type===2&&bleScan){const scan=bleScan;bleScan=null;clearTimeout(scan.timer);event.error?scan.reject(bleError('scan failed',event.error)):scan.resolve([...scan.devices.values()]);
    }else if(event.type===3&&record){clearTimeout(record.timer);record.timer=0;if(event.error)bleCloseRecord(record,bleError('connect failed',event.error));else if(record.resolve){record.resolve(record.object);record.resolve=record.reject=null;}
    }else if(event.type===4&&record)bleCloseRecord(record,null);
    else if(event.type===5&&record){const pending=record.pending.get(event.request);if(!pending)continue;record.pending.delete(event.request);clearTimeout(pending.timer);event.error?pending.reject(bleError('GATT failed',event.error)):pending.resolve(event.data);
    }else if(event.type===6&&record){const group=record.subscriptions.get(event.service+'/'+event.characteristic);if(group)bleDispatch(group,event.data);
    }else if(event.type===7){blePeripheralPeers.add(event.id);if(blePeripheral)bleDispatch(blePeripheralConnect,event.id);}
    else if(event.type===8){blePeripheralPeers.delete(event.id);bleDispatch(blePeripheralDisconnect,event.id);}
    else if(event.type===9&&blePeripheral){const callback=blePeripheral[event.tag]?.onWrite;if(callback){try{callback(event.data);}catch(error){console.error('BLE onWrite:',error);}}}
    else if(event.type===10){let data=bleEmpty,ok=false;const callback=blePeripheral?.[event.tag]?.onRead;
      try{if(callback){data=bleBytes(callback());ok=true;}}catch(error){console.error('BLE onRead:',error);}
      if(bleLive)try{bleNative.readReply(event.request,data,ok);}catch(error){console.error('BLE read reply:',error);}
    }
  }
  bleIdle();
}
px.ble={
  available:()=>bleLive&&bleNative.available(),
  peripheral:{
    start(options){
      bleRequired();if(!options||typeof options.name!=='string'||!Array.isArray(options.services)||!options.services.length||options.services.length>8)throw new TypeError('BLE start needs name and 1..8 services');
      const callbacks=[],seenServices=new Set();const services=options.services.map(service=>{
        const uuid=bleUuid(service.uuid);if(seenServices.has(uuid))throw new TypeError('duplicate BLE service');seenServices.add(uuid);
        if(!Array.isArray(service.characteristics))throw new TypeError('BLE characteristics must be an array');const seen=new Set();
        return {uuid,characteristics:service.characteristics.map(chr=>{if(callbacks.length>=32)throw new RangeError('BLE supports at most 32 characteristics');const uuid=bleUuid(chr.uuid);if(seen.has(uuid))throw new TypeError('duplicate BLE characteristic');seen.add(uuid);
          if(!Array.isArray(chr.properties)||!chr.properties.length)throw new TypeError('BLE properties required');let properties=0;for(const name of chr.properties){const value={read:1,write:2,notify:8}[name];if(!value)throw new TypeError('invalid BLE property');properties|=value;}
          if(chr.onRead!==undefined)bleCallback(chr.onRead);if(chr.onWrite!==undefined)bleCallback(chr.onWrite);callbacks.push({onRead:chr.onRead,onWrite:chr.onWrite});
          return {uuid,properties,value:chr.value==null?bleEmpty:bleBytes(chr.value),onRead:typeof chr.onRead==='function'};
        })};
      });
      bleNative.peripheralStart(options.name,services);blePeripheral=callbacks;bleStartTimer();
    },
    notify(service,characteristic,data){bleRequired();bleNative.notify(bleUuid(service),bleUuid(characteristic),bleBytes(data));},
    stop(){bleRequired();bleNative.peripheralStop();blePeripheral=null;blePump();},
    onConnect:callback=>bleSubscribe(blePeripheralConnect,callback),onDisconnect:callback=>bleSubscribe(blePeripheralDisconnect,callback)
  },
  central:{
    scan(options={}){return new Promise((resolve,reject)=>{
      bleRequired();if(!options||typeof options!=='object')throw new TypeError('BLE scan needs options');if(bleScan)throw bleError('scan busy');if(options.onDevice!==undefined)bleCallback(options.onDevice);
      const timeout=options.timeoutMs===undefined?5000:options.timeoutMs;bleNative.scan(timeout);const scan={resolve,reject,devices:new Map(),onDevice:options.onDevice,timer:0};bleScan=scan;
      scan.timer=setTimeout(()=>{if(bleScan!==scan)return;bleScan=null;try{bleNative.stopScan();}catch(_){}reject(bleError('scan timeout'));bleIdle();},timeout+1000);bleStartTimer();
    });},
    stopScan(){bleRequired();bleNative.stopScan();},
    connect(id,options={}){return new Promise((resolve,reject)=>{
      bleRequired();if(!options||typeof options!=='object')throw new TypeError('BLE connect needs options');const timeout=options.timeoutMs===undefined?10000:options.timeoutMs;
      const token=bleNative.connect(id,timeout),record=bleConnection(token);record.resolve=resolve;record.reject=reject;
      record.timer=setTimeout(()=>{try{bleNative.disconnect(token);}catch(_){}bleCloseRecord(record,bleError('connect timeout'));},timeout+1000);bleStartTimer();
    });}
  }
};
exitHandlers.add(()=>{
  if(!bleLive)return;const error=bleError('application exited');bleLive=false;if(bleTimer)clearInterval(bleTimer);bleTimer=0;
  if(bleScan){clearTimeout(bleScan.timer);bleScan.reject(error);bleScan=null;}blePeripheral=null;
  for(const record of [...bleConnections.values()])bleCloseRecord(record,error);blePeripheralPeers.clear();blePeripheralConnect.clear();blePeripheralDisconnect.clear();bleNative.shutdown();
});
