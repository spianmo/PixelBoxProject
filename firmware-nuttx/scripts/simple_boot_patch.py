#!/usr/bin/env python3
"""为隔离 ESP32-S3 Simple Boot 补齐进入应用前的模拟时钟毛刺收尾。"""
from pathlib import Path
import argparse


RELATIVE = "arch/xtensa/src/esp32s3/esp32s3_start.c"
MARKER = "/* PixelBox Simple Boot: finish analog clock glitch boot protection."
INCLUDE_OLD = """#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT
#  include "bootloader_init.h"
#endif"""
INCLUDE_NEW = """#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT
#  include "bootloader_init.h"
#  include "bootloader_soc.h"
#endif"""
START_OLD = """  configure_cpu_caches();

  __esp32s3_start();"""
START_NEW = """  configure_cpu_caches();

#ifdef CONFIG_ESPRESSIF_SIMPLE_BOOT
  /* PixelBox Simple Boot: finish analog clock glitch boot protection.
   * 对齐 ESP-IDF v5.1.4 bootloader_utility.c 的应用交接流程：
   * 启动检查与 XIP 映射完成后，关闭会受 RF/EMI 误触发的模拟毛刺复位。
   * 复用官方函数，仅清 FIB_SEL bit0 与 ANA_CONF bit20；不改 eFuse、
   * brownout 或 watchdog。此调用必须晚于 XIP 映射与 cache 初始化。
   */

  bootloader_ana_clock_glitch_reset_config(false);
#endif

  __esp32s3_start();"""


def patch_source(source: str) -> str:
    """先核对全部锚点，再返回完整变更，防止漂移时写出半个补丁。"""
    if MARKER in source:
        if source.count(INCLUDE_NEW) != 1 or source.count(START_NEW) != 1:
            raise ValueError("Simple Boot 补丁标记存在但内容已漂移")
        if source.count("bootloader_ana_clock_glitch_reset_config(false);") != 1:
            raise ValueError("Simple Boot 毛刺配置调用重复")
        return source
    if "bootloader_soc.h" in source or "bootloader_ana_clock_glitch_reset_config" in source:
        raise ValueError("Simple Boot 已有其他毛刺配置，拒绝不确定修补")
    if source.count(INCLUDE_OLD) != 1 or source.count(START_OLD) != 1:
        raise ValueError("ESP32-S3 Simple Boot 启动源码锚点已漂移")
    return source.replace(INCLUDE_OLD, INCLUDE_NEW, 1).replace(START_OLD, START_NEW, 1)


def apply_simple_boot_patch(nuttx_root: Path, *, check: bool = False) -> bool:
    root = Path(nuttx_root).resolve(strict=True)
    if ".deps" in root.parts:
        raise ValueError("拒绝修改 .deps；请指定 build 下的隔离快照")
    target = root / RELATIVE
    if target.is_symlink() or not target.resolve(strict=True).is_relative_to(root):
        raise ValueError("拒绝修改快照外的 ESP32-S3 启动源码")
    original = target.read_text()
    updated = patch_source(original)
    if updated != original and not check:
        target.write_text(updated)
    return updated != original


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nuttx_root", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        changed = apply_simple_boot_patch(args.nuttx_root, check=args.check)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
    print("Simple Boot 补丁: " + ("需要更新" if args.check and changed else
                               "已更新" if changed else "已存在"))


if __name__ == "__main__":
    main()
