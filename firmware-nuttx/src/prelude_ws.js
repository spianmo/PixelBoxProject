/* RFC6455客户端：发送队列保留到TCP真实排空，热重启只关闭本VM的连接。 */
const wsRecords=new WeakMap(),wsActive=new Set();
/* 编码器由共享core稍后安装，必须在实际调用时才读取全局构造器。 */
const wsEncoder={encode:value=>new g.TextEncoder().encode(value)},wsDecoder={decode:value=>new g.TextDecoder().decode(value)};
const wsDispatch=(record,type,details={})=>{
  try{const callback=record.object['on'+type];if(typeof callback==='function')callback.call(record.object,Object.assign({type},details));}
  catch(error){console.error('WebSocket callback:',error);}
};
const wsStop=(record,code,reason,notify=true)=>{
  if(record.state===3)return;record.state=3;wsActive.delete(record);
  if(record.timer)clearInterval(record.timer);if(record.deadline)clearTimeout(record.deadline);if(record.closeTimer)clearTimeout(record.closeTimer);
  record.timer=record.deadline=record.closeTimer=0;
  for(const unsubscribe of record.subscriptions)unsubscribe();record.subscriptions=[];
  if(record.socket)record.socket.close();record.decoder.free();record.queue=[];record.queuedBytes=0;
  if(notify)wsDispatch(record,'close',{code,reason});
};
const wsFail=(record,error)=>{if(record.state===3)return;wsDispatch(record,'error',{message:String(error&&error.message||error)});wsStop(record,1006,'');};
const wsFlush=record=>{
  if(!record.socket||record.state===3)return;
  try{
    while(record.queue.length){
      const item=record.queue[0];
      if(item.offset===item.frame.length){
        if(netQueued(record.socket))return;
        record.queue.shift();record.queuedBytes-=item.size;
        if(item.close){record.closeSent=true;if(record.closeReceived){wsStop(record,record.closeCode,record.closeReason);return;}}
        continue;
      }
      const end=Math.min(item.offset+16384,item.frame.length);
      try{record.socket.send(item.frame.subarray(item.offset,end));}
      catch(error){if(String(error).includes('ENOBUFS'))return;throw error;}
      item.offset=end;
    }
    if(record.timer){clearInterval(record.timer);record.timer=0;}
  }catch(error){wsFail(record,error);}
};
const wsEnqueue=(record,opcode,data,close=false)=>{
  if(record.queue.length>=32)throw new Error('ENOBUFS: WebSocket control queue full');
  const frame=new Uint8Array(native.ws.frame(opcode,data,native.randomBytes(4)));
  record.queue.push({frame,offset:0,size:opcode<8?data.length:0,close});
  if(opcode<8)record.queuedBytes+=data.length;
  if(!record.timer)record.timer=setInterval(()=>wsFlush(record),5);
};
const wsClosing=(record,code,reason,reply)=>{
  if(record.state===3)return;
  if(record.state===0){wsStop(record,1006,'');return;}
  if(reply){record.closeReceived=true;record.closeCode=code;record.closeReason=reason;}
  if(record.state!==2){
    record.state=2;
    const text=wsEncoder.encode(reason),body=code===1005?new Uint8Array(0):new Uint8Array(text.length+2);
    if(body.length){body[0]=code>>8;body[1]=code&255;body.set(text,2);}
    wsEnqueue(record,8,body,true);
    record.closeTimer=setTimeout(()=>wsStop(record,1006,''),3000);
  }
  if(record.closeSent&&record.closeReceived)wsStop(record,record.closeCode,record.closeReason);
};
const wsFrames=(record,bytes)=>{
  const events=record.decoder.feed(bytes);
  for(const event of events){
    if(record.state===3)return;
    const data=new Uint8Array(event.data);
    if(event.opcode===8){const code=data.length?(data[0]<<8)|data[1]:1005;wsClosing(record,code,wsDecoder.decode(data.subarray(2)),true);}
    else if(event.opcode===9){if(record.state===1)wsEnqueue(record,10,data);}
    else if(event.opcode!==10&&record.state===1)wsDispatch(record,'message',{data:event.opcode===1?wsDecoder.decode(data):event.data});
  }
};
g.WebSocket=class WebSocket {
  constructor(url,protocols=[],privateHeaders={}){
    if(typeof url!=='string'||!/^wss?:\/\//i.test(url)||url.includes('#'))throw new TypeError('invalid WebSocket URL');
    const address=httpUrl(url.replace(/^ws/i,'http'));
    if(typeof protocols==='string')protocols=[protocols];
    if(!Array.isArray(protocols)||protocols.some(value=>typeof value!=='string'||!httpToken.test(value))||new Set(protocols).size!==protocols.length)
      throw new TypeError('invalid WebSocket protocols');
    protocols=protocols.slice();
    const extraHeaders=[];
    if(!privateHeaders||typeof privateHeaders!=='object'||Array.isArray(privateHeaders))throw new TypeError('invalid WebSocket headers');
    for(const name of Object.keys(privateHeaders)){
      const value=String(privateHeaders[name]),key=name.toLowerCase();
      if(!httpToken.test(name)||/[\x00-\x08\x0a-\x1f\x7f-\uffff]/.test(value)||
        ['host','connection','upgrade','content-length','transfer-encoding'].includes(key)||key.startsWith('sec-websocket-'))
        throw new TypeError('invalid WebSocket custom header');
      extraHeaders.push(name+': '+value);
    }
    const key=btoa(String.fromCharCode(...new Uint8Array(native.randomBytes(16))));
    const record={object:this,state:0,socket:null,decoder:native.ws.createDecoder(false,262144),subscriptions:[],
      queue:[],queuedBytes:0,timer:0,deadline:0,closeTimer:0,closeSent:false,closeReceived:false,closeCode:1005,closeReason:'',header:new Uint8Array(0)};
    wsRecords.set(this,record);wsActive.add(record);
    this.onopen=this.onmessage=this.onerror=this.onclose=null;
    Object.defineProperties(this,{url:{value:address.url.replace(/^http/,'ws'),enumerable:true},
      binaryType:{value:'arraybuffer',enumerable:true,writable:true},readyState:{get:()=>record.state,enumerable:true}});
    record.deadline=setTimeout(()=>wsFail(record,new Error('ETIMEDOUT: WebSocket handshake')),10000);
    px.net.connectTcp({host:address.host,port:address.port,tls:address.tls,timeoutMs:10000}).then(socket=>{
      if(record.state!==0){socket.close();return;}record.socket=socket;
      record.subscriptions.push(socket.onError(error=>wsFail(record,error)));
      record.subscriptions.push(socket.onClose(()=>wsStop(record,record.closeReceived?record.closeCode:1006,record.closeReceived?record.closeReason:'')));
      record.subscriptions.push(socket.onData(value=>{
        if(record.state===3)return;
        try{
          let bytes=new Uint8Array(value);
          if(record.state===0){
            const joined=new Uint8Array(record.header.length+bytes.length);joined.set(record.header);joined.set(bytes,record.header.length);record.header=joined;
            const end=httpHeaderEnd(joined);if(end<0){if(joined.length>16384)throw new Error('WebSocket headers too large');return;}
            if(end+4>16384)throw new Error('WebSocket headers too large');
            const lines=httpAscii(joined.subarray(0,end)).split('\r\n');
            if(!/^HTTP\/1\.1 101(?: |$)/.test(lines.shift()))throw new Error('WebSocket upgrade rejected');
            const headers=httpHeaders(lines);
            if((headers.upgrade||'').toLowerCase()!=='websocket'||!(headers.connection||'').toLowerCase().split(',').map(value=>value.trim()).includes('upgrade')||
               headers['sec-websocket-accept']!==native.ws.accept(key)||headers['sec-websocket-extensions']!==undefined)
              throw new Error('invalid WebSocket handshake');
            const selected=headers['sec-websocket-protocol'];
            if(selected!==undefined&&!protocols.includes(selected))throw new Error('invalid WebSocket selected protocol');
            if(protocols.length&&selected===undefined)throw new Error('WebSocket protocol not selected');
            bytes=joined.subarray(end+4);record.header=null;clearTimeout(record.deadline);record.deadline=0;record.state=1;wsDispatch(record,'open');
          }
          if(bytes.length)wsFrames(record,bytes);
        }catch(error){wsFail(record,error);}
      }));
      const lines=['GET '+address.path+' HTTP/1.1','Host: '+address.authority,'Upgrade: websocket','Connection: Upgrade',
        'Sec-WebSocket-Version: 13','Sec-WebSocket-Key: '+key];
      if(protocols.length)lines.push('Sec-WebSocket-Protocol: '+protocols.join(', '));
      lines.push(...extraHeaders);
      const request=wsEncoder.encode(lines.join('\r\n')+'\r\n\r\n');
      if(request.length>16384)throw new Error('WebSocket request headers too large');
      socket.send(request);
    }).catch(error=>wsFail(record,error));
  }
  send(value){
    const record=wsRecords.get(this);if(!record||record.state!==1)throw new Error('WebSocket is not open');
    const data=typeof value==='string'?wsEncoder.encode(value):u8(value);
    if(record.queue.filter(item=>item.size||item.frame[0]===0x81||item.frame[0]===0x82).length>=16||data.length>65536-record.queuedBytes)
      throw new Error('ENOBUFS: WebSocket send queue full');
    wsEnqueue(record,typeof value==='string'?1:2,data);
  }
  close(code=1000,reason=''){
    const record=wsRecords.get(this);if(!record)throw new TypeError('invalid WebSocket');
    if(!Number.isInteger(code)||(code!==1000&&(code<3000||code>4999)))throw new RangeError('invalid WebSocket close code');
    reason=String(reason);if(wsEncoder.encode(reason).length>123)throw new RangeError('WebSocket close reason exceeds 123 bytes');
    if(record.state>=2)return;wsClosing(record,code,reason,false);
  }
};
for(const [name,value] of [['CONNECTING',0],['OPEN',1],['CLOSING',2],['CLOSED',3]])Object.defineProperty(g.WebSocket,name,{value,enumerable:true});
/* 语音等固件模块可发送握手凭据；只在本闭包内可见，绝不拼进URL或日志。 */
const wsConnectWithHeaders=(url,headers,protocols=[])=>new g.WebSocket(url,protocols,headers);
const wsReadPause=(socket,paused)=>{
  const record=wsRecords.get(socket);
  if(record&&record.socket&&record.state===1)netReadPause(record.socket,paused);
};
/* 固件模块完成或取消流式任务时立即释放连接，不等待对端关闭握手。 */
const wsDispose=socket=>{const record=wsRecords.get(socket);if(record)wsStop(record,1000,'',false);};
exitHandlers.add(()=>{for(const record of [...wsActive])wsStop(record,1006,'',false);});
