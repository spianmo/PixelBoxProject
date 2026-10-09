#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', '05-electronic-perler', 'assets');
const routes = [
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
];

function usage() {
  console.error('用法: node examples/scripts/check-electronic-perler-http.mjs http://<设备IP>:8080 [轮数]');
  process.exit(2);
}

if (!process.argv[2]) usage();
const url = new URL(process.argv[2]);
const rounds = Number(process.argv[3] ?? 5);
if (url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash ||
    !Number.isInteger(rounds) || rounds < 1 || rounds > 100) usage();

function request(path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) });
    socket.setTimeout(35000, () => socket.destroy(new Error('35 秒内未收到完整响应')));
    socket.once('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAccept-Encoding: identity\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > 2 * 1024 * 1024) socket.destroy(new Error('响应超过 2 MiB'));
    });
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('error', reject);
    socket.once('close', (hadError) => {
      if (!hadError && !socket.readableEnded) reject(new Error('响应尚未结束，连接已关闭'));
    });
  });
}

function inspect(raw, expected) {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw new Error(`HTTP 响应头不完整，收到 ${raw.length} 字节`);
  const lines = raw.subarray(0, end).toString('latin1').split('\r\n');
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(lines.shift() ?? '')) throw new Error('HTTP 状态不是 200');
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`无效响应头: ${line}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
  }
  const lengths = headers.get('content-length') ?? [];
  if (lengths.length !== 1 || !/^\d+$/.test(lengths[0])) throw new Error('Content-Length 缺失、重复或无效');
  if (headers.has('transfer-encoding') || headers.has('content-encoding')) {
    throw new Error('响应使用了未预期的传输或内容编码');
  }
  const declared = Number(lengths[0]);
  const body = raw.subarray(end + 4);
  const actual = body.length;
  if (declared !== actual) throw new Error(`Content-Length=${declared}，实际响应体=${actual}`);
  if (!body.equals(expected)) {
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    throw new Error(`响应体与本地资源不同：设备 SHA-256=${sha(body)}，本地 SHA-256=${sha(expected)}`);
  }
  return actual;
}

let checked = 0;
for (let round = 1; round <= rounds; round++) {
  for (const [path, file] of routes) {
    const expected = readFileSync(join(assets, file));
    try {
      const bytes = inspect(await request(path), expected);
      checked++;
      console.log(`[OK] 第 ${round}/${rounds} 轮 ${path}: ${bytes} 字节`);
    } catch (error) {
      console.error(`[FAIL] 第 ${round}/${rounds} 轮 ${path}: ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode) break;
}
if (!process.exitCode) console.log(`[OK] ${checked} 次请求的长度和响应体均正确`);
