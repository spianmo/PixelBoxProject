#!/usr/bin/env python3
"""用现成独立宿主 QuickJS 归档验证当前原生投影源文件，含 UBSan。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host_build", type=Path)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    build = args.host_build.resolve()
    with tempfile.TemporaryDirectory(prefix="px-projection-tests-") as directory:
        binary = Path(directory) / "projection"
        command = [*shlex.split(os.environ.get("CC", "cc")), "-std=gnu11", "-O2", "-g",
                   "-DPX_TEST_PROJECTION",
                   "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
                   "-I" + str(build / "generated/quickjs-ng"), "-I" + str(project / "include"),
                   str(project / "src/projection.c"),
                   str(project / "tests/test_projection.c"), str(build / "libpixelbox_quickjs.a"),
                   "-lpthread", "-lm", "-o", str(binary)]
        subprocess.run(command, check=True, timeout=60)
        subprocess.run([str(binary), str(project / "tests/test_projection.js")], check=True, timeout=60)


if __name__ == "__main__":
    main()
