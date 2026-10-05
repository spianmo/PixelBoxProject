#!/usr/bin/env python3
"""检查字体输入校验、导出快照的独立性与生成文件的稳定性。"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import struct
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parent
SOURCE = REPOSITORY / "firmware/components/hal_display"
SPEC = importlib.util.spec_from_file_location("prepare_text", PROJECT / "tools/prepare_text.py")
assert SPEC and SPEC.loader
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PrepareTextTests(unittest.TestCase):
    def test_reject_invalid_font_records(self) -> None:
        data = (SOURCE / "fonts/pixel8.pxf").read_bytes()
        PREPARE.validate_font(data, "pixel8")
        for mutation in (b"bad", data[:-1], b"NOPE" + data[4:]):
            with self.assertRaises(ValueError):
                PREPARE.validate_font(mutation, "damaged")
        duplicate = bytearray(data)
        duplicate[24:26] = duplicate[16:18]
        with self.assertRaises(ValueError):
            PREPARE.validate_font(duplicate, "duplicate")
        outside = bytearray(data)
        struct.pack_into("<I", outside, 20, 0xffffffff)
        with self.assertRaises(ValueError):
            PREPARE.validate_font(outside, "outside")

    def test_repository_generation_is_complete_and_stable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pixelbox-font-prepare-") as directory:
            output = Path(directory) / "generated"
            PREPARE.prepare(PROJECT, REPOSITORY, output)
            expected = ["pxfont.c", "hal_display/pxfont.h", "pixelbox_fonts.h",
                        "licenses/pixelbox-pxfont-LICENSE", "licenses/fusion-pixel-OFL.txt",
                        "licenses/FONT-SOURCES.md"]
            snapshots = {name: ((output / name).read_bytes(), (output / name).stat().st_mtime_ns)
                         for name in expected}
            self.assertEqual((output / "pxfont.c").read_bytes(), (SOURCE / "src/pxfont.c").read_bytes())
            self.assertEqual((output / "hal_display/pxfont.h").read_bytes(),
                             (SOURCE / "include/hal_display/pxfont.h").read_bytes())
            header = (output / "pixelbox_fonts.h").read_text()
            for name in ("pixel8", "pixel12", "pixel16"):
                self.assertIn(f"_Alignas(4) static const unsigned char px_font_{name}[]", header)
            PREPARE.prepare(PROJECT, REPOSITORY, output)
            for name, (data, mtime) in snapshots.items():
                self.assertEqual((output / name).read_bytes(), data)
                self.assertEqual((output / name).stat().st_mtime_ns, mtime)

    def test_shared_cache_precedes_repository_and_works_standalone(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pixelbox-font-cache-") as directory:
            project = Path(directory) / "standalone"
            cached = project / "shared/hal_display"
            for name in ("src/pxfont.c", "include/hal_display/pxfont.h",
                         "fonts/pixel8.pxf", "fonts/pixel12.pxf", "fonts/pixel16.pxf"):
                target = cached / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(SOURCE / name, target)
            with (cached / "src/pxfont.c").open("a") as stream:
                stream.write("\n/* 独立缓存标记 */\n")
            shutil.copyfile(REPOSITORY / "LICENSE", cached / "LICENSE")
            shutil.copyfile(REPOSITORY / "tools/fontgen/README.md", cached / "FONT-SOURCES.md")
            shutil.copyfile(REPOSITORY / "simulator/src/renderer/src/device-sim/sandbox/fonts/OFL.txt",
                            cached / "fonts/OFL.txt")
            for repo_root in (REPOSITORY, Path(directory) / "missing-repository"):
                output = project / "generated"
                PREPARE.prepare(project, repo_root, output)
                self.assertIn("独立缓存标记", (output / "pxfont.c").read_text())
                self.assertTrue((output / "licenses/fusion-pixel-OFL.txt").is_file())


if __name__ == "__main__":
    unittest.main()
