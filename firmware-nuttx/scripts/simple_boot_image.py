#!/usr/bin/env python3
"""为 ESP32-S3 Simple Boot 的 ROM 可见 RAM 段生成并校验 SHA-256。"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import struct
import tempfile


def ram_image_end(data: bytes) -> int:
    """校验 ROM 可见段与 XOR，返回 16 字节对齐的 checksum 结束偏移。"""
    if len(data) < 24 or data[0] != 0xE9 or not 1 <= data[1] <= 16:
        raise ValueError("无效的 ESP32-S3 镜像头")
    if struct.unpack_from("<H", data, 12)[0] != 9 or data[23] not in (0, 1):
        raise ValueError("镜像芯片或 SHA-256 标志不属于受支持的 ESP32-S3 格式")
    offset = 24
    checksum = 0xEF
    for _ in range(data[1]):
        if offset + 8 > len(data):
            raise ValueError("RAM 段头被截断")
        _, length = struct.unpack_from("<II", data, offset)
        end = offset + 8 + length
        if end > len(data):
            raise ValueError("RAM 段数据被截断")
        for value in data[offset + 8:end]:
            checksum ^= value
        offset = end
    checksum_end = (offset // 16 + 1) * 16
    if checksum_end > len(data) or data[checksum_end - 1] != checksum:
        raise ValueError("ROM 可见 RAM 段 checksum 校验失败")
    if any(data[offset:checksum_end - 1]):
        raise ValueError("RAM checksum 前的对齐填充不是零")
    return checksum_end


def validate_image(data: bytes) -> str:
    """拒绝缺失或错误的摘要，返回已验证的 SHA-256。"""
    end = ram_image_end(data)
    if data[23] != 1:
        raise ValueError("Simple Boot 镜像缺少 ROM SHA-256 摘要")
    digest = hashlib.sha256(data[:end]).digest()
    if data[end:end + 32] != digest:
        raise ValueError("Simple Boot 镜像 SHA-256 校验失败")
    return digest.hex()


def add_digest(data: bytes) -> bytes:
    """优先复用 padding；不足时整页后移 Flash 段，保持 MMU 对齐与内容。"""
    end = ram_image_end(data)
    if data[23] == 1:
        validate_image(data)
        return data
    if end + 8 > len(data):
        raise ValueError("Simple Boot 镜像缺少 RAM 后的 padding 段")
    address, length = struct.unpack_from("<II", data, end)
    if address != 0 or end + 8 + length > len(data):
        raise ValueError("RAM 后的 padding 段无效")
    if any(data[end + 8:end + 8 + length]):
        raise ValueError("RAM 后的 padding 包含非零数据，拒绝覆盖")

    # esptool --ram-only-header 不生成摘要。边界处 padding 可能只有 0/16 字节，
    # 增加一个64KiB MMU页；Simple Boot loader从段头获取真实LMA，虚拟地址不变。
    # 不能只插入32字节：那会破坏Flash偏移与虚拟地址的低16位一致性。
    output = bytearray(data)
    if length < 32:
        output[end + 8:end + 8] = bytes(0x10000)
        length += 0x10000
    output[23] = 1
    output[end:end + 32] = hashlib.sha256(output[:end]).digest()
    struct.pack_into("<II", output, end + 32, 0, length - 32)
    result = bytes(output)
    validate_image(result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--check", action="store_true", help="只校验，不修改镜像")
    args = parser.parse_args()
    try:
        if args.image.is_symlink():
            raise ValueError("镜像路径不能是符号链接")
        data = args.image.read_bytes()
        result = data if args.check else add_digest(data)
        digest = validate_image(result)
        if result != data:
            # 先完成所有格式校验，再原子替换，避免取消构建时留下半写入镜像。
            with tempfile.NamedTemporaryFile(prefix=".simple-boot-", dir=args.image.parent,
                                             delete=False) as temporary:
                temporary.write(result)
                temporary_path = Path(temporary.name)
            temporary_path.replace(args.image)
        print(f"[nuttx] Simple Boot ROM SHA-256: {digest} (valid)")
        return 0
    except (OSError, ValueError) as error:
        parser.exit(1, f"[nuttx] 镜像校验失败: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
