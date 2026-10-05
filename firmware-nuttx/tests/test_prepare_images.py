#!/usr/bin/env python3
"""验证图片解码依赖的可重复生成、缓存优先、补丁漂移检查和许可保留。"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parent
VENDOR = REPOSITORY / "firmware/components/hal_display/vendor"
JPEG = REPOSITORY / "firmware/managed_components/espressif__esp_jpeg/tjpgd"
SPEC = importlib.util.spec_from_file_location("prepare_images", PROJECT / "tools/prepare_images.py")
assert SPEC and SPEC.loader
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PrepareImageTests(unittest.TestCase):
    def test_complete_and_repeatable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pixelbox-image-prepare-") as directory:
            output = Path(directory) / "generated"
            PREPARE.prepare(PROJECT, REPOSITORY, output)
            expected = ["images/" + name for name in
                        ("pngle.c", "pngle.h", "miniz.c", "miniz.h", "gifdec.c", "gifdec.h",
                         "tjpgd.c", "tjpgd.h", "tjpgdcnf.h", "README.md")]
            expected += ["licenses/image-vendor-README.md", "licenses/tjpgd-LICENSE.txt"]
            snapshots = {name: ((output / name).read_bytes(), (output / name).stat().st_mtime_ns)
                         for name in expected}
            self.assertIn(b"Copyright", snapshots["licenses/tjpgd-LICENSE.txt"][0])
            self.assertNotIn(b"sdkconfig", (output / "images/tjpgdcnf.h").read_bytes().split(b"*/", 1)[1])
            PREPARE.prepare(PROJECT, REPOSITORY, output)
            for name, (data, mtime) in snapshots.items():
                self.assertEqual((output / name).read_bytes(), data)
                self.assertEqual((output / name).stat().st_mtime_ns, mtime)

    def test_shared_cache_and_standalone(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pixelbox-image-cache-") as directory:
            project = Path(directory) / "standalone"
            cache = project / "shared/hal_display/vendor"
            cache.mkdir(parents=True)
            for name in ("pngle.c", "pngle.h", "miniz.c", "miniz.h", "gifdec.c", "gifdec.h", "README.md"):
                shutil.copyfile(VENDOR / name, cache / name)
            jpeg_cache = project / "shared/tjpgd"
            jpeg_cache.mkdir(parents=True)
            for name in ("tjpgd.c", "tjpgd.h"):
                shutil.copyfile(JPEG / name, jpeg_cache / name)
            with (cache / "pngle.c").open("a") as stream:
                stream.write("\n/* 独立缓存标记 */\n")
            for repo in (REPOSITORY, Path(directory) / "missing-repository"):
                output = project / "generated"
                PREPARE.prepare(project, repo, output)
                self.assertIn("独立缓存标记", (output / "images/pngle.c").read_text())

    def test_upstream_drift_rejected(self) -> None:
        cases = [(PREPARE.adapt_pngle, VENDOR / "pngle.c", "size_t  avail_out;"),
                 (PREPARE.adapt_gifdec, VENDOR / "gifdec.c", "if (n > avail) n = avail;"),
                 (PREPARE.adapt_jpeg, JPEG / "tjpgd.c", "tmp[0] = d * dqf[0] >> 8;")]
        for adapt, path, anchor in cases:
            original = path.read_text()
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    adapt(original.replace(anchor, "/* 上游锚点变化 */", 1))
                with self.assertRaises(ValueError):
                    adapt(original + "\n" + anchor)


if __name__ == "__main__":
    unittest.main()
