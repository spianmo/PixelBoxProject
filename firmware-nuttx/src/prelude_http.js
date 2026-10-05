/* HTTP/1.1建立于异步TCP/TLS；HTTPS始终开启证书验证，不回退为明文。 */
const httpBodyLimit=2*1024*1024,httpHeaderLimit=32768;
const httpToken=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const httpUrl=value=>{
  if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f\\]/.test(value))throw new TypeError('invalid HTTP URL');
  const match=/^(https?):\/\/([^/?#]+)([^#]*)/i.exec(value);
  if(!match)throw new TypeError('fetch supports http(s) URLs');
  const scheme=match[1].toLowerCase(),tls=scheme==='https',defaultPort=tls?443:80;
  const authority=/^([A-Za-z0-9._-]+)(?::([0-9]+))?$/.exec(match[2]);
  if(!authority)throw new TypeError('HTTP URL needs an IPv4 address or hostname without credentials');
  const host=authority[1].toLowerCase(),port=authority[2]===undefined?defaultPort:Number(authority[2]);
  if(!Number.isInteger(port)||port<1||port>65535||host.length>255)throw new RangeError('invalid HTTP host or port');
  const path=match[3]?(match[3][0]==='?'?'/'+match[3]:match[3]):'/';
  if(/[^\x21-\x7e]/.test(path))throw new TypeError('HTTP path must be percent-encoded');
  const origin=scheme+'://'+host+(port===defaultPort?'':':'+port);
  return {host,port,path,origin,scheme,tls,url:origin+path,authority:host+(port===defaultPort?'':':'+port)};
};
const httpRedirect=(location,base)=>{
  if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location))return httpUrl(location);
  if(location.startsWith('//'))return httpUrl(base.scheme+':'+location);
  if(!location||/[\x00-\x20\x7f\\]/.test(location))throw new TypeError('invalid HTTP redirect');
  if(location[0]==='#')return httpUrl(base.url);
  if(location[0]==='?')return httpUrl(base.origin+base.path.split('?')[0]+location);
  let path=location[0]==='/'?location:base.path.split('?')[0].replace(/[^/]*$/,'')+location;
  const boundary=path.search(/[?#]/),suffix=boundary<0?'':path.slice(boundary);
  path=boundary<0?path:path.slice(0,boundary);
  const segments=[];
  const pieces=path.split('/');
  for(let index=0;index<pieces.length;++index) {
    const segment=pieces[index];
    if(segment==='..'){if(segments.length)segments.pop();}
    else if(segment!=='.')segments.push(segment);
    if(index===pieces.length-1&&(segment==='.'||segment==='..'))segments.push('');
  }
  return httpUrl(base.origin+(segments.join('/').startsWith('/')?'':'/')+segments.join('/')+suffix);
};
const httpAscii=bytes=>{
  let value='';for(let i=0;i<bytes.length;++i)value+=String.fromCharCode(bytes[i]);return value;
};
const httpLineEnd=bytes=>{for(let i=0;i+1<bytes.length;++i)if(bytes[i]===13&&bytes[i+1]===10)return i;return -1;};
const httpHeaderEnd=bytes=>{for(let i=0;i+3<bytes.length;++i)if(bytes[i]===13&&bytes[i+1]===10&&bytes[i+2]===13&&bytes[i+3]===10)return i;return -1;};
const httpHeaders=lines=>{
  const headers=Object.create(null);
  for(const line of lines) {
    const colon=line.indexOf(':');
    if(colon<=0||!httpToken.test(line.slice(0,colon))||/[\x00-\x08\x0a-\x1f\x7f]/.test(line.slice(colon+1)))throw new Error('invalid HTTP response header');
    const key=line.slice(0,colon).toLowerCase(),value=line.slice(colon+1).trim();
    if((key==='content-length'||key==='transfer-encoding')&&headers[key]!==undefined)throw new Error('duplicate HTTP framing header');
    headers[key]=headers[key]===undefined?value:headers[key]+', '+value;
  }
  return headers;
};
const httpRequest=(address,method,headers,body,timeout)=>new Promise((resolve,reject)=>{
  let socket=null,done=false,uploadTimer=0,subscriptions=[];
  let pending=new Uint8Array(0),phase='headers',remaining=0,status=0,statusText='',responseHeaders=null;
  let bodyBuffer=null,bodyLength=0,interim=0,trailerBytes=0;
  const cleanup=()=>{
    clearTimeout(deadlineTimer);if(uploadTimer)clearTimeout(uploadTimer);
    for(const unsubscribe of subscriptions)unsubscribe();subscriptions=[];
    if(socket)socket.close();
  };
  const fail=error=>{if(done)return;done=true;cleanup();reject(error instanceof Error?error:new Error(String(error)));};
  const finish=()=>{
    if(done)return;
    const buffer=bodyBuffer?bodyBuffer.buffer.slice(0,bodyLength):new ArrayBuffer(0);
    done=true;cleanup();resolve({status,statusText,headers:responseHeaders,body:buffer,url:address.url});
  };
  const deadlineTimer=setTimeout(()=>fail(new Error('ETIMEDOUT: HTTP request')),timeout);
  const append=bytes=>{
    if(bytes.length>httpBodyLimit-bodyLength)throw new RangeError('HTTP response exceeds 2MiB');
    if(!bodyBuffer||bodyLength+bytes.length>bodyBuffer.length) {
      const capacity=Math.min(httpBodyLimit,Math.max(bodyLength+bytes.length,bodyBuffer?bodyBuffer.length*2:16384));
      const next=new Uint8Array(capacity);if(bodyBuffer)next.set(bodyBuffer.subarray(0,bodyLength));bodyBuffer=next;
    }
    bodyBuffer.set(bytes,bodyLength);bodyLength+=bytes.length;
  };
  const consume=count=>{pending=pending.subarray(count);};
  const parse=()=>{
    while(!done) {
      if(phase==='headers') {
        const end=httpHeaderEnd(pending);
        if(end<0){if(pending.length>httpHeaderLimit)throw new RangeError('HTTP headers exceed 32KiB');return;}
        if(end+4>httpHeaderLimit)throw new RangeError('HTTP headers exceed 32KiB');
        const lines=httpAscii(pending.subarray(0,end)).split('\r\n');consume(end+4);
        const first=/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: ([\x20-\x7e]*))?$/.exec(lines.shift());
        if(!first)throw new Error('invalid HTTP status line');
        status=Number(first[1]);statusText=first[2]||'';responseHeaders=httpHeaders(lines);
        if(status<200) {
          if(status===101||++interim>8)throw new Error('unsupported HTTP upgrade or too many interim responses');
          continue;
        }
        if(method==='HEAD'||status===204||status===304){finish();return;}
        const encoding=responseHeaders['content-encoding'];
        if(encoding&&encoding.toLowerCase()!=='identity')throw new Error('ENOTSUP: compressed HTTP response');
        const transfer=responseHeaders['transfer-encoding'],length=responseHeaders['content-length'];
        if(transfer!==undefined) {
          if(length!==undefined||transfer.toLowerCase()!=='chunked')throw new Error('unsupported or ambiguous HTTP body framing');
          phase='chunk-size';
        } else if(length!==undefined) {
          if(!/^[0-9]+$/.test(length)||!Number.isSafeInteger(Number(length)))throw new Error('invalid HTTP content length');
          remaining=Number(length);if(remaining>httpBodyLimit)throw new RangeError('HTTP response exceeds 2MiB');
          phase='length';if(!remaining){finish();return;}
        } else phase='close';
      } else if(phase==='length'||phase==='chunk-data') {
        if(!pending.length)return;
        const size=Math.min(remaining,pending.length);append(pending.subarray(0,size));consume(size);remaining-=size;
        if(!remaining){if(phase==='length'){finish();return;}phase='chunk-crlf';}
      } else if(phase==='close') {
        if(pending.length){append(pending);pending=new Uint8Array(0);}return;
      } else if(phase==='chunk-size') {
        const end=httpLineEnd(pending);
        if(end<0){if(pending.length>1024)throw new RangeError('HTTP chunk line too long');return;}
        if(end>1024)throw new RangeError('HTTP chunk line too long');
        const line=httpAscii(pending.subarray(0,end));consume(end+2);
        if(!/^[0-9a-fA-F]+(?:;[\x20-\x7e]*)?$/.test(line))throw new Error('invalid HTTP chunk size');
        remaining=parseInt(line.split(';')[0],16);
        if(!Number.isSafeInteger(remaining)||remaining>httpBodyLimit-bodyLength)throw new RangeError('HTTP response exceeds 2MiB');
        phase=remaining?'chunk-data':'trailers';
      } else if(phase==='chunk-crlf') {
        if(pending.length<2)return;
        if(pending[0]!==13||pending[1]!==10)throw new Error('invalid HTTP chunk terminator');
        consume(2);phase='chunk-size';
      } else if(phase==='trailers') {
        const end=httpLineEnd(pending);
        if(end<0){if(trailerBytes+pending.length>8192)throw new RangeError('HTTP trailers exceed 8KiB');return;}
        trailerBytes+=end+2;if(trailerBytes>8192)throw new RangeError('HTTP trailers exceed 8KiB');
        if(!end){consume(2);finish();return;}
        const trailer=httpHeaders([httpAscii(pending.subarray(0,end))]);
        if(trailer['content-length']!==undefined||trailer['transfer-encoding']!==undefined)throw new Error('invalid HTTP framing trailer');
        consume(end+2);
      }
    }
  };
  px.net.connectTcp({host:address.host,port:address.port,tls:address.tls,timeoutMs:Math.max(1,Math.ceil(timeout))}).then(connected=>{
    if(done){connected.close();return;}socket=connected;
    subscriptions.push(socket.onError(message=>fail(new Error(message))));
    subscriptions.push(socket.onClose(()=>{if(!done){if(phase==='close'){try{finish();}catch(error){fail(error);}}else fail(new Error('truncated HTTP response'));}}));
    subscriptions.push(socket.onData(data=>{
      if(done)return;
      try {
        const bytes=new Uint8Array(data),combined=new Uint8Array(pending.length+bytes.length);
        combined.set(pending);combined.set(bytes,pending.length);pending=combined;parse();
      } catch(error){fail(error);}
    }));
    const lines=[method+' '+address.path+' HTTP/1.1','Host: '+address.authority,'Connection: close','Accept-Encoding: identity'];
    for(const key of Object.keys(headers))lines.push(key+': '+headers[key]);
    if(body.length||method==='POST'||method==='PUT'||method==='PATCH')lines.push('Content-Length: '+body.length);
    const head=new TextEncoder().encode(lines.join('\r\n')+'\r\n\r\n');
    if(head.length>httpHeaderLimit){fail(new RangeError('HTTP request headers exceed 32KiB'));return;}
    const parts=[head,body];let part=0,offset=0;
    const upload=()=>{
      uploadTimer=0;if(done)return;
      try {
        while(part<parts.length) {
          if(offset===parts[part].length){++part;offset=0;continue;}
          const end=Math.min(offset+16384,parts[part].length);
          try {socket.send(parts[part].subarray(offset,end));}
          catch(error){if(String(error).includes('ENOBUFS')){uploadTimer=setTimeout(upload,5);return;}throw error;}
          offset=end;
        }
      } catch(error){fail(error);}
    };
    upload();
  }).catch(fail);
});

