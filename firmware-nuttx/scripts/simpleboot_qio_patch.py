#!/usr/bin/env python3
"""为隔离的ESP32-S3 SimpleBoot接入官方QE流程；不操作设备或原始SDK。"""
from pathlib import Path
import re

CHIP = "arch/xtensa/src/esp32s3/"
HAL = CHIP + "esp-hal-3rdparty/"
SDK = HAL + "nuttx/esp32s3/include/sdkconfig.h"
MAKE = CHIP + "hal.mk"
LINK = "boards/xtensa/esp32s3/common/scripts/esp32s3_sections.ld"
IMAGE = "tools/esp32s3/Config.mk"
QIO = HAL + "components/bootloader_support/bootloader_flash/src/flash_qio_mode.c"
WRAP = HAL + "components/spi_flash/spi_flash_wrap.c"
SDK_ANCHOR = "#  define CONFIG_BOOTLOADER_FLASH_XMC_SUPPORT 1\n#endif\n"
SDK_MAPPING = '''
/* ROM先以DIO载入RAM；只有SimpleBoot QIO配置才启用官方QE初始化。
 * 字符串FLASHMODE仍为dio，与ROM镜像头保持一致。 */
#if defined(CONFIG_ESPRESSIF_SIMPLE_BOOT) && defined(CONFIG_ESP32S3_FLASH_MODE_QIO)
#  undef CONFIG_ESPTOOLPY_FLASHMODE_DIO
#  undef CONFIG_FLASHMODE_DIO
#  define CONFIG_ESPTOOLPY_FLASHMODE_QIO 1
#  define CONFIG_FLASHMODE_QIO CONFIG_ESPTOOLPY_FLASHMODE_QIO
#endif
'''
MAKE_ANCHOR = "ifeq ($(CONFIG_ESPRESSIF_SIMPLE_BOOT),y)\n"
MAKE_WIRING = '''  # QE与wrap清除使用同版官方实现，在映射Flash前执行。
  ifeq ($(CONFIG_ESP32S3_FLASH_MODE_QIO),y)
    CHIP_CSRCS += chip$(DELIM)$(ESP_HAL_3RDPARTY_REPO)$(DELIM)components$(DELIM)bootloader_support$(DELIM)bootloader_flash$(DELIM)src$(DELIM)flash_qio_mode.c
    CHIP_CSRCS += chip$(DELIM)$(ESP_HAL_3RDPARTY_REPO)$(DELIM)components$(DELIM)spi_flash$(DELIM)spi_flash_wrap.c
  endif
'''
IMAGE_ANCHOR = "FLASH_FREQ := $(CONFIG_ESPRESSIF_FLASH_FREQ)\n"
IMAGE_MODE = '''# 只调整SimpleBoot QIO的ROM头；其它启动/Flash模式保持原语义。
ifeq ($(CONFIG_ESPRESSIF_SIMPLE_BOOT)$(CONFIG_ESP32S3_FLASH_MODE_QIO),yy)
\tFLASH_MODE := dio
endif

'''


def replace_once(text: str, before: str, after: str, label: str) -> str:
    """核验完整上下文，重复调用幂等，发现漂移就拒绝写入。"""
    if after in text:
        if text.count(after) != 1:
            raise ValueError(f"{label}: 补丁重复")
        return text
    if text.count(before) != 1:
        raise ValueError(f"{label}: 上游源码版本不匹配")
    return text.replace(before, after, 1)


def patch(tree: Path) -> list[str]:
    tree = Path(tree)
    paths = [SDK, MAKE, LINK, IMAGE, QIO]
    # 所有文件先读入并完成验证，避免后续版本检查失败留下半套接线。
    if not (tree / WRAP).is_file():
        raise ValueError("缺少同版官方 spi_flash_wrap.c")
    original = {rel: (tree / rel).read_text(encoding="utf-8") for rel in paths}
    changed = original.copy()
    changed[SDK] = replace_once(original[SDK], SDK_ANCHOR,
                                SDK_ANCHOR + SDK_MAPPING, SDK)
    changed[MAKE] = replace_once(original[MAKE], MAKE_ANCHOR,
                                 MAKE_ANCHOR + MAKE_WIRING, MAKE)
    changed[IMAGE] = replace_once(original[IMAGE], IMAGE_ANCHOR,
                                  IMAGE_MODE + IMAGE_ANCHOR, IMAGE)
    for suffix in ("(.text .text.* .literal .literal.*)", "(.rodata .rodata.*)"):
        before = "    *libarch.a:*bootloader_flash_config_esp32s3.*" + suffix + "\n"
        after = before + "    *libarch.a:*flash_qio_mode.*" + suffix + "\n" \
            + "    *libarch.a:*spi_flash_wrap.*" + suffix + "\n"
        changed[LINK] = replace_once(changed[LINK], before, after, LINK)
    # 普通ESP_LOG会依赖运行时日志锁；早期入口必须与既有bootloader一样使用EARLY。
    qio = original[QIO]
    if "void bootloader_enable_qio_mode(void)" not in qio:
        raise ValueError("flash_qio_mode.c: 官方QE入口不匹配")
    changed[QIO] = re.sub(r"\bESP_LOG([EWIDV])\(", r"ESP_EARLY_LOG\1(", qio)
    if not re.search(r"\bESP_EARLY_LOG[EWIDV]\(", changed[QIO]):
        raise ValueError("flash_qio_mode.c: 官方日志上下文不匹配")
    written = []
    for rel in paths:
        if changed[rel] != original[rel]:
            (tree / rel).write_text(changed[rel], encoding="utf-8")
            written.append(rel)
    return written


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree", type=Path)
    args = parser.parse_args()
    for name in patch(args.tree):
        print(name)
