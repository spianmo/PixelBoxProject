#!/usr/bin/env python3
"""编译纯C图片模块，以Pillow独立解码结果验证像素/透明度/GIF disposal；每命令限60秒。"""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import shlex
import struct
import subprocess
import sys
import tempfile
import zlib

from PIL import Image, ImageSequence


def command(arguments: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(arguments, check=False, timeout=60, capture_output=capture)
    if result.returncode and capture and result.stderr:
        sys.stderr.buffer.write(result.stderr)
    result.check_returncode()
    return result


def fixtures(directory: Path) -> list[tuple[str, int]]:
    rgb = Image.new("RGB", (17, 13))
    rgb.putdata([((x * 17) % 256, (y * 29) % 256, (x * 7 + y * 13) % 256)
                 for y in range(13) for x in range(17)])
    rgb.save(directory / "rgb.png")
    alpha = rgb.convert("RGBA")
    alpha.putdata([(r, g, b, [0, 1, 127, 128, 200, 255][index % 6])
                   for index, (r, g, b, _) in enumerate(alpha.get_flattened_data())])
    alpha.save(directory / "alpha.png")
    palette = rgb.quantize(colors=8)
    palette.save(directory / "palette.png", transparency=bytes([0, 127, 128, 255, 255, 255, 255, 255]))
    rgb.convert("L").save(directory / "gray.png")
    rgb.save(directory / "444.jpg", quality=98, subsampling=0)
    Image.new("RGB", (19, 11), (180, 40, 70)).save(directory / "420.jpg", quality=98, subsampling=2)
    rgb.convert("L").save(directory / "gray.jpg", quality=98)
    rgb.save(directory / "progressive.jpg", progressive=True)
    rgb.save(directory / "unsupported.bmp")

    # 明确生成Adam7数据，避免依赖Pillow编码器是否采纳interlace选项。
    def chunk(name: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload))
    passes = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
              (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    scanlines = bytearray()
    for x0, y0, dx, dy in passes:
        for y in range(y0, alpha.height, dy):
            scanlines.append(0)
            for x in range(x0, alpha.width, dx):
                scanlines.extend(alpha.getpixel((x, y)))
    ihdr = struct.pack(">IIBBBBB", alpha.width, alpha.height, 8, 6, 0, 0, 1)
    adam7 = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
    (directory / "adam7.png").write_bytes(adam7)

    colors = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * (256 * 3 - 12)
    frames = []
    for index in range(4):
        frame = Image.new("P", (16, 12), 1 if index == 0 else 0)
        frame.putpalette(colors)
        if index: frame.paste(index, (index, index, 8 + index, 7 + index))
        frames.append(frame)
    frames[0].save(directory / "animation.gif", save_all=True, append_images=frames[1:],
                   duration=[0, 20, 150, 30], loop=0, transparency=0, disposal=[1, 2, 3, 1], optimize=False)
    big = Image.new("RGB", (33, 25))
    big.putdata([((x * 13 + y * 19) % 256, (x * 7 + y * 29) % 256, (x * 31 + y * 3) % 256)
                 for y in range(25) for x in range(33)])
    big.quantize(colors=256).save(directory / "interlaced.gif", interlace=True)
    # 第二帧故意没有GCE，验证它不继承上一帧透明索引和20ms延迟。
    header = b"GIF89a\x02\x00\x01\x00\x80\x00\x00" + b"\x00\x00\x00\xff\x00\x00"
    image_descriptor = b"\x2c\x00\x00\x00\x00\x02\x00\x01\x00\x00"
    first_frame = b"\x21\xf9\x04\x05\x02\x00\x00\x00" + image_descriptor + b"\x02\x02\x0c\x0a\x00"
    second_frame = image_descriptor + b"\x02\x02\x44\x0a\x00"
    (directory / "without-gce.gif").write_bytes(header + first_frame + second_frame + b"\x3b")
    return [("rgb.png", 0), ("alpha.png", 0), ("palette.png", 0), ("gray.png", 0),
            ("adam7.png", 0), ("444.jpg", 4), ("420.jpg", 4), ("gray.jpg", 3)]


def frames_from_output(data: bytes) -> list[tuple[int, int, int, bytes]]:
    frames = []
    offset = 0
    while offset < len(data):
        width, height, delay = struct.unpack_from("<III", data, offset)
        offset += 12
        count = width * height * 4
        assert offset + count <= len(data)
        frames.append((width, height, delay, data[offset:offset + count]))
        offset += count
    return frames


def compare(actual: tuple[int, int, int, bytes], expected: Image.Image, tolerance: int,
            delay: int = 0, opaque: bool = False) -> None:
    width, height, actual_delay, pixels = actual
    assert (width, height) == expected.size
    assert actual_delay == delay, (actual_delay, delay)
    reference = expected.convert("RGBA").tobytes()
    for index in range(width * height):
        a = pixels[index * 4:index * 4 + 4]
        b = reference[index * 4:index * 4 + 4]
        assert max(abs(a[channel] - b[channel]) for channel in range(3)) <= tolerance, (index, a, b)
        assert a[3] == (255 if opaque or b[3] >= 128 else 0), (index, a, b)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", choices=("undefined", "address,undefined"))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="pixelbox-images-test-") as temporary:
        directory = Path(temporary)
        generated = directory / "generated"
        command([sys.executable, str(project / "tools/prepare_images.py"), "--output", str(generated)])
        flags = ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror"]
        if args.sanitize:
            flags.extend(["-fsanitize=" + args.sanitize, "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"])
        objects = []
        sources = [project / "src/image.c", project / "tests/test_images.c"]
        sources.extend(generated / "images" / name for name in ("pngle.c", "miniz.c", "gifdec.c", "tjpgd.c"))
        for source in sources:
            output = directory / (source.stem + ".o")
            command([*shlex.split(os.environ.get("CC", "cc")), *flags,
                     "-I" + str(project / "include"), "-I" + str(generated / "images"),
                     "-c", str(source), "-o", str(output)])
            objects.append(str(output))
        executable = directory / "test_images"
        command([*shlex.split(os.environ.get("CC", "cc")), *flags, *objects, "-lm", "-o", str(executable)])
        cases = fixtures(directory)
        for name, tolerance in cases:
            decoded = frames_from_output(command([str(executable), "static", str(directory / name)], True).stdout)
            assert len(decoded) == 1
            with Image.open(directory / name) as expected:
                compare(decoded[0], expected, tolerance)
            print("静态像素通过:", name, flush=True)
        for name in ("animation.gif", "interlaced.gif"):
            actual = frames_from_output(command([str(executable), "gif", str(directory / name)], True).stdout)
            with Image.open(directory / name) as reference:
                expected = [(frame.copy(), frame.info.get("duration", 0) or 100)
                            for frame in ImageSequence.Iterator(reference)]
            assert len(actual) == len(expected)
            for frame, (reference, delay) in zip(actual, expected):
                compare(frame, reference, 0, delay, True)
            static = frames_from_output(command([str(executable), "static", str(directory / name)], True).stdout)
            assert static == actual[:1]
            print("GIF像素/disposal/时长通过:", name, len(actual), flush=True)
        keyed = frames_from_output(command([str(executable), "static", str(directory / "rgb.png"), "0"], True).stdout)[0]
        assert keyed[3][3] == 0 and keyed[3][7] == 255
        no_gce = frames_from_output(command([str(executable), "gif", str(directory / "without-gce.gif")], True).stdout)
        assert [frame[2] for frame in no_gce] == [20, 100]
        assert no_gce[0][3] == b"\xff\x00\x00\xff\x00\x00\x00\xff"
        assert no_gce[1][3] == b"\x00\x00\x00\xff\xff\x00\x00\xff"
        print("GIF无GCE帧透明/时长重置通过", flush=True)
        for name in ("progressive.jpg", "unsupported.bmp"):
            result = subprocess.run([str(executable), "static", str(directory / name)], capture_output=True, timeout=60)
            assert result.returncode == 1 and b"image error:" in result.stderr
        for name in ("rgb.png", "444.jpg", "animation.gif"):
            command([str(executable), "limits", str(directory / name)])
            command([str(executable), "truncated", str(directory / name)])
            command([str(executable), "mutated", str(directory / name)])
            print("资源上限/全部截断前缀/2000次变异通过:", name, flush=True)
        print("图片模块回归全部通过。", flush=True)


if __name__ == "__main__":
    main()
