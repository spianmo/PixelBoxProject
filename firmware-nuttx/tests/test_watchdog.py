#!/usr/bin/env python3
"""用确定时钟和ioctl边界验证健康看门狗；测试从不操作真机或系统watchdog。"""
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
    flags = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
             "-I" + str(project / "include"), "-I" + str(project / "tests")]
    if args.ubsan:
        flags += ["-fsanitize=undefined", "-fno-sanitize-recover=all"]
    cc = shlex.split(os.environ.get("CC", "cc"))
    with tempfile.TemporaryDirectory(prefix="pixelbox-watchdog-test-") as temporary:
        build = Path(temporary)

        def run(command):
            subprocess.run(command, check=True, timeout=60)

        run([*cc, *flags, "-c", str(project / "src/watchdog.c"), "-o", str(build / "stub.o")])
        run([*cc, *flags, "-DPX_WATCHDOG_TEST", "-DPX_WATCHDOG_REDIRECT", "-c",
             str(project / "src/watchdog.c"), "-o", str(build / "watchdog.o")])
        executable = build / "test_watchdog"
        run([*cc, *flags, str(project / "tests/test_watchdog.c"), str(build / "watchdog.o"),
             "-lpthread", "-o", str(executable)])
        cases = ("idle", "progress", "stall", "late_end", "multiple", "handles", "feed_fail",
                 "clock_fail", "clock_back", "open_fail", "set_fail", "start_fail", "verify_fail",
                 "capture_mode", "owned", "launch_fail", "slow_start",
                 "register_before_start", "register_delayed_success",
                 "register_delayed_failure", "register_start_timeout")
        for case in cases:
            run([str(executable), case])
    print(f"{len(cases)}项watchdog状态/设备交互测试通过；硬件复位仍须真机验证")


if __name__ == "__main__":
    main()
