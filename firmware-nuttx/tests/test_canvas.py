#!/usr/bin/env python3
"""以真实 Canvas 类和原生 fillRects 执行 UBSan 边界/像素等价测试。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host_build", type=Path)
    parser.add_argument("--optimize", choices=["0", "2", "3"], default="2")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    build = args.host_build.resolve()
    prelude = (project / "src/prelude.js").read_text()
    canvas = prelude[prelude.index("  class Canvas {"):prelude.index("  const drawMethods =")]
    with tempfile.TemporaryDirectory(prefix="px-canvas-tests-") as directory:
        binary = Path(directory) / "canvas"
        script = Path(directory) / "canvas.js"
        script.write_text(canvas + "\n" + (project / "tests/test_canvas.js").read_text() + "\n" +
                          (project / "tests/test_canvas_layers.js").read_text() + "\n" +
                          (project / "tests/test_canvas_text.js").read_text() + "\n" +
                          (project / "tests/test_canvas_restore.js").read_text() + "\n" +
                          (project / "tests/test_canvas_rows.js").read_text() + "\n" +
                          (project / "tests/test_canvas_blocks.js").read_text() + "\n{\nconst screen=new Canvas(8,8);\n" +
                          (project / "src/prelude_image.js").read_text() + "\n" +
                          (project / "tests/test_canvas_blit.js").read_text() + "\n}\n" +
                          (project / "tests/test_canvas_clear.js").read_text() + "\n")
        command = [*shlex.split(os.environ.get("CC", "cc")), "-std=gnu11", "-O" + args.optimize, "-g",
                   "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
                   "-DPX_TEST_CANVAS", "-DPX_TEST_CANVAS_TEXT", "-I" + str(build / "generated/quickjs-ng"),
                   "-I" + str(build / "generated"),
                   "-I" + str(project / "include"),
                   str(project / "src/canvas.c"), str(project / "tests/test_projection.c"),
                   str(project / "src/text.c"), str(project / "src/text_binding.c"),
                   str(build / "generated/pxfont.c"),
                   str(build / "libpixelbox_quickjs.a"), "-lpthread", "-lm", "-o", str(binary)]
        subprocess.run(command, check=True, timeout=60)
        subprocess.run([str(binary), str(script)], check=True, timeout=60)
        # 独立数值压力测试直接包含真实canvas.c，验证Float认证的每一个被接受端点。
        math_binary = Path(directory) / "canvas-math"
        math_command = command[:command.index(str(project / "src/canvas.c"))] + [
            str(project / "tests/test_canvas_math.c"), str(build / "libpixelbox_quickjs.a"),
            "-lpthread", "-lm", "-o", str(math_binary)]
        subprocess.run(math_command, check=True, timeout=60)
        subprocess.run([str(math_binary)], check=True, timeout=60)
        # 整数布局候选直接对照原Double裁剪/缩放，覆盖网格ULP与半像素边界。
        logical_binary = Path(directory) / "canvas-logical"
        logical_command = command[:command.index(str(project / "src/canvas.c"))] + [
            str(project / "tests/test_canvas_logical.c"), str(build / "libpixelbox_quickjs.a"),
            "-lpthread", "-lm", "-o", str(logical_binary)]
        subprocess.run(logical_command, check=True, timeout=60)
        subprocess.run([str(logical_binary)], check=True, timeout=60)


if __name__ == "__main__":
    main()
