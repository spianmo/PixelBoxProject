#!/usr/bin/env python3
from pathlib import Path
import importlib.util
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tls_build_patch", ROOT / "scripts/tls_build_patch.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
BASE = 'CFLAGS += -DMBEDTLS_CONFIG_FILE="<mbedtls/esp_config.h>"\nCHIP_CSRCS += pk_ecc.c\n'


class PatchTests(unittest.TestCase):
    def test_minimal_and_idempotent(self):
        result = MODULE.patch_source(BASE)
        self.assertEqual(MODULE.patch_source(result), result)
        for name in MODULE.SOURCES:
            self.assertEqual(result.count("CHIP_CSRCS += " + name + "\n"), 1)
        self.assertTrue(result.startswith(BASE))

    def test_drift(self):
        for value in ("", BASE + BASE, BASE + "CHIP_CSRCS += ssl_tls.c\n",
                      BASE + MODULE.MARKER + "\n"):
            with self.assertRaises(ValueError):
                MODULE.patch_source(value)

    def test_check_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / MODULE.RELATIVE
            path.parent.mkdir(parents=True)
            path.write_text(BASE)
            self.assertTrue(MODULE.apply_tls_build_patch(directory, check=True))
            self.assertEqual(path.read_text(), BASE)
            self.assertTrue(MODULE.apply_tls_build_patch(directory))
            self.assertFalse(MODULE.apply_tls_build_patch(directory))

    def test_reject_upstream_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            upstream = root / ".deps/nuttx"
            upstream.mkdir(parents=True)
            with self.assertRaises(ValueError):
                MODULE.apply_tls_build_patch(upstream)
            outside = root / "outside.mk"
            outside.write_text(BASE)
            target = root / "snapshot" / MODULE.RELATIVE
            target.parent.mkdir(parents=True)
            target.symlink_to(outside)
            with self.assertRaises(ValueError):
                MODULE.apply_tls_build_patch(root / "snapshot")


if __name__ == "__main__":
    unittest.main()
