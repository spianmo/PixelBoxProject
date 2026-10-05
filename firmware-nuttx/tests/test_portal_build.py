#!/usr/bin/env python3
"""通过完整主运行时验证门户条件接线，不初始化网络或操作真机。"""
from pathlib import Path
import argparse
import subprocess
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("enabled", choices=("ON", "OFF"))
    args = parser.parse_args()
    enabled = args.enabled == "ON"
    expected = "ENODEV" if enabled else "ENOTSUP"
    source = """
function check(ok, reason) { if (!ok) throw new Error(reason); }
// 主 prelude 会隐藏 native；用公开接口的不同错误区分构建开关。
check(typeof globalThis.__pxNative === 'undefined', 'native binding leaked');
check(Object.isFrozen(px.wifi.portal), 'portal API is not frozen');
for (const name of ['start', 'stop', 'status']) {
  check(typeof px.wifi.portal[name] === 'function', 'missing ' + name);
  let error;
  try { px.wifi.portal[name](); } catch (e) { error = e; }
  check(error && String(error).includes('EXPECTED'), 'wrong error for ' + name);
}
check(!px.wifi.status().connected, 'build probe changed Wi-Fi state');
console.log('PORTAL_BUILD_OK');
""".replace("EXPECTED", expected)
    with tempfile.TemporaryDirectory(prefix="pixelbox-portal-build-") as directory:
        result = subprocess.run([str(args.executable.resolve()), "--app-root", directory,
                                 "--data-root", directory, "--timeout-ms", "2000", "--eval", source],
                                check=False, text=True, capture_output=True, timeout=5)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "PORTAL_BUILD_OK" in result.stdout, result.stdout + result.stderr
    print(f"Portal build gate {'enabled' if enabled else 'disabled'} passed via main runtime")


if __name__ == "__main__":
    main()
