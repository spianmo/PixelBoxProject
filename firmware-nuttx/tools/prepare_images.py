#!/usr/bin/env python3
"""复制便携PNG/GIF/JPEG解码器，回放边界修补；只改生成目录，不改旧固件。"""
from __future__ import annotations

import argparse
from pathlib import Path


def write_if_changed(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError("解码器上游结构已变化，无法安全回放修补: " + old[:90])
    return text.replace(old, new, 1)


def adapt_pngle(text: str) -> str:
    text = replace_once(text, "return (p[0] << 24)", "return ((uint32_t)p[0] << 24)")
    text = replace_once(text, "size_t  avail_out;", "size_t  avail_out;\n\tint stream_done;")
    text = replace_once(text, "pngle->next_out = NULL; // indicates IDAT hasn't been processed yet",
                        "pngle->next_out = NULL; // indicates IDAT hasn't been processed yet\n\tpngle->stream_done = 0;")
    text = replace_once(text, "pngle->next_out   += out_bytes;",
                        "if (status == TINFL_STATUS_DONE) pngle->stream_done = 1;\n\t\t\tpngle->next_out   += out_bytes;")
    text = replace_once(text, 'if (pngle->next_out == NULL) return PNGLE_ERROR("No IDAT chunk is found");',
                        'if (pngle->next_out == NULL || !pngle->stream_done) return PNGLE_ERROR("Incomplete IDAT stream");')
    return text


def adapt_gifdec(text: str) -> str:
    # 完整结构由image.c先验证；这里额外修补解码字典、调色板和错误路径。
    text = replace_once(text, "if (n > avail) n = avail;", "if (n > avail) { memset(buf, 0, n); n = avail; }")
    text = replace_once(text, 'memcmp(sigver, "89a", 3) != 0',
                        '(memcmp(sigver, "89a", 3) != 0 && memcmp(sigver, "87a", 3) != 0)')
    text = replace_once(text, 'fprintf(stderr, "unknown extension: %02X\\n", label);',
                        'discard_sub_blocks(gif); /* 未知扩展仍须完整跳过子块。 */')
    text = replace_once(text, "table = new_table(key_size);\n    key_size++;",
                        "table = new_table(key_size);\n    if (!table) return -1;\n    key_size++;")
    text = replace_once(text, "frm_off = 0;\n    ret = 0;",
                        "if (key != clear) { free(table); return -1; }\n    frm_off = 0;\n    ret = 0;")
    text = replace_once(text, "entry = table->entries[key];\n        str_len = entry.length;",
                        "if (key >= table->nentries) { free(table); return -1; }\n"
                        "        entry = table->entries[key];\n        str_len = entry.length;\n"
                        "        if (!str_len || str_len > frm_size - frm_off) { free(table); return -1; }")
    text = replace_once(text, "gif->frame[(gif->fy + y) * gif->width + gif->fx + x] = entry.suffix;",
                        "if (entry.suffix >= gif->palette->size || y >= gif->fh) { free(table); return -1; }\n"
                        "            gif->frame[(gif->fy + y) * gif->width + gif->fx + x] = entry.suffix;")
    text = replace_once(text, "else\n                entry = table->entries[entry.prefix];",
                        "else {\n                if (entry.prefix >= table->nentries) { free(table); return -1; }\n"
                        "                entry = table->entries[entry.prefix];\n            }")
    text = replace_once(text, "free(table);\n    if (key == stop)\n        gd_read(&gif->rd, &sub_len, 1); /* Must be zero! */",
                        "if (frm_off != frm_size) { free(table); return -1; }\n"
                        "    if (key != stop) {\n        do {\n"
                        "            key = get_key(gif, key_size, &sub_len, &shift, &byte);\n"
                        "            if (key == clear) key_size = init_key_size;\n"
                        "        } while (key == clear);\n"
                        "        if (key != stop) { free(table); return -1; }\n    }\n    free(table);")
    text = replace_once(text, "bgcolor = &gif->palette->colors[gif->bgindex*3];\n        i =",
                        "bgcolor = &gif->gct.colors[gif->bgindex*3];\n        i =")
    text = replace_once(text, "dispose(gif);\n    gd_read(&gif->rd, &sep, 1);",
                        "dispose(gif);\n    memset(&gif->gce, 0, sizeof(gif->gce)); /* GCE只应用于下一图形。 */\n    gd_read(&gif->rd, &sep, 1);")
    return text


def adapt_jpeg(text: str) -> str:
    # 损坏熵流也不能触发C有符号溢出；保持合法文件的整数IDCT舍入顺序。
    text = replace_once(text, "int32_t v0, v1, v2, v3, v4, v5, v6, v7;\n    int32_t t10, t11, t12, t13;",
                        "int64_t v0, v1, v2, v3, v4, v5, v6, v7;\n    int64_t t10, t11, t12, t13;")
    text = replace_once(text, "if (!cls && d > 11)", "if ((!cls && d > 11) || (cls && (d & 15) > 10))")
    text = replace_once(text, "jd->dcv[cmp] = (int16_t)d;",
                        "if (d < -2048 || d > 2047) return JDR_FMT1;\n                jd->dcv[cmp] = (int16_t)d;")
    text = replace_once(text, "tmp[0] = d * dqf[0] >> 8;", "tmp[0] = (int32_t)((int64_t)d * dqf[0] >> 8);")
    text = replace_once(text, "tmp[i] = d * dqf[i] >> 8;", "tmp[i] = (int32_t)((int64_t)d * dqf[i] >> 8);")
    return text


def prepare(project: Path, repo_root: Path, output: Path) -> None:
    cached = project / "shared/hal_display/vendor"
    source = cached if cached.is_dir() else repo_root / "firmware/components/hal_display/vendor"
    jpeg_cache = project / "shared/tjpgd"
    jpeg = jpeg_cache if jpeg_cache.is_dir() else repo_root / "firmware/managed_components/espressif__esp_jpeg/tjpgd"
    files = {name: (source / name).read_bytes()
             for name in ("pngle.c", "pngle.h", "miniz.c", "miniz.h", "gifdec.c", "gifdec.h", "README.md")}
    for name in ("tjpgd.c", "tjpgd.h"):
        files[name] = (jpeg / name).read_bytes()
    files["pngle.c"] = adapt_pngle(files["pngle.c"].decode()).encode()
    files["gifdec.c"] = adapt_gifdec(files["gifdec.c"].decode()).encode()
    files["tjpgd.c"] = adapt_jpeg(files["tjpgd.c"].decode()).encode()
    files["tjpgdcnf.h"] = b"""/* NuttX/host: portable TJpgDec configuration, no sdkconfig dependency. */
#define JD_SZBUF 1024
#define JD_FORMAT 0
#define JD_USE_SCALE 0
#define JD_TBLCLIP 1
#define JD_FASTDECODE 1
#define JD_DEFAULT_HUFFMAN 0
"""
    for name, data in files.items():
        write_if_changed(output / "images" / name, data)
    write_if_changed(output / "licenses" / "image-vendor-README.md", files["README.md"])
    write_if_changed(output / "licenses" / "tjpgd-LICENSE.txt", files["tjpgd.c"].split(b'#include "tjpgd.h"')[0])


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=project.parent)
    parser.add_argument("--output", type=Path, default=project / "generated")
    args = parser.parse_args()
    prepare(project, args.repo_root.resolve(), args.output.resolve())
    print(f"PNG/GIF/TJpgDec 与许可已准备: {args.output}")


if __name__ == "__main__":
    main()
