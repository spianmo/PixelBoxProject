#!/usr/bin/env python3
"""运行真实 QuickJS 二进制验证公共契约、持久化、安全边界和事件循环。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest

EXECUTABLE = Path(sys.argv.pop(1)).resolve()
PROJECT = Path(__file__).resolve().parents[1]
ASSERTIONS = """
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(a, b) { assert(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function throws(fn, message) {
  try { fn(); } catch (error) { if (message) equal(error.message, message); return; }
  throw new Error('expected exception');
}
"""


def members(body: str) -> list[str]:
    """只切分接口顶层分号；返回类型中的对象和 callback 签名不被拆开。"""
    result, start, brace, paren = [], 0, 0, 0
    for index, char in enumerate(body):
        brace += (char == "{") - (char == "}")
        paren += (char == "(") - (char == ")")
        if char == ";" and not brace and not paren:
            result.append(body[start:index].strip())
            start = index + 1
    if body[start:].strip():
        result.append(body[start:].strip())
    return result


def interface_checks(source: str) -> list[str]:
    source = re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.S)
    interfaces: dict[str, tuple[str, str | None]] = {}
    for match in re.finditer(r"interface\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{", source):
        depth, index = 1, match.end()
        while depth:
            depth += (source[index] == "{") - (source[index] == "}")
            index += 1
        interfaces[match.group(1)] = (source[match.end():index - 1], match.group(2))
    checks = []

    def visit_body(body: str, path: str) -> None:
        for member in members(body):
            match = re.match(r"(?:readonly\s+)?(\w+)\??\s*(.*)", member, flags=re.S)
            if not match:
                raise AssertionError(f"unsupported interface member: {member}")
            name, declaration = match.groups()
            target = path + "." + name
            if declaration.startswith("(") or declaration.startswith("<"):
                checks.append(f"assert(typeof {target} === 'function', '{target} must be function');")
            elif declaration.startswith(":"):
                value = declaration[1:].strip()
                if value in interfaces:
                    visit(value, target)
                elif value.startswith("{"):
                    checks.append(f"assert({target} && typeof {target} === 'object', '{target} must be object');")
                    visit_body(value[1:-1], target)
                else:
                    expected = value if value in ("number", "string", "boolean") else None
                    condition = "=== " + repr(expected) if expected else "!== 'undefined'"
                    checks.append(f"assert(typeof {target} {condition}, '{target} missing or invalid');")
            else:
                raise AssertionError(f"cannot parse {target}: {declaration}")

    def visit(name: str, path: str) -> None:
        body, parent = interfaces[name]
        if parent:
            visit(parent, path)
        visit_body(body, path)

    visit("PixelBox", "px")
    return checks


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="pixelbox-nuttx-test-")
        self.root = Path(self.temporary.name)
        self.app = self.root / "app"
        self.data = self.root / "data"
        self.app.mkdir(); self.data.mkdir()
        (self.app / "assets").mkdir()
        (self.app / "manifest.json").write_text(json.dumps({"name": "fixture", "id": "test.runtime", "version": "1.2.3"}))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_js(self, code: str, *, expected: int = 0, args: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        entry = self.root / "entry.js"
        entry.write_text(ASSERTIONS + code)
        result = subprocess.run([str(EXECUTABLE), "--app-root", str(self.app), "--data-root", str(self.data),
                                 "--timeout-ms", "2000", *args, str(entry)],
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_sdk_surface(self) -> None:
        declaration = PROJECT.parent / "sdk/types/pixelbox.d.ts"
        if not declaration.is_file():
            self.skipTest("standalone project: SDK declaration not present")
        checks = interface_checks(declaration.read_text())
        self.assertGreater(len(checks), 150, "interface parser lost public methods")
        self.run_js("assert(px === pixelbox);\n" + "\n".join(checks))

    def test_core_and_memory(self) -> None:
        self.run_js("""
        const info = px.system.info(); equal(info.model, 'pixelbox-nuttx-host');
        assert(typeof info.chip === 'string'); assert(info.deviceId.startsWith('pxb-'));
        equal(info.screen, {width:0,height:0}); assert(Object.values(info.capabilities).every(x => x === false));
        equal(px.sensors.imu.available(), false); equal(info.capabilities.imu, false);
        equal(info.capabilities.touch, false);
        throws(() => px.input.onTouch(1), 'onTouch needs a function');
        throws(() => px.input.onTouch(() => {}), 'ENOTSUP');
        equal(px.system.battery(), {level:-1,charging:false,voltageMv:0});
        const before = px.system.memory().jsHeapUsed; const held = new Uint8Array(100000);
        assert(px.system.memory().jsHeapUsed > before + 90000);
        assert(px.system.now() > 1700000000000); assert(performance.now() > 0);
        px.system.setTimezone('UTC0'); equal(new Date(0).getTimezoneOffset(), 0);
        equal([px.app.name,px.app.id,px.app.version], ['fixture','test.runtime','1.2.3']);
        """)

    def test_float_parsing_and_formatting(self) -> None:
        """覆盖 NuttX dtoa 接管的 QuickJS 解析和格式化路径。"""
        self.run_js("""
        equal(Number('1.25'), 1.25);
        equal(Number('1e-7'), 1e-7);
        equal(Number('0x10'), 16);
        equal(JSON.parse('1.25'), 1.25);
        equal((1.25).toString(), '1.25');
        equal((1.005).toFixed(2), '1.00');
        equal((1e21).toFixed(2), '1e+21');
        equal((1.2345).toPrecision(3), '1.23');
        equal((1.2345).toExponential(2), '1.23e+0');
        equal((-0).toString(), '0');
        """)

    def test_wifi_binding_validation_and_host_errors(self) -> None:
        self.run_js("""
        equal(px.wifi.status().connected, false);
        const calls = [
          () => px.wifi.scan(),
          () => px.wifi.connect('valid', '', {save:false}),
          () => px.wifi.connect('', ''),
          () => px.wifi.connect('bad\\0ssid', ''),
          () => px.wifi.connect('x', '', {timeoutMs:-1}),
          () => px.wifi.connect('x', '', {timeoutMs:Infinity})
        ];
        let finished = 0;
        for (const call of calls) call().then(() => {throw new Error('unexpected host WLAN success');},
          () => {finished++;});
        setTimeout(() => equal(finished, calls.length), 50);
        """)

    def test_shared_text_color_helpers(self) -> None:
        self.run_js("""
        const bytes = new TextEncoder().encode('你好 PixelBox');
        equal(new TextDecoder().decode(bytes), '你好 PixelBox');
        equal(px.util.hexEncode(px.util.hexDecode('00abff')), '00abff');
        equal(px.util.b64encode(px.util.b64decode('AAH/')), 'AAH/');
        equal(atob(btoa('abc')), 'abc'); equal(px.color.rgb(300,128,-1), 0xff8000);
        equal(px.color.hsv(120,100,100), 0x00ff00); equal(px.color.lerp(0,0xffffff,.5), 0x808080);
        """)

    def test_crypto_vectors_and_offsets(self) -> None:
        for value in ("", "abc", "a" * 55, "a" * 56, "a" * 64, "a" * 1000, "中文 UTF-8"):
            self.run_js(f"equal(px.util.hexEncode(px.util.sha256({json.dumps(value)})), '{hashlib.sha256(value.encode()).hexdigest()}');")
        self.run_js("""
        equal(px.util.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
        const data = new Uint8Array([0,97,98,99,0]);
        equal(px.util.hexEncode(px.util.sha256(data.subarray(1,4))), px.util.hexEncode(px.util.sha256('abc')));
        equal(px.util.randomBytes(0).byteLength, 0); equal(px.util.randomBytes(32).byteLength, 32);
        assert(px.util.hexEncode(px.util.randomBytes(32)) !== px.util.hexEncode(px.util.randomBytes(32)));
        assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(px.util.uuid()));
        throws(() => px.util.randomBytes(-1)); throws(() => px.util.sha256(new Int32Array(1)));
        """)

    def test_storage_and_assets(self) -> None:
        (self.app / "assets/message.txt").write_text("asset 中文")
        self.run_js("""
        equal(px.app.readAssetText('message.txt'), 'asset 中文');
        equal(new TextDecoder().decode(px.app.readAsset('message.txt')), 'asset 中文');
        px.storage.fs.mkdir('/data/sub'); px.storage.fs.writeText('/data/sub/text', 'hello');
        px.storage.fs.append('/data/sub/text', new TextEncoder().encode(' world'));
        equal(px.storage.fs.readText('/data/sub/text'), 'hello world');
        px.storage.fs.writeBytes('/data/bytes', new Uint8Array([9,1,2,3,9]).subarray(1,4));
        equal([...new Uint8Array(px.storage.fs.readBytes('/data/bytes'))], [1,2,3]);
        const stat = px.storage.fs.stat('/data/sub/text'); equal(stat.name,'text'); equal(stat.size,11); equal(stat.isDir,false);
        assert(stat.mtime > 0); equal(px.storage.fs.stat('/data/missing'),null);
        equal(px.storage.fs.readDir('/data/sub').map(x=>x.name), ['text']);
        px.storage.fs.remove('/data/sub/text'); px.storage.fs.remove('/data/sub');
        equal(px.storage.fs.exists('/data/sub'), false);
        """)

    def test_kv_persists_across_processes(self) -> None:
        self.run_js("px.storage.kv.set('count', 12); px.storage.kv.set('object', {ok:true}); px.storage.kv.set('__proto__','safe');")
        self.run_js("""
        equal(px.storage.kv.get('count'),'12'); equal(px.storage.kv.getJSON('object'),{ok:true});
        equal(px.storage.kv.get('__proto__'),'safe'); equal(px.storage.kv.get('missing'),null);
        equal(px.storage.kv.keys().sort(),['__proto__','count','object']);
        px.storage.kv.remove('count'); equal(px.storage.kv.get('count'),null);
        px.storage.kv.clear(); equal(px.storage.kv.keys(),[]);
        """)

    def test_storage_boundaries(self) -> None:
        outside = self.root / "secret"
        outside.write_text("secret")
        (self.data / "link").symlink_to(outside)
        self.run_js("""
        throws(() => px.storage.fs.readText('/data/../secret'));
        throws(() => px.storage.fs.readText('/data/link'));
        throws(() => px.storage.fs.writeText('/app/manifest.json','bad'));
        throws(() => px.storage.fs.readText('/etc/passwd'));
        throws(() => px.storage.fs.writeText('/data/null\\0suffix','bad'));
        throws(() => px.app.readAsset('../manifest.json'));
        throws(() => px.storage.fs.remove('/data'));
        """)
        self.assertEqual(outside.read_text(), "secret")

    def test_file_limit_allows_recording_and_rejects_oversize(self) -> None:
        # 48kHz/60秒单声道WAV超过4MiB；仍拒绝超过8MiB的文件。
        accepted = 48000 * 60 * 2 + 44
        with (self.data / "recording.wav").open("wb") as stream:
            stream.truncate(accepted)
        with (self.data / "oversize").open("wb") as stream:
            stream.truncate(8 * 1024 * 1024 + 1)
        self.run_js(f"equal(px.storage.fs.readBytes('/data/recording.wav').byteLength,{accepted});"
                    "throws(()=>px.storage.fs.readBytes('/data/oversize'));",
                    args=("--heap-bytes", str(16 * 1024 * 1024)))

    def test_missing_storage_does_not_fallback_to_ram(self) -> None:
        self.data = self.root / "not-mounted"
        self.run_js("throws(() => px.storage.kv.set('a','b')); throws(() => px.storage.fs.writeText('/data/x','a')); ")
        self.assertFalse(self.data.exists())

    def test_timers_microtasks_and_unsubscribe(self) -> None:
        self.run_js("""
        const events = []; Promise.resolve().then(()=>events.push('promise'));
        queueMicrotask(()=>events.push('micro')); setTimeout((a,b)=>{events.push(a+b);},0,'t','imer');
        const cancelled = setTimeout(()=>{throw new Error('cancelled timer ran');},0); clearTimeout(cancelled);
        let ticks = 0; const timer = setInterval(()=>{if(++ticks === 2) clearInterval(timer);},2);
        px.app.onExit(()=>{ equal(events,['promise','micro','timer']); equal(ticks,2); });
        const off = px.app.onExit(()=>{throw new Error('cancelled onExit ran');}); off();
        """)

    def test_slow_frame_services_newly_due_input_before_next_frame(self) -> None:
        # 真实事件循环中绘制先占据 timer 槽0；输入在绘制期间到期。
        # 不刷新 now 的旧循环会先再次调用 render，出现 frame/frame/input。
        self.run_js("""
        const events = [];
        function render() {
          events.push('frame');
          if (events.length === 1) {
            const until = performance.now() + 80;
            while (performance.now() < until) {}
            setTimeout(render, 0);
          } else {
            clearInterval(input);
            equal(events.slice(0, 3), ['frame', 'input', 'frame']);
          }
        }
        setTimeout(render, 1);
        const input = setInterval(() => events.push('input'), 50);
        """)

    def test_overdue_input_runs_before_later_frame_deadline(self) -> None:
        # JS 同步任务期间两个 timer 都过期，触摸截止时间更早但槽位更靠后。
        self.run_js("""
        const events = [];
        setTimeout(() => events.push('frame'), 30);
        setTimeout(() => events.push('input'), 10);
        const until = performance.now() + 60;
        while (performance.now() < until) {}
        px.app.onExit(() => equal(events, ['input', 'frame']));
        """)

    def test_timer_capacity_preserves_all_arguments(self) -> None:
        """填满堆上的定时器表，验证引用复制、边界拒绝和回调后槽位复用。"""
        self.run_js("""
        let calls = 0;
        const args = Array.from({length:16}, (_, index)=>({index}));
        throws(()=>setTimeout(()=>{},0,...args,17),'too many timer arguments');
        for (let timer=0;timer<128;++timer) {
          setTimeout((...values)=>{
            equal(values.length,16);
            for (let index=0;index<16;++index) equal(values[index].index,index);
            ++calls;
            if (calls===128) setTimeout(()=>{++calls;},0);
          },0,...args);
        }
        throws(()=>setTimeout(()=>{},0),'timer limit exceeded (128)');
        px.app.onExit(()=>equal(calls,129));
        """)

    def test_deep_recursion_reports_stack_overflow_and_recovers(self) -> None:
        """脚本递归受 QuickJS 栈上限拒绝后，仍能继续执行定时器与退出钩子。"""
        self.run_js("""
        let caught = false;
        function recurse() { return recurse()+1; }
        try { recurse(); } catch (error) {
          assert(/maximum call stack size exceeded/i.test(String(error)));
          caught = true;
        }
        assert(caught);
        let ticked = false;
        setTimeout(()=>{ticked=true;},0);
        px.app.onExit(()=>assert(ticked));
        """)

    def test_promise_hardware_methods_reject(self) -> None:
        self.run_js("""
        const methods = [()=>px.wifi.scan(), ()=>px.wifi.connect('x'),
          ()=>px.audio.player.play('x'), ()=>px.audio.record('/data/a'),
          ()=>px.camera.init(), ()=>px.camera.capture(),
          ()=>px.system.otaApply('x')];
        let caught = 0;
        for (const method of methods) { const result = method(); assert(result instanceof Promise); result.catch(e=>{equal(e.message,'ENOTSUP');++caught;}); }
        const bleMethods = [()=>px.ble.central.scan(), ()=>px.ble.central.connect('01:02:03:04:05:06')];
        for (const method of bleMethods) {
          const result = method(); assert(result instanceof Promise);
          result.catch(e=>{assert(/^ENOTSUP: BLE \\(-[0-9]+\\)$/.test(e.message));++caught;});
        }
        px.app.onExit(()=>equal(caught,methods.length+bleMethods.length));
        equal(px.system.info().capabilities.ble,false);
        for(const domain of [px.ble,px.camera,px.gps,px.led,px.speech,px.sensors.imu]) equal(domain.available(),false);
        for(const method of [()=>px.screen.clear(),()=>px.led.show()]) throws(method,'ENOTSUP');
        equal([WebSocket.CONNECTING,WebSocket.OPEN,WebSocket.CLOSING,WebSocket.CLOSED],[0,1,2,3]);
        equal(px.voice.state(),'idle'); equal(px.audio.mic.active,false); equal(px.audio.player.playing,false);
        const offWifi = px.wifi.on('connected',()=>{});
        assert(typeof offWifi === 'function'); offWifi();
        """)

    def test_mdns_runtime_binding_and_offline_discovery(self) -> None:
        self.run_js("""
        let invalid = 0, offline = false;
        for (const call of [()=>px.net.mdns.discover('_http._tcp', null),
                            ()=>px.net.mdns.discover('_http._tcp', {timeoutMs:0}),
                            ()=>px.net.mdns.discover('invalid', {timeoutMs:500})]) {
          const pending = call(); assert(pending instanceof Promise);
          pending.catch(error=>{assert(!/ENOTSUP/.test(error.message)); ++invalid;});
        }
        throws(()=>px.net.mdns.advertise({service:'_http._tcp',port:0}));
        const off=px.net.mdns.advertise({name:'Runtime Owner',service:'_http._tcp',port:8123,txt:{app:'fixture'}});
        assert(typeof off==='function'); off(); off();
        px.net.mdns.discover('_http._tcp',{timeoutMs:1000}).then(()=>{throw new Error('expected offline error');},error=>{
          assert(/ENETDOWN/.test(error.message)); offline=true;
        });
        px.app.onExit(()=>{equal(invalid,3);equal(offline,true);});
        """)

    def test_mdns_owner_cleanup_on_early_exit(self) -> None:
        # 未配置 IP，worker 不打开组播 socket；main 的全局 shutdown 校验 owner 已释放。
        self.run_js("""
        px.net.mdns.advertise({name:'Runtime Exit',service:'_http._tcp',port:8124});
        px.net.mdns.discover('_http._tcp',{timeoutMs:10000}).catch(()=>{});
        px.app.exit();
        """)

    def test_real_http_through_runtime_event_loop(self) -> None:
        # 使用真实本地 TCP 和 HTTP 服务端，覆盖 FFI/prelude/Promise 到退出的完整链路。
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"ok":true,"source":"runtime-loopback"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            self.run_js(f"""
            let completed = false;
            fetch('http://127.0.0.1:{server.server_port}/check').then(async response => {{
              equal(response.status, 200);
              equal(await response.json(), {{ok:true,source:'runtime-loopback'}});
              completed = true;
            }});
            px.app.onExit(() => equal(completed, true));
            """)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_native_rectangles_match_clipped_canvas(self) -> None:
        self.run_js("""
        const batched=px.screen.createCanvas(17,13),reference=px.screen.createCanvas(17,13);
        const raw=new Int32Array(8*5+10), rects=raw.subarray(5,45);
        rects.set([-5,-4,8,8,0xff102030, 15,11,8,8,0xaabbcc, 1,2,0,8,1,
          -2147483648,0,2147483647,2,2, 0,0,-1,2,3, 0,0,17,1,0xabcdef,
          5,5,3,3,0x123456, 6,6,8,8,0xff0000]);
        batched.fillRects(rects,8);
        for(let i=0;i<8;i++)reference.fillRect(...rects.subarray(i*5,i*5+5));
        for(let y=0;y<13;y++)for(let x=0;x<17;x++)equal(batched.getPixel(x,y),reference.getPixel(x,y));
        equal(raw[0],0);equal(raw[49],0);
        batched.fillRects(new Int32Array(0),0);
        throws(()=>batched.fillRects(rects,9));
        throws(()=>batched.fillRects(new Uint32Array(5),1));
        batched.dispose();throws(()=>batched.fillRects(rects,1));
        """)

    def test_projection_and_blend(self) -> None:
        self.run_js("""
        const points = new Float32Array([0,0,0, 1,0,0, 2,0,0, 4,1,0]);
        const projected = new Int32Array(8); px.util.projectPoints(points,{},projected);
        equal([...projected],[0,0,1,0,2,0,4,1]);
        const runs = new Int32Array(12); equal(px.util.projectPointRuns(points,{},runs),2); equal([...runs.slice(0,6)],[0,0,3,4,1,1]);
        const mixed = new Float32Array(3); px.util.blendPoints([new Float32Array([1,2,3]),new Float32Array([4,6,8])],new Float32Array([.25,.75]),mixed);
        equal([...mixed],[3.25,5,6.75]);
        throws(()=>px.util.blendPoints([mixed],new Float32Array([1]),mixed));
        throws(()=>px.util.projectPoints(points,{distance:0},projected));
        throws(()=>px.util.projectPoints(points,{},new Int32Array(points.buffer)));
        throws(()=>px.util.projectPoints(new Float32Array([0,0,64]),{},new Int32Array(2)));
        """)

    def test_native_text_layout_rasterization_and_getter_errors(self) -> None:
        self.run_js('''
        const c = px.screen.createCanvas(160,80);
        const st = {font:'pixel12',scale:2,color:0x12ab34,align:'center'};
        const size = c.measureText('PixelBox 像素盒',st);
        assert(size.width > 0 && size.height === 24);
        equal(c.measureText('',st),{width:0,height:0});
        equal(c.measureText('abc',{font:'missing'}),c.measureText('abc',{font:'pixel8'}));
        equal(c.measureText('A',{scale:99}),c.measureText('A',{scale:8}));
        c.clear(); c.drawText('像素 A',80,8,st);
        let painted=0; for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++) {
          const color=c.getPixel(x,y); assert(color===0 || color===0x12ab34); painted += !!color;
        }
        assert(painted>30,'glyphs must paint actual pixels');
        c.clear(); c.drawText('A',-10000,-10000,st); assert(c._pixels.every(v=>v===0));
        throws(()=>c.drawText('A',0,0,{get scale(){throw new Error('style failure')}}),'style failure');
        assert(c._pixels.every(v=>v===0));
        throws(()=>c.measureText()); throws(()=>c.drawText('A'));
        c.dispose(); throws(()=>c.measureText('A'),'canvas is disposed');
        ''')

    def test_offscreen_canvas_and_codec(self) -> None:
        self.run_js("""
        const c = px.screen.createCanvas(8,8); c.clear(); c.setPixel(1,1,0xff0000); equal(c.getPixel(1,1),0xff0000);
        c.fillRect(2,2,2,2,0x00ff00); equal(c.getPixel(3,3),0x00ff00);
        c.fillRects(new Int32Array([0,0,1,1,0xffffff])); equal(c.getPixel(0,0),0xffffff);
        c.drawLine(0,7,7,7,0x0000ff); equal(c.getPixel(4,7),0x0000ff);
        const d = px.screen.createCanvas(16,16); d.drawImage(c,0,0,{w:16,h:16}); equal(d.getPixel(2,2),0xff0000);
        d.drawCircle(8,8,2,0xffffff); equal(d.getPixel(10,8),0xffffff);
        d.fillCircle(8,8,1,0xabcdef); equal(d.getPixel(8,8),0xabcdef);
        c.dispose(); throws(()=>c.clear());
        equal([...new Uint8Array(px.audio.encodeImaAdpcm(new Uint8Array([0,0])))],[1,0,0,0,0,0]);
        equal(px.audio.encodeImaAdpcm(new Uint8Array([0,0,1,0])).byteLength,7);
        throws(()=>px.audio.encodeImaAdpcm(new Uint8Array(0)));
        """)

    def test_entry_exception_fails(self) -> None:
        result = self.run_js("throw new Error('entry-boom');", expected=1)
        self.assertIn("entry-boom", result.stderr)

    def test_timer_exception_fails(self) -> None:
        result = self.run_js("setTimeout(()=>{throw new Error('timer-boom');},0);", expected=1)
        self.assertIn("timer-boom", result.stderr)

    def test_unhandled_rejection_is_not_hidden_by_handled_rejection(self) -> None:
        result = self.run_js("Promise.reject(new Error('unhandled-first')); Promise.reject(new Error('handled-second')).catch(()=>{});", expected=1)
        self.assertIn("unhandled-first", result.stderr)

    def test_infinite_script_is_interrupted(self) -> None:
        self.run_js("while(true) {}", expected=1, args=("--turn-timeout-ms", "40"))

    def test_infinite_microtasks_are_interrupted(self) -> None:
        self.run_js("function spin(){queueMicrotask(spin);}spin();", expected=1, args=("--turn-timeout-ms", "40"))

    def test_native_canvas_obeys_uncatchable_turn_deadline(self) -> None:
        result = self.run_js("""
        const c=px.screen.createCanvas(512,512), rects=new Int32Array(8192*5);
        for(let i=0;i<8192;i++) rects.set([0,0,512,512,0xffffff],i*5);
        setTimeout(()=>{
          console.log('native-fill-start');
          try { c.fillRects(rects); } catch(error) { console.log('native-fill-caught'); }
          console.log('native-fill-finished');
        },0);
        """, expected=1, args=("--turn-timeout-ms", "40"))
        self.assertIn('native-fill-start', result.stdout)
        self.assertIn('interrupted', result.stderr)
        self.assertNotIn('native-fill-caught', result.stdout)
        self.assertNotIn('native-fill-finished', result.stdout)

    def test_runtime_timeout_stops_intervals(self) -> None:
        result = self.run_js("setInterval(()=>{},10);", expected=1, args=("--timeout-ms", "50"))
        self.assertIn("runtime timeout", result.stderr)

    def test_app_exit_runs_cleanup(self) -> None:
        self.run_js("px.app.onExit(()=>px.storage.fs.writeText('/data/exit','done'));px.app.exit();")
        self.assertEqual((self.data / "exit").read_text(), "done")


if __name__ == "__main__":
    unittest.main(verbosity=2)
