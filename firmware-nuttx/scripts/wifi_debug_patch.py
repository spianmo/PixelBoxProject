#!/usr/bin/env python3
"""给隔离 NuttX 快照添加一次性 Wi-Fi 初始化日志，不改上游 .deps。"""
from __future__ import annotations

import argparse
from pathlib import Path

MARKER = "/* PixelBox Wi-Fi initialization diagnostics v1. */"
MEMORY_MARKER = "/* PixelBox Wi-Fi internal allocation diagnostics v2. */"
FILES = {
    "adapter": "arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c",
    "wireless": "arch/xtensa/src/common/espressif/esp_wireless.c",
    "wlan": "arch/xtensa/src/common/espressif/esp_wlan.c",
}


def replace_exact(source: str, old: str, new: str) -> str:
    count = source.count(old)
    if count != 1:
        raise ValueError(f"Wi-Fi 源码漂移：期望 1 个目标，得到 {count}: {old[:90]!r}")
    return source.replace(old, new, 1)


def modify_function(source: str, name: str, transform) -> str:
    # 这些上游 C 函数的结束括号独占顶格；只在单个函数内匹配调用，避免误改 AP。
    import re
    pattern = rf"(?m)^(?:static )?(?:int|int32_t) {re.escape(name)}\([^;]*?\n\{{\n"
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise ValueError(f"Wi-Fi 源码漂移：无法唯一定位 {name}")
    start = matches[0].start()
    end = source.find("\n}\n", matches[0].end())
    if end < 0:
        raise ValueError(f"Wi-Fi 源码漂移：{name} 缺少结束括号")
    end += 3
    return source[:start] + transform(source[start:end]) + source[end:]


def log_result(body: str, call: str, label: str) -> str:
    return replace_exact(body, call, call + (
        f'\n  syslog(LOG_ERR, "[wifi-debug] {label} ret=%d raw=0x%x\\n",\n'
        "         (int)ret, (unsigned int)ret);"
    ))


def patch_v1_source(kind: str, source: str) -> str:
    if MARKER in source:
        return source
    if "#include <syslog.h>" not in source:
        source = replace_exact(source, "#include <debug.h>",
                               "#include <debug.h>\n#include <syslog.h>")

    if kind == "adapter":
        def adapter(body: str) -> str:
            anchor = "  ret = esp_wifi_init(&wifi_cfg);"
            diagnostics = '''  /* 同版本号不保证 ABI 相同；记录魔数字段的真实偏移。 */
  syslog(LOG_ERR,
         "[wifi-debug] cfg size=%u magic_offset=%u magic=0x%x "
         "osi_size=%u osi_magic_offset=%u osi_version=%d osi_magic=0x%x\\n",
         (unsigned int)sizeof(wifi_cfg),
         (unsigned int)offsetof(wifi_init_config_t, magic),
         (unsigned int)wifi_cfg.magic,
         (unsigned int)sizeof(g_wifi_osi_funcs),
         (unsigned int)offsetof(wifi_osi_funcs_t, _magic),
         (int)g_wifi_osi_funcs._version,
         (unsigned int)g_wifi_osi_funcs._magic);
  syslog(LOG_ERR,
         "[wifi-debug] buffers rx=%d/%d tx_type=%d tx=%d/%d "
         "ampdu=%d/%d ba=%d nvs=%d\\n",
         wifi_cfg.static_rx_buf_num, wifi_cfg.dynamic_rx_buf_num,
         wifi_cfg.tx_buf_type, wifi_cfg.static_tx_buf_num,
         wifi_cfg.dynamic_tx_buf_num, wifi_cfg.ampdu_rx_enable,
         wifi_cfg.ampdu_tx_enable, wifi_cfg.rx_ba_win, wifi_cfg.nvs_enable);

'''
            body = replace_exact(body, anchor, diagnostics + anchor)
            body = log_result(body, anchor, "esp_wifi_init")
            return log_result(body,
                "  ret = esp_wifi_set_tx_done_cb(esp_wifi_tx_done_cb);", "tx_done_cb")
        source = modify_function(source, "esp_wifi_adapter_init", adapter)
    elif kind == "wireless":
        def wireless(body: str) -> str:
            body = log_result(body, "  ret = esp_wifi_init_internal(config);", "init_internal")
            return log_result(body, "  ret = esp_supplicant_init();", "supplicant_init")
        source = modify_function(source, "esp_wifi_init", wireless)
    elif kind == "wlan":
        def station(body: str) -> str:
            for call, label in (
                ("  ret = esp_wifi_adapter_init();", "adapter_init"),
                ("  ret = esp_wifi_sta_read_mac(eth_mac);", "read_mac"),
                ("  ret = esp_net_initialize(ESPRESSIF_WLAN_STA_DEVNO,\n"
                 "                               eth_mac, &g_sta_ops);", "net_initialize"),
                ("  ret = esp_wifi_sta_register_recv_cb(wlan_sta_rx_done);", "rx_cb"),
            ):
                body = log_result(body, call, label)
            return body
        source = modify_function(source, "esp_wlan_sta_initialize", station)

        def network(body: str) -> str:
            call = "  ret = netdev_register(netdev, NET_LL_IEEE80211);"
            return replace_exact(body, call, '''#ifdef CONFIG_DRIVERS_IEEE80211
  syslog(LOG_ERR, "[wifi-debug] IEEE80211 enabled; lltype=%d\\n",
         (int)NET_LL_IEEE80211);
#else
  syslog(LOG_ERR, "[wifi-debug] IEEE80211 DISABLED; lltype=%d\\n",
         (int)NET_LL_IEEE80211);
#endif
''' + call + '''
  syslog(LOG_ERR, "[wifi-debug] netdev_register ret=%d ifname=%s\\n",
         ret, netdev->d_ifname);''')
        source = modify_function(source, "esp_net_initialize", network)
    else:
        raise ValueError(f"未知 Wi-Fi 源文件类型: {kind}")
    return MARKER + "\n" + source


