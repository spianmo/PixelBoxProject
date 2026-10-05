#!/usr/bin/env python3
"""验证 Wi-Fi 诊断补丁的精确定位、幂等性和隔离保护。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/wifi_debug_patch.py"
SPEC = importlib.util.spec_from_file_location("wifi_debug_patch", SCRIPT)
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)

FIXTURES = {
    "adapter": """#include <debug.h>
int esp_wifi_adapter_init(void)
{
  ret = esp_wifi_init(&wifi_cfg);
  ret = esp_wifi_set_tx_done_cb(esp_wifi_tx_done_cb);
  return ret;
}

FIXTURES["adapter"] += '''
static void *esp_malloc_internal(size_t size)
{
  return xtensa_imm_malloc(size);
}
static void *esp_realloc_internal(void *ptr, size_t size)
{
  return xtensa_imm_realloc(ptr, size);
}
static void *esp_calloc_internal(size_t n, size_t size)
{
  return xtensa_imm_calloc(n, size);
}
static void *esp_zalloc_internal(size_t size)
{
  return xtensa_imm_zalloc(size);
}
static void fake_failures(void)
{
      wlerr("Failed to create mqueue\\n");
      wlerr("Failed to create task\\n");
}
'''
""",
    "wireless": """#include <debug.h>
int32_t esp_wifi_init(const wifi_init_config_t *config)
{
  ret = esp_wifi_init_internal(config);
  ret = esp_supplicant_init();
  return ret;
}
""",
    "wlan": """#include <debug.h>
static int esp_net_initialize(int devno, uint8_t *mac_addr,
                                  const struct wlan_ops *ops)
{
  ret = netdev_register(netdev, NET_LL_IEEE80211);
  return ret;
}
int esp_wlan_sta_initialize(void)
{
  ret = esp_wifi_adapter_init();
  ret = esp_wifi_sta_read_mac(eth_mac);
  ret = esp_net_initialize(ESPRESSIF_WLAN_STA_DEVNO,
                               eth_mac, &g_sta_ops);
  ret = esp_wifi_sta_register_recv_cb(wlan_sta_rx_done);
  return ret;
}
int esp_wlan_softap_initialize(void)
{
  ret = esp_wifi_adapter_init();
  return ret;
}
""",
}


class WiFiDebugPatchTests(unittest.TestCase):
    def make_tree(self, root):
        for kind, relative in PATCH.FILES.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(FIXTURES[kind])

    def test_exact_call_chain_and_abi(self):
        patched = {kind: PATCH.patch_source(kind, text) for kind, text in FIXTURES.items()}
        for label in ("init_internal", "supplicant_init"):
            self.assertIn(f"[wifi-debug] {label} ret=%d raw=0x%x", patched["wireless"])
        for label in ("adapter_init", "read_mac", "net_initialize", "rx_cb"):
            self.assertIn(f"[wifi-debug] {label} ret=%d raw=0x%x", patched["wlan"])
        self.assertIn("offsetof(wifi_osi_funcs_t, _magic)", patched["adapter"])
        self.assertIn("offsetof(wifi_init_config_t, magic)", patched["adapter"])
        # AP 分支保持原样；不能因相同函数调用而把 STA 日志插入其他分支。
        self.assertEqual(patched["wlan"].split("int esp_wlan_softap_initialize")[1],
                         FIXTURES["wlan"].split("int esp_wlan_softap_initialize")[1])

    def test_idempotent(self):
        for kind, text in FIXTURES.items():
            once = PATCH.patch_source(kind, text)
            self.assertEqual(once, PATCH.patch_source(kind, once))
            self.assertEqual(once.count(PATCH.MARKER), 1)

    def test_upgrade_v1_preserves_existing_diagnostics(self):
        v1 = PATCH.patch_v1_source("adapter", FIXTURES["adapter"])
        upgraded = PATCH.patch_source("adapter", v1)
        self.assertIn(PATCH.MEMORY_MARKER, upgraded)
        self.assertIn("internal_free=%u largest=%u", upgraded)
        self.assertEqual(upgraded.count("cfg size=%u"), 1)
        self.assertEqual(upgraded, PATCH.patch_source("adapter", upgraded))

    def test_check_does_not_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.make_tree(root)
            self.assertEqual(len(PATCH.apply_wifi_debug_patch(root, check=True)), 3)
            for kind, relative in PATCH.FILES.items():
                self.assertEqual((root / relative).read_text(), FIXTURES[kind])
            self.assertEqual(len(PATCH.apply_wifi_debug_patch(root)), 3)
            self.assertEqual(PATCH.apply_wifi_debug_patch(root), [])

    def test_drift_does_not_partially_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.make_tree(root)
            path = root / PATCH.FILES["wlan"]
            path.write_text(FIXTURES["wlan"].replace("esp_wifi_sta_read_mac", "changed_read_mac"))
            with self.assertRaises(ValueError):
                PATCH.apply_wifi_debug_patch(root)
            for kind in ("adapter", "wireless"):
                self.assertEqual((root / PATCH.FILES[kind]).read_text(), FIXTURES[kind])

    def test_reject_upstream_deps(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / ".deps" / "nuttx"
            self.make_tree(root)
            with self.assertRaisesRegex(ValueError, ".deps"):
                PATCH.apply_wifi_debug_patch(root)

    def test_reject_symlink_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "tree"
            outside = Path(folder) / "external.c"
            self.make_tree(root)
            path = root / PATCH.FILES["wlan"]
            original = path.read_text()
            outside.write_text(original)
            path.unlink()
            path.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "快照外部"):
                PATCH.apply_wifi_debug_patch(root)
            self.assertEqual(outside.read_text(), original)
            self.assertEqual((root / PATCH.FILES["adapter"]).read_text(), FIXTURES["adapter"])


if __name__ == "__main__":
    unittest.main()
