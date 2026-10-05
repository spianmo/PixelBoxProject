/* 在 prelude 的 native / px / exitHandlers 共享闭包内嵌入。 */
const audioInternal = (() => {
  const jobs = new Map();
  const streamStates = new WeakMap();
  let pollTimer = 0;
  let closing = false;
  let loadGeneration = 0;
  const available = () => typeof native.audioAvailable === 'function' && native.audioAvailable();
  const requireAudio = () => {
    if (!available()) throw new Error('ENOTSUP');
    if (closing) throw new Error('ECANCELED');
  };
  const notify = state => {
    for (const item of [...state.callbacks]) {
      if (!item.active) continue;
      item.active = false;
      state.callbacks.delete(item);
      try { item.callback(); } catch (error) { console.error(error); }
    }
  };
  const pollAudio = () => {
    if (closing || typeof native.audioPoll !== 'function') return;
    let result;
    while ((result = native.audioPoll()) !== null) {
      const state = jobs.get(result.jobId);
      if (!state) continue;
      if (result.started) {
        if (state.resolve) {
          state.resolve(playHandle(state));
          state.resolve = state.reject = null;
        }
        continue;
      }
      jobs.delete(result.jobId);
      state.ended = true;
      state.stopping = false;
      state.error = result.error ? new Error(result.code || 'EIO') : null;
      for (const waiter of state.waiters) {
        if (state.error) waiter.reject(state.error); else waiter.resolve();
      }
      state.waiters.clear();
      if (state.reject) {
        state.reject(new Error(result.code || 'EIO'));
        state.resolve = state.reject = null;
      }
      /* onEnded 仅表示终结；硬件错误明确写入日志，不能悄悄当成功。 */
      if (result.error && result.code !== 'ECANCELED')
        console.error('audio playback failed: ' + (result.code || 'EIO'));
      notify(state);
    }
    if (!jobs.size && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  };
  const stateFor = id => {
    const state = {id, ended: false, stopping: false, error: null, callbacks: new Set(), waiters: new Set()};
    jobs.set(id, state);
    if (!pollTimer) pollTimer = setInterval(pollAudio, 20);
    return state;
  };
  const onEnded = (state, callback) => {
    if (typeof callback !== 'function') throw new TypeError('onEnded needs a function');
    const item = {callback, active: true};
    state.callbacks.add(item);
    if (state.ended) setTimeout(() => {
      if (!closing && item.active) {
        item.active = false;
        state.callbacks.delete(item);
        try { callback(); } catch (error) { console.error(error); }
      }
    }, 0);
    return () => { item.active = false; state.callbacks.delete(item); };
  };
  const stop = state => {
    pollAudio();
    if (state.ended || state.stopping || closing) return;
    native.audioStop(state.id);
    state.stopping = true;
  };
  const format = opts => {
    opts = opts === undefined ? {} : opts;
    if (!opts || typeof opts !== 'object') throw new TypeError('audio options must be an object');
    const rate = opts.sampleRate === undefined ? 16000 : opts.sampleRate;
    const channels = opts.channels === undefined ? 1 : opts.channels;
    if (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(rate) ||
        (channels !== 1 && channels !== 2)) throw new RangeError('EINVAL');
    return {rate, channels};
  };
  px.audio.setVolume = percent => {
    requireAudio();
    if (!Number.isFinite(percent)) throw new RangeError('EINVAL');
    native.audioSetVolume(percent);
  };
  px.audio.getVolume = () => { requireAudio(); return native.audioGetVolume(); };
  const playHandle = state => ({
    stop: () => stop(state),
    pause() { pollAudio(); if (!state.ended && !state.stopping) native.audioPause(state.id, true); },
    resume() { pollAudio(); if (!state.ended && !state.stopping) native.audioPause(state.id, false); },
    get playing() { return !closing && !state.ended && !state.stopping && native.audioPlaying(state.id); },
    onEnded: callback => onEnded(state, callback)
  });
  px.audio.player.play = async src => {
    requireAudio();
    if (typeof src !== 'string' || !src || src.includes('\0')) throw new TypeError('play needs a file path or URL');
    const generation = loadGeneration;
    let data;
    if (/^https?:\/\//i.test(src)) {
      if (typeof globalThis.fetch !== 'function') throw new Error('ENOTSUP');
      const response = await globalThis.fetch(src);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      data = u8(await response.arrayBuffer());
    } else {
      /* 沿用文件系统的虚拟路径校验，不绕过 /app 与 /data 的访问边界。 */
      data = u8(native.fs.readBytes(src));
    }
    if (closing || generation !== loadGeneration) throw new Error('ECANCELED');
    if (!data.byteLength || data.byteLength > 8 * 1024 * 1024) throw new RangeError('EINVAL');
    pollAudio();
    const id = native.audioPlayEncoded(data);
    return new Promise((resolve, reject) => {
      const state = stateFor(id);
      state.resolve = resolve;
      state.reject = reject;
    });
  };
  px.audio.player.playPcm = (pcm, opts) => {
    requireAudio();
    const {rate, channels} = format(opts);
    const data = u8(pcm);
    if (!data.byteLength || data.byteLength % (channels * 2)) throw new RangeError('EINVAL');
    pollAudio();
    const state = stateFor(native.audioPlayPcm(data, rate, channels));
    return playHandle(state);
  };
  px.audio.player.openPcmStream = opts => {
    requireAudio();
    const {rate, channels} = format(opts);
    pollAudio();
    const state = stateFor(native.audioStreamOpen(rate, channels));
    let eos = false;
    const stream = {
      feed(pcm) {
        pollAudio();
        if (eos || state.ended || state.stopping || closing) throw new Error('EINVAL');
        const data = u8(pcm);
        if (data.byteLength % (channels * 2)) throw new RangeError('EINVAL');
        /* 原生环满抛 EAGAIN；调用方可用 buffered() 节流后重试整个分块。 */
        native.audioStreamFeed(state.id, data);
      },
      end() {
        pollAudio();
        if (eos || state.ended || state.stopping || closing) return;
        native.audioStreamEnd(state.id);
        eos = true;
      },
      stop: () => stop(state),
      onEnded: callback => onEnded(state, callback),
      buffered() {
        pollAudio();
        return state.ended || state.stopping || closing ? 0 : native.audioBuffered(state.id);
      }
    };
    streamStates.set(stream, state);
    return stream;
  };
  px.audio.player.tone = (frequency = 440, duration = 200, volume = 80) => {
    requireAudio();
    if (!Number.isFinite(frequency) || frequency < 20 || frequency >= 8000 ||
        !Number.isInteger(duration) || duration <= 0 || duration > 60000 ||
        !Number.isFinite(volume)) throw new RangeError('EINVAL');
    pollAudio();
    stateFor(native.audioTone(frequency, duration, volume));
  };
  px.audio.player.stopAll = () => {
    requireAudio();
    ++loadGeneration;
    pollAudio();
    native.audioStopAll();
    for (const state of jobs.values()) state.stopping = true;
  };
  Object.defineProperty(px.audio.player, 'playing', {
    configurable: true, enumerable: true,
    get: () => !closing && typeof native.audioPlaying === 'function' && native.audioPlaying(0)
  });
  exitHandlers.add(() => {
    closing = true;
    ++loadGeneration;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
    for (const state of jobs.values()) {
      state.ended = true;
      state.error = new Error('ECANCELED');
      for (const waiter of state.waiters) waiter.reject(state.error);
      state.waiters.clear();
      if (state.reject) state.reject(new Error('ECANCELED'));
      state.resolve = state.reject = null;
      for (const item of state.callbacks) item.active = false;
      state.callbacks.clear();
    }
    jobs.clear();
    if (typeof native.audioShutdown === 'function') native.audioShutdown();
  });
  return {
    available,
    /* 语音 Promise 必须区别 DMA 成功、取消及硬件失败，公开 onEnded 仍保持原契约。 */
    openPcmStream(options) {
      const stream = px.audio.player.openPcmStream(options);
      const state = streamStates.get(stream);
      const finished = new Promise((resolve, reject) => state.waiters.add({resolve, reject}));
      return {stream, finished};
    }
  };
})();
