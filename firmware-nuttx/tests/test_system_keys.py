#!/usr/bin/env python3
"""验证纯按键状态机、独立采样、双队列与看门狗；不操作真实按键/USB。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ubsan", action="store_true")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    cc = shlex.split(os.environ.get("CC", "cc"))
    flags = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
             "-I" + str(project / "include"), "-I" + str(project / "tests"), "-pthread"]
    if args.ubsan:
        flags += ["-fsanitize=undefined", "-fno-sanitize-recover=all"]
    with tempfile.TemporaryDirectory(prefix="px-system-keys-") as temporary:
        build = Path(temporary)

        def run(command):
            subprocess.run(command, check=True, timeout=60)

        run([*cc, *flags, "-c", str(project / "src/system_keys.c"), "-o", str(build / "host.o")])
        runner = build / "runner"
        run([*cc, *flags, "-DPX_SYSTEM_KEYS_TEST", str(project / "src/system_keys.c"),
             str(project / "src/power.c"), str(project / "tests/test_system_keys.c"), "-o", str(runner)])
        cases = ("core", "queues", "worker", "blocked_io", "provisioning", "launch_fail", "watchdog_fail")
        for case in cases:
            run([str(runner), case])
    print(f"{len(cases)} 组系统按键测试通过；真机按键/显示切换待烧录验证")


if __name__ == "__main__":
    main()
