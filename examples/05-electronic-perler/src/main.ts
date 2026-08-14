import {
  BeadPattern,
  DisplayMode,
  MEDIA_STORAGE_KEY,
  MODE_STORAGE_KEY,
  PATTERN_STORAGE_KEY,
  PerlerMedia,
  colorFromHex,
  parseDisplayMode,
  parseMediaPayload,
  parseMusicUrl,
  parsePatternPayload,
} from './pattern';

const HTTP_PORT = 8080;
const MEDIA_CHUNK_BYTES = 8 * 1024;
const MAX_HTTP_BYTES = MEDIA_CHUNK_BYTES + 4 * 1024;
const SCREEN_BG = 0x000000;
const TEXT_MAIN = 0xFFFFFF;
const ERROR = 0xFF6B57;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

interface UploadSession {
  id: string;
  path: string;
  media: PerlerMedia;
  received: number;
}

type MusicPlaybackState = 'stopped' | 'loading' | 'playing' | 'paused' | 'error';

let pattern = loadSavedPattern();
let media = loadSavedMedia();
let displayMode = loadSavedMode();
let animation: PxAnimation | null = null;
let upload: UploadSession | null = null;
let uploadSequence = 0;
let dirty = true;
let musicHandle: PxPlayHandle | null = null;
let unsubscribeMusicEnded: Unsubscribe | null = null;
let musicGeneration = 0;
let musicUrl = '';
let musicState: MusicPlaybackState = 'stopped';
let musicError: string | null = null;

function mediaPath(slot: 0 | 1): string {
  return `/data/perler-${slot}.bin`;
}

function safeRemove(path: string): void {
  try {
    if (px.storage.fs.exists(path)) px.storage.fs.remove(path);
  } catch (error) {
    console.warn(`清理媒体文件失败: ${String(error)}`);
  }
}

function loadSavedPattern(): BeadPattern | null {
  const saved = px.storage.kv.getJSON<unknown>(PATTERN_STORAGE_KEY);
  if (saved === null) return null;
  try {
    return parsePatternPayload(saved);
  } catch (error) {
    console.warn(`忽略无效的历史图案: ${String(error)}`);
    px.storage.kv.remove(PATTERN_STORAGE_KEY);
    return null;
  }
}

function loadSavedMedia(): PerlerMedia | null {
  const saved = px.storage.kv.getJSON<unknown>(MEDIA_STORAGE_KEY);
  if (saved === null) return null;
  try {
    const value = parseMediaPayload(saved);
    if (px.storage.fs.stat(mediaPath(value.slot))?.size !== value.size) {
      throw new Error('媒体文件大小与元数据不一致');
    }
    return value;
  } catch (error) {
    console.warn(`忽略无效的历史媒体: ${String(error)}`);
    px.storage.kv.remove(MEDIA_STORAGE_KEY);
    return null;
  }
}