def patch_source(kind: str, source: str) -> str:
    source = patch_v1_source(kind, source)
    if kind != "adapter" or MEMORY_MARKER in source:
        return source
    # 已有 v1 快照也必须补充诊断；只记录失败，避免启动串口被分配日志淹没。
    anchor = "static void *esp_malloc_internal(size_t size)\n{"
    helper = '''#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
static void *pixelbox_wifi_alloc_result(void *ptr, const char *op, size_t size)
{
  if (ptr == NULL && size != 0)
    {
      struct mallinfo info = xtensa_imm_mallinfo();
      syslog(LOG_ERR,
             "[wifi-debug] %s failed size=%u internal_free=%u largest=%u\\n",
             op, (unsigned int)size, (unsigned int)info.fordblks,
             (unsigned int)info.mxordblk);
    }
  return ptr;
}
#endif

'''
    source = replace_exact(source, anchor, helper + anchor)
    for name, args, size in (("malloc", "size", "size"),
                             ("realloc", "ptr, size", "size"),
                             ("calloc", "n, size", "n * size"),
                             ("zalloc", "size", "size")):
        call = f"  return xtensa_imm_{name}({args});"
        source = replace_exact(source, call,
            f"  return pixelbox_wifi_alloc_result(xtensa_imm_{name}({args}),\n"
            f'                                    "{name}", {size});')
    source = replace_exact(source, '      wlerr("Failed to create mqueue\\n");',
        '      syslog(LOG_ERR, "[wifi-debug] mqueue failed ret=%d len=%u item=%u\\n",\n'
        '             ret, (unsigned int)queue_len, (unsigned int)item_size);')
    source = replace_exact(source, '      wlerr("Failed to create task\\n");',
        '      syslog(LOG_ERR, "[wifi-debug] task failed name=%s pid=%d stack=%u\\n",\n'
        '             name, pid, (unsigned int)stack_depth);')
    return MEMORY_MARKER + "\n" + source


def apply_wifi_debug_patch(nuttx_root: Path, *, check: bool = False) -> list[str]:
    root = nuttx_root.resolve(strict=True)
    if ".deps" in root.parts:
        raise ValueError("拒绝修改 .deps 上游源码；请指定 firmware-nuttx/build 下的隔离快照")
    edits = []
    # 所有目标都先验证成功，再开始写入；版本不匹配不会留下部分诊断补丁。
    for kind, relative in FILES.items():
        path = root / relative
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"拒绝修改指向快照外部的文件: {path}")
        original = path.read_text(encoding="utf-8")
        updated = patch_source(kind, original)
        if updated != original:
            edits.append((path, updated))
    if not check:
        for path, updated in edits:
            path.write_text(updated, encoding="utf-8")
    return [str(path.relative_to(root)) for path, _ in edits]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nuttx_root", type=Path)
    parser.add_argument("--check", action="store_true", help="只校验补丁目标，不写入")
    args = parser.parse_args()
    try:
        changed = apply_wifi_debug_patch(args.nuttx_root, check=args.check)
    except (OSError, ValueError) as error:
        parser.exit(1, f"[wifi-debug] {error}\n")
    action = "可添加诊断" if args.check else "已添加诊断"
    print(f"[wifi-debug] {action}: {len(changed)} 个文件")
    for name in changed:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
