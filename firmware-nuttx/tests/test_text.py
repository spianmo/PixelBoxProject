#!/usr/bin/env python3
"""独立构建文字模块并对照原 ESP-IDF 字形算法；不使用共享构建目录。"""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import shlex
import subprocess
import sys
import tempfile


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, timeout=60)


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", nargs="?", const="address,undefined",
                        choices=("address", "undefined", "address,undefined"),
                        help="启用 sanitizer；可单独指定 undefined")
    args = parser.parse_args()
    source = project.parent / "firmware/components/hal_display"
    with tempfile.TemporaryDirectory(prefix="pixelbox-text-test-") as directory:
        build = Path(directory)
        generated = build / "generated"
        run([sys.executable, str(project / "tools/prepare_text.py"), "--output", str(generated)])
        # 直接提取原有文本实现，避免把被测算法复制到测试中自证正确。
        text = (source / "src/gfx.cpp").read_text()
        start = text.index("uint32_t utf8_next(")
        end = text.rindex("}  // namespace gfx")
        (build / "pixelbox_text_reference.inc").write_text("namespace gfx {\n" + text[start:end] + "\n}\n")
        flags = ["-O1", "-g", "-Wall", "-Wextra", "-Werror"]
        if args.sanitize:
            flags.extend([f"-fsanitize={args.sanitize}", "-fno-sanitize-recover=all",
                          "-fno-omit-frame-pointer"])
        includes = ["-I" + str(project / "include"), "-I" + str(generated),
                    "-I" + str(source / "include"), "-I" + str(build)]
        objects = []
        for c_source in [project / "src/text.c", generated / "pxfont.c"]:
            output = build / (c_source.stem + ".o")
            run([*shlex.split(os.environ.get("CC", "cc")), "-std=c11", *flags, *includes,
                 "-c", str(c_source), "-o", str(output)])
            objects.append(str(output))
        executable = build / "test_text"
        run([*shlex.split(os.environ.get("CXX", "c++")), "-std=c++17", *flags, *includes,
             str(project / "tests/test_text.cpp"), *objects, "-o", str(executable)])
        # 每种字体独立进程，保留全部案例并限制每一组在 60 秒内完成。
        for name in ("pixel8", "pixel12", "pixel16"):
            run([str(executable), str(source / "fonts"), name])


if __name__ == "__main__":
    main()
