#!/usr/bin/env python3
"""只修补工程快照中的 ESP32-S3 AP/STA 模式切换，禁止重启仍在工作的另一角色。"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re

FUNCTIONS = {
    "esp_wifi_sta_start": ("91254af750cdd13c81abdab594b1cadd79c0bfe0a498e241adc972194d567cf2", True, True),
    "esp_wifi_sta_stop": ("7f4060eba788bdedfffcccac34f9027b3058c22f12d983bb3b8a01e082bd644d", True, False),
    "esp_wifi_softap_start": ("766f19d8ee728f9b6cc45dcc8488a2282092ce27966a4cab6ec25ccaa4113a6c", False, True),
    "esp_wifi_softap_stop": ("0e309c20eac8df3e69652a859336fd2b0a8d8640d130baae9df191ff9770e030", False, False),
}
MARKER = "/* PIXELBOX_APSTA_PRESERVE_LINK_V1 */"
HELPER = r'''/* PIXELBOX_APSTA_PRESERVE_LINK_V1 */
/* 模式切换只增删目标角色；仍有角色运行时禁止 stop/start 整个 Wi-Fi。
 * 例如 APSTA -> STA 只移除 AP，保留 STA 关联、IP 与现有远程连接。
 * 全部 API 成功后才提交 started 标志，错误不能伪装为已开/已关。
 */
int pixelbox_wifi_apsta_safe(void);
int pixelbox_wifi_apsta_safe(void)
{
  return 1;
}

int pixelbox_wifi_softap_running(void);
int pixelbox_wifi_softap_running(void)
{
  int running = 0;
  esp_wifi_lock(true);
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  running = g_softap_started;
#endif
  esp_wifi_lock(false);
  return running;
}

int pixelbox_wifi_softap_sync(void);
int pixelbox_wifi_softap_sync(void)
{
  int ret = -ENOTSUP;
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  /* AP_START 事件异步更新配置；首次 ioctl 不能抢在事件之前使用全零缓存。 */
  esp_wifi_lock(true);
  if (g_softap_started)
    {
      ret = esp_wifi_get_config(WIFI_IF_AP, &g_softap_wifi_cfg);
      if (ret)
        {
          ret = wifi_errno_trans(ret);
        }
    }
  else
    {
      ret = -ENETDOWN;
    }
  esp_wifi_lock(false);
#endif
  return ret;
}

static int pixelbox_wifi_role_transition(bool station, bool enable)
{
  int ret = OK;
  bool sta = false;
  bool ap = false;
  bool was_running;
  wifi_mode_t mode;

  esp_wifi_lock(true);
#ifdef ESPRESSIF_WLAN_HAS_STA
  sta = g_sta_started;
#endif
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  ap = g_softap_started;
#endif
  if ((station ? sta : ap) == enable)
    {
      goto out;
    }

  was_running = sta || ap;
  if (station)
    {
      sta = enable;
    }
  else
    {
      ap = enable;
    }

  if (!sta && !ap)
    {
      ret = esp_wifi_stop();
    }
  else
    {
      mode = sta ? (ap ? WIFI_MODE_APSTA : WIFI_MODE_STA) : WIFI_MODE_AP;
      ret = esp_wifi_set_mode(mode);
      if (!ret && !was_running)
        {
          ret = esp_wifi_start();
        }
    }
  if (ret)
    {
      ret = wifi_errno_trans(ret);
      goto out;
    }
#ifdef ESPRESSIF_WLAN_HAS_STA
  g_sta_started = sta;
#endif
#ifdef ESPRESSIF_WLAN_HAS_SOFTAP
  g_softap_started = ap;
#endif
out:
  esp_wifi_lock(false);
  return ret;
}

'''


def replacement(name: str, station: bool, enable: bool) -> str:
    return (f"int {name}(void)\n{{\n"
            f"  return pixelbox_wifi_role_transition({str(station).lower()}, {str(enable).lower()});\n}}")


def patch_source(source: str) -> str:
    """先校验四处精确版本，再一次性生成结果；重复应用不得重复插入。"""
    if MARKER in source:
        if source.count(HELPER) != 1 or any(
                source.count(replacement(name, station, enable)) != 1
                for name, (_, station, enable) in FUNCTIONS.items()):
            raise ValueError("APSTA 补丁不完整或已漂移，拒绝继续")
        return source
    originals = {}
    for name, (expected, _, _) in FUNCTIONS.items():
        matches = list(re.finditer(r"^int " + name + r"\(void\)\n\{.*?^\}",
                                  source, re.MULTILINE | re.DOTALL))
        if len(matches) != 1 or hashlib.sha256(matches[0][0].encode()).hexdigest() != expected:
            raise ValueError(f"APSTA 上游版本不匹配: {name}，未修改源码")
        originals[name] = matches[0][0]
    # 插在所有角色编译条件之前，兼容 STA-only、AP-only 及双角色配置。
    anchor = "/****************************************************************************\n * Station functions\n ****************************************************************************/"
    if source.count(anchor) != 1:
        raise ValueError("APSTA Station functions 锚点不唯一，未修改源码")
    for name, (_, station, enable) in FUNCTIONS.items():
        source = source.replace(originals[name], replacement(name, station, enable), 1)
    return source.replace(anchor, HELPER + anchor, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="工程快照内 esp32s3_wifi_adapter.c")
    args = parser.parse_args()
    try:
        if args.source.is_symlink():
            raise ValueError("拒绝通过符号链接修改 SDK")
        original = args.source.read_text(encoding="utf-8")
        updated = patch_source(original)
        if updated != original:
            args.source.write_text(updated, encoding="utf-8")
        print("[nuttx] APSTA 模式切换补丁已验证")
        return 0
    except (OSError, ValueError) as error:
        parser.exit(1, f"[nuttx] APSTA 补丁失败: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
