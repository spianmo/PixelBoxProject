#!/usr/bin/env python3
"""验证 AXP2101 只读电池路径、PKEY IRQ 消费与纯 GPIO 按键状态机。"""
from __future__ import annotations

import argparse
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
    parser.add_argument("--ubsan", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pixelbox-power-test-") as directory:
        build = Path(directory)
        for folder in ["nuttx/i2c", "nuttx/fs"]:
            (build / folder).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(project.parent / ".deps/nuttx/include/nuttx/i2c/i2c_master.h",
                        build / "nuttx/i2c/i2c_master.h")
        (build / "nuttx/config.h").write_text("#define FAR\n#define CODE\n#define CONFIG_I2C_DRIVER 1\n")
        (build / "nuttx/fs/ioctl.h").write_text("#define _I2CIOC(n) (0x1000 + (n))\n")
        compiler = shlex.split(os.environ.get("CC", "cc"))
        flags = ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-pthread"]
        if args.ubsan:
            flags += ["-fsanitize=undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"]
        includes = ["-I" + str(build), "-I" + str(project / "include"),
                    "-I" + str(project / "tests")]
        run([*compiler, *flags, *includes, "-c", str(project / "src/power.c"),
             "-o", str(build / "power_host.o")])
        executable = build / "test_power"
        run([*compiler, *flags, *includes, "-DPX_POWER_TEST",
             str(project / "src/power.c"), str(project / "tests/test_power.c"),
             "-o", str(executable)])
        run([str(executable)])
        file_executable = build / "test_power_file"
        run([*compiler, *flags, *includes, "-DPX_POWER_TEST_FILE",
             str(project / "src/power.c"), str(project / "tests/test_power.c"),
             "-o", str(file_executable)])
        run([str(file_executable)])


if __name__ == "__main__":
    main()
