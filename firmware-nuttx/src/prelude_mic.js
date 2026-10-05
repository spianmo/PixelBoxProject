/* 与 prelude 的 native / px / exitHandlers 同闭包；录音与订阅共享物理采集。 */
const micHub = (() => {
  const inputRate = 16000;
  const records = new Set();
  const consumers = new Set();
  let subscriber = null;
  let timer = 0;
  let closing = false;
  const supported = () => typeof native.micAvailable === 'function' && native.micAvailable();
  const requireMic = () => {
    if (!supported()) throw new Error('ENOTSUP');
    if (closing) throw new Error('ECANCELED');
  };
  const wanted = () => subscriber !== null || records.size !== 0 || consumers.size !== 0;
  const stopUnused = () => {
    if (!wanted()) {
      native.micStop();
      if (timer) { clearInterval(timer); timer = 0; }
    }
  };
  const fail = error => {
    subscriber = null;
    for (const record of records) record.reject(error);
    records.clear();
    const failed = [...consumers];
    consumers.clear();
    native.micStop();
    if (timer) { clearInterval(timer); timer = 0; }
    for (const consumer of failed) {
      try { consumer.onError(error); } catch (failure) { console.error(failure); }
    }
    console.error('microphone capture failed: ' + error.message);
  };
  const ensureCapture = () => {
    if (wanted() && !native.micActive() && !native.micBusy())
      native.micStart(inputRate, 10);
    if (wanted() && !timer) timer = setInterval(poll, 10);
  };
  /* 每个订阅独立保留跨帧相位；MIC 和 record 可使用不同采样率。 */
  const resampler = (rate, output) => {
    let previous = 0, index = 0, phase = inputRate, havePrevious = false;
    return data => {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let offset = 0; offset < data.byteLength; offset += 2) {
        const current = view.getInt16(offset, true);
        if (!havePrevious) {
          havePrevious = true;
          previous = current;
          if (output(current) === false) return;
          continue;
        }
        ++index;
        const right = index * rate, left = right - rate;
        while (phase <= right) {
          const fraction = phase - left;
          const sample = Math.trunc((previous * (rate - fraction) + current * fraction) / rate);
          phase += inputRate;
          if (output(sample) === false) return;
        }
        previous = current;
      }
    };
  };
  function poll() {
    if (closing || !wanted()) return;
    try {
      /* 先读取上一次采集的终态，不能先重启并覆盖其异步错误。
       * 按累计PCM限制每轮约一秒（末批最多额外90ms），批量读取也不能无限追赶生产者。
       */
      let received = 0;
      for (let count = 0; count < 100 && received < 32000 && wanted(); ++count) {
        const frame = native.micPoll();
        if (frame === null) break;
        const bytes = u8(frame.data);
        if (frame.sampleRate !== inputRate || !bytes.byteLength || bytes.byteLength % 2)
          throw new Error('EPROTO');
        received += bytes.byteLength;
        /* 先复制给录音，用户回调随后可安全 stop/start 或修改自己的帧。 */
        for (const record of [...records]) if (records.has(record)) record.feed(bytes);
        /* 内部语音订阅先各得独立帧，用户 MIC 回调不能改坏 ASR 音频。 */
        for (const consumer of [...consumers]) if (consumers.has(consumer)) {
          try { consumer.onData(bytes.slice()); } catch (error) {
            consumers.delete(consumer);
            try { consumer.onError(error); } catch (failure) { console.error(failure); }
          }
        }
        const current = subscriber;
        if (current && !closing) current.feed(bytes);
      }
      stopUnused();
      ensureCapture();
    } catch (error) { fail(error); }
  }
  const clampInteger = (value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value)) throw new RangeError('EINVAL');
    return Math.max(min, Math.min(max, Math.trunc(value)));
  };
  px.audio.mic = {
    start(options) {
      requireMic();
      if (!options || typeof options !== 'object' || typeof options.onData !== 'function')
        throw new TypeError('mic.start needs onData');
      const rate = options.sampleRate === undefined ? 16000 : options.sampleRate;
      if (![8000, 16000, 24000, 32000, 44100, 48000].includes(rate)) throw new RangeError('EINVAL');
      const frameMs = clampInteger(options.frameMs, 32, 10, 500);
      const length = Math.floor(rate * frameMs / 1000) * 2;
      let frame = new Uint8Array(length), used = 0;
      const state = {};
      const deliver = () => {
        const ready = frame.buffer;
        frame = new Uint8Array(length);
        used = 0;
        try { options.onData(ready); } catch (error) { console.error(error); }
      };
      /* 同率 PCM 不需要插值；批量合帧仍检查回调内 stop/start，旧订阅不继续消费。 */
      state.feed = rate === inputRate ? data => {
        for (let offset = 0; offset < data.length && subscriber === state && !closing;) {
          const count = Math.min(length - used, data.length - offset);
          frame.set(data.subarray(offset, offset + count), used);
          used += count; offset += count;
          if (used === length) deliver();
        }
      } : resampler(rate, sample => {
        if (subscriber !== state || closing) return false;
        frame[used++] = sample & 255;
        frame[used++] = (sample >> 8) & 255;
        if (used === length) deliver();
        return subscriber === state && !closing;
      });
      subscriber = state;
      try { ensureCapture(); } catch (error) { subscriber = null; stopUnused(); throw error; }
    },
    stop() { subscriber = null; stopUnused(); },
    get active() { return !closing && subscriber !== null; },
    setGain(percent) {
      requireMic();
      if (!Number.isFinite(percent)) throw new RangeError('EINVAL');
      native.micSetGain(percent);
    }
  };
  px.audio.record = async (path, options = {}) => {
    requireMic();
    if (typeof path !== 'string' || !path.startsWith('/data/') || path.includes('\0') ||
        path.split('/').some(part => part === '..' || part === '.') || path.endsWith('/'))
      throw new TypeError('record path must stay under /data/');
    if (!options || typeof options !== 'object') throw new TypeError('record options must be an object');
    const rate = options.sampleRate === undefined ? 16000 : options.sampleRate;
    if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new RangeError('EINVAL');
    const duration = clampInteger(options.maxMs, 10000, 100, 60000);
    const samples = Math.floor(rate * duration / 1000);
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    /* 直接在最终 WAV 缓冲内采集，避免大录音再复制一份 PCM。 */
    const label = (offset, text) => {
      for (let i = 0; i < text.length; ++i) bytes[offset + i] = text.charCodeAt(i);
    };
    label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE');
    label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data');
    view.setUint32(40, samples * 2, true);
    return new Promise((resolve, reject) => {
      let written = 0;
      const record = {reject};
      const complete = () => {
        records.delete(record);
        try {
          /* 路径与符号链接仍由原生 fs 的虚拟路径检查处理。 */
          native.fs.writeBytes(path, bytes);
          resolve(Math.floor(written * 1000 / rate));
        } catch (error) { reject(error); }
      };
      record.feed = rate === inputRate ? data => {
        if (closing || !records.has(record)) return;
        const count = Math.min(data.length, (samples - written) * 2);
        bytes.set(data.subarray(0, count), 44 + written * 2);
        written += count / 2;
        if (written === samples) complete();
      } : resampler(rate, sample => {
        if (closing || !records.has(record)) return false;
        view.setInt16(44 + written++ * 2, sample, true);
        if (written === samples) {
          complete(); return false;
        }
        return true;
      });
      records.add(record);
      try { ensureCapture(); } catch (error) { records.delete(record); stopUnused(); reject(error); }
    });
  };
  exitHandlers.add(() => {
    closing = true;
    subscriber = null;
    for (const record of records) record.reject(new Error('ECANCELED'));
    records.clear();
    const failed = [...consumers];
    consumers.clear();
    for (const consumer of failed) {
      try { consumer.onError(new Error('ECANCELED')); } catch (error) { console.error(error); }
    }
    if (timer) { clearInterval(timer); timer = 0; }
    if (typeof native.micStop === 'function') native.micStop();
  });
  return {
    available: supported,
    /* 固件模块专用的16k订阅，按已就绪的10ms帧批量交付，不替换公开mic.start回调。 */
    subscribe(onData, onError) {
      requireMic();
      if (typeof onData !== 'function' || typeof onError !== 'function') throw new TypeError('invalid microphone consumer');
      const consumer = {onData, onError};
      consumers.add(consumer);
      try { ensureCapture(); } catch (error) { consumers.delete(consumer); stopUnused(); throw error; }
      return () => { consumers.delete(consumer); stopUnused(); };
    }
  };
})();
