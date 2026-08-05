/**
 * devd 开发服务协议 — 常量与类型定义
 *
 * 与 docs/architecture.md §5 逐条对齐:
 *   - 传输: ws://<device-ip>:8765/devd,文本帧 JSON
 *   - 请求: { id, method, params }
 *   - 响应: { id, result } 或 { id, error: { code, message } }
 *   - 主动事件: { event, data }
 *   - 发现: mDNS `_pixelbox._tcp`,port 8765,TXT: model / fw / app
 */

/** devd 默认监听端口 */
export const DEVD_DEFAULT_PORT = 8765;
/** devd WebSocket 路径 */
export const DEVD_WS_PATH = '/devd';
/** app.push_chunk 单块原始数据上限(32KB,base64 编码前) */
export const PUSH_CHUNK_SIZE = 32 * 1024;
/** mDNS 服务类型(bonjour-service 写法,对应 _pixelbox._tcp) */
export const MDNS_SERVICE_TYPE = 'pixelbox';

/** 请求帧 */
export interface DevdRequestFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** 响应帧(result 与 error 二选一) */
export interface DevdResultFrame {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 设备主动事件帧 */
export interface DevdEventFrame {
  event: string;
  data: unknown;
}

/** hello 方法返回的设备信息 */
export interface DevdHelloResult {
  name: string;
  model: string;
  fw: string;
  app: string;
  appVersion: string;
  ip: string;
  mac: string;
  heapFree: number;
}

/** 应用 manifest(pixelbox.json,见 architecture.md §6) */
export interface PixelboxManifest {
  /** 应用 ID,反向域名风格,如 "com.example.pixelclock" */
  id: string;
  /** 应用显示名称 */
  name: string;
  /** semver 版本号 */
  version: string;
  /** 入口文件(dist 内相对路径),默认 "main.js" */
  entry: string;
  /** 资源 glob 列表,如 ["assets/**"] */
  assets?: string[];
  /** 最低固件版本要求 */
  minFirmware?: string;
}

/** app.push_begin 中的文件描述 */
export interface PushFileEntry {
  /** 应用包内相对路径(POSIX 风格),如 "main.js"、"assets/icon.png" */
  path: string;
  /** 文件字节数 */
  size: number;
  /** 文件内容 SHA-256(hex 小写) */
  sha256: string;
}

/** log 事件级别 */
export type DevdLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** log 事件数据(console.* 与 ESP_LOG 均转发) */
export interface DevdLogData {
  level: DevdLogLevel | string;
  tag: string;
  msg: string;
  /** Unix 毫秒或设备开机毫秒 */
  ts: number;
}

/** app.state 事件的应用状态 */
export type DevdAppState = 'running' | 'stopped' | 'updating' | 'crashed';

/** app.state 事件数据 */
export interface DevdAppStateData {
  state: DevdAppState;
  error?: string;
}
