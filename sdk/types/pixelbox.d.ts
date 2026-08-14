/**
 * PixelBox 像素盒 — 设备端 TypeScript API 契约 (v0.1.0)
 *
 * ⚠️ 本文件是整个项目的【唯一事实源 / Single Source of Truth】:
 *   - 固件 (firmware/components/bindings_*) 必须按此签名注册原生 API
 *   - 模拟器 (simulator/src/renderer/src/device-sim) 必须按此签名实现 shim
 *   - 任何签名变更必须同步三端,禁止单端私改
 *
 * 运行环境: QuickJS-ng (ES2023),无 Node/DOM。全局提供 px / pixelbox 命名空间
 * 以及 Web 风格标准全局 (console / 定时器 / fetch / WebSocket / TextEncoder 等)。
 *
 * 约定:
 *   - 颜色统一为 24 位整数 0xRRGGBB
 *   - 二进制统一使用 ArrayBuffer / Uint8Array
 *   - 所有事件订阅函数返回 Unsubscribe,调用即取消订阅
 *   - 硬件不存在/未启用时,对应 available() 返回 false,其余方法抛 Error("ENOTSUP")
 */

/** 24 位 RGB 颜色,如 0xFF8800 */
declare type Color = number;
/** 取消订阅函数 */
declare type Unsubscribe = () => void;
/** 二进制数据入参 */
declare type BinaryLike = ArrayBuffer | Uint8Array;

// ============================================================
// 标准全局 (Web 风格子集)
// ============================================================

interface Console {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}
declare var console: Console;

