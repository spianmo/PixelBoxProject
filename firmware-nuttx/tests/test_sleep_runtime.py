#!/usr/bin/env python3
"""真实 SDK/TCP/QuickJS 触发睡眠请求；宿主拒绝后 devd 仍可显式恢复 VM。"""
from pathlib import Path
import argparse
import json
import re
import selectors
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
args = parser.parse_args()
project = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="pixelbox-sleep-runtime-") as temporary:
    directory = Path(temporary)
    app, data = directory / "app", directory / "data"
    app.mkdir(); data.mkdir()
    (app / "main.js").write_text("globalThis.marker=42; console.log('sleep runtime ready');")
    sdk, script = directory / "sdk.cjs", directory / "client.cjs"
    subprocess.run(["node", "-e", "require(" + json.dumps(str(project.parent / "sdk/node_modules/esbuild")) +
                    ").buildSync(" + json.dumps({"entryPoints": [str(project.parent / "sdk/src/devd.ts")],
                    "bundle": True, "platform": "node", "format": "cjs", "outfile": str(sdk)}) + ")"],
                   check=True, timeout=60)
    script.write_text("const {DevdClient}=require(" + json.dumps(str(sdk)) + ");\n" + r"""
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const client=await DevdClient.connect('127.0.0.1',{port:Number(process.argv[2])});
  const events=[]; client.onEvent((event,data)=>events.push({event,data})); await client.subscribeLogs();
  async function running(){
    for(let i=0;i<100;++i){try{if(await client.evalJs('marker')==='42')return;}catch{}await delay(10);}
    throw new Error('VM unavailable');
  }
  await running();
  await assert.rejects(client.evalJs('px.system.deepSleep(0)'),/duration/);
  assert.equal(await client.evalJs('marker'),'42');
  await client.evalJs('px.system.deepSleep(1000)').catch(error=>assert.match(error.message,/application stopping/));
  for(let i=0;i<100&&!events.some(e=>e.data.tag==='sleep');++i)await delay(10);
  const rejection=events.find(e=>e.data.tag==='sleep');assert(rejection&&/rejected/.test(rejection.data.msg));
  await assert.rejects(client.evalJs('1'),/application stopped/);
  assert.equal((await client.hello()).name,'PixelBox');
  await delay(100);await assert.rejects(client.evalJs('1'),/application stopped/);
  await client.restartApp();await running();assert.equal(await client.evalJs('6*7'),'42');
  client.close();console.log('sleep runtime: refusal preserved devd and explicit restart recovered VM');
})().catch(error=>{console.error(error);process.exitCode=1;});
""")
    process = subprocess.Popen([str(args.binary.resolve()), "--serve", "--port", "0",
                                "--app-root", str(app), "--data-root", str(data)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
        assert selector.select(timeout=5), "service did not report its port"
        line = process.stdout.readline(); match = re.search(r"devd listening on port (\d+)", line)
        assert match, line
        subprocess.run(["node", str(script), match.group(1)], check=True, timeout=10)
    finally:
        process.terminate(); process.communicate(timeout=5)
