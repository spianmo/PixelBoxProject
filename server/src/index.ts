/**
 * PixelBox 语音中继服务器入口。
 * - HTTP: GET /healthz 健康检查
 * - WS  : /realtime?token=xxx(协议见 docs/architecture.md §7)
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config, reportConfig } from './config.js';
import { Session } from './session.js';
import { log, logWarn } from './util.js';

const startedAt = Date.now();
let nextId = 1;
const sessions = new Set<Session>();

// ---------------- HTTP(健康检查) ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        sessions: sessions.size,
        models: {
          stt: config.stt.model,
          llm: config.llm.model,
          tts: config.tts.model,
        },
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('PixelBox voice relay: WS /realtime, GET /healthz');
});

// ---------------- WebSocket(/realtime) ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/realtime') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (config.token !== '' && url.searchParams.get('token') !== config.token) {
    logWarn('server', `拒绝连接(token 校验失败): ${req.socket.remoteAddress ?? '?'}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

wss.on('connection', (ws: AliveWebSocket) => {
  const session = new Session(ws, String(nextId++));
  sessions.add(session);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => {
    sessions.delete(session);
  });
});

// 心跳保活:30s 未响应 pong 的连接直接断开
const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<AliveWebSocket>) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000);

// ---------------- 启动与退出 ----------------
reportConfig();
server.listen(config.port, () => {
  log('server', `语音中继已启动: ws://0.0.0.0:${config.port}/realtime  (健康检查 GET /healthz)`);
});

function shutdown(): void {
  log('server', '正在退出...');
  clearInterval(heartbeat);
  for (const s of sessions) s.dispose();
  wss.close();
  server.close(() => process.exit(0));
  // 兜底 2s 强退
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
