"""无人值守刷写的故障边界：失败不继续写、不吞掉已校验阶段、不覆盖备份。"""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import flash_recover as recovery
from simple_boot_image import add_digest


def image():
    header = bytearray(24)
    header[0:2] = bytes((0xE9, 1))
    struct.pack_into("<H", header, 12, 9)
    data = header + struct.pack("<II", 0x3FC88000, 4) + b"test"
    checksum = 0xEF
    for value in b"test":
        checksum ^= value
    data += bytes(15 - len(data) % 16) + bytes((checksum,))
    data += struct.pack("<II", 0, 80) + bytes(80)
    return add_digest(bytes(data))


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "image.bin"
        self.source.write_bytes(image())
        self.output = self.root / "attempt"
        self.phases = []
        self.heap_patcher = patch.object(recovery, "validate_heap_evidence",
                                         return_value={"pass": True, "tail_bytes": 19920})
        self.heap_gate = self.heap_patcher.start()
        self.addCleanup(self.heap_patcher.stop)

    def tearDown(self):
        self.temporary.cleanup()

    def step(self, output, port, baud, phase, arguments):
        self.phases.append(phase)
        if phase == "backup":
            Path(arguments[-1]).write_bytes(bytes(int(arguments[-2], 0)))
        if phase in ("write", "verify"):
            self.assertEqual(Path(arguments[-1]).read_bytes(), image())
            self.assertEqual(arguments[-2], "0")

    def run_recovery(self, step=None):
        with patch.object(recovery, "esptool_step", side_effect=step or self.step), \
             patch.object(recovery, "reboot_rom") as reset, \
             patch.object(recovery, "wait_for_nsh") as wait:
            result = recovery.recover(self.source, "/dev/cu.fixture", self.output)
        return result, reset, wait

    def test_invalid_or_oversized_image_never_opens_transport(self):
        for data in (b"broken", image() + bytes(recovery.STORAGE_OFFSET)):
            self.source.write_bytes(data)
            with patch.object(recovery, "esptool_step") as step:
                with self.assertRaises(ValueError):
                    recovery.recover(self.source, "/dev/cu.fixture", self.output)
                step.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_short_backup_prevents_flash(self):
        def short(output, port, baud, phase, arguments):
            self.phases.append(phase)
            Path(arguments[-1]).write_bytes(b"partial")
        with self.assertRaisesRegex(ValueError, "备份分块长度不完整"):
            self.run_recovery(short)
        self.assertEqual(self.phases, ["backup"])

    def test_verify_failure_keeps_written_state_and_skips_reset(self):
        def failed(output, port, baud, phase, arguments):
            self.step(output, port, baud, phase, arguments)
            if phase == "verify":
                raise RuntimeError("verify failed")
        with patch.object(recovery, "esptool_step", side_effect=failed), \
             patch.object(recovery, "reboot_rom") as reset:
            with self.assertRaisesRegex(RuntimeError, "verify failed"):
                recovery.recover(self.source, "/dev/cu.fixture", self.output)
            reset.assert_not_called()
        self.assertEqual(json.loads((self.output / "state.json").read_text())["phase"], "written")

    def test_reset_failure_retains_verified_firmware(self):
        with patch.object(recovery, "esptool_step", side_effect=self.step), \
             patch.object(recovery, "reboot_rom", side_effect=OSError("USB re-enumerated")):
            with self.assertRaises(OSError):
                recovery.recover(self.source, "/dev/cu.fixture", self.output)
        self.assertEqual(json.loads((self.output / "state.json").read_text())["phase"], "verified")

    def test_success_uses_immutable_snapshot(self):
        def change_source(output, port, baud, phase, arguments):
            self.step(output, port, baud, phase, arguments)
            if phase == "backup":
                self.source.write_bytes(b"changed while flashing")
        result, reset, wait = self.run_recovery(change_source)
        self.assertEqual(self.phases, ["backup", "write", "verify"])
        self.assertEqual(result["phase"], "booted")
        reset.assert_called_once()
        wait.assert_called_once()
        self.heap_gate.assert_called_once_with(self.source, self.output / "firmware.bin")
        self.assertEqual(result["internalHeap"]["tail_bytes"], 19920)

    def test_heap_failure_never_touches_device(self):
        self.heap_gate.side_effect = ValueError("内部堆越过 ROM 保留区")
        with patch.object(recovery, "backup_flash") as backup, \
             patch.object(recovery, "esptool_step") as step, \
             patch.object(recovery, "reboot_rom") as reset:
            with self.assertRaisesRegex(ValueError, "内部堆越过"):
                recovery.recover(self.source, "/dev/cu.fixture", self.output)
        backup.assert_not_called()
        step.assert_not_called()
        reset.assert_not_called()
        state = json.loads((self.output / "state.json").read_text())
        self.assertEqual(state["phase"], "prepared")
        self.assertIn("内部堆越过", state["error"])

    def test_heap_gate_checks_snapshot_before_backup(self):
        def validate(source, staged):
            self.assertEqual(source, self.source)
            self.assertEqual(staged.read_bytes(), image())
            self.assertEqual(self.phases, [])
            return {"pass": True}
        self.heap_gate.side_effect = validate
        self.run_recovery()

    def test_existing_evidence_directory_is_preserved(self):
        self.output.mkdir()
        previous = self.output / "backup.bin"
        previous.write_bytes(b"previous")
        with patch.object(recovery, "esptool_step") as step:
            with self.assertRaises(FileExistsError):
                recovery.recover(self.source, "/dev/cu.fixture", self.output)
            step.assert_not_called()
        self.assertEqual(previous.read_bytes(), b"previous")

    def test_reset_only_never_reads_or_writes_flash(self):
        with patch.object(recovery, "esptool_step") as step, \
             patch.object(recovery, "reboot_rom") as reset, \
             patch.object(recovery, "wait_for_nsh"):
            state = recovery.recover(None, "/dev/cu.fixture", self.output)
        step.assert_not_called()
        reset.assert_called_once()
        self.assertEqual(state["phase"], "booted")
        self.heap_gate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
