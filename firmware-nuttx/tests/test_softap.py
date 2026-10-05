#!/usr/bin/env python3
"""使用真实 NuttX 无线 ABI 验证独立 SoftAP 控制模块，无真实网络操作。"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", choices=("undefined",))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pixelbox-softap-control-") as tmp:
        build = Path(tmp)
        (build / "nuttx/wireless").mkdir(parents=True)
        (build / "nuttx/fs").mkdir()
        shutil.copyfile(root.parent / ".deps/nuttx/include/nuttx/wireless/wireless.h",
                        build / "nuttx/wireless/wireless.h")
        (build / "nuttx/config.h").write_text("#define FAR\n")
        (build / "nuttx/fs/ioctl.h").write_text("#define _WLIOC(n) (0x8b00 + (n))\n")
        flags = ["-std=c11", "-D_DEFAULT_SOURCE", "-D_DARWIN_C_SOURCE", "-O1", "-g",
                 "-Wall", "-Wextra", "-Werror", "-pthread", "-I" + str(build),
                 "-I" + str(root / "include"), "-I" + str(root / "tests")]
        if args.sanitize:
            flags += ["-fsanitize=undefined", "-fno-sanitize-recover=all"]
        subprocess.run(["cc", *flags, "-c", str(root / "src/softap.c"),
                        "-o", str(build / "softap_host.o")], check=True, timeout=30)
        binary = build / "test-softap"
        subprocess.run(["cc", *flags, "-DPX_SOFTAP_TEST", str(root / "src/softap.c"),
                        str(root / "tests/test_softap.c"), "-o", str(binary)], check=True, timeout=30)
        subprocess.run([str(binary)], check=True, timeout=10)


if __name__ == "__main__":
    main()
