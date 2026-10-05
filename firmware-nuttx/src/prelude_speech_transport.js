/* 语音专用的有界 PCM 消费和 HTTPS 流；依赖 audio/mic/net/http/ws 片段。 */
let speechEncoderInstance = null;
const speechEncoder = {encode: value => (speechEncoderInstance || (speechEncoderInstance = new TextEncoder())).encode(value)};
const speechNow = () => performance.now();
const speechError = value => value instanceof Error ? value : new Error(String(value));
const speechCall = (callback, value) => {
  if (typeof callback === 'function') try { callback(value); } catch (error) { console.error(error); }
};
const speechText = (text, limit = 6000) => {
  if (typeof text !== 'string' || !text.length || speechEncoder.encode(text).length > limit ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new TypeError('invalid speech text');
  return text;
};
const speechXml = text => text.replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[ch]));
const speechWav = () => {
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0,'RIFF'], [8,'WAVEfmt '], [36,'data']])
    for (let i = 0; i < value.length; ++i) bytes[offset + i] = value.charCodeAt(i);
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,16000,true); view.setUint32(28,32000,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true);
  return bytes;
};
const speechPcmSink = (sampleRate = 16000, onFlow = () => {}) => {
  if (![8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(sampleRate))
    throw new RangeError('invalid speech PCM rate');
  let job = null, timer = 0, done = false, ended = false, paused = false, terminal = null;
  let queued = 0, total = 0, carry = -1, previous = 0, index = 0, phase = sampleRate, havePrevious = false;
  const queue = [], capacity = 512 * 1024;
  let resolve, reject;
  const finished = new Promise((yes,no) => { resolve = yes; reject = no; });
  finished.catch(() => {});
  const setPaused = value => { if (paused !== value) { paused = value; onFlow(value); } };
  const stop = error => {
    if (done) return;
    done = true; terminal = speechError(error || 'ECANCELED');
    if (timer) clearInterval(timer); timer = 0;
    queue.length = 0; queued = 0;
    if (job) job.stream.stop();
    try { setPaused(false); } catch (_) {}
    reject(terminal);
  };
  const pump = () => {
    if (done) return;
    try {
      if (!job && queue.length) {
        /* 固定输出 16k，允许 ES7210 采集与 ES8311 播放共用 I2S 时钟。 */
        try { job = audioInternal.openPcmStream({sampleRate:16000,channels:1}); }
        catch (error) { if (String(error).includes('EBUSY')) { if (queued >= 32768) setPaused(true); return; } throw error; }
        job.finished.then(() => {
          if (done) return;
          if (!ended || queue.length) { stop(new Error('EIO: PCM ended before drain')); return; }
          done = true; if (timer) clearInterval(timer); timer = 0;
          setPaused(false); resolve();
        }, stop);
      }
      while (job && queue.length) {
        try { job.stream.feed(queue[0]); }
        catch (error) { if (String(error).includes('EAGAIN')) break; throw error; }
        queued -= queue.shift().length;
      }
      /* buffered() 的公开单位是毫秒，16k 单声道 PCM16 每毫秒为 32 字节。 */
      const buffered = queued + (job ? job.stream.buffered() * 32 : 0);
      if (buffered >= 32768) setPaused(true);
      else if (buffered <= 16384) setPaused(false);
      if (ended && !queue.length && job) job.stream.end();
    } catch (error) { stop(error); }
  };
  return {
    finished,
    push(input) {
      if (done || ended) throw terminal || new Error('EINVAL: PCM stream ended');
      const bytes = u8(input);
      if (bytes.length > 4 * 1024 * 1024 - total) throw new RangeError('speech PCM exceeds 4MiB');
      total += bytes.length;
      /* 同率 PCM 只复制完整样本，避免16k语音下行的逐字节JS循环阻塞同时采音。
       * 半个样本仍跨包保存；每块独立拥有内存，发送方改写原输入不会污染播放。
       */
      if (sampleRate === 16000) {
        const append = data => {
          if (!data.length) return;
          if (data.length > capacity - queued) throw new Error('ENOBUFS: speech PCM queue full');
          queue.push(data); queued += data.length;
        };
        let offset = 0;
        if (carry >= 0 && bytes.length) {
          append(new Uint8Array([carry,bytes[0]])); carry = -1; offset = 1;
        }
        const end = bytes.length - ((bytes.length - offset) % 2);
        while (offset < end) {
          const next = Math.min(offset + 4096,end);
          append(bytes.slice(offset,next)); offset = next;
        }
        if (offset < bytes.length) carry = bytes[offset];
      } else {
        /* 重采样路径保留跨分块相位与半样本，不能独立取整每一包。 */
        let out = new Uint8Array(4096), used = 0;
        const flush = () => {
          if (!used) return;
          if (used > capacity - queued) throw new Error('ENOBUFS: speech PCM queue full');
          queue.push(out.slice(0,used)); queued += used; out = new Uint8Array(4096); used = 0;
        };
        const emit = sample => { out[used++] = sample & 255; out[used++] = (sample >> 8) & 255; if (used === out.length) flush(); };
        const sample = current => {
          if (!havePrevious) { havePrevious = true; previous = current; emit(current); return; }
          ++index;
          const right = index * 16000, left = right - 16000;
          while (phase <= right) {
            const fraction = phase - left;
            emit(Math.trunc((previous * (16000 - fraction) + current * fraction) / 16000));
            phase += sampleRate;
          }
          previous = current;
        };
        for (const byte of bytes) {
          if (carry < 0) carry = byte;
          else { const value = carry | (byte << 8); carry = -1; sample(value >= 32768 ? value - 65536 : value); }
        }
        flush();
      }
      if (!timer) timer = setInterval(pump,5);
      pump();
      if (done && terminal) throw terminal;
    },
    end() {
      if (done || ended) return;
      if (!total || carry >= 0) { stop(new Error('EPROTO: incomplete speech PCM')); return; }
      ended = true; pump();
    },
    stop,
    get paused() { return paused; },
    get total() { return total; }
  };
};

/* 只访问官方 TTS HTTPS 域名，拒绝重定向；TCP 暂停读取形成真正的接收窗背压。 */
const speechHttpStream = (config, text, onData) => {
  let socket = null, done = false, paused = false, sendTimer = 0, subscriptions = [];
  let pending = new Uint8Array(0), phase = 'headers', remaining = 0, status = 0, total = 0, interim = 0, trailerBytes = 0;
  let lastData = speechNow(), resolve, reject;
  const started = lastData;
  const finished = new Promise((yes,no) => { resolve = yes; reject = no; });
  finished.catch(() => {});
  const cleanup = () => {
    clearInterval(timer); if (sendTimer) clearTimeout(sendTimer); sendTimer = 0;
    for (const unsubscribe of subscriptions) unsubscribe(); subscriptions = [];
    if (socket) socket.close(); pending = new Uint8Array(0);
  };
  const fail = error => { if (done) return; done = true; cleanup(); reject(speechError(error)); };
  const finish = () => { if (done) return; done = true; cleanup(); resolve(total); };
  const timer = setInterval(() => {
    if (speechNow() - started >= 120000 || (!paused && speechNow() - lastData >= 15000))
      fail(new Error('ETIMEDOUT: Azure TTS transport'));
  },100);
  const consume = count => { pending = pending.subarray(count); };
  const output = bytes => {
    if (bytes.length > 4 * 1024 * 1024 - total) throw new RangeError('Azure TTS exceeds 4MiB');
    total += bytes.length;
    if (bytes.length) onData(bytes);
  };
  const parse = () => {
    while (!done) {
      if (phase === 'headers') {
        const end = httpHeaderEnd(pending);
        if (end < 0) { if (pending.length > 32768) throw new Error('HTTP headers exceed 32KiB'); return; }
        if (end + 4 > 32768) throw new Error('HTTP headers exceed 32KiB');
        const lines = httpAscii(pending.subarray(0,end)).split('\r\n'); consume(end + 4);
        const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(lines.shift());
        if (!match) throw new Error('invalid Azure HTTP status');
        status = Number(match[1]); const headers = httpHeaders(lines);
        if (status < 200) { if (status === 101 || ++interim > 8) throw new Error('invalid Azure HTTP interim'); continue; }
        if (status !== 200) throw new Error(status === 401 || status === 403 ? 'Azure 语音密钥或区域无效' : 'Azure TTS HTTP ' + status);
        if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') throw new Error('compressed Azure response rejected');
        const transfer = headers['transfer-encoding'], length = headers['content-length'];
        if (transfer !== undefined) {
          if (length !== undefined || transfer.toLowerCase() !== 'chunked') throw new Error('ambiguous HTTP framing');
          phase = 'chunk-size';
        } else if (length !== undefined) {
          if (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 4 * 1024 * 1024) throw new Error('invalid Azure content length');
          remaining = Number(length); phase = 'length'; if (!remaining) { finish(); return; }
        } else phase = 'close';
      } else if (phase === 'length' || phase === 'chunk-data') {
        if (!pending.length) return;
        const size = Math.min(remaining,pending.length); output(pending.subarray(0,size)); consume(size); remaining -= size;
        if (!remaining) { if (phase === 'length') { finish(); return; } phase = 'chunk-crlf'; }
      } else if (phase === 'close') {
        if (pending.length) { output(pending); pending = new Uint8Array(0); } return;
      } else if (phase === 'chunk-size') {
        const end = httpLineEnd(pending);
        if (end < 0) { if (pending.length > 1024) throw new Error('HTTP chunk line too long'); return; }
        if (end > 1024) throw new Error('HTTP chunk line too long');
        const line = httpAscii(pending.subarray(0,end)); consume(end + 2);
        if (!/^[0-9a-fA-F]+(?:;[\x20-\x7e]*)?$/.test(line)) throw new Error('invalid HTTP chunk');
        remaining = parseInt(line.split(';')[0],16);
        if (!Number.isSafeInteger(remaining) || remaining > 4 * 1024 * 1024 - total) throw new Error('Azure TTS exceeds 4MiB');
        phase = remaining ? 'chunk-data' : 'trailers';
      } else if (phase === 'chunk-crlf') {
        if (pending.length < 2) return;
        if (pending[0] !== 13 || pending[1] !== 10) throw new Error('invalid HTTP chunk terminator');
        consume(2); phase = 'chunk-size';
      } else {
        const end = httpLineEnd(pending);
        if (end < 0) { if (trailerBytes + pending.length > 8192) throw new Error('HTTP trailers exceed 8KiB'); return; }
        trailerBytes += end + 2; if (trailerBytes > 8192) throw new Error('HTTP trailers exceed 8KiB');
        if (!end) { finish(); return; }
        const header = httpHeaders([httpAscii(pending.subarray(0,end))]);
        if (header['content-length'] !== undefined || header['transfer-encoding'] !== undefined) throw new Error('invalid HTTP framing trailer');
        consume(end + 2);
      }
    }
  };
  Promise.resolve().then(() => {
    if (typeof netReadPause !== 'function') throw new Error('ENOTSUP: TCP receive flow control');
    return px.net.connectTcp({host:config.region + '.tts.speech.microsoft.com',port:443,tls:true,timeoutMs:15000});
  }).then(connected => {
    if (done) { connected.close(); return; }
    socket = connected; netReadPause(socket,paused);
    subscriptions.push(socket.onError(fail));
    subscriptions.push(socket.onClose(() => { if (done) return; if (phase === 'close') finish(); else fail(new Error('EPROTO: truncated Azure TTS response')); }));
    subscriptions.push(socket.onData(data => {
      if (done) return;
      try {
        const bytes = u8(data);
        if (pending.length + bytes.length > 262144) throw new Error('ENOBUFS: Azure HTTP input');
        const joined = new Uint8Array(pending.length + bytes.length); joined.set(pending); joined.set(bytes,pending.length); pending = joined;
        lastData = speechNow(); parse();
      } catch (error) { fail(error); }
    }));
    const body = speechEncoder.encode("<speak version='1.0' xml:lang='" + config.language + "'><voice name='" + config.voice + "'>" + speechXml(text) + '</voice></speak>');
    const head = speechEncoder.encode(['POST /cognitiveservices/v1 HTTP/1.1','Host: ' + config.region + '.tts.speech.microsoft.com',
      'Ocp-Apim-Subscription-Key: ' + config.key,'Content-Type: application/ssml+xml',
      'X-Microsoft-OutputFormat: raw-16khz-16bit-mono-pcm','User-Agent: ObeingPixel/1.0',
      'Connection: close','Accept-Encoding: identity','Content-Length: ' + body.length,'',''].join('\r\n'));
    const parts = [head,body]; let part = 0, offset = 0;
    const upload = () => {
      sendTimer = 0; if (done) return;
      try {
        while (part < parts.length) {
          if (offset === parts[part].length) { ++part; offset = 0; continue; }
          const end = Math.min(offset + 4096,parts[part].length);
          try { socket.send(parts[part].subarray(offset,end)); }
          catch (error) { if (String(error).includes('ENOBUFS')) { sendTimer = setTimeout(upload,5); return; } throw error; }
          offset = end;
        }
      } catch (error) { fail(error); }
    };
    upload();
  }).catch(fail);
  return {
    finished,
    cancel: () => fail(new Error('ECANCELED')),
    pause(value) {
      if (done || paused === value) return;
      paused = value; lastData = speechNow();
      if (socket) netReadPause(socket,value);
    }
  };
};