function loadSavedMode(): DisplayMode {
  const saved = px.storage.kv.get(MODE_STORAGE_KEY);
  try {
    const value = parseDisplayMode(saved);
    if (value === 'pattern' && pattern) return value;
    if (value === media?.kind) return value;
  } catch {
    // 无效模式会在下方按现有内容恢复。
  }
  return media?.kind ?? 'pattern';
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function musicStatus(): { url: string; state: MusicPlaybackState; error: string | null } {
  return { url: musicUrl, state: musicState, error: musicError };
}

function detachMusicHandle(stop: boolean): void {
  if (unsubscribeMusicEnded) {
    unsubscribeMusicEnded();
    unsubscribeMusicEnded = null;
  }
  if (stop && musicHandle) musicHandle.stop();
  musicHandle = null;
}

/** 异步连接网络音频；generation 防止较慢的旧请求覆盖新请求状态。 */
function beginMusicPlayback(url: string): void {
  const generation = ++musicGeneration;
  detachMusicHandle(true);
  musicUrl = url;
  musicState = 'loading';
  musicError = null;

  let pending: Promise<PxPlayHandle>;
  try {
    pending = px.audio.player.play(url);
  } catch (error) {
    musicState = 'error';
    musicError = errorMessage(error);
    return;
  }
  void pending.then((handle) => {
    if (generation !== musicGeneration) {
      handle.stop();
      return;
    }
    musicHandle = handle;
    musicState = 'playing';
    unsubscribeMusicEnded = handle.onEnded(() => {
      if (generation !== musicGeneration || musicHandle !== handle) return;
      detachMusicHandle(false);
      musicState = 'stopped';
      musicError = null;
    });
  }).catch((error) => {
    if (generation !== musicGeneration) return;
    detachMusicHandle(false);
    musicState = 'error';
    musicError = errorMessage(error);
  });
}

function pauseMusicPlayback(): void {
  if (!musicHandle || musicState !== 'playing') throw new Error('当前没有正在播放的音乐');
  musicHandle.pause();
  musicState = 'paused';
  musicError = null;
}

function resumeMusicPlayback(): void {
  if (!musicHandle || musicState !== 'paused') throw new Error('当前没有已暂停的音乐');
  musicHandle.resume();
  musicState = 'playing';
  musicError = null;
}

function stopMusicPlayback(): void {
  musicGeneration += 1;
  detachMusicHandle(true);
  musicState = 'stopped';
  musicError = null;
}

/** 真机键2短按仅在正在播放或已暂停时切换状态，其他音乐状态保持不变。 */
function toggleMusicPlayback(): void {
  try {
    if (musicState === 'playing') {
      pauseMusicPlayback();
      console.log('键2: 音乐已暂停');
    } else if (musicState === 'paused') {
      resumeMusicPlayback();
      console.log('键2: 音乐继续播放');
    }
  } catch (error) {
    musicError = errorMessage(error);
    console.warn(`键2切换音乐失败: ${musicError}`);
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function findHeaderEnd(data: Uint8Array): number {
  for (let i = 0; i <= data.byteLength - 4; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) return i;
  }
  return -1;
}

function splitRequestPath(rawPath: string): { path: string; query: Record<string, string> } {
  const question = rawPath.indexOf('?');
  const path = question < 0 ? rawPath : rawPath.slice(0, question);
  const query: Record<string, string> = {};
  if (question < 0) return { path, query };
  for (const part of rawPath.slice(question + 1).split('&')) {
    if (!part) continue;
    const equal = part.indexOf('=');
    const name = decodeURIComponent(equal < 0 ? part : part.slice(0, equal));
    const value = decodeURIComponent(equal < 0 ? '' : part.slice(equal + 1));
    query[name] = value;
  }
  return { path, query };
}

function sendResponse(
  sock: PxTcpSocket,
  status: number,
  statusText: string,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
    ...Object.keys(extraHeaders).map((name) => `${name}: ${extraHeaders[name]}`),
    '',
    '',
  ].join('\r\n');
  sock.send(headers);
  if (body.length > 0) sock.send(body);

  // PxTcpSocket.send() 进入异步发送队列，按响应体大小留出排空时间。
  const closeDelayMs = Math.min(1500, 150 + Math.ceil(byteLength(body) / 1024) * 30);
  setTimeout(() => sock.close(), closeDelayMs);
}

function sendJson(sock: PxTcpSocket, status: number, value: unknown): void {
  const reasons: Record<number, string> = {
    200: 'OK',
    400: 'Bad Request',
    404: 'Not Found',
    413: 'Payload Too Large',
  };
  sendResponse(sock, status, reasons[status] ?? 'Error', 'application/json; charset=utf-8', JSON.stringify(value));
}

function containRect(sourceWidth: number, sourceHeight: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(px.screen.width / sourceWidth, px.screen.height / sourceHeight);
  const w = Math.max(1, Math.round(sourceWidth * scale));
  const h = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.floor((px.screen.width - w) / 2),
    y: Math.floor((px.screen.height - h) / 2),
    w,
    h,
  };
}

function activateMedia(next: PerlerMedia, path: string): void {
  let nextAnimation: PxAnimation | null = null;
  if (next.kind === 'gif') {
    nextAnimation = px.screen.loadGif(path, {
      removeBackground: next.removeBackground,
      backgroundThreshold: next.backgroundThreshold,
    });
  } else {
    const probe = px.screen.createCanvas(1, 1);
    try {
      probe.drawImage(path, 0, 0, { w: 1, h: 1 });
    } finally {
      probe.dispose();
    }
  }

  if (animation) animation.dispose();
  animation = nextAnimation;
  if (animation) animation.play();
  media = next;
  displayMode = next.kind;
  px.storage.kv.set(MEDIA_STORAGE_KEY, next);
  px.storage.kv.set(MODE_STORAGE_KEY, displayMode);
  px.screen.setFps(next.kind === 'gif' ? 60 : 5);
  dirty = true;
}

