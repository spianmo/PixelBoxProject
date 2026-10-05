/* POSIX事件只在QuickJS主循环派发；不把回调或Promise交给DNS worker。 */
const network = native.net;
const netObjects = new Map();
const netSocketIds = new WeakMap();
const netQueued = socket => network.queued(netSocketIds.get(socket));
const netReadPause = (socket,paused) => network.pause(netSocketIds.get(socket),!!paused);
let netTimer = 0;
let netActive = true;
const netRequired = () => {if(!netActive)throw new Error('ECANCELED: network context is closed');};
const netSubscription = (subscribers, callback) => {
  if (typeof callback !== 'function') throw new TypeError('network callback must be a function');
  subscribers.add(callback); return () => { subscribers.delete(callback); };
};
const netDispatch = (subscribers, value) => {
  for (const callback of [...subscribers]) {
    try { callback(value); } catch (error) { console.error('Network callback:', error); }
  }
};
const netStopped = () => { if (!netObjects.size && netTimer) { clearInterval(netTimer); netTimer = 0; } };
const tcpObject = (id, host, port, connected) => {
  const record = {kind:'tcp',connected,closed:false,closing:false,resolve:null,reject:null,data:new Set(),close:new Set(),error:new Set()};
  const object = {
    send(data) { if (!record.connected) throw new Error('socket is closed'); network.send(id,data); },
    close() {if(record.closed||record.closing)return;record.closing=true;record.connected=false;network.close(id);},
    get connected() { return record.connected; },
    get bufferedAmount() { return record.connected ? netQueued(object) : 0; },
    get remoteHost() { return host; }, get remotePort() { return port; },
    onData:callback=>netSubscription(record.data,callback),
    onClose:callback=>netSubscription(record.close,callback),
    onError:callback=>netSubscription(record.error,callback)
  };
  record.object=object;netObjects.set(id,record);netSocketIds.set(object,id);return record;
};
const netPump = () => {
  for (let i=0;i<32;++i) {
    let event;
    try {event=network.poll();}
    catch(error) {
      netActive=false;
      for(const record of netObjects.values()) {
        record.closed=true;
        if(record.reject)record.reject(error);
        if(record.kind==='tcp'){record.connected=false;netDispatch(record.error,String(error));netDispatch(record.close);}
      }
      netObjects.clear();network.shutdown();netStopped();return;
    }
    if(!event)break;
    const record=netObjects.get(event.id);
    if(!record){if(event.acceptedId)network.close(event.acceptedId);continue;}
    if(event.type===1) {
      if(record.closed||record.closing)continue;
      record.connected=true;
      if(record.resolve){record.resolve(record.object);record.resolve=record.reject=null;}
    } else if(event.type===2) {
      if(record.closed){network.close(event.acceptedId);continue;}
      const accepted=tcpObject(event.acceptedId,event.host,event.port,true);
      try{record.onConnection(accepted.object);}catch(error){console.error('TCP onConnection:',error);}
    } else if(event.type===3)netDispatch(record.data,event.data);
    else if(event.type===4)netDispatch(record.messages,{data:event.data,host:event.host,port:event.port});
    else if(event.type===5) {
      netObjects.delete(event.id);
      record.closed=true;
      if(record.reject)record.reject(new Error(event.error ? 'TCP connection failed ('+event.error+')' : 'TCP connection cancelled'));
      if(record.kind==='tcp') {
        record.connected=false;
        if(event.error)netDispatch(record.error,'TCP network error ('+event.error+')');
        netDispatch(record.close);record.data.clear();record.close.clear();record.error.clear();
      } else {if(record.messages)record.messages.clear();if(event.error)console.error('Network socket closed:',event.error);}
    }
  }
  netStopped();
};
const netStarted=()=>{if(!netTimer)netTimer=setInterval(netPump,5);};
px.net={
  connectTcp(options) {
    return new Promise((resolve,reject)=>{
      if(!options||typeof options!=='object')throw new TypeError('connectTcp needs options');
      netRequired();
      const host=options.host,port=options.port,tls=!!options.tls,timeout=options.timeoutMs===undefined?10000:options.timeoutMs;
      const id=network.connect(host,port,tls,timeout),record=tcpObject(id,host,port,false);
      record.resolve=resolve;record.reject=reject;netStarted();
    });
  },
  listenTcp(options) {
    if(!options||typeof options!=='object'||typeof options.onConnection!=='function')throw new TypeError('listenTcp needs port and onConnection');
    netRequired();
    const callback=options.onConnection,result=network.listen(options.port);
    const record={kind:'listener',closed:false,onConnection:callback};
    netObjects.set(result.id,record);netStarted();
    return {get port(){return result.port;},close(){if(record.closed)return;record.closed=true;network.close(result.id);}};
  },
  createUdp(options={}) {
    if(!options||typeof options!=='object')throw new TypeError('createUdp needs options');
    netRequired();
    const result=network.udp(options.bindPort===undefined?0:options.bindPort),messages=new Set();
    const record={kind:'udp',closed:false,messages};
    netObjects.set(result.id,record);netStarted();
    return {send(data,host,port){if(record.closed)throw new Error('UDP socket is closed');network.send(result.id,data,host,port);},
      onMessage:callback=>netSubscription(messages,callback),close(){if(record.closed)return;record.closed=true;network.close(result.id);messages.clear();}};
  },
  mdns:{discover:rejected,advertise:unsupported},hostname:()=>native.hostname
};
/* VM退出后旧对象立即失效，所有迟到网络事件只由C层释放，不再回调旧VM。 */
exitHandlers.add(()=>{netActive=false;if(netTimer)clearInterval(netTimer);netTimer=0;
  for(const record of netObjects.values()){record.closed=true;if(record.kind==='tcp')record.connected=false;}
  netObjects.clear();network.shutdown();});
