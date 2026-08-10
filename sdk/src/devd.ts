/**
 * DevdClient — devd 开发服务协议客户端(库导出,CLI / 模拟器 / 第三方工具共用)
 *
 * 能力:
 *   - 请求/响应关联(id 递增 + 超时)
 *   - 主动事件分发(log / app.state)
 *   - 应用推送: hello → app.push_begin(files 含 sha256)→ app.push_chunk(32KB/块 base64)→ app.push_end
 *   - js.eval / logs.subscribe / logs.unsubscribe / app.restart / app.stop
 */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import {
  DEVD_DEFAULT_PORT,
  DEVD_WS_PATH,
  PUSH_CHUNK_SIZE,
  type DevdHelloResult,
  type DevdRequestFrame,
  type PixelboxManifest,
  type PushFileEntry,
} from './protocol';

/** 设备返回的协议错误({id, error:{code, message}}) */
export class DevdError extends Error {
  /** 协议错误码 */
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'DevdError';
    this.code = code;
  }
}

/** 连接选项 */
export interface DevdClientOptions {
  /** devd 端口,默认 8765 */
  port?: number;
  /** 连接握手超时毫秒,默认 6000 */
  connectTimeoutMs?: number;
}

/** 待推送文件(内存内容形式) */
export interface PushFile {
  /** 应用包内相对路径(POSIX 风格) */
  path: string;
  /** 文件内容 */
  data: Buffer;
}

/** 推送进度回调数据 */
export interface PushProgress {
  /** begin: 会话建立;file: 分块上传中;end: 校验切换完成 */
  phase: 'begin' | 'file' | 'end';
  /** 当前文件路径(phase = file 时) */
  file?: string;
  /** 当前文件序号(从 0 开始) */
  fileIndex?: number;
  /** 文件总数 */
  fileCount?: number;
  /** 已发送字节数 */
  sentBytes: number;
  /** 总字节数 */
  totalBytes: number;
}

