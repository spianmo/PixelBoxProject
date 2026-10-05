#!/usr/bin/env python3
"""独立验证 Wi-Fi 原生控制流程；不访问真机，不使用共享交叉构建。"""
from __future__ import annotations

import argparse
import errno
from pathlib import Path
import os
import shlex
import shutil
import subprocess
import tempfile


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, timeout=60)


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", action="store_true")
    parser.add_argument("--ubsan", action="store_true", help="仅使用未定义行为检查")
    args = parser.parse_args()
    dependencies = project.parent / ".deps"
    with tempfile.TemporaryDirectory(prefix="pixelbox-wifi-test-") as directory:
        build = Path(directory)
        # 使用真实 SDK 的无线结构和 DHCP 声明，避免手抄结构掩盖 ABI 错误。
        for folder in ["nuttx/wireless", "nuttx/fs", "netutils"]:
            (build / folder).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dependencies / "nuttx/include/nuttx/wireless/wireless.h",
                        build / "nuttx/wireless/wireless.h")
        shutil.copyfile(dependencies / "apps/include/netutils/dhcpc.h",
                        build / "netutils/dhcpc.h")
        (build / "nuttx/config.h").write_text("#define FAR\n#define CONFIG_NETDB_DNSCLIENT 1\n")
        (build / "nuttx/fs/ioctl.h").write_text("#define _WLIOC(n) (0x8b00 + (n))\n")
        compiler = shlex.split(os.environ.get("CC", "cc"))
        flags = ["-std=c11", "-D_DEFAULT_SOURCE", "-D_DARWIN_C_SOURCE", "-O1", "-g",
                 "-Wall", "-Wextra", "-Werror", "-pthread"]
        if args.sanitize:
            flags += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
        elif args.ubsan:
            flags += ["-fsanitize=undefined", "-fno-omit-frame-pointer"]
        includes = ["-I" + str(build), "-I" + str(project / "include"),
                    "-I" + str(project / "tests")]
        run([*compiler, *flags, *includes, "-c", str(project / "src/wifi.c"),
             "-o", str(build / "wifi_host.o")])
        executable = build / "test_wifi"
        run([*compiler, *flags, *includes, "-DPX_WIFI_TEST",
             str(project / "src/wifi.c"), str(project / "tests/test_wifi.c"),
             "-o", str(executable)])
        result = subprocess.run([str(executable)], check=True, timeout=60,
                                capture_output=True, text=True)
        for stage in ["associate", "dhcp-open", "dhcp-request", "connected-status"]:
            assert f"stage={stage} result={-errno.ENETUNREACH}" in result.stderr
        assert "diagnostic-ssid" not in result.stderr
        assert "diagnostic-secret-123" not in result.stderr
        print(result.stdout, end="")


if __name__ == "__main__":
    main()
