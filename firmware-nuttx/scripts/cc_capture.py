#!/usr/bin/env python3
"""作为 NuttX CCACHE 前缀记录真实编译参数，供 espIDE 的 clangd 使用。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    arguments = sys.argv[1:]
    result = subprocess.run(arguments, check=False)
    capture = os.environ.get("PX_NUTTX_COMPDB")
    if result.returncode == 0 and capture and "-c" in arguments:
        source = next((arg for arg in arguments if arg.endswith((".c", ".cpp", ".cxx"))), None)
        if source:
            # 并行编译按源文件分片写入，主任务结束后合并，避免多进程争抢一个 JSON。
            file = str(Path(source).resolve())
            directory = Path(capture)
            directory.mkdir(parents=True, exist_ok=True)
            name = hashlib.sha256(file.encode()).hexdigest() + ".json"
            temporary = directory / f"{name}.{os.getpid()}.tmp"
            temporary.write_text(json.dumps({"directory": os.getcwd(), "file": file,
                                             "arguments": arguments}), encoding="utf-8")
            temporary.replace(directory / name)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
