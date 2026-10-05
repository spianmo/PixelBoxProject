#!/usr/bin/env python3
"""验证精确上游补丁和真实编译的 STA/AP 状态切换；不连接任何设备。"""
import argparse
import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("softap_patch", ROOT / "scripts/softap_adapter_patch.py")
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent /
                        ".deps/nuttx/arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c")
    parser.add_argument("--sanitize", choices=("undefined",))
    args = parser.parse_args()
    original = args.source.read_text()
    updated = patch.patch_source(original)
    assert updated != original
    assert patch.patch_source(updated) == updated
    for source in (original.replace("int esp_wifi_softap_stop(void)", "int changed_stop(void)"),
                   original.replace("int esp_wifi_sta_start(void)\n{", "int esp_wifi_sta_start(void)\n{\n  drift();", 1),
                   updated.replace(patch.HELPER, patch.HELPER.replace("return 1;", "return 0;"), 1),
                   updated.replace("return pixelbox_wifi_role_transition(false, false);", "return 0;")):
        try:
            patch.patch_source(source)
        except ValueError:
            pass
        else:
            raise AssertionError("补丁版本漂移必须拒绝")
    with tempfile.TemporaryDirectory(prefix="pixelbox-softap-") as tmp:
        directory = Path(tmp)
        source = directory / "esp32s3_wifi_adapter.c"
        source.write_text(original)
        command = [sys.executable, str(SPEC.origin), str(source)]
        subprocess.run(command, check=True, timeout=10)
        assert source.read_text() == updated
        stamp = source.stat().st_mtime_ns
        subprocess.run(command, check=True, timeout=10)
        assert source.stat().st_mtime_ns == stamp
        source.write_text("drifted source")
        failure = subprocess.run(command, capture_output=True, timeout=10)
        assert failure.returncode != 0 and source.read_text() == "drifted source"
        source.unlink()
        source.symlink_to(args.source)
        failure = subprocess.run(command, capture_output=True, timeout=10)
        assert failure.returncode != 0 and args.source.read_text() == original

        functions = {}
        for name in patch.FUNCTIONS:
            functions[name] = re.search(r"^int " + name + r"\(void\)\n\{.*?^\}",
                                        updated, re.MULTILINE | re.DOTALL)[0]
        header = patch.HELPER + "\n#ifdef ESPRESSIF_WLAN_HAS_STA\n" + \
            functions["esp_wifi_sta_start"] + "\n" + functions["esp_wifi_sta_stop"] + \
            "\n#endif\n#ifdef ESPRESSIF_WLAN_HAS_SOFTAP\n" + \
            functions["esp_wifi_softap_start"] + "\n" + functions["esp_wifi_softap_stop"] + "\n#endif\n"
        (directory / "softap_adapter_under_test.h").write_text(header)
        for defines in (("ESPRESSIF_WLAN_HAS_STA",), ("ESPRESSIF_WLAN_HAS_SOFTAP",),
                        ("ESPRESSIF_WLAN_HAS_STA", "ESPRESSIF_WLAN_HAS_SOFTAP")):
            binary = directory / "test-softap"
            compile_args = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                            "-I", str(directory), str(ROOT / "tests/test_softap_adapter.c"),
                            "-o", str(binary)] + ["-D" + value for value in defines]
            if args.sanitize:
                compile_args += ["-fsanitize=undefined", "-fno-sanitize-recover=all"]
            subprocess.run(compile_args, check=True, timeout=30)
            subprocess.run([str(binary)], check=True, timeout=10)
    print("SoftAP adapter patch: version, idempotence, rollback and all three role builds passed")


if __name__ == "__main__":
    main()
