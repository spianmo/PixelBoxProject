#!/usr/bin/env python3
"""编译真实板级 IMU 函数，验证量程与物理单位一致以及 I2C 失败边界。"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

BOARD = Path(__file__).resolve().parents[1] / "boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_board.c"
PREFIX = r'''
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
struct i2c_master_s { int unused; };
struct pixelbox_imu_sample { float ax, ay, az, gx, gy, gz; };
static struct i2c_master_s bus;
static struct i2c_master_s *g_i2c = &bus;
static bool ready = true;
static uint8_t registers[256], raw_data[12];
static int failed_register = -1, read_error, writes;
static bool pixelbox_board_imu_available(void) { return ready; }
static void up_mdelay(int ms) { assert(ms == 15); }
static int pixelbox_i2c_write8(struct i2c_master_s *b, uint16_t address, uint8_t reg, uint8_t value)
{
  assert(b == &bus && address == 0x6b);
  if (reg == failed_register) return -ENXIO;
  registers[reg] = value; ++writes; return 0;
}
static int pixelbox_i2c_read(struct i2c_master_s *b, uint16_t address,
                           const uint8_t *reg, size_t reglen, uint8_t *out, size_t length)
{
  assert(b == &bus && address == 0x6b && reglen == 1 && *reg == 0x35 && length == 12);
  if (read_error) return read_error;
  memcpy(out, raw_data, length); return 0;
}
'''
CHECKS = r'''
int main(void)
{
  assert(pixelbox_qmi8658_configure(&bus) == 0);
  /* 原 ESP-IDF 的 ±8g 档位是 aFS=010；与4096 LSB/g必须成对匹配。 */
  assert((registers[3] & 0x70) == 0x20);
  assert((registers[3] & 0x0f) == 7);
  assert(registers[2] == 0x40 && registers[4] == 0x54 && registers[8] == 3);
  const int16_t input[] = {4096, -4096, 0, 64, -128, 32767};
  for (unsigned i = 0; i < 6; ++i) {
    raw_data[2*i] = (uint16_t)input[i] & 255;
    raw_data[2*i+1] = (uint16_t)input[i] >> 8;
  }
  struct pixelbox_imu_sample result;
  assert(pixelbox_board_imu_read(&result) == 0);
  assert(result.ax == 1 && result.ay == -1 && result.az == 0);
  assert(result.gx == 1 && result.gy == -2 && result.gz == 511.984375f);
  failed_register = 3; registers[8] = 0; writes = 0;
  assert(pixelbox_qmi8658_configure(&bus) == -ENXIO);
  assert(writes == 2 && registers[8] == 0);
  read_error = -EIO;
  assert(pixelbox_board_imu_read(&result) == -EIO && result.ax == 1);
  ready = false;
  assert(pixelbox_board_imu_read(&result) == -ENODEV);
  assert(pixelbox_board_imu_read(NULL) == -ENODEV);
  return 0;
}
'''


class QMI8658BoardTests(unittest.TestCase):
    def test_range_units_and_io_failures(self):
        source = BOARD.read_text()
        defines = "\n".join(re.findall(r"^#define PIXELBOX_QMI8658_.*$", source, re.M))
        begin = source.index("static int pixelbox_qmi8658_configure(")
        configure = source[begin:source.index("\nstatic void pixelbox_log_probe", begin)]
        begin = source.index("int pixelbox_board_imu_read(")
        read = source[begin:source.index("\nbool pixelbox_board_touch_available", begin)]
        with tempfile.TemporaryDirectory(prefix="pixelbox-qmi8658-") as temporary:
            root = Path(temporary)
            (root / "test.c").write_text(PREFIX + defines + "\n" + configure + read + CHECKS)
            result = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra",
                                     "-Werror", "-fsanitize=undefined", str(root / "test.c"),
                                     "-o", str(root / "test")], capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(root / "test")], capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
