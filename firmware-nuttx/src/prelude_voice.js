/* 原中继协议的 NuttX 实现：16k PCM 上行、VAD、打断、连续对话与 TTS 背压。 */
(() => {
  const events = new Map(['stateChange','wake','speechStart','speechEnd','userText','assistantDelta','assistantText','level','error'].map(name => [name,new Set()]));
  let config = null, socket = null, pending = null, micStop = null, timer = 0, state = 'idle', closed = false;
  let continuous = false, round = false, epoch = 0, say = null, tts = null, ttsEnded = false;
  let deadline = 0, lastReceive = 0, lastSend = 0, lastLevel = -100;
  let queue = [], queued = 0, uplink = new Uint8Array(1920), uplinkUsed = 0;
  let vadFrame = new Uint8Array(640), vadUsed = 0, noise = 0, speechRun = 0, silence = 0, heard = false, listenMs = 0, bargeRun = 0;
  let preroll = [], prerollBytes = 0;
  const emit = (name,value) => { for (const callback of [...events.get(name)]) speechCall(callback,value); };
  const setState = value => { if (state !== value) { state = value; emit('stateChange',value); } };
  const releaseMic = () => { if (micStop) micStop(); micStop = null; vadUsed = 0; };
  const finishSay = error => {
    if (!say) return;
    const current = say; say = null;
    if (error) current.reject(speechError(error)); else current.resolve();
  };
  const stopTts = error => {
    const current = tts; tts = null; ttsEnded = false;
    if (current) current.stop(error || new Error('ECANCELED'));
  };
  const closeSocket = () => {
    if (!socket) return;
    const old = socket; socket = null;
    old.onopen = old.onmessage = old.onerror = old.onclose = null; wsDispose(old);
  };
  const clearOutput = () => { queue = []; queued = 0; uplinkUsed = 0; };
  const idle = () => {
    pending = null; round = false; deadline = 0; clearOutput(); releaseMic(); stopTts();
    preroll = []; prerollBytes = 0;
    if (timer) clearInterval(timer); timer = 0;
    setState('idle');
  };
  const failure = value => {
    const error = speechError(value);
    const ticket = ++epoch; continuous = false; closeSocket(); finishSay(error); idle();
    if (ticket === epoch) emit('error',error.message);
  };
  const tick = () => {
    try {
      const now = speechNow();
      if (deadline && now >= deadline) throw new Error('ETIMEDOUT: voice ' + state);
      if (say && now >= say.deadline) throw new Error('ETIMEDOUT: voice.say');
      if (tts && !ttsEnded && !tts.paused && now - lastReceive >= 15000) throw new Error('ETIMEDOUT: voice audio input');
      if (queue.length && now - lastSend >= 15000) throw new Error('ETIMEDOUT: voice uplink');
      if (!socket || socket.readyState !== 1) return;
      while (queue.length) {
        try { socket.send(queue[0].data); }
        catch (error) { if (String(error).includes('ENOBUFS')) return; throw error; }
        queued -= queue.shift().size; lastSend = now;
      }
    } catch (error) { failure(error); }
  };
  const ensureTimer = () => { if (!timer) timer = setInterval(tick,5); };
  const enqueue = data => {
    const size = typeof data === 'string' ? speechEncoder.encode(data).length : data.length;
    if (size > 128 * 1024 - queued || queue.length >= 256) throw new Error('ENOBUFS: voice uplink');
    if (!queue.length) lastSend = speechNow();
    queue.push({data,size}); queued += size; ensureTimer();
  };
  const control = (type,text) => enqueue(JSON.stringify(text === undefined ? {type} : {type,text}));
  const audio = data => {
    let offset = 0;
    while (offset < data.length) {
      const count = Math.min(uplink.length - uplinkUsed,data.length - offset);
      uplink.set(data.subarray(offset,offset + count),uplinkUsed); offset += count; uplinkUsed += count;
      if (uplinkUsed === uplink.length) { const ready = uplink; uplink = new Uint8Array(1920); uplinkUsed = 0; enqueue(ready); }
    }
  };
  const ensureMic = () => {
    if (micStop) return;
    if (!micHub.available()) throw new Error('ENOTSUP: voice microphone');
    micStop = micHub.subscribe(bytes => {
      const ticket = epoch;
      try {
        for (let offset = 0; offset < bytes.length && micStop && ticket === epoch;) {
          /* micHub 为消费者复制独立输入；整20ms帧直接读取，跨批尾帧才拼接。 */
          if (!vadUsed && bytes.length - offset >= 640) {
            const frame = offset === 0 && bytes.length === 640 ? bytes : bytes.subarray(offset,offset + 640);
            offset += 640; processFrame(frame);
          } else {
            const count = Math.min(vadFrame.length - vadUsed,bytes.length - offset);
            vadFrame.set(bytes.subarray(offset,offset + count),vadUsed); vadUsed += count; offset += count;
            if (vadUsed === vadFrame.length) { const frame = vadFrame; vadFrame = new Uint8Array(640); vadUsed = 0; processFrame(frame); }
          }
        }
      } catch (error) { failure(error); }
    },failure);
  };
  const beginRound = () => {
    const ticket = epoch;
    ensureMic(); uplinkUsed = 0; speechRun = silence = listenMs = bargeRun = 0; heard = false;
    deadline = 0; setState('listening');
    if (ticket === epoch && state === 'listening') ensureTimer();
  };
  const interrupt = () => {
    if (state !== 'speaking') return;
    const ticket = epoch;
    const retained = preroll;
    control('interrupt'); tick();
    if (ticket !== epoch) return;
    finishSay(new Error('interrupted')); stopTts(new Error('interrupted'));
    if (round) {
      beginRound(); if (ticket !== epoch || state !== 'listening') return;
      heard = true; speechRun = 3; emit('speechStart');
      if (ticket === epoch && state === 'listening') for (const frame of retained) audio(frame);
    } else {
      /* say 结束会清空本地 FIFO，先交给 WebSocket；发送队列满时直接
       * 关闭连接，让中继停止旧 TTS，避免仅停止扬声器却继续接收旧语音。
       */
      if (queue.length) closeSocket();
      idle();
    }
    preroll = []; prerollBytes = 0;
  };
  function processFrame(frame) {
    const ticket = epoch;
    const rms = native.micPcmRms(frame);
    if (noise <= 0) noise = rms > 1 ? rms : 100;
    const voice = rms > Math.max(noise * 3,120);
    noise = voice ? noise * 0.999 + rms * 0.001 : noise * 0.95 + rms * 0.05;
    const now = speechNow();
    if ((state === 'listening' || state === 'thinking' || state === 'speaking') && now - lastLevel >= 100) {
      lastLevel = now; emit('level',Math.trunc(Math.min(100,Math.sqrt(rms / 32768) * 140)));
      if (ticket !== epoch) return;
    }
    if (state === 'listening') {
      audio(frame); listenMs += 20;
      if (voice) { ++speechRun; silence = 0; } else { speechRun = 0; silence += 20; }
      if (!heard && speechRun >= 3) { heard = true; emit('speechStart'); if (ticket !== epoch) return; }
      if (heard && silence >= config.vadSilenceMs) {
        /* PCM 与 speech.end 共用同一 FIFO，网络拥塞时仍保证严格发送顺序。 */
        if (uplinkUsed) { enqueue(uplink.slice(0,uplinkUsed)); uplinkUsed = 0; }
        control('speech.end'); deadline = speechNow() + 60000; setState('thinking');
        if (ticket === epoch && state === 'thinking') emit('speechEnd');
      } else if (!heard && listenMs >= 15000 && !continuous) { closeSocket(); idle(); }
    } else if (state === 'speaking') {
      /* frame 的所有者只属于本消费者，保留引用不会被后续采集覆盖。 */
      preroll.push(frame); prerollBytes += frame.length;
      while (prerollBytes > 16000) prerollBytes -= preroll.shift().length;
      bargeRun = rms > Math.max(noise * 6,500) ? bargeRun + 1 : 0;
      if (bargeRun >= 12) interrupt();
    }
  }
  const message = event => {
    if (state === 'idle') return;
    try {
      lastReceive = speechNow();
      if (typeof event.data !== 'string') { if (tts && !ttsEnded) tts.push(event.data); return; }
      if (speechEncoder.encode(event.data).length > 32768) throw new Error('voice text exceeds 32KiB');
      const body = JSON.parse(event.data);
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') throw new Error('invalid voice message');
      const text = typeof body.text === 'string' ? body.text : '';
      if (body.type === 'stt.final') emit('userText',text);
      else if (body.type === 'llm.delta') emit('assistantDelta',text);
      else if (body.type === 'llm.done') emit('assistantText',text);
      else if (body.type === 'tts.begin') {
        if (state !== 'thinking' && state !== 'speaking') return;
        stopTts(); const owner = socket;
        const sink = speechPcmSink(body.sampleRate === undefined ? 16000 : body.sampleRate,paused => {
          if (socket === owner) { wsReadPause(owner,paused); if (!paused) lastReceive = speechNow(); }
        });
        tts = sink; ttsEnded = false; bargeRun = 0; preroll = []; prerollBytes = 0;
        deadline = speechNow() + 120000; setState('speaking');
        sink.finished.then(() => {
          if (tts !== sink) return;
          tts = null; ttsEnded = false; finishSay();
          try { if (round && continuous) beginRound(); else idle(); } catch (error) { failure(error); }
        },error => { if (tts === sink) failure(error); });
      } else if (body.type === 'tts.end') {
        if (tts) { ttsEnded = true; tts.end(); }
      } else if (body.type === 'error') {
        const error = new Error(typeof body.message === 'string' ? body.message : '服务器错误');
        const ticket = epoch;
        finishSay(error); stopTts(error); emit('error',error.message);
        if (ticket !== epoch) return;
        if (round && continuous) beginRound(); else idle();
      }
    } catch (error) { failure(error); }
  };
  const connected = action => {
    if (socket && socket.readyState === 1) { action(); return; }
    pending = action;
    if (socket && socket.readyState === 0) return;
    let url = config.serverUrl;
    if (config.token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(config.token);
    const owner = new g.WebSocket(url); socket = owner;
    const ticket = epoch;
    owner.onopen = () => {
      if (socket !== owner) return;
      try {
        const mac = String(px.wifi.status().mac || '').replace(/[^0-9a-f]/gi,'').toLowerCase();
        if (mac.length !== 12) throw new Error('ENODEV: voice device MAC');
        enqueue(JSON.stringify({type:'session.start',device:'px-' + mac.slice(-6),sampleRate:16000}));
        const action = pending; pending = null; if (action) action();
        if (socket === owner) tick();
      } catch (error) { failure(error); }
    };
    owner.onmessage = event => { if (socket === owner) message(event); };
    owner.onerror = event => { if (socket === owner) failure(new Error(event.message || 'voice connection failed')); };
    owner.onclose = () => { if (socket === owner) failure(new Error('voice connection closed')); };
    deadline = speechNow() + 15000; setState('connecting');
    if (ticket === epoch && socket === owner) ensureTimer();
  };
  const requireConfig = () => {
    if (closed) throw new Error('ECANCELED');
    if (!config) throw new Error('voice 未配置,请先调用 configure()');
  };
  const start = keepListening => {
    try {
      requireConfig(); if (state !== 'idle') return;
      ++epoch; continuous = keepListening; round = true;
      connected(beginRound);
    } catch (error) { failure(error); }
  };
  px.voice = {
    configure(options) {
      if (!options || typeof options !== 'object' || typeof options.serverUrl !== 'string' || !/^wss?:\/\//i.test(options.serverUrl) || options.serverUrl.includes('#')) throw new TypeError('voice needs ws(s) serverUrl');
      httpUrl(options.serverUrl.replace(/^ws/i,'http'));
      if (options.token !== undefined && (typeof options.token !== 'string' || speechEncoder.encode(options.token).length > 2048)) throw new TypeError('invalid voice token');
      if (options.wakeword) throw new Error('ENOTSUP: local voice wakeword backend is not ported');
      const value = options.vadSilenceMs === undefined ? 800 : options.vadSilenceMs;
      if (!Number.isFinite(value)) throw new TypeError('invalid voice VAD silence');
      px.voice.stop(); noise = 0;
      config = {serverUrl:options.serverUrl,token:options.token || '',vadSilenceMs:Math.max(200,Math.min(5000,Math.trunc(value)))};
    },
    start: () => start(false),
    startContinuous: () => start(true),
    stop() { ++epoch; continuous = false; closeSocket(); finishSay(new Error('stopped')); idle(); },
    interrupt() { try { interrupt(); } catch (error) { failure(error); } },
    sendText(text) {
      try {
        requireConfig(); speechText(text); if (state !== 'idle') throw new Error('EBUSY: voice');
      } catch (error) { emit('error',speechError(error).message); return; }
      try {
        ++epoch; round = continuous = false; ensureMic();
        connected(() => { control('text.input',text); deadline = speechNow() + 60000; setState('thinking'); });
      } catch (error) { failure(error); }
    },
    say(text) {
      try { requireConfig(); speechText(text); if (say || state !== 'idle') throw new Error('EBUSY: voice.say'); }
      catch (error) { return Promise.reject(error); }
      return new Promise((resolve,reject) => {
        ++epoch; round = continuous = false; say = {resolve,reject,deadline:speechNow() + 60000};
        try { connected(() => { control('tts.request',text); deadline = speechNow() + 60000; setState('thinking'); }); }
        catch (error) { failure(error); }
      });
    },
    state: () => state,
    on(name,callback) {
      if (!events.has(name) || typeof callback !== 'function') throw new TypeError('invalid voice event');
      events.get(name).add(callback); return () => events.get(name).delete(callback);
    }
  };
  exitHandlers.add(() => { closed = true; for (const callbacks of events.values()) callbacks.clear(); px.voice.stop(); config = null; });
})();
