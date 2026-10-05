/* 独立 Azure 语音 API；密钥仅在当前 VM 内存中，不写文件、不拼入 URL。 */
(() => {
  let config = null, operation = null, wakeOperation = null, closed = false;
  const available = () => !closed && micHub.available() && audioInternal.available() && typeof wsConnectWithHeaders === 'function';
  const required = () => {
    if (!available()) throw new Error('ENOTSUP: speech hardware is not ready');
    if (!config) throw new Error('请先配置 Azure 语音区域和密钥');
  };
  const integer = (value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value)) throw new RangeError('invalid speech duration');
    return Math.max(min,Math.min(max,Math.trunc(value)));
  };
  const cancel = () => { if (operation) operation.cancel(); };
  const stopWake = () => { if (wakeOperation) wakeOperation.cancel(); };
  const launch = run => {
    cancel();
    return new Promise((resolve,reject) => {
      const job = {done:false,dispose:() => {}};
      const finish = (error,value) => {
        if (job.done) return;
        job.done = true; job.dispose();
        if (operation === job) operation = null;
        if (error) reject(speechError(error)); else resolve(value);
      };
      job.cancel = () => finish(new Error('ECANCELED'));
      operation = job;
      try { run(job,finish,{...config}); } catch (error) { finish(error); }
    });
  };
  const asr = (job,finish,settings,options) => {
    const maxMs = integer(options.maxMs,15000,1000,30000);
    const silenceMs = integer(options.silenceMs,800,300,3000);
    const timeoutMs = integer(options.timeoutMs,20000,5000,60000);
    const id = [...u8(native.randomBytes(16))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    const started = speechNow(), connectDeadline = started + Math.min(timeoutMs,15000);
    const captureDeadline = started + maxMs + 1000, totalDeadline = Math.max(connectDeadline,captureDeadline) + timeoutMs;
    const pcm = new Uint8Array(maxMs * 32);
    let captured = 0, used = 0, sent = 0, ending = false, inputEnded = false, responseDeadline = 0;
    let socket = null, unsubscribe = null, timer = 0, ready = false, stage = 0;
    let voicedMs = 0, quietMs = 0, heard = false, noise = 0.001, lastLevel = -100;
    let finalText = '', partialText = '';
    const stopMic = () => { if (unsubscribe) unsubscribe(); unsubscribe = null; };
    job.dispose = () => {
      stopMic(); if (timer) clearInterval(timer); timer = 0;
      if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; wsDispose(socket); socket = null; }
    };
    const headers = path => 'Path: ' + path + '\r\nX-RequestId: ' + id + '\r\nX-Timestamp: ' + new Date().toISOString() + '\r\n';
    const audio = bytes => {
      /* Azure 音频消息是“文本头 + 空行 + 二进制体”，没有自定义长度前缀。 */
      const header = speechEncoder.encode(headers('audio') + (bytes.length ? 'Content-Type: audio/x-wav\r\n' : '') + '\r\n');
      const frame = new Uint8Array(header.length + bytes.length);
      frame.set(header); frame.set(bytes,header.length);
      return frame;
    };
    const send = bytes => {
      try { socket.send(bytes); return true; }
      catch (error) { if (String(error).includes('ENOBUFS')) return false; throw error; }
    };
    const process = () => {
      if (job.done) return;
      try {
        const now = speechNow();
        if (now >= totalDeadline || (!ready && now >= connectDeadline) || (inputEnded && now >= responseDeadline)) throw new Error('ETIMEDOUT: Azure 语音识别超时');
        if (now >= captureDeadline && !ending) { stopMic(); ending = true; used = captured; }
        /* VAD 在 20ms 帧上运转；连接期间完整保留开口音频，连接成功后按序追发。 */
        while (!ending && captured - used >= 640) {
          const view = new DataView(pcm.buffer,used,640); let sum = 0;
          for (let i = 0; i < 640; i += 2) { const sample = view.getInt16(i,true) / 32768; sum += sample * sample; }
          const rms = Math.sqrt(sum / 320), voice = rms > (heard ? Math.max(0.0025,noise * 1.8) : Math.max(0.004,noise * 2.5));
          if (!heard && !voice) noise = noise * 0.97 + Math.min(rms,0.003) * 0.03;
          if (voice) { voicedMs += 20; quietMs = 0; }
          else { quietMs += 20; if (!heard && quietMs > 120) voicedMs = 0; }
          used += 640; if (voicedMs >= 180) heard = true;
          if (now - lastLevel >= 100) { lastLevel = now; speechCall(options.onLevel,Math.trunc(Math.min(100,rms * 400))); }
          if (job.done) return;
          if (heard && quietMs >= silenceMs) { ending = true; stopMic(); }
        }
        if (!ending && captured === pcm.length) { ending = true; stopMic(); }
        if (ending && used === 0) used = captured;
        else if (ending && !heard) used = captured;
        if (!ready) return;
        if (stage === 0) {
          const message = headers('speech.config') + 'Content-Type: application/json\r\n\r\n' +
            JSON.stringify({context:{system:{name:'PixelBox',version:'1.0'},os:{platform:'NuttX'}}});
          if (!send(message)) return; stage = 1;
        }
        if (stage === 1) { if (!send(audio(speechWav()))) return; stage = 2; }
        while (used > sent && (used - sent >= 1280 || ending)) {
          const size = Math.min(4096,used - sent);
          if (!send(audio(pcm.subarray(sent,sent + size)))) return;
          sent += size;
        }
        if (ending && sent === used && !inputEnded) {
          if (!send(audio(new Uint8Array(0)))) return;
          inputEnded = true; responseDeadline = now + timeoutMs;
        }
      } catch (error) { finish(error); }
    };
    unsubscribe = micHub.subscribe(bytes => {
      if (job.done || ending) return;
      const count = Math.min(bytes.length,pcm.length - captured); pcm.set(bytes.subarray(0,count),captured); captured += count;
      process();
    },finish);
    const url = 'wss://' + settings.region + '.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=' +
      encodeURIComponent(settings.language) + '&format=simple&endSilenceTimeoutMs=' + silenceMs + '&initialSilenceTimeoutMs=' + maxMs;
    socket = wsConnectWithHeaders(url,{'Ocp-Apim-Subscription-Key':settings.key,'X-ConnectionId':id});
    socket.onopen = () => { if (!job.done) { ready = true; process(); } };
    socket.onerror = event => finish(new Error(event.message || 'Azure WSS failed'));
    socket.onclose = () => finish(new Error('Azure 语音连接已中断'));
    socket.onmessage = event => {
      if (job.done) return;
      try {
        if (typeof event.data !== 'string' || speechEncoder.encode(event.data).length > 65536) throw new Error('Azure 语音消息格式错误');
        const boundary = event.data.indexOf('\r\n\r\n'); if (boundary < 0) throw new Error('Azure 语音消息格式错误');
        const fields = httpHeaders(event.data.slice(0,boundary).split('\r\n'));
        if (fields['x-requestid'] !== id) return;
        const path = fields.path;
        if (path === 'turn.end') { finish(finalText ? null : new Error('未识别到有效文字，请重试'),finalText); return; }
        if (path !== 'speech.hypothesis' && path !== 'speech.phrase') return;
        const body = JSON.parse(event.data.slice(boundary + 4));
        const value = path === 'speech.hypothesis' ? body.Text : body.DisplayText;
        if (path === 'speech.hypothesis' || body.RecognitionStatus === 'Success') {
          if (typeof value !== 'string') return;
          const next = finalText + value;
          if (speechEncoder.encode(next).length > 32768) throw new Error('Azure 识别响应超出限制');
          if (path === 'speech.phrase') finalText = next;
          if (partialText !== next) { partialText = next; speechCall(options.onPartial,next); }
        } else if (typeof body.RecognitionStatus === 'string' && !['NoMatch','InitialSilenceTimeout','EndOfDictation'].includes(body.RecognitionStatus)) throw new Error('Azure 语音识别失败');
      } catch (error) { finish(error); }
    };
    timer = setInterval(process,5);
  };
  px.speech = {
    available,
    configure(options) {
      if (!options || typeof options !== 'object') throw new TypeError('speech.configure needs options');
      const next = {region:options.region,key:options.key,language:options.language === undefined ? 'zh-CN' : options.language,
        voice:options.voice === undefined ? 'zh-CN-XiaoxiaoNeural' : options.voice};
      if (typeof next.region !== 'string' || !/^[a-z0-9]{1,40}$/.test(next.region) ||
          typeof next.key !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(next.key) ||
          typeof next.language !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(next.language) ||
          typeof next.voice !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(next.voice)) throw new TypeError('Azure 区域、密钥或语言格式无效');
      if (!available()) throw new Error('ENOTSUP: speech hardware is not ready');
      cancel(); stopWake(); config = next;
    },
    recognize(options = {}) {
      required();
      if (!options || typeof options !== 'object') throw new TypeError('invalid recognize options');
      for (const key of ['onLevel','onPartial']) if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError(key + ' must be a function');
      const snapshot = {...options};
      for (const [key,value,min,max] of [['maxMs',15000,1000,30000],['silenceMs',800,300,3000],['timeoutMs',20000,5000,60000]])
        snapshot[key] = integer(snapshot[key],value,min,max);
      return launch((job,finish,settings) => asr(job,finish,settings,snapshot));
    },
    speak(text) {
      required(); speechText(text);
      return launch((job,finish,settings) => {
        let transport = null;
        const sink = speechPcmSink(16000,paused => { if (transport) transport.pause(paused); });
        const deadline = setTimeout(() => finish(new Error('ETIMEDOUT: Azure 语音播报超时')),120000);
        job.dispose = () => { clearTimeout(deadline); if (transport) transport.cancel(); sink.stop(); };
        transport = speechHttpStream(settings,text,bytes => sink.push(bytes));
        sink.finished.then(() => finish(),finish);
        transport.finished.then(() => { if (!job.done) sink.end(); },finish);
      });
    },
    wakeword: {
      start(options) {
        if (!options || typeof options !== 'object' || typeof options.onWake !== 'function' ||
            (options.onError !== undefined && typeof options.onError !== 'function')) throw new TypeError('invalid wakeword callbacks');
        const {phrase,pinyin,threshold} = options;
        if (typeof phrase !== 'string' || !phrase.length || speechEncoder.encode(phrase).length > 96 || phrase.trim() !== phrase || /[\x00-\x1f\x7f]/.test(phrase) ||
            typeof pinyin !== 'string' || pinyin.length < 2 || pinyin.length > 63 || !/^[a-z]+(?: [a-z]+)*$/.test(pinyin) ||
            !Number.isFinite(threshold) || threshold < 0 || threshold > 0.9999) throw new TypeError('invalid wakeword phrase, pinyin or threshold');
        if (closed) return Promise.reject(new Error('ECANCELED'));
        if (!micHub.available() || typeof native.wakewordAvailable !== 'function' || !native.wakewordAvailable())
          return Promise.reject(new Error('ENOTSUP: MultiNet7 wakeword backend is not available'));
        stopWake();
        const callbacks = {onWake:options.onWake,onError:options.onError};
        return new Promise((resolve,reject) => {
          const job = {id:0,ready:false,done:false}, deadline = speechNow() + 15000;
          let timer = 0, unsubscribe = null;
          const finish = (error,woken = false,notify = true) => {
            if (job.done) return;
            job.done = true;
            if (timer) clearInterval(timer);
            if (unsubscribe) unsubscribe(); unsubscribe = null;
            if (job.id) native.wakewordStop(job.id);
            if (wakeOperation === job) wakeOperation = null;
            if (!job.ready) reject(error || new Error('ECANCELED'));
            else if (error && !closed && notify) speechCall(callbacks.onError,speechError(error).message);
            else if (woken && !closed) speechCall(callbacks.onWake);
          };
          job.cancel = () => finish(new Error('ECANCELED'),false,false);
          wakeOperation = job;
          const tick = () => {
            if (job.done) return;
            try {
              if (!job.ready && speechNow() >= deadline) throw new Error('ETIMEDOUT: MultiNet7 初始化超时');
              // stop 是异步资源回收；旧任务释放模型后才创建新的真实推理实例。
              if (!job.id) {
                if (native.wakewordBusy()) return;
                job.id = native.wakewordStart(pinyin,threshold);
              }
              for (let i = 0; i < 4 && !job.done; ++i) {
                const event = native.wakewordPoll(); if (!event) break;
                if (event.jobId !== job.id) continue;
                if (event.kind === 'error') throw new Error((event.code || 'EIO') + ': MultiNet7');
                if (event.kind === 'ready' && !job.ready) {
                  unsubscribe = micHub.subscribe(bytes => { if (!job.done) native.wakewordFeed(job.id,bytes); },error => finish(error));
                  job.ready = true; resolve();
                } else if (event.kind === 'wake' && job.ready) finish(null,true);
              }
            } catch (error) { finish(error); }
          };
          timer = setInterval(tick,10); tick();
        });
      },
      stop: stopWake
    },
    cancel() { cancel(); stopWake(); }
  };
  exitHandlers.add(() => { closed = true; cancel(); stopWake(); config = null; });
})();
