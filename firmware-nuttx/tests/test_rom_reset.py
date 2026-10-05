import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "rom_reset", Path(__file__).resolve().parents[1] / "scripts/rom_reset.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeROM:
    CHIP_NAME = "ESP32-S3"
    RTCCNTL_BASE_REG = 0x60008000
    RTC_CNTL_OPTION1_REG = 0x6000812C
    RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 1
    RTC_CNTL_WDTWPROTECT_REG = 0x600080B0
    RTC_CNTL_WDT_WKEY = 0x50D83AA1
    RTC_CNTL_WDTCONFIG0_REG = 0x60008098

    def __init__(self, fail_at=None):
        self.calls = []
        self.fail_at = fail_at

    def write_reg(self, *args):
        self.calls.append(args)
        if len(self.calls) == self.fail_at:
            raise OSError("ROM communication failed")


class ResetTests(unittest.TestCase):
    def test_older_rom_without_watchdog_method(self):
        rom = FakeROM()
        with patch.object(module.time, "sleep") as sleep:
            module.reset_esp32s3(rom)
        self.assertEqual(rom.calls, [
            (0x6000812C, 0, 1), (0x600080B0, 0x50D83AA1),
            (0x6000809C, 2000), (0x60008098, 0xD0000102),
            (0x600080B0, 0),
        ])
        sleep.assert_called_once_with(0.5)

    def test_wrong_chip_never_written(self):
        rom = FakeROM(); rom.CHIP_NAME = "ESP32"
        with self.assertRaises(ValueError):
            module.reset_esp32s3(rom)
        self.assertFalse(rom.calls)

    def test_failed_force_download_clear_stops_reset(self):
        rom = FakeROM(fail_at=1)
        with self.assertRaises(OSError):
            module.reset_esp32s3(rom)
        self.assertEqual(len(rom.calls), 1)


if __name__ == "__main__":
    unittest.main()