g.fetch=async function (url,options={}) {
  let address=httpUrl(url);
  if(!options||typeof options!=='object')throw new TypeError('fetch options must be an object');
  let method=options.method===undefined?'GET':String(options.method).toUpperCase();
  if(!['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(method))throw new TypeError('unsupported HTTP method');
  const timeout=options.timeoutMs===undefined?15000:Number(options.timeoutMs);
  if(!Number.isFinite(timeout)||timeout<1||timeout>120000)throw new RangeError('HTTP timeout must be 1..120000 ms');
  const redirect=options.redirect===undefined?'follow':options.redirect;
  if(redirect!=='follow'&&redirect!=='error')throw new TypeError('redirect must be follow or error');
  const headers=Object.create(null),provided=options.headers;
  if(provided!==undefined) {
    if(!provided||typeof provided!=='object'||Array.isArray(provided))throw new TypeError('HTTP headers must be an object');
    for(const name of Object.keys(provided)) {
      const key=name.toLowerCase(),value=String(provided[name]);
      if(!httpToken.test(name)||/[\x00-\x08\x0a-\x1f\x7f-\uffff]/.test(value))throw new TypeError('invalid HTTP request header');
      if(['host','content-length','transfer-encoding','connection','trailer','upgrade','accept-encoding'].includes(key))throw new TypeError('HTTP transport controls header: '+key);
      headers[key]=value;
    }
  }
  const input=options.body;
  let body=input===undefined||input===null?new Uint8Array(0):typeof input==='string'?new TextEncoder().encode(input):u8(input).slice();
  if(body.length>httpBodyLimit)throw new RangeError('HTTP request body exceeds 2MiB');
  if(typeof input==='string'&&headers['content-type']===undefined)headers['content-type']='text/plain;charset=UTF-8';
  const deadline=performance.now()+timeout;
  for(let redirects=0;;++redirects) {
    const remaining=deadline-performance.now();if(remaining<=0)throw new Error('ETIMEDOUT: HTTP request');
    const result=await httpRequest(address,method,headers,body,remaining);
    if([301,302,303,307,308].includes(result.status)&&result.headers.location!==undefined) {
      if(redirect==='error')throw new Error('HTTP redirect rejected');
      if(redirects>=5)throw new Error('HTTP redirect limit exceeded');
      const next=httpRedirect(result.headers.location,address);
      // 跨origin不转发凭据；同origin相对跳转保留原有授权。
      if(next.origin!==address.origin)for(const key of ['authorization','proxy-authorization','cookie'])delete headers[key];
      if(result.status===303||((result.status===301||result.status===302)&&method==='POST')) {
        method='GET';body=new Uint8Array(0);delete headers['content-type'];
      }
      address=next;continue;
    }
    const response={text:()=>Promise.resolve(new TextDecoder().decode(result.body)),
      json:()=>Promise.resolve().then(()=>JSON.parse(new TextDecoder().decode(result.body))),
      arrayBuffer:()=>Promise.resolve(result.body)};
    Object.defineProperties(response,{status:{value:result.status,enumerable:true},ok:{value:result.status>=200&&result.status<300,enumerable:true},
      statusText:{value:result.statusText,enumerable:true},headers:{value:result.headers,enumerable:true},url:{value:result.url,enumerable:true}});
    return response;
  }
};
