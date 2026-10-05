#!/usr/bin/env python3
"""内部堆构建门禁边界回归；不构建固件、不访问串口。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check_internal_heap.py"
SPEC = importlib.util.spec_from_file_location("internal_heap", SCRIPT)
HEAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEAP)
CONFIG = '''CONFIG_ARCH_CHIP="esp32s3"
CONFIG_ARCH_CHIP_ESP32S3=y
CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=y
CONFIG_XTENSA_IMEM_REGION_SIZE=0x38000
'''


class InternalHeapTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pixelbox-heap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.elf = self.root / "nuttx.elf"
        self.elf.write_bytes(b"ELF fixture; nm output is explicitly mocked")
        self.config = self.root / ".config"
        self.config.write_text(CONFIG)

    def inspect(self, address=0x3FCB0000, endpoint=0x3FCEEE34, minimum=4096, output=None):
        if output is None:
            output = f"_sheap B {address:x}\n"
        with patch.object(HEAP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")):
            return HEAP.inspect_heap(self.elf, self.config, endpoint, minimum)

    def test_success(self):
        result = self.inspect()
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["pass"])
        self.assertEqual(result["heap_end"], 0x3FCE8000)
        self.assertEqual(result["tail_bytes"], 0x6E34)

    def test_overlap(self):
        result = self.inspect(address=0x3FCB7764)
        self.assertEqual(result["status"], "fail")
        self.assertFalse(result["pass"])
        self.assertEqual(result["tail_bytes"], -2352)

    def test_insufficient_tail(self):
        result = self.inspect(endpoint=0x3FCE8FFF)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["tail_bytes"], 4095)

    def test_exact_boundary(self):
        result = self.inspect(endpoint=0x3FCE9000)
        self.assertTrue(result["pass"])
        self.assertEqual(result["tail_bytes"], 4096)

    def test_invalid_config(self):
        invalid = [CONFIG.replace("0x38000", value) for value in ("0", "-1", "garbage", "0x100000000", "", '"4096"')]
        invalid += [CONFIG.replace("CONFIG_ARCH_CHIP_ESP32S3=y", "CONFIG_ARCH_CHIP_ESP32S3=n"),
                    CONFIG.replace('CONFIG_ARCH_CHIP="esp32s3"\n', ""),
                    CONFIG.replace('"esp32s3"', '"esp32"'),
                    CONFIG.replace("CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=y", "CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=n"),
                    CONFIG + "CONFIG_XTENSA_IMEM_REGION_SIZE=4096\n",
                    CONFIG.replace("CONFIG_XTENSA_IMEM_REGION_SIZE=0x38000\n", "")]
        for contents in invalid:
            with self.subTest(contents=contents):
                self.config.write_text(contents)
                self.assertEqual(self.inspect()["status"], "error")

    def test_missing_symbol(self):
        self.assertIn("found 0", self.inspect(output="other B 3fcb0000\n")["error"])

    def test_duplicate_symbol(self):
        self.assertIn("found 2", self.inspect(output="_sheap B 3fcb0000\n_sheap B 3fcb0000\n")["error"])

    def test_invalid_symbol(self):
        for output in ("_sheap U\n", "_sheap B xyz\n", "_sheap B 0\n", "_sheap B 100000000\n"):
            with self.subTest(output=output):
                self.assertEqual(self.inspect(output=output)["status"], "error")

    def test_positive_config_and_address_validation(self):
        for value in (0, -1, "0x100000000", "nan", True):
            with self.subTest(value=value):
                self.assertEqual(self.inspect(endpoint=value)["status"], "error")
                self.assertEqual(self.inspect(minimum=value)["status"], "error")

    def test_overflow(self):
        self.assertIn("overflows", self.inspect(address=0xFFFF0000)["error"])
        self.assertIn("overflows", self.inspect(address=0xFFFC7000, minimum=0x2000)["error"])

    def test_nm_failure(self):
        with patch.object(HEAP.subprocess, "run", side_effect=subprocess.TimeoutExpired("nm", 30)):
            self.assertEqual(HEAP.inspect_heap(self.elf, self.config, 0x3FCEEE34)["status"], "error")

    def test_cli_json_and_exit_status(self):
        nm = self.root / "fake-nm"
        nm.write_text('#!/usr/bin/env python3\nprint("_sheap B 3fcb0000")\n')
        nm.chmod(0o700)
        for endpoint, expected in (("0x3FCE9000", 0), ("0x3FCE8FFF", 1), ("bad", 1)):
            with self.subTest(endpoint=endpoint):
                result = subprocess.run([sys.executable, str(SCRIPT), "--elf", str(self.elf),
                                         "--config", str(self.config), "--nm", str(nm),
                                         "--rom-reserved-start", endpoint],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(json.loads(result.stdout)["pass"], expected == 0)


if __name__ == "__main__":
    unittest.main()
