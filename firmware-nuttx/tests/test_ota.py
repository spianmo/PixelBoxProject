#!/usr/bin/env python3
"""通过主 prelude、真实 QuickJS 与本机 TCP/HTTP 验证只读 OTA 查询。"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit
import unittest


EXECUTABLE = Path(sys.argv.pop(1)).resolve()
ASSERTIONS = """
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
async function rejects(call, pattern) {
  try { await call(); } catch (error) { assert(pattern.test(error.message), error.message); return error; }
  throw new Error('expected rejection');
}
"""


class OtaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not EXECUTABLE.is_file():
            raise FileNotFoundError("build the host QuickJS runtime first: " + str(EXECUTABLE))
        cls.temporary = tempfile.TemporaryDirectory(prefix="pixelbox-ota-quickjs-")
        cls.root = Path(cls.temporary.name)
        # 固定当前 host 可执行文件，避免与主构建输出并行替换产生测试歧义。
        cls.executable = cls.root / "pixelbox"
        shutil.copy2(EXECUTABLE, cls.executable)
        cls.app, cls.data = cls.root / "app", cls.root / "data"
        cls.app.mkdir(); cls.data.mkdir()
        (cls.app / "manifest.json").write_text(json.dumps({"id": "test.ota", "name": "OTA fixture", "version": "1.0.0"}))
        cls.closed = {"timeout": threading.Event(), "exit": threading.Event()}
        cls.connected = {"timeout": threading.Event(), "exit": threading.Event()}

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: object) -> None:
                pass

            def reply(self, status: int, body: bytes, **headers: str) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                if body:
                    self.wfile.write(body)
                self.close_connection = True

            def do_GET(self) -> None:
                address = urlsplit(self.path)
                query = parse_qs(address.query, keep_blank_values=True)
                if address.path == "/manifest":
                    result = {"version": query.get("version", ["2.0.0"])[0],
                              "url": "https://firmware.invalid/update.bin"}
                    if "notes" in query:
                        result["notes"] = query["notes"][0]
                    self.reply(200, json.dumps(result, ensure_ascii=False).encode())
                elif address.path.startswith("/status/"):
                    self.reply(int(address.path.rsplit("/", 1)[1]), b"not JSON")
                elif address.path == "/bad-json":
                    self.reply(200, b'{"version":')
                elif address.path == "/missing":
                    self.reply(200, b'{"version":"2.0.0"}')
                elif address.path == "/disconnect":
                    # 已建立连接但不返回任何 HTTP 数据，确定性覆盖传输失败。
                    self.close_connection = True
                elif address.path == "/redirect":
                    self.reply(302, b"", Location="/manifest?version=v2.1.0&notes=redirected")
                elif address.path == "/chunked":
                    body = json.dumps({"version": "V2.0.0", "url": "https://firmware.invalid/update.bin",
                                       "notes": "中文更新说明"}, ensure_ascii=False).encode()
                    self.send_response(200)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    # UTF-8 多字节字符横跨 HTTP chunk，验证实际 TextDecoder/HTTP 接线。
                    for offset in range(0, len(body), 5):
                        piece = body[offset:offset + 5]
                        self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    self.close_connection = True
                elif address.path == "/slow-redirect":
                    time.sleep(1.25)
                    self.reply(302, b"", Location="/hang/timeout")
                elif address.path.startswith("/hang/"):
                    name = address.path.rsplit("/", 1)[1]
                    cls.connected[name].set()
                    self.connection.settimeout(12)
                    try:
                        if self.connection.recv(1) == b"":
                            cls.closed[name].set()
                    except ConnectionResetError:
                        cls.closed[name].set()
                    except socket.timeout:
                        pass
                    self.close_connection = True
                else:
                    self.reply(404, b"missing")

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temporary.cleanup()

    def run_js(self, code: str, *, timeout_ms: int = 4000) -> subprocess.CompletedProcess[str]:
        entry = self.root / "ota-entry.js"
        # 直接调用主 prelude 的公开 API，避免手动注入片段掩盖漏接线和版本源漂移。
        loader = """
