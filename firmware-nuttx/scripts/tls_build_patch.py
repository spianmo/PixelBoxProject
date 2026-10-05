#!/usr/bin/env python3
"""仅向隔离HAL的Wireless.mk补齐TLS1.2/X509源码；不修改SDK配置或上游缓存。"""
from pathlib import Path
import argparse

SOURCES = (
    "ssl_tls.c", "ssl_msg.c", "ssl_client.c", "ssl_tls12_client.c",
    "ssl_tls12_server.c", "ssl_ciphersuites.c", "x509.c", "x509_crt.c", "x509_crl.c",
)
MARKER = "# PixelBox TLS transport: use the same ESP HAL mbedTLS configuration."
RELATIVE = "arch/xtensa/src/common/espressif/Wireless.mk"


def patch_source(source):
    block = MARKER + "\n" + "".join("CHIP_CSRCS += " + name + "\n" for name in SOURCES)
    if MARKER in source:
        if source.count(block) != 1:
            raise ValueError("TLS补丁标记存在但内容已漂移")
        return source
    anchor = "CHIP_CSRCS += pk_ecc.c\n"
    if source.count(anchor) != 1 or "MBEDTLS_CONFIG_FILE" not in source:
        raise ValueError("Wireless.mk配置/源码锚点已漂移")
    for name in SOURCES:
        if "CHIP_CSRCS += " + name + "\n" in source:
            raise ValueError("TLS源码已单独接入，拒绝重复编译: " + name)
    return source.replace(anchor, anchor + "\n" + block, 1)


def apply_tls_build_patch(nuttx_root, *, check=False):
    root = Path(nuttx_root).resolve(strict=True)
    if ".deps" in root.parts:
        raise ValueError("拒绝修改.deps；请指定build下的隔离快照")
    target = root / RELATIVE
    if target.is_symlink() or not target.resolve(strict=True).is_relative_to(root):
        raise ValueError("拒绝修改快照外的Wireless.mk")
    original = target.read_text()
    updated = patch_source(original)
    if updated != original and not check:
        target.write_text(updated)
    return updated != original


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nuttx_root", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        changed = apply_tls_build_patch(args.nuttx_root, check=args.check)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
    print("TLS补丁: " + ("需要更新" if args.check and changed else "已更新" if changed else "已存在"))


if __name__ == "__main__":
    main()
