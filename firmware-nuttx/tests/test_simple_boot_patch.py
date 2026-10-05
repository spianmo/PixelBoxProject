#!/usr/bin/env python3
"""验证应用交接顺序、隔离修补边界，以及官方函数只修改两个毛刺位。"""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("simple_boot_patch", ROOT / "scripts/simple_boot_patch.py")
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)
BASE = patch.INCLUDE_OLD + "\n\nvoid start(void)\n{\n" + patch.START_OLD + "\n}\n"


class SimpleBootPatchTests(unittest.TestCase):
    def test_sdk_patch_is_minimal_and_idempotent(self):
        source = ROOT.parent / ".deps/nuttx" / patch.RELATIVE
        original = source.read_text()
        updated = patch.patch_source(original)
        self.assertEqual(patch.patch_source(updated), updated)
        self.assertEqual(updated.replace(patch.INCLUDE_NEW, patch.INCLUDE_OLD)
                         .replace(patch.START_NEW, patch.START_OLD), original)
        self.assertEqual(source.read_text(), original)

    def test_drift_and_partial_patches_fail_without_write(self):
        malformed = ("", BASE + BASE, BASE.replace(patch.START_OLD, "other startup"),
                     BASE.replace(patch.INCLUDE_OLD, patch.INCLUDE_NEW),
                     patch.patch_source(BASE).replace("config(false);", "config(true);"),
                     patch.patch_source(BASE) + "bootloader_ana_clock_glitch_reset_config(false);\n")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / patch.RELATIVE
            target.parent.mkdir(parents=True)
            for source in malformed:
                target.write_text(source)
                with self.subTest(source=source[:40]):
                    with self.assertRaises(ValueError):
                        patch.apply_simple_boot_patch(directory)
                    self.assertEqual(target.read_text(), source)

    def test_check_and_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / patch.RELATIVE
            target.parent.mkdir(parents=True)
            target.write_text(BASE)
            self.assertTrue(patch.apply_simple_boot_patch(directory, check=True))
            self.assertEqual(target.read_text(), BASE)
            self.assertTrue(patch.apply_simple_boot_patch(directory))
            self.assertFalse(patch.apply_simple_boot_patch(directory))

    def test_reject_upstream_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            upstream = root / ".deps/nuttx"
            upstream.mkdir(parents=True)
            with self.assertRaises(ValueError):
                patch.apply_simple_boot_patch(upstream)
            outside = root / "outside.c"
            outside.write_text(BASE)
            target = root / "snapshot" / patch.RELATIVE
            target.parent.mkdir(parents=True)
            target.symlink_to(outside)
            with self.assertRaises(ValueError):
                patch.apply_simple_boot_patch(root / "snapshot")
            self.assertEqual(outside.read_text(), BASE)

    def test_disabled_for_other_bootloaders_and_after_cache_init(self):
        source = """
#include <assert.h>
#include <stdbool.h>
static unsigned phase, called;
static void configure_cpu_caches(void) { assert(phase == 0); phase = 1; }
#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT
static void bootloader_ana_clock_glitch_reset_config(bool enabled) {
  assert(phase == 1); assert(!enabled); phase = 2; called++;
}
#endif
static void __esp32s3_start(void) {
#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT
  assert(phase == 2 && called == 1);
#else
  assert(phase == 1 && called == 0);
#endif
  phase = 3;
}
static void start(void) {
""" + patch.START_NEW + """
}
int main(void) { start(); assert(phase == 3); }
"""
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "handoff.c"
            file.write_text(source)
            for simple in (False, True):
                with self.subTest(simple_boot=simple):
                    exe = Path(directory) / ("simple" if simple else "other")
                    command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror"]
                    if simple:
                        command.append("-DCONFIG_ESPRESSIF_SIMPLE_BOOT=1")
                    subprocess.run(command + [str(file), "-o", str(exe)], check=True, timeout=30)
                    subprocess.run([str(exe)], check=True, timeout=5)

    def test_official_hal_preserves_brownout_watchdog_and_other_bits(self):
        hal = ROOT / "build/esp32s3/nuttx/arch/xtensa/src/esp32s3/esp-hal-3rdparty"
        official = hal / "components/bootloader_support/src/esp32s3/bootloader_soc.c"
        if not official.is_file():
            self.skipTest("先准备 esp32s3 隔离 HAL，再运行官方函数寄存器测试")
        registers = hal / "components/soc/esp32s3/include/soc"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            include = root / "soc"
            include.mkdir()
            for filename in ("rtc_cntl_reg.h", "reg_base.h"):
                (include / filename).write_bytes((registers / filename).read_bytes())
            (include / "soc.h").write_text("""
#pragma once
#include <stdint.h>
#include "reg_base.h"
#define BIT(n) (UINT32_C(1) << (n))
void test_reg_clear(uint32_t address, uint32_t mask);
void test_reg_set(uint32_t address, uint32_t mask);
#define REG_CLR_BIT(address, mask) test_reg_clear((address), (mask))
#define REG_SET_BIT(address, mask) test_reg_set((address), (mask))
""")
            harness = root / "register_test.c"
            harness.write_text("""
#include <assert.h>
#include <stdbool.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
void bootloader_ana_clock_glitch_reset_config(bool enable);
static uint32_t fib, ana, writes;
_Static_assert(RTC_CNTL_FIB_SEL_REG == 0x60008148, "FIB register");
_Static_assert(RTC_CNTL_ANA_CONF_REG == 0x60008034, "ANA register");
_Static_assert(RTC_CNTL_FIB_GLITCH_RST == 1, "FIB glitch bit");
_Static_assert(RTC_CNTL_GLITCH_RST_EN == (1u << 20), "ANA glitch bit");
_Static_assert(RTC_CNTL_FIB_BOD_RST == 2, "FIB brownout bit");
_Static_assert(RTC_CNTL_FIB_SUPER_WDT_RST == 4, "FIB watchdog bit");
void test_reg_clear(uint32_t address, uint32_t mask) {
  /* 白名单约束真实 HAL 的每次写入，防止误清欠压/看门狗及其他位。 */
  if (writes == 0) {
    assert(address == 0x60008148 && mask == 1); fib &= ~mask;
  } else {
    assert(writes == 1 && address == 0x60008034 && mask == (1u << 20));
    ana &= ~mask;
  }
  writes++;
}
void test_reg_set(uint32_t address, uint32_t mask) {
  (void)address; (void)mask; assert(!"Unexpected register set");
}
int main(void) {
  const uint32_t values[] = {0, 0xffffffff, 0xd8500000, 0x00000006};
  for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
    for (unsigned j = 0; j < sizeof(values) / sizeof(values[0]); j++) {
      fib = values[i]; ana = values[j]; writes = 0;
      bootloader_ana_clock_glitch_reset_config(false);
      assert(writes == 2);
      assert(fib == (values[i] & ~1u));
      assert(ana == (values[j] & ~(1u << 20)));
    }
  }
}
""")
            exe = root / "register_test"
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-fsanitize=undefined", "-I", str(root), str(official),
                            str(harness), "-o", str(exe)], check=True, timeout=30)
            subprocess.run([str(exe)], check=True, timeout=5)


if __name__ == "__main__":
    unittest.main()