declare function setTimeout(handler: (...args: unknown[]) => void, timeoutMs?: number, ...args: unknown[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(handler: (...args: unknown[]) => void, intervalMs?: number, ...args: unknown[]): number;
declare function clearInterval(id: number): void;
declare function queueMicrotask(cb: () => void): void;

interface PxRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string | BinaryLike;
  /** 超时毫秒,默认 15000 */
  timeoutMs?: number;
}
interface PxResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly url: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** HTTP(S) 请求,固件侧基于 esp_http_client + 证书包 */
declare function fetch(url: string, init?: PxRequestInit): Promise<PxResponse>;

declare class WebSocket {
  constructor(url: string, protocols?: string | string[]);
  static readonly CONNECTING: 0;
  static readonly OPEN: 1;
  static readonly CLOSING: 2;
  static readonly CLOSED: 3;
  readonly readyState: 0 | 1 | 2 | 3;
  readonly url: string;
  /** 二进制消息一律以 ArrayBuffer 递交 */
  binaryType: 'arraybuffer';
  onopen: ((ev: { type: 'open' }) => void) | null;
  onmessage: ((ev: { type: 'message'; data: string | ArrayBuffer }) => void) | null;
  onclose: ((ev: { type: 'close'; code: number; reason: string }) => void) | null;
  onerror: ((ev: { type: 'error'; message: string }) => void) | null;
  send(data: string | BinaryLike): void;
  close(code?: number, reason?: string): void;
}

declare class TextEncoder {
  encode(input: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: 'utf-8');
  decode(input?: BinaryLike): string;
}
declare function atob(b64: string): string;
declare function btoa(raw: string): string;
declare var performance: { now(): number };

// ============================================================
// px 根命名空间
// ============================================================

declare const px: PixelBox;
/** px 的完整别名 */
declare const pixelbox: PixelBox;

interface PixelBox {
  readonly system: PxSystem;
  readonly app: PxApp;
  readonly storage: PxStorage;
  readonly screen: PxScreen;
  readonly input: PxInput;
  readonly audio: PxAudio;
  readonly voice: PxVoice;
  readonly wifi: PxWifi;
  readonly net: PxNet;
  readonly ble: PxBle;
  readonly camera: PxCamera;
  readonly gps: PxGps;
  readonly sensors: PxSensors;
  readonly led: PxLed;
  readonly util: PxUtil;
  readonly color: PxColorUtil;
}

// ------------------------------------------------------------
// system 系统
// ------------------------------------------------------------

interface PxDeviceInfo {
  /** 设备型号,如 "pixelbox-s3-v1" */
  model: string;
  /** 固件版本 semver */
  firmwareVersion: string;
  /** 芯片型号,如 "esp32s3" */
  chip: string;
  /** 唯一设备 ID (基于 MAC 派生) */
  deviceId: string;
  /** 屏幕分辨率 */
  screen: { width: number; height: number };
  /** 各硬件能力开关 */
  capabilities: {
    camera: boolean; gps: boolean; ble: boolean; led: boolean;
    imu: boolean; touch: boolean; battery: boolean; mic: boolean; speaker: boolean;
  };
}
interface PxMemoryInfo {
  /** 内部堆剩余字节 */
  heapFree: number;
  /** PSRAM 剩余字节 */
  psramFree: number;
  /** JS 引擎堆占用字节 */
  jsHeapUsed: number;
}
interface PxBatteryInfo {
  /** 电量百分比 0-100,无电池返回 -1 */
  level: number;
  charging: boolean;
  /** 电压 mV */
  voltageMv: number;
}
interface PxOtaProgress { phase: 'download' | 'write' | 'verify'; percent: number }

interface PxSystem {
  info(): PxDeviceInfo;
  memory(): PxMemoryInfo;
  battery(): PxBatteryInfo;
  /** 重启整机 */
  restart(): void;
  /** 深度睡眠;不传时长则需外部唤醒 */
  deepSleep(ms?: number): void;
  /** Unix 毫秒时间戳 */
  now(): number;
  /** 通过 NTP 同步时间 */
  ntpSync(server?: string): Promise<void>;
  /** 设置时区,如 "CST-8" (POSIX TZ 格式) */
  setTimezone(tz: string): void;
  /** 芯片温度 ℃ */
  temperature(): number;
  /** 固件 OTA:检查 manifest url,返回可用更新信息或 null */
  otaCheck(manifestUrl: string): Promise<{ version: string; url: string; notes?: string } | null>;
  /** 固件 OTA:下载并写入,成功后自动重启 */
  otaApply(firmwareUrl: string, onProgress?: (p: PxOtaProgress) => void): Promise<void>;
  on(event: 'lowBattery' | 'chargingChange', cb: (info: PxBatteryInfo) => void): Unsubscribe;
}

// ------------------------------------------------------------
// app 应用生命周期 (JS 应用包,支持热更新)
// ------------------------------------------------------------

interface PxApp {
  /** 当前应用 manifest 中的 name / id / version */
  readonly name: string;
  readonly id: string;
  readonly version: string;
  /** 读取应用包内只读资源 (相对 assets/ 路径) */
  readAsset(path: string): ArrayBuffer;
  readAssetText(path: string): string;
  /** 应用即将被停止/热更新替换时回调,用于收尾 */
  onExit(cb: () => void): Unsubscribe;
  /** 主动退出应用 (JS VM 停止,固件保持运行等待新包) */
  exit(): void;
}

// ------------------------------------------------------------
// storage 存储 (NVS 键值 + LittleFS 文件)
// ------------------------------------------------------------

interface PxFileStat { name: string; size: number; isDir: boolean; mtime: number }

interface PxStorage {
  kv: {
    get(key: string): string | null;
    getJSON<T = unknown>(key: string): T | null;
    set(key: string, value: string | number | boolean | object): void;
    remove(key: string): void;
    keys(): string[];
    clear(): void;
  };
  /** 可写目录挂载于 /data,应用只读包挂载于 /app */
  fs: {
    readText(path: string): string;
    readBytes(path: string): ArrayBuffer;
    writeText(path: string, data: string): void;
    writeBytes(path: string, data: BinaryLike): void;
    append(path: string, data: string | BinaryLike): void;
    exists(path: string): boolean;
    remove(path: string): void;
    mkdir(path: string): void;
    readDir(path: string): PxFileStat[];
    stat(path: string): PxFileStat | null;
  };
}

// ------------------------------------------------------------
// screen 屏幕 (AMOLED 368x448 RGB565,像素动画核心)
// ------------------------------------------------------------

interface PxTextStyle {
  color?: Color;
  /** 内置字体: 'pixel8'(8px ASCII) | 'pixel12'(12px 含常用中文) | 'pixel16' */
  font?: 'pixel8' | 'pixel12' | 'pixel16';
  /** 整数倍放大,默认 1 */
  scale?: number;
  /** 放大平滑 (Scale2x/3x 阶梯圆滑),默认 false;仅 2/3/4/6/8 倍生效。
   * 适合大号拉丁字母/简单形状;会侵蚀密集中文小字的笔画,中文勿开 */
  smooth?: boolean;
  align?: 'left' | 'center' | 'right';
}
interface PxDrawImageOpts {
  /** 目标宽高 (最近邻缩放,保像素风) */
  w?: number; h?: number;
  /** 源矩形裁剪 */
  sx?: number; sy?: number; sw?: number; sh?: number;
  /** 透明色键 (该颜色像素跳过绘制) */
  colorKey?: Color;
}

/** 离屏画布,与主屏拥有一致的绘图 API */
interface PxCanvas extends PxDrawTarget {
  readonly width: number;
  readonly height: number;
  /** 释放原生缓冲 */
  dispose(): void;
}

interface PxDrawTarget {
  clear(color?: Color): void;
  setPixel(x: number, y: number, color: Color): void;
  getPixel(x: number, y: number): Color;
  drawLine(x0: number, y0: number, x1: number, y1: number, color: Color): void;
  drawRect(x: number, y: number, w: number, h: number, color: Color): void;
  fillRect(x: number, y: number, w: number, h: number, color: Color): void;
  drawCircle(x: number, y: number, r: number, color: Color): void;
  fillCircle(x: number, y: number, r: number, color: Color): void;
  drawText(text: string, x: number, y: number, style?: PxTextStyle): void;
  /** 返回文本渲染宽高 */
  measureText(text: string, style?: PxTextStyle): { width: number; height: number };
  /** 绘制 PNG/JPEG 二进制、/app 或 /data 内图片路径、或另一画布 */
  drawImage(src: BinaryLike | string | PxCanvas, x: number, y: number, opts?: PxDrawImageOpts): void;
}

interface PxAnimation {
  play(): void;
  pause(): void;
  stop(): void;
  /** 跳到指定帧 */
  seek(frame: number): void;
  readonly playing: boolean;
  readonly frameCount: number;
  readonly currentFrame: number;
  /** 把当前帧画到目标 (默认主屏)，缩放和裁剪参数与 drawImage 一致 */
  draw(x: number, y: number, target?: PxDrawTarget, opts?: PxDrawImageOpts): void;
  onEnd(cb: () => void): Unsubscribe;
  dispose(): void;
}

interface PxGifLoadOpts {
  /** 仅清除每帧中与画布边界连通的背景区域 */
  removeBackground?: boolean;
  /** RGB 欧氏距离容差，默认 44 */
  backgroundThreshold?: number;
}

interface PxScreen extends PxDrawTarget {
  readonly width: number;
  readonly height: number;
  /** 亮度 0-100 */
  setBrightness(percent: number): void;
  getBrightness(): number;
  /** 屏幕电源 (AMOLED 熄屏省电) */
  setPower(on: boolean): void;
  setRotation(deg: 0 | 90 | 180 | 270): void;
  /** 手动提交帧缓冲到面板;在 onFrame 回调内绘制时会自动提交 */
  flush(): void;
  /**
   * 逐帧渲染回调 (类 requestAnimationFrame 的持续订阅版)。
   * dt 为与上一帧的间隔毫秒。回调返回后自动 flush。
   */
  onFrame(cb: (dt: number) => void): Unsubscribe;
  /** 目标帧率 1-60,默认 30 */
  setFps(fps: number): void;
  createCanvas(w: number, h: number): PxCanvas;
  /**
   * 创建帧动画:frames 为图片路径/二进制/画布数组,或雪碧图 { sheet, frameW, frameH }
   */
  createAnimation(opts: {
    frames: Array<string | BinaryLike | PxCanvas> | { sheet: string | BinaryLike; frameW: number; frameH: number };
    fps?: number;
    loop?: boolean;
  }): PxAnimation;
  /** 加载 GIF 为动画对象 */
  loadGif(src: string | BinaryLike, opts?: PxGifLoadOpts): PxAnimation;
}

// ------------------------------------------------------------
// input 输入 (触摸 + 按键)
// ------------------------------------------------------------

interface PxTouchEvent { type: 'down' | 'move' | 'up'; x: number; y: number }
interface PxButtonEvent {
  /** 'boot' BOOT 键(物理键1) | 'power' 电源键(物理键2,经 PMU 轮询) | 'user' 用户键(物理键3);
   * 数字为扩展按键编号。三键同时承担系统动作(键1 设置页/键2 应用页·长按清应用/
   * 键3 息屏·关机),应用仍可监听 */
  id: 'boot' | 'user' | 'power' | number;
  type: 'down' | 'up' | 'click' | 'doubleClick' | 'longPress';
}
interface PxGestureEvent { dir: 'left' | 'right' | 'up' | 'down'; distance: number }

interface PxInput {
  onTouch(cb: (ev: PxTouchEvent) => void): Unsubscribe;
  onButton(cb: (ev: PxButtonEvent) => void): Unsubscribe;
  /** 基于触摸合成的滑动手势 */
  onGesture(cb: (ev: PxGestureEvent) => void): Unsubscribe;
}

// ------------------------------------------------------------
// audio 音频 (ES8311 codec: 麦克风 + 扬声器)
// ------------------------------------------------------------

interface PxMicOptions {
  /** 采样率,默认 16000 */
  sampleRate?: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  /** 每次回调的帧长毫秒,默认 32 */
  frameMs?: number;
  /** PCM16LE 单声道数据回调 */
  onData: (pcm: ArrayBuffer) => void;
}
interface PxPlayHandle {
  stop(): void;
  pause(): void;
  resume(): void;
  readonly playing: boolean;
  onEnded(cb: () => void): Unsubscribe;
}

interface PxAudio {
  /** 扬声器音量 0-100 */
  setVolume(percent: number): void;
  getVolume(): number;
  mic: {
    start(opts: PxMicOptions): void;
    stop(): void;
    readonly active: boolean;
    /** 麦克风增益 0-100 */
    setGain(percent: number): void;
  };
  player: {
    /** 播放 /app、/data 路径或 http(s) URL 的 wav/mp3 */
    play(src: string): Promise<PxPlayHandle>;
    /** 播放原始 PCM16LE */
    playPcm(pcm: BinaryLike, opts?: { sampleRate?: number; channels?: 1 | 2 }): PxPlayHandle;
    /** 流式 PCM 播放:先 open 再不断 feed (用于 TTS 流) */
    openPcmStream(opts?: { sampleRate?: number; channels?: 1 | 2 }): {
      feed(pcm: BinaryLike): void;
      /** 声明流结束,播完触发 onEnded */
      end(): void;
      stop(): void;
      onEnded(cb: () => void): Unsubscribe;
      /** 当前缓冲的毫秒数 */
      buffered(): number;
    };
    /** 蜂鸣 */
    tone(freqHz: number, durationMs: number, volume?: number): void;
    stopAll(): void;
    readonly playing: boolean;
  };
  /** 录音到文件 (wav),返回实际时长毫秒 */
  record(path: string, opts?: { maxMs?: number; sampleRate?: number }): Promise<number>;
}

// ------------------------------------------------------------
// voice 语音对话 (设备 <-> 中继服务器 <-> STT/LLM/TTS)
// ------------------------------------------------------------

type PxVoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

interface PxVoiceEvents {
  /** 状态机变化 */
  stateChange: (state: PxVoiceState) => void;
  /** 唤醒词触发 (若启用) */
  wake: () => void;
  /** VAD 检测到开始/结束说话 */
  speechStart: () => void;
  speechEnd: () => void;
  /** 用户语音的最终识别文本 */
  userText: (text: string) => void;
  /** LLM 流式增量文本 */
  assistantDelta: (delta: string) => void;
  /** LLM 完整回复文本 */
  assistantText: (text: string) => void;
  /** 麦克风实时音量 0-100 (用于 UI 律动) */
  level: (level: number) => void;
  error: (message: string) => void;
}

interface PxVoice {
  /** 配置中继服务器 (协议见 docs/architecture.md) */
  configure(opts: {
    serverUrl: string;
    token?: string;
    /** 是否启用本地唤醒词 (需固件编译开启 esp-sr) */
    wakeword?: boolean;
    /** VAD 静音判定毫秒,默认 800 */
    vadSilenceMs?: number;
  }): void;
  /** 开始一轮拾音对话 (听 -> 想 -> 说),完成后回到 idle */
  start(): void;
  /** 持续对话模式:说完自动再听 */
  startContinuous(): void;
  stop(): void;
  /** 打断当前 TTS 播报 */
  interrupt(): void;
  /** 直接发送文本走 LLM+TTS (不拾音) */
  sendText(text: string): void;
  /** 文本转语音播报 (经服务器 TTS) */
  say(text: string): Promise<void>;
  state(): PxVoiceState;
  on<K extends keyof PxVoiceEvents>(event: K, cb: PxVoiceEvents[K]): Unsubscribe;
}

// ------------------------------------------------------------
// wifi
// ------------------------------------------------------------

interface PxWifiAp { ssid: string; rssi: number; secure: boolean; channel: number }
interface PxWifiStatus {
  connected: boolean;
  ssid: string | null;
  ip: string | null;
  rssi: number;
  mac: string;
}

interface PxWifi {
  scan(): Promise<PxWifiAp[]>;
  /** 连接并等待拿到 IP;凭据在连接验证成功后持久化 (误输密码不覆盖已存凭据),开机自动重连 */
  connect(ssid: string, password?: string, opts?: { timeoutMs?: number; save?: boolean }): Promise<PxWifiStatus>;
  disconnect(): void;
  status(): PxWifiStatus;
  on(event: 'connected' | 'disconnected' | 'gotIp', cb: (st: PxWifiStatus) => void): Unsubscribe;
  /** 开启 SoftAP (配网/调试) */
  startAP(ssid: string, password?: string): void;
  stopAP(): void;
}

// ------------------------------------------------------------
// net 网络 (TCP/UDP/mDNS;HTTP 用全局 fetch,WS 用全局 WebSocket)
// ------------------------------------------------------------

interface PxTcpSocket {
  send(data: string | BinaryLike): void;
  close(): void;
  readonly connected: boolean;
  readonly remoteHost: string;
  readonly remotePort: number;
  onData(cb: (data: ArrayBuffer) => void): Unsubscribe;
  onClose(cb: () => void): Unsubscribe;
  onError(cb: (message: string) => void): Unsubscribe;
}
interface PxTcpServer {
  readonly port: number;
  close(): void;
}
interface PxUdpSocket {
  send(data: string | BinaryLike, host: string, port: number): void;
  onMessage(cb: (msg: { data: ArrayBuffer; host: string; port: number }) => void): Unsubscribe;
  close(): void;
}
interface PxMdnsService { name: string; host: string; ip: string; port: number; txt: Record<string, string> }

interface PxNet {
  connectTcp(opts: { host: string; port: number; tls?: boolean; timeoutMs?: number }): Promise<PxTcpSocket>;
  listenTcp(opts: { port: number; onConnection: (sock: PxTcpSocket) => void }): PxTcpServer;
  createUdp(opts?: { bindPort?: number }): PxUdpSocket;
  mdns: {
    /** 发现局域网服务,如 "_pixelbox._tcp" */
    discover(service: string, opts?: { timeoutMs?: number }): Promise<PxMdnsService[]>;
    /** 注册本机服务广播 */
    advertise(opts: { name: string; service: string; port: number; txt?: Record<string, string> }): Unsubscribe;
  };
  hostname(): string;
}

// ------------------------------------------------------------
// ble 蓝牙 (NimBLE)
// ------------------------------------------------------------

interface PxBleCharacteristicDef {
  uuid: string;
  properties: Array<'read' | 'write' | 'notify'>;
  value?: BinaryLike;
  onWrite?: (data: ArrayBuffer) => void;
  onRead?: () => BinaryLike;
}
interface PxBleScanResult { id: string; name: string | null; rssi: number; manufacturerData: ArrayBuffer | null }
interface PxBleConnection {
  services(): Promise<Array<{ uuid: string; characteristics: Array<{ uuid: string; properties: string[] }> }>>;
  read(serviceUuid: string, charUuid: string): Promise<ArrayBuffer>;
  write(serviceUuid: string, charUuid: string, data: BinaryLike, opts?: { withResponse?: boolean }): Promise<void>;
  subscribe(serviceUuid: string, charUuid: string, cb: (data: ArrayBuffer) => void): Promise<Unsubscribe>;
  disconnect(): Promise<void>;
  onDisconnect(cb: () => void): Unsubscribe;
}

interface PxBle {
  available(): boolean;
  peripheral: {
    /** 以外设身份广播 GATT 服务 */
    start(opts: { name: string; services: Array<{ uuid: string; characteristics: PxBleCharacteristicDef[] }> }): void;
    notify(serviceUuid: string, charUuid: string, data: BinaryLike): void;
    stop(): void;
    onConnect(cb: (centralId: string) => void): Unsubscribe;
    onDisconnect(cb: (centralId: string) => void): Unsubscribe;
  };
  central: {
    scan(opts?: { timeoutMs?: number; onDevice?: (dev: PxBleScanResult) => void }): Promise<PxBleScanResult[]>;
    stopScan(): void;
    connect(deviceId: string, opts?: { timeoutMs?: number }): Promise<PxBleConnection>;
  };
}

// ------------------------------------------------------------
// camera 摄像头 (OV2640 DVP,定制板可选)
// ------------------------------------------------------------

interface PxCamera {
  available(): boolean;
  init(opts?: {
    resolution?: 'QQVGA' | 'QVGA' | 'VGA' | 'SVGA' | 'XGA' | '720P';
    /** JPEG 质量 1-63,越小越清晰 */
    quality?: number;
    format?: 'jpeg' | 'rgb565';
  }): Promise<void>;
  /** 拍一帧 (jpeg 二进制) */
  capture(): Promise<ArrayBuffer>;
  startStream(opts: { fps?: number; onFrame: (frame: ArrayBuffer) => void }): void;
  stopStream(): void;
  deinit(): void;
}

// ------------------------------------------------------------
// gps 定位 (UART NMEA 模块,定制板可选)
// ------------------------------------------------------------

interface PxGpsFix {
  lat: number; lng: number;
  altitudeM: number;
  speedMps: number;
  course: number;
  satellites: number;
  hdop: number;
  /** Unix 毫秒 */
  timestamp: number;
}

interface PxGps {
  available(): boolean;
  start(opts: { intervalMs?: number; onFix: (fix: PxGpsFix) => void; onStatus?: (s: 'searching' | 'fixed' | 'lost') => void }): void;
  stop(): void;
  last(): PxGpsFix | null;
}

// ------------------------------------------------------------
// sensors 传感器 (IMU QMI8658 等)
// ------------------------------------------------------------

interface PxImuData { ax: number; ay: number; az: number; gx: number; gy: number; gz: number }

interface PxSensors {
  imu: {
    available(): boolean;
    start(opts: { rateHz?: number; onData: (d: PxImuData) => void }): void;
    stop(): void;
    onShake(cb: () => void): Unsubscribe;
    /** 设备被翻转/立起等姿态变化 */
    onOrientation(cb: (o: 'up' | 'down' | 'left' | 'right' | 'flat' | 'faceDown') => void): Unsubscribe;
  };
}

// ------------------------------------------------------------
// led 灯带 (WS2812,定制板可选)
// ------------------------------------------------------------

interface PxLed {
  available(): boolean;
  readonly count: number;
  setBrightness(percent: number): void;
  set(index: number, color: Color): void;
  fill(color: Color): void;
  clear(): void;
  /** 提交到灯带 */
  show(): void;
}

// ------------------------------------------------------------
// util / color 工具
// ------------------------------------------------------------

interface PxUtil {
  b64encode(data: BinaryLike): string;
  b64decode(b64: string): ArrayBuffer;
  hexEncode(data: BinaryLike): string;
  hexDecode(hex: string): ArrayBuffer;
  crc32(data: BinaryLike): number;
  sha256(data: BinaryLike | string): ArrayBuffer;
  /** 随机字节 */
  randomBytes(len: number): ArrayBuffer;
  uuid(): string;
}

interface PxColorUtil {
  rgb(r: number, g: number, b: number): Color;
  /** h 0-360, s/v 0-100 */
  hsv(h: number, s: number, v: number): Color;
  /** 两色线性插值,t 0-1 */
  lerp(a: Color, b: Color, t: number): Color;
  readonly BLACK: Color; readonly WHITE: Color; readonly RED: Color;
  readonly GREEN: Color; readonly BLUE: Color; readonly YELLOW: Color;
  readonly CYAN: Color; readonly MAGENTA: Color; readonly ORANGE: Color; readonly GRAY: Color;
}
