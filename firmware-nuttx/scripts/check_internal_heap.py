#!/usr/bin/env python3
"""校验 ESP32-S3 独立内部堆不侵入实测 ROM 保留区；输出可归档 JSON。"""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


UINT32_MAX = 0xFFFFFFFF
CONFIG_KEYS = (
    "CONFIG_ARCH_CHIP",
    "CONFIG_ARCH_CHIP_ESP32S3",
    "CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP",
    "CONFIG_XTENSA_IMEM_REGION_SIZE",
)


def positive_u32(value, name):
    """只接受十进制/十六进制正整数，不允许负数、零或地址溢出。"""
    if isinstance(value, str):
        if not re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", value):
            raise ValueError(f"{name} must be a positive decimal or hexadecimal integer")
        value = int(value, 16 if value.lower().startswith("0x") else 10)
    if not isinstance(value, int) or isinstance(value, bool) or not 0 < value <= UINT32_MAX:
        raise ValueError(f"{name} must be in [1, 0xffffffff]")
    return value


def checked_add(left, right, name):
    positive_u32(left, name + " left")
    positive_u32(right, name + " right")
    if left > UINT32_MAX - right:
        raise ValueError(f"{name} overflows a 32-bit address")
    return left + right


def read_config(path):
    values = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if "=" not in line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        if key not in CONFIG_KEYS:
            continue
        if key in values:
            raise ValueError(f"duplicate config: {key}")
        values[key] = value
    if values.get("CONFIG_ARCH_CHIP_ESP32S3") != "y":
        raise ValueError("CONFIG_ARCH_CHIP_ESP32S3 must be y")
    if values.get("CONFIG_ARCH_CHIP") != '"esp32s3"':
        raise ValueError('CONFIG_ARCH_CHIP must be "esp32s3"')
    if values.get("CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP") != "y":
        raise ValueError("CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP must be y")
    return positive_u32(values.get("CONFIG_XTENSA_IMEM_REGION_SIZE"),
                        "CONFIG_XTENSA_IMEM_REGION_SIZE")


def parse_sheap(output):
    # POSIX nm 格式固定为 name type value [size]，不能静默选取重复符号。
    entries = [line.split() for line in output.splitlines()
               if line.split() and line.split()[0] == "_sheap"]
    if len(entries) != 1:
        raise ValueError(f"expected exactly one _sheap symbol, found {len(entries)}")
    entry = entries[0]
    if len(entry) < 3 or entry[1].upper() == "U" or not re.fullmatch(r"[0-9a-fA-F]+", entry[2]):
        raise ValueError("_sheap must be a defined symbol with a hexadecimal address")
    return positive_u32(int(entry[2], 16), "_sheap")


def inspect_heap(elf, config, rom_reserved_start, minimum_tail=4096, nm="nm"):
    result = {
        "elf": str(elf), "config": str(config), "_sheap": None,
        "imem_region_size": None, "heap_start": None, "heap_end": None,
        "rom_reserved_start": None, "minimum_tail": None, "tail_bytes": None,
        "status": "error", "pass": False,
    }
    try:
        result["rom_reserved_start"] = positive_u32(rom_reserved_start, "rom_reserved_start")
        result["minimum_tail"] = positive_u32(minimum_tail, "minimum_tail")
        if not Path(elf).is_file():
            raise ValueError(f"ELF does not exist: {elf}")
        result["imem_region_size"] = read_config(Path(config))
        process = subprocess.run([str(nm), "--format=posix", str(elf)],
                                 check=True, capture_output=True, text=True, timeout=30)
        result["_sheap"] = result["heap_start"] = parse_sheap(process.stdout)
        result["heap_end"] = checked_add(result["heap_start"], result["imem_region_size"], "heap_end")
        result["tail_bytes"] = result["rom_reserved_start"] - result["heap_end"]
        required_end = checked_add(result["heap_end"], result["minimum_tail"], "heap_end + minimum_tail")
        # ROM 端点来自运行硬件，不能用链接脚本的 DRAM 终点代替它。
        result["pass"] = required_end <= result["rom_reserved_start"]
        result["status"] = "pass" if result["pass"] else "fail"
        if not result["pass"]:
            result["error"] = (f"internal heap leaves {result['tail_bytes']} bytes before ROM; "
                               f"at least {result['minimum_tail']} required")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result["error"] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--elf", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--rom-reserved-start", required=True)
    parser.add_argument("--minimum-tail", default="4096")
    parser.add_argument("--nm", default="nm", help="目标工具链 nm 可执行文件路径")
    args = parser.parse_args()
    result = inspect_heap(args.elf, args.config, args.rom_reserved_start, args.minimum_tail, args.nm)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