const firmwareVersion = px.system.info().firmwareVersion;
assert(typeof firmwareVersion === 'string' && /^\\d+\\.\\d+\\.\\d+$/.test(firmwareVersion));
px.system.info = () => { throw new Error('OTA must not probe hardware through info'); };
"""
        entry.write_text(ASSERTIONS + loader + "\nconst base = " + json.dumps(self.base) + ";\n" + code)
        result = subprocess.run([str(self.executable), "--app-root", str(self.app), "--data-root", str(self.data),
                                 "--timeout-ms", str(timeout_ms), str(entry)],
                                text=True, capture_output=True, timeout=timeout_ms / 1000 + 5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OTA_TEST_DONE", result.stdout, result.stdout + result.stderr)
        return result

    def test_real_http_versions_and_optional_notes(self) -> None:
        self.run_js("""
        (async () => {
          let synchronous = false;
          try { px.system.otaCheck(); } catch (error) { synchronous = true; equal(error.message, 'otaCheck(manifestUrl) 缺少 URL'); }
          assert(synchronous);
          for (const version of [firmwareVersion, 'V' + firmwareVersion, '0.0.0',
            firmwareVersion + '-rc.1', firmwareVersion + '.9'])
            equal(await px.system.otaCheck(base + '/manifest?version=' + version), null);
          equal(await px.system.otaCheck(base + '/manifest?version=v2.0.0'),
            {version:'v2.0.0',url:'https://firmware.invalid/update.bin'});
          equal(await px.system.otaCheck(base + '/manifest?version=V2.0.0&notes='),
            {version:'V2.0.0',url:'https://firmware.invalid/update.bin'});
          equal(await px.system.otaCheck(base + '/manifest?notes=release'),
            {version:'2.0.0',url:'https://firmware.invalid/update.bin',notes:'release'});
          console.log('OTA_TEST_DONE');
        })();
        """)

    def test_real_http_status_json_and_missing_fields(self) -> None:
        self.run_js("""
        (async () => {
          for (const status of [201, 204, 404, 500]) {
            const error = await rejects(() => px.system.otaCheck(base + '/status/' + status), /OTA manifest 获取失败/);
            equal(error.message, 'OTA manifest 获取失败: HTTP ' + status);
          }
          const syntax = await rejects(() => px.system.otaCheck(base + '/bad-json'), /./);
          equal(syntax.name, 'SyntaxError');
          await rejects(() => px.system.otaCheck(base + '/missing'), /manifest 缺少 version\\/url 字段/);
          await rejects(() => px.system.otaCheck('file:///not-a-url'), /OTA manifest 获取失败/);
          console.log('OTA_TEST_DONE');
        })();
        """)

    def test_real_http_redirect_chunked_and_concurrency(self) -> None:
        self.run_js("""
        (async () => {
          const results = await Promise.all([
            px.system.otaCheck(base + '/redirect'),
            px.system.otaCheck(base + '/chunked'),
            px.system.otaCheck(base + '/manifest?version=0.0.0')
          ]);
          equal(results, [
            {version:'v2.1.0',url:'https://firmware.invalid/update.bin',notes:'redirected'},
            {version:'V2.0.0',url:'https://firmware.invalid/update.bin',notes:'中文更新说明'}, null
          ]);
          console.log('OTA_TEST_DONE');
        })();
        """)

    def test_real_connection_failure(self) -> None:
        self.run_js("""
        (async () => {
          await rejects(() => px.system.otaCheck(base + '/disconnect'), /OTA manifest 获取失败: truncated HTTP response/);
          console.log('OTA_TEST_DONE');
        })();
        """)

    def test_real_ten_second_deadline_spans_redirect_and_closes_socket(self) -> None:
        self.closed["timeout"].clear(); self.connected["timeout"].clear()
        started = time.monotonic()
        result = self.run_js("""
        (async () => {
          const start = performance.now();
          const error = await rejects(() => px.system.otaCheck(base + '/slow-redirect'), /ETIMEDOUT/);
          equal(error.message, 'OTA manifest 获取失败: ETIMEDOUT: HTTP request');
          const elapsed = performance.now() - start;
          assert(elapsed >= 9500 && elapsed < 10500, 'deadline exceeded: ' + elapsed);
          console.log('OTA_TIMEOUT_MS=' + elapsed);
          console.log('OTA_TEST_DONE');
        })();
        """, timeout_ms=13000)
        self.assertLess(time.monotonic() - started, 13, result.stdout + result.stderr)
        self.assertTrue(self.connected["timeout"].is_set(), "redirect target did not connect")
        self.assertTrue(self.closed["timeout"].wait(1), "deadline did not close the real TCP connection")
        print(result.stdout.strip())

    def test_real_application_exit_closes_connection_and_rejects_query(self) -> None:
        self.closed["exit"].clear(); self.connected["exit"].clear()
        self.run_js("""
        const pending = rejects(() => px.system.otaCheck(base + '/hang/exit'), /ECANCELED: application exited/);
        setTimeout(() => {
          __pxRunExit();
          pending.then(async () => {
            await rejects(() => px.system.otaCheck(base + '/manifest'), /ECANCELED: OTA context is closed/);
            console.log('OTA_TEST_DONE');
            px.app.exit();
          });
        }, 150);
        """)
        self.assertTrue(self.connected["exit"].is_set(), "query did not connect before exit")
        self.assertTrue(self.closed["exit"].wait(1), "VM exit did not close the real TCP connection")


if __name__ == "__main__":
    unittest.main()
