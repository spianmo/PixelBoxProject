#!/usr/bin/env python3
"""把原 ESP-IDF 独立配网页编码为 C 字节数组；保持网页内容逐字相同。"""
from pathlib import Path
import argparse


def render(source: bytes) -> str:
    rows = [", ".join(str(value) for value in source[i:i + 20]) for i in range(0, len(source), 20)]
    return ("/* 由 scripts/embed_portal.py 生成，来源为原 ESP-IDF portal.html。 */\n"
            "static const unsigned char portal_html_bytes[] = {\n  " + ",\n  ".join(rows) +
            ", 0\n};\n#define portal_html ((const char *)portal_html_bytes)\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    source = project.parent / "firmware/components/wifi_portal/src/portal.html"
    target = project / "src/portal_html.inc"
    expected = render(source.read_bytes())
    if args.check:
        if target.read_text() != expected:
            raise SystemExit("portal_html.inc 与原门户 HTML 不一致")
    else:
        target.write_text(expected)


if __name__ == "__main__":
    main()