function beginMediaUpload(bodyBytes: Uint8Array): { id: string; chunkBytes: number } {
  const requested = JSON.parse(decoder.decode(bodyBytes)) as unknown;
  const nextSlot: 0 | 1 = media?.slot === 0 ? 1 : 0;
  const next = parseMediaPayload(requested, nextSlot);
  const path = mediaPath(nextSlot);
  px.storage.fs.writeBytes(path, new Uint8Array(0));
  upload = {
    id: `${++uploadSequence}-${nextSlot}`,
    path,
    media: next,
    received: 0,
  };
  return { id: upload.id, chunkBytes: MEDIA_CHUNK_BYTES };
}

function appendMediaChunk(query: Record<string, string>, bodyBytes: Uint8Array): number {
  if (!upload || query.id !== upload.id) throw new Error('上传会话已失效，请重新发送');
  const offset = Number(query.offset);
  if (!Number.isInteger(offset) || offset !== upload.received) throw new Error('分块偏移不连续');
  if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > MEDIA_CHUNK_BYTES) throw new Error('分块大小无效');
  if (upload.received + bodyBytes.byteLength > upload.media.size) throw new Error('上传数据超出声明大小');
  px.storage.fs.append(upload.path, bodyBytes);
  upload.received += bodyBytes.byteLength;
  return upload.received;
}

function commitMediaUpload(bodyBytes: Uint8Array): PerlerMedia {
  const request = JSON.parse(decoder.decode(bodyBytes)) as { id?: unknown };
  if (!upload || request.id !== upload.id) throw new Error('上传会话已失效，请重新发送');
  const completed = upload;
  if (completed.received !== completed.media.size || px.storage.fs.stat(completed.path)?.size !== completed.media.size) {
    throw new Error('媒体文件尚未上传完整');
  }

  const previousPath = media ? mediaPath(media.slot) : null;
  try {
    activateMedia(completed.media, completed.path);
  } catch (error) {
    safeRemove(completed.path);
    throw new Error(`媒体解码失败: ${String(error)}`);
  } finally {
    upload = null;
  }
  if (previousPath && previousPath !== completed.path) safeRemove(previousPath);
  return completed.media;
}

