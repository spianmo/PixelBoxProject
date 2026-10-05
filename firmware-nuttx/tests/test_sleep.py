"""默认关闭的定时深睡状态机；真实 service pthread，不访问硬件。"""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="pixelbox-sleep-") as temporary:
    binary = Path(temporary) / "sleep-service"
    subprocess.run([*shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-D_POSIX_C_SOURCE=200809L",
                    "-DPX_SERVICE_PORTAL", "-DPX_SLEEP_CLEANUP_MS=200", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
                    "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I" + str(root / "include"),
                    str(root / "src/service.c"), str(root / "tests/test_sleep_service.c"),
                    "-pthread", "-o", str(binary)], check=True, timeout=60)
    subprocess.run([str(binary)], check=True, timeout=10)
