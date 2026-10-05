#!/usr/bin/env python3
"""通过主运行时检查默认构建的本地唤醒拒绝路径，不操作音频设备。"""
from pathlib import Path
import argparse
import subprocess
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    source = """
if (typeof globalThis.__pxNative !== 'undefined') throw new Error('native binding leaked');
if (typeof px.speech.wakeword.start !== 'function') throw new Error('wakeword API missing');
px.speech.wakeword.start({phrase:'你好',pinyin:'ni hao',threshold:0.5,onWake() {
  throw new Error('disabled backend produced a recognition result');
}}).then(() => { throw new Error('disabled backend started'); }, error => {
  if (!String(error).includes('ENOTSUP')) throw error;
  px.speech.wakeword.stop();
  console.log('MULTINET7_DISABLED_OK');
});
"""
    with tempfile.TemporaryDirectory(prefix="pixelbox-mn7-build-") as directory:
        result = subprocess.run([str(args.executable.resolve()), "--app-root", directory,
                                 "--data-root", directory, "--timeout-ms", "2000", "--eval", source],
                                text=True, capture_output=True, timeout=5)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "MULTINET7_DISABLED_OK" in result.stdout, result.stdout + result.stderr
    print("Default main runtime rejects unavailable MultiNet7 explicitly")


if __name__ == "__main__":
    main()