/** 事件回调:event 为事件名(log / app.state / ...),data 为事件数据 */
export type DevdEventHandler = (event: string, data: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class DevdClient {
  /** 设备主机(IP 或 mDNS 主机名) */
  readonly host: string;
  /** devd 端口 */
  readonly port: number;

  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Set<DevdEventHandler>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private closed = false;

  private constructor(ws: WebSocket, host: string, port: number) {
    this.ws = ws;
    this.host = host;
    this.port = port;
    ws.on('message', (raw) => {
      this.handleMessage(typeof raw === 'string' ? raw : raw.toString());
    });
    ws.on('close', (code) => {
      this.handleClose(`连接关闭 (code=${code})`);
    });
    ws.on('error', (err) => {
      this.handleClose(`连接错误: ${err.message}`);
    });
  }

  /** 连接设备 devd 服务(ws://host:port/devd) */
  static connect(host: string, opts: DevdClientOptions = {}): Promise<DevdClient> {
    const port = opts.port ?? DEVD_DEFAULT_PORT;
    const timeoutMs = opts.connectTimeoutMs ?? 6000;
    const url = `ws://${host}:${port}${DEVD_WS_PATH}`;
    return new Promise<DevdClient>((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      ws.once('open', () => {
        resolve(new DevdClient(ws, host, port));
      });
      ws.once('error', (err) => {
        reject(new Error(`无法连接 ${url}: ${err.message}`));
      });
    });
  }

  /** 连接是否已关闭 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 发送一次请求并等待响应 */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('devd 连接已关闭'));
    }
    const id = this.nextId++;
    const frame: DevdRequestFrame = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`devd 请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify(frame), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`devd 发送失败: ${err.message}`));
        }
      });
    });
  }

  /** 订阅设备主动事件(log / app.state),返回取消订阅函数 */
  onEvent(handler: DevdEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** 订阅连接关闭,返回取消订阅函数 */
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** 主动关闭连接 */
  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.ws.close();
    } catch {
      /* 忽略关闭异常 */
    }
    // 立即进入关闭态,不等 close 事件回环
    this.handleClose('本地主动关闭');
  }

  // ---------- 高层协议方法 ----------

  /** hello:握手并获取设备信息 */
  hello(): Promise<DevdHelloResult> {
    return this.request<DevdHelloResult>('hello', {}, 8000);
  }

  /** js.eval:在设备 JS VM 中执行代码,返回字符串化结果 */
  async evalJs(code: string, timeoutMs = 15000): Promise<string> {
    const res = await this.request<{ result: string }>('js.eval', { code }, timeoutMs);
    return res.result;
  }

  /**
   * logs.subscribe:订阅日志广播(日志经 onEvent 以 "log" 事件到达)
   * @param since 只回放 seq > since 的历史(断线重连增量续传;0 = 全量)
   * @returns last_seq 设备当前最大日志 seq;boot 每次开机随机标识——
   *          boot 变化(或兜底 last_seq 小于本地已见 seq)说明设备已重启,
   *          应以 since=0 重新订阅;老固件无这两个字段。
   *          回放与实时广播可能交叠送重复行,调用方按事件 data.seq 去重。
   */
  async subscribeLogs(since = 0): Promise<{ ok: boolean; last_seq?: number; boot?: number }> {
    return await this.request<{ ok: boolean; last_seq?: number; boot?: number }>(
      'logs.subscribe',
      { since },
      8000,
    );
  }

  /** logs.unsubscribe:取消日志订阅 */
  async unsubscribeLogs(): Promise<void> {
    await this.request('logs.unsubscribe', {}, 8000);
  }

  /** app.restart:重启当前应用(仅重启 JS VM) */
  async restartApp(): Promise<void> {
    await this.request('app.restart', {}, 15000);
  }

  /** app.stop:停止当前应用 */
  async stopApp(): Promise<void> {
    await this.request('app.stop', {}, 15000);
  }

  /**
   * 推送应用包(热更新):
   *   push_begin(manifest + 文件清单含 sha256)→ 逐文件 32KB 分块 push_chunk → push_end
   * push_end 成功即表示设备校验通过、原子切换并热重启 JS VM。
   */
  async pushApp(
    manifest: PixelboxManifest,
    files: PushFile[],
    onProgress?: (p: PushProgress) => void,
  ): Promise<void> {
    if (files.length === 0) {
      throw new Error('推送文件列表为空,请先执行构建');
    }
    const entries: PushFileEntry[] = files.map((f) => ({
      path: f.path,
      size: f.data.length,
      sha256: createHash('sha256').update(f.data).digest('hex'),
    }));
    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    onProgress?.({ phase: 'begin', sentBytes: 0, totalBytes });

    const begin = await this.request<{ session: string }>(
      'app.push_begin',
      { manifest, files: entries },
      20000,
    );
    const session = begin.session;

    let sentBytes = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // 空文件无需分块,设备已从 push_begin 得知其 size=0
      for (let offset = 0; offset < file.data.length; offset += PUSH_CHUNK_SIZE) {
        const chunk = file.data.subarray(offset, offset + PUSH_CHUNK_SIZE);
        await this.request<{ received: number }>(
          'app.push_chunk',
          { session, path: file.path, offset, dataB64: chunk.toString('base64') },
          20000,
        );
        sentBytes += chunk.length;
        onProgress?.({
          phase: 'file',
          file: file.path,
          fileIndex: i,
          fileCount: files.length,
          sentBytes,
          totalBytes,
        });
      }
    }

    // push_end 触发设备端校验 + 原子切换 + 热重启 VM,给足超时
    await this.request<{ ok: boolean }>('app.push_end', { session }, 60000);
    onProgress?.({ phase: 'end', sentBytes, totalBytes });
  }

  // ---------- 内部 ----------

  private handleMessage(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // 忽略非 JSON 帧
    }
    if (typeof frame !== 'object' || frame === null) {
      return;
    }
    const obj = frame as Record<string, unknown>;

    // 响应帧:{id, result} 或 {id, error}
    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (!pending) {
        return;
      }
      this.pending.delete(obj.id);
      clearTimeout(pending.timer);
      if (obj.error && typeof obj.error === 'object') {
        const err = obj.error as { code?: number; message?: string };
        pending.reject(new DevdError(err.code ?? -1, err.message ?? '设备返回未知错误'));
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    // 事件帧:{event, data}
    if (typeof obj.event === 'string') {
      for (const handler of this.eventHandlers) {
        try {
          handler(obj.event, obj.data);
        } catch {
          /* 用户回调异常不影响客户端本体 */
        }
      }
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`devd 连接断开: ${reason}`));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler(reason);
      } catch {
        /* 忽略回调异常 */
      }
    }
  }
}
