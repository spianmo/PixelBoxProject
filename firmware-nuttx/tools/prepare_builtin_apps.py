#!/usr/bin/env python3
"""逐字节嵌入原 ESP-IDF 设置页/欢迎页；缺失时失败，禁止生成替代界面。"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def prepare(project: Path, repo: Path, output: Path) -> dict[str, dict[str, object]]:
    chunks = ["/* 自动生成：原 ESP-IDF 内置应用，禁止手改。 */\n",
              "#ifndef PIXELBOX_BUILTIN_APPS_DATA_H\n#define PIXELBOX_BUILTIN_APPS_DATA_H\n"]
    manifest = {}
    for name, filename in (("settings", "settings_app.js"), ("welcome", "default_app.js")):
        source = project / "shared" / filename
        if not source.is_file():
            source = repo / "firmware/components/appmgr/src" / filename
        data = source.read_bytes()
        data.decode("utf-8")  # 仅校验编码，不改动换行或任意源字节。
        if not data or b"\0" in data:
            raise ValueError(f"内置应用为空或含 NUL，不能作为 JS source: {source}")
        digest = hashlib.sha256(data).hexdigest()
        manifest[name] = {"length": len(data), "sha256": digest, "source": str(source)}
        chunks.append(f'#define PX_BUILTIN_{name.upper()}_SHA256 "{digest}"\n')
        chunks.append(f"static const unsigned char px_builtin_{name}_source[] = {{\n")
        terminated = data + b"\0"
        chunks.extend(",".join(f"0x{byte:02x}" for byte in terminated[index:index + 24]) + ",\n"
                      for index in range(0, len(terminated), 24))
        chunks.append("};\n")
    chunks.append("#endif\n")
    encoded = "".join(chunks).encode("utf-8")
    target = output / "builtin_apps_data.h"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or target.read_bytes() != encoded:
        target.write_bytes(encoded)
    return manifest


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=project)
    parser.add_argument("--repo-root", type=Path, default=project.parent)
    parser.add_argument("--output", type=Path, default=project / "generated")
    args = parser.parse_args()
    result = prepare(args.project.resolve(), args.repo_root.resolve(), args.output.resolve())
    for name, entry in result.items():
        print(f"{name}: {entry['length']} bytes, sha256={entry['sha256']}")


if __name__ == "__main__":
    main()
