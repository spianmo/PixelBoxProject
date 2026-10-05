#!/usr/bin/env python3
"""真实 QuickJS 公开接口的构建开关、参数和非托管调用门禁。"""
from pathlib import Path
import argparse
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("enabled", choices=("ON", "OFF"))
args = parser.parse_args()
source = r"""
function check(body, pattern) {
  let error; try { body(); } catch(e) { error=e; }
  if (!error || !pattern.test(String(error))) throw new Error('unexpected sleep result: '+error);
}
check(()=>px.system.deepSleep(), /ENOTSUP/);
check(()=>px.system.deepSleep(undefined), /ENOTSUP/);
"""
if args.enabled == "ON":
    source += r"""
for (const value of [0, -1, .1, NaN, Infinity, -Infinity, 86400001, Number.MAX_SAFE_INTEGER])
  check(()=>px.system.deepSleep(value), /RangeError/);
for (const value of [null, '1000', {}, true, 1n])
  check(()=>px.system.deepSleep(value), /TypeError/);
for (const value of [1, 1000, 86400000])
  check(()=>px.system.deepSleep(value), /ENODEV/);
"""
else:
    source += "check(()=>px.system.deepSleep(1000), /ENOTSUP/);\n"
source += "console.log('SLEEP_BUILD_OK');"
with tempfile.TemporaryDirectory(prefix="pixelbox-sleep-binding-") as directory:
    result = subprocess.run([str(args.binary.resolve()), "--app-root", directory, "--data-root", directory,
                             "--timeout-ms", "2000", "--eval", source], timeout=5, capture_output=True, text=True)
    assert result.returncode == 0 and "SLEEP_BUILD_OK" in result.stdout, result.stdout + result.stderr
print("sleep build gate passed:", args.enabled)