function routeRequest(sock: PxTcpSocket, method: string, rawPath: string, bodyBytes: Uint8Array): void {
  const { path, query } = splitRequestPath(rawPath);
  if (method === 'GET' && path === '/') {
    sendResponse(sock, 200, 'OK', 'text/html; charset=utf-8', px.app.readAssetText('index.html'));
    return;
  }
  if (method === 'GET' && path === '/app.js') {
    sendResponse(sock, 200, 'OK', 'text/javascript; charset=utf-8', px.app.readAssetText('app.js'));
    return;
  }
  if (method === 'GET' && path === '/style.css') {
    sendResponse(sock, 200, 'OK', 'text/css; charset=utf-8', px.app.readAssetText('style.css'));
    return;
  }
  if (method === 'GET' && path === '/api/status') {
    const wifi = px.wifi.status();
    sendJson(sock, 200, {
      ok: true,
      device: px.app.name,
      ip: wifi.ip,
      mode: displayMode,
      screen: { width: px.screen.width, height: px.screen.height },
      pattern: pattern ? { cols: pattern.cols, rows: pattern.rows, colors: pattern.palette.length } : null,
      music: musicStatus(),
      media: media ? {
        kind: media.kind,
        width: media.width,
        height: media.height,
        size: media.size,
        removeBackground: media.removeBackground,
        backgroundThreshold: media.backgroundThreshold,
        crop: media.crop,
      } : null,
    });
    return;
  }
  if (method === 'POST' && path === '/api/music/play') {
    try {
      const url = parseMusicUrl(JSON.parse(decoder.decode(bodyBytes)) as unknown);
      beginMusicPlayback(url);
      sendJson(sock, 200, { ok: true, music: musicStatus() });
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: errorMessage(error), music: musicStatus() });
    }
    return;
  }
  if (method === 'POST' && path === '/api/music/pause') {
    try {
      pauseMusicPlayback();
      sendJson(sock, 200, { ok: true, music: musicStatus() });
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: errorMessage(error), music: musicStatus() });
    }
    return;
  }
  if (method === 'POST' && path === '/api/music/resume') {
    try {
      resumeMusicPlayback();
      sendJson(sock, 200, { ok: true, music: musicStatus() });
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: errorMessage(error), music: musicStatus() });
    }
    return;
  }
  if (method === 'POST' && path === '/api/music/stop') {
    stopMusicPlayback();
    sendJson(sock, 200, { ok: true, music: musicStatus() });
    return;
  }
  if (method === 'POST' && path === '/api/pattern') {
    try {
      const next = parsePatternPayload(JSON.parse(decoder.decode(bodyBytes)) as unknown);
      if (animation) {
        animation.dispose();
        animation = null;
      }
      pattern = next;
      displayMode = 'pattern';
      px.storage.kv.set(PATTERN_STORAGE_KEY, next);
      px.storage.kv.set(MODE_STORAGE_KEY, displayMode);
      px.screen.setFps(5);
      dirty = true;
      sendJson(sock, 200, { ok: true, beads: next.cols * next.rows, mode: displayMode });
      px.audio.player.tone(880, 45, 10);
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method === 'POST' && path === '/api/media/begin') {
    try {
      sendJson(sock, 200, { ok: true, ...beginMediaUpload(bodyBytes) });
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method === 'POST' && path === '/api/media/chunk') {
    try {
      sendJson(sock, 200, { ok: true, received: appendMediaChunk(query, bodyBytes) });
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method === 'POST' && path === '/api/media/commit') {
    try {
      const completed = commitMediaUpload(bodyBytes);
      sendJson(sock, 200, { ok: true, mode: completed.kind, size: completed.size });
      px.audio.player.tone(880, 45, 10);
    } catch (error) {
      sendJson(sock, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method === 'OPTIONS') {
    sendResponse(sock, 200, 'OK', 'text/plain', '', { Allow: 'GET, POST, OPTIONS' });
    return;
  }
  sendJson(sock, 404, { ok: false, error: '接口不存在' });
}

/** 每条连接只处理一个 HTTP/1.1 请求，完成后主动关闭。 */
function handleConnection(sock: PxTcpSocket): void {
  let buffer: Uint8Array = new Uint8Array(0);
  let headerEnd = -1;
  let contentLength = 0;
  let method = '';
  let path = '';
  let handled = false;
  const idleTimeout = setTimeout(() => sock.close(), 5000);

  const rejectLargeRequest = (): void => {
    handled = true;
    sendJson(sock, 413, { ok: false, error: '请求体过大' });
  };

  sock.onData((chunk) => {
    if (handled) return;
    buffer = appendBytes(buffer, new Uint8Array(chunk));
    if (buffer.byteLength > MAX_HTTP_BYTES) {
      rejectLargeRequest();
      return;
    }

    if (headerEnd < 0) {
      headerEnd = findHeaderEnd(buffer);
      if (headerEnd < 0) return;
      const headerText = decoder.decode(buffer.slice(0, headerEnd));
      const lines = headerText.split('\r\n');
      const requestLine = lines.shift()?.split(' ') ?? [];
      if (requestLine.length < 2) {
        handled = true;
        sendJson(sock, 400, { ok: false, error: 'HTTP 请求行无效' });
        return;
      }
      method = requestLine[0].toUpperCase();
      path = requestLine[1];
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        if (line.slice(0, colon).trim().toLowerCase() === 'content-length') {
          contentLength = Number(line.slice(colon + 1).trim());
        }
      }
      if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > MEDIA_CHUNK_BYTES) {
        rejectLargeRequest();
        return;
      }
    }

    const bodyStart = headerEnd + 4;
    if (buffer.byteLength < bodyStart + contentLength) return;
    handled = true;
    routeRequest(sock, method, path, buffer.slice(bodyStart, bodyStart + contentLength));
  });
  sock.onClose(() => clearTimeout(idleTimeout));
  sock.onError((message) => console.warn(`HTTP 客户端错误: ${message}`));
}

function drawPattern(value: BeadPattern): void {
  const cell = Math.max(1, Math.floor(Math.min(px.screen.width / value.cols, px.screen.height / value.rows)));
  const gridW = cell * value.cols;
  const gridH = cell * value.rows;
  const startX = Math.floor((px.screen.width - gridW) / 2);
  const startY = Math.floor((px.screen.height - gridH) / 2);
  const colors = value.palette.map(colorFromHex);
  const pixels = value.pixels;
  const cols = value.cols;

  // 熨烫后的拼豆按无间隙方块显示；空豆位保持屏幕黑底。
  // 同一行内连续同色的豆位合成一次 fillRect：设备上单次 fillRect 约 100us，
  // 64x64 逐格画要 562ms，合并后典型图案只剩几十到几百次调用。
  // 色板索引一律用 charCodeAt 算术求得，不走 charAt/parseInt（见 pattern.ts 注释）。
  for (let row = 0; row < value.rows; row++) {
    const rowBase = row * cols;
    const y = startY + row * cell;
    let col = 0;
    while (col < cols) {
      const code = pixels.charCodeAt(rowBase + col);
      if (code === 46) { // '.' 空豆位
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < cols && pixels.charCodeAt(rowBase + col + run) === code) run += 1;
      // 校验阶段已保证是 0-9 / a-z
      const index = code <= 57 ? code - 48 : code - 87;
      px.screen.fillRect(startX + col * cell, y, cell * run, cell, colors[index]);
      col += run;
    }
  }
}

function drawMedia(): void {
  if (!media) return;
  if (displayMode === 'gif' && animation) {
    if (media.crop) {
      const sx = Math.max(0, Math.round(media.crop.x));
      const sy = Math.max(0, Math.round(media.crop.y));
      const size = Math.max(1, Math.min(
        Math.round(media.crop.size),
        media.width - sx,
        media.height - sy,
      ));
      const rect = containRect(size, size);
      animation.draw(rect.x, rect.y, undefined, {
        sx,
        sy,
        sw: size,
        sh: size,
        w: rect.w,
        h: rect.h,
      });
    } else {
      const rect = containRect(media.width, media.height);
      animation.draw(rect.x, rect.y, undefined, { w: rect.w, h: rect.h });
    }
  } else if (displayMode === 'image') {
    const rect = containRect(media.width, media.height);
    px.screen.drawImage(mediaPath(media.slot), rect.x, rect.y, { w: rect.w, h: rect.h });
  }
}

function drawEmptyState(ip: string | null): void {
  const text = ip ? `http://${ip}:${HTTP_PORT}` : 'Wi-Fi 未连接';
  const style: PxTextStyle = { font: 'pixel8', color: ip ? TEXT_MAIN : ERROR };
  const metrics = px.screen.measureText(text, style);
  px.screen.drawText(
    text,
    Math.floor((px.screen.width - metrics.width) / 2),
    Math.floor((px.screen.height - metrics.height) / 2),
    style,
  );
}

function hasVisibleContent(): boolean {
  return (displayMode === 'pattern' && pattern !== null) ||
    ((displayMode === 'image' || displayMode === 'gif') && media !== null);
}

function render(): void {
  px.screen.clear(SCREEN_BG);
  if (displayMode === 'pattern' && pattern) drawPattern(pattern);
  else if ((displayMode === 'image' || displayMode === 'gif') && media) drawMedia();
  else drawEmptyState(px.wifi.status().ip);
}

if (displayMode === 'gif' && media) {
  try {
    animation = px.screen.loadGif(mediaPath(media.slot), {
      removeBackground: media.removeBackground,
      backgroundThreshold: media.backgroundThreshold,
    });
    animation.play();
  } catch (error) {
    console.warn(`GIF 恢复失败: ${String(error)}`);
    media = null;
    displayMode = 'pattern';
    px.storage.kv.remove(MEDIA_STORAGE_KEY);
    px.storage.kv.set(MODE_STORAGE_KEY, displayMode);
  }
}

const server = px.net.listenTcp({ port: HTTP_PORT, onConnection: handleConnection });
const stopMdns = px.net.mdns.advertise({
  name: 'PixelBox 电子拼豆',
  service: '_http._tcp',
  port: HTTP_PORT,
  txt: { path: '/', app: 'electronic-perler' },
});

px.input.onButton((ev) => {
  if (ev.id === 'power' && ev.type === 'click') toggleMusicPlayback();
});

let lastIp = px.wifi.status().ip;
setInterval(() => {
  const nextIp = px.wifi.status().ip;
  if (nextIp !== lastIp) {
    lastIp = nextIp;
    if (!hasVisibleContent()) dirty = true;
  }
}, 2000);

px.screen.setFps(displayMode === 'gif' && animation ? 60 : 5);
px.screen.onFrame(() => {
  if (displayMode !== 'gif' && !dirty) return;
  dirty = false;
  render();
});

px.app.onExit(() => {
  if (animation) animation.dispose();
  stopMusicPlayback();
  server.close();
  stopMdns();
});

console.log(`电子拼豆服务已启动: http://${px.wifi.status().ip ?? px.net.hostname()}:${HTTP_PORT}`);
