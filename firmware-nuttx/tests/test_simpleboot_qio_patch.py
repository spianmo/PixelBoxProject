"""验证模式隔离、完整接线、幂等与漂移拒绝；不连接设备。"""
from pathlib import Path
import importlib.util
import tempfile
import subprocess
import unittest

path = Path(__file__).resolve().parents[1] / "scripts/simpleboot_qio_patch.py"
spec = importlib.util.spec_from_file_location("simpleboot_qio_patch", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class QioPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        files = {
            m.SDK: '#include <nuttx/config.h>\n#define CONFIG_ESPTOOLPY_FLASHMODE_DIO 1\n#define CONFIG_FLASHMODE_DIO CONFIG_ESPTOOLPY_FLASHMODE_DIO\n#define CONFIG_ESPTOOLPY_FLASHMODE "dio"\n#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT\n' + m.SDK_ANCHOR,
            m.MAKE: m.MAKE_ANCHOR + '  CHIP_CSRCS += existing.c\nendif\n',
            m.IMAGE: """ifeq ($(CONFIG_ESP32S3_FLASH_MODE_DIO),y)
FLASH_MODE := dio
else ifeq ($(CONFIG_ESP32S3_FLASH_MODE_DOUT),y)
FLASH_MODE := dout
else ifeq ($(CONFIG_ESP32S3_FLASH_MODE_QIO),y)
FLASH_MODE := qio
else ifeq ($(CONFIG_ESP32S3_FLASH_MODE_QOUT),y)
FLASH_MODE := qout
endif
""" + m.IMAGE_ANCHOR,
            m.LINK: ''.join('    *libarch.a:*bootloader_flash_config_esp32s3.*' + suffix + '\n' for suffix in ['(.text .text.* .literal .literal.*)', '(.rodata .rodata.*)']),
            m.QIO: 'void bootloader_enable_qio_mode(void) { ESP_LOGI(TAG, "QIO"); ESP_LOGE(TAG, "failed"); }\n',
            m.WRAP: '/* same-version upstream source */\n',
        }
        for rel, content in files.items():
            p = self.tree / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

    def test_complete_wiring_and_idempotence(self):
        self.assertEqual(len(m.patch(self.tree)), 5)
        self.assertEqual(m.patch(self.tree), [])
        sdk = (self.tree / m.SDK).read_text()
        self.assertIn('defined(CONFIG_ESPRESSIF_SIMPLE_BOOT) && defined(CONFIG_ESP32S3_FLASH_MODE_QIO)', sdk)
        self.assertIn('#define CONFIG_ESPTOOLPY_FLASHMODE "dio"', sdk)
        self.assertIn('#  undef CONFIG_FLASHMODE_DIO', sdk)
        self.assertIn('#  define CONFIG_FLASHMODE_QIO CONFIG_ESPTOOLPY_FLASHMODE_QIO', sdk)
        image = (self.tree / m.IMAGE).read_text()
        self.assertIn('ifeq ($(CONFIG_ESPRESSIF_SIMPLE_BOOT)$(CONFIG_ESP32S3_FLASH_MODE_QIO),yy)', image)
        for name in ['flash_qio_mode', 'spi_flash_wrap']:
            self.assertEqual((self.tree / m.LINK).read_text().count('*' + name + '.*'), 2)
        self.assertNotIn('ESP_LOG', (self.tree / m.QIO).read_text())
        self.assertIn('ESP_EARLY_LOG', (self.tree / m.QIO).read_text())

    def test_cpp_and_make_mode_matrix(self):
        m.patch(self.tree)
        include = self.tree / "include"
        (include / "nuttx").mkdir(parents=True)
        for simple in (False, True):
            for mode in ("DIO", "DOUT", "QIO", "QOUT"):
                with self.subTest(simpleboot=simple, mode=mode):
                    # 执行真实预处理器，而非只检查分支字符串存在。
                    defines = ("#define CONFIG_ESPRESSIF_SIMPLE_BOOT 1\n" if simple else "")
                    defines += "#define CONFIG_ESP32S3_FLASH_MODE_" + mode + " 1\n"
                    (include / "nuttx/config.h").write_text(defines)
                    result = subprocess.run(
                        ["cc", "-E", "-dM", "-x", "c", "-I" + str(include),
                         "-include", str(self.tree / m.SDK), "-"],
                        input="", text=True, capture_output=True, check=True, timeout=60)
                    macros = dict(line.removeprefix("#define ").split(" ", 1)
                                  for line in result.stdout.splitlines()
                                  if line.startswith("#define ") and " " in line.removeprefix("#define "))
                    qio = simple and mode == "QIO"
                    self.assertEqual("CONFIG_ESPTOOLPY_FLASHMODE_QIO" in macros, qio)
                    self.assertEqual("CONFIG_ESPTOOLPY_FLASHMODE_DIO" in macros, not qio)
                    self.assertEqual("CONFIG_FLASHMODE_QIO" in macros, qio)
                    self.assertEqual("CONFIG_FLASHMODE_DIO" in macros, not qio)
                    self.assertEqual(macros["CONFIG_ESPTOOLPY_FLASHMODE"], '"dio"')
                    # 使用与上游相同的原模式选择，再让GNU make实际求值补丁条件。
                    config = ("CONFIG_ESPRESSIF_SIMPLE_BOOT=y\n" if simple else "")
                    config += "CONFIG_ESP32S3_FLASH_MODE_" + mode + "=y\n"
                    query = self.tree / "query.mk"
                    query.write_text(config + "include " + str(self.tree / m.IMAGE)
                                     + '\nall:\n\t@printf "%s\\n" "$(FLASH_MODE)"\n')
                    result = subprocess.run(
                        ["make", "--no-print-directory", "-f", str(query), "all"],
                        text=True, capture_output=True, check=True, timeout=60)
                    self.assertEqual(result.stdout.strip(), "dio" if qio else mode.lower())

    def test_drift_rejected_without_partial_write(self):
        (self.tree / m.LINK).write_text('unknown upstream linker')
        before = {p: p.read_bytes() for p in self.tree.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError):
            m.patch(self.tree)
        self.assertEqual(before, {p: p.read_bytes() for p in self.tree.rglob('*') if p.is_file()})

    def test_missing_wrap_rejected(self):
        # 重定向到一个不存在的源码路径，避免删除文件。
        old = m.WRAP
        try:
            m.WRAP = 'missing.c'
            with self.assertRaises(ValueError):
                m.patch(self.tree)
        finally:
            m.WRAP = old


if __name__ == '__main__':
    unittest.main()
