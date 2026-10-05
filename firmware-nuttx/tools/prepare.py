#!/usr/bin/env python3
"""准备 NuttX/host 公用依赖，不下载网络资源、不修改共享 QuickJS 源码。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


def write_if_changed(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def embed(source: Path, output: Path, symbol: str) -> None:
    # 按 UTF-8 原始字节嵌入，避免宿主 Python/交叉编译器之间的编码差异。
    data = source.read_bytes()
    # 分模块的 FFI 脚本在同一闭包内拼接，复用 native/px 与退出清理集合。
    for include in re.findall(rb"/\* @include ([a-z_]+\.js) \*/", data):
        path = source.parent / include.decode("ascii")
        data = data.replace(b"/* @include " + include + b" */", path.read_bytes())
    data += b"\0"
    lines = [",".join(str(byte) for byte in data[i:i + 24]) for i in range(0, len(data), 24)]
    text = f"/* Generated from {source.name}; do not edit. */\nstatic const char {symbol}[] = {{\n"
    text += ",\n".join(lines) + "\n};\n"
    write_if_changed(output, text.encode())


def adapt_quickjs(source: bytes) -> bytes:
    """将 QuickJS-ng 的浮点路径切换到固件内置 dtoa 实现。"""
    text = source.decode("utf-8")

    include_marker = '#include "xsum.h"\n'
    if '#include "dtoa.h"\n' not in text:
        if include_marker not in text:
            raise SystemExit("QuickJS-ng quickjs.c 缺少 xsum.h include，无法接入 dtoa")
        text = text.replace(include_marker, include_marker + '#include "dtoa.h"\n', 1)

    strtod_start = text.find("static double js_strtod(")
    strtod_end = text.find("/* `js_atof", strtod_start)
    if strtod_start < 0 or strtod_end < 0:
        raise SystemExit("QuickJS-ng quickjs.c 缺少 js_strtod/js_atof 边界")
    text = text[:strtod_start] + '''static double js_strtod(const char *str, int radix, bool is_float)
{
    JSATODTempMem tmp_mem;
    int flags = is_float ? 0 : JS_ATOD_INT_ONLY;

    return px_atod(str, NULL, radix, flags, &tmp_mem);
}

''' + text[strtod_end:]

    format_start = text.find("/* JavaScript rounding is specified as round to nearest tie away")
    infinite_start = text.find("static JSValue js_dtoa_infinite", format_start)
    radix_start = text.find("/* `js_dtoa_radix", infinite_start)
    if format_start < 0 or infinite_start < 0 or radix_start < 0:
        raise SystemExit("QuickJS-ng quickjs.c 缺少浮点格式化区边界")
    infinite_end = text.find("#define JS_DTOA_TOSTRING", infinite_start)
    if infinite_end < 0 or infinite_end > radix_start:
        raise SystemExit("QuickJS-ng quickjs.c 缺少 js_dtoa_infinite 结束边界")
    infinite_impl = text[infinite_start:infinite_end]
    dtoa_impl = '''/* NuttX 使用 vendored dtoa，避免依赖 libc 的区域设置和舍入行为。 */
#define JS_DTOA_TOSTRING    0
#define JS_DTOA_EXPONENTIAL 1
#define JS_DTOA_FIXED       2
#define JS_DTOA_PRECISION   3

static JSValue js_dtoa(JSContext *ctx, double d, int n_digits, int mode)
{
    char buf[256];
    JSDTOATempMem tmp_mem;
    char *start = buf + 8;
    int sign = d < 0;
    int flags;
    int digits;
    int len;

    if (!isfinite(d))
        return js_dtoa_infinite(ctx, d);

    d = fabs(d);  /* dtoa 默认不显示负零，保持 QuickJS 原行为。 */
    if (mode != JS_DTOA_EXPONENTIAL && n_digits == 0 &&
        d <= (double)MAX_SAFE_INTEGER) {
        uint64_t u64 = (uint64_t)d;
        if (d == u64) {
            len = u64toa(start, u64);
            goto done;
        }
    }

    switch (mode) {
    case JS_DTOA_TOSTRING:
        digits = 0;
        flags = JS_DTOA_FORMAT_FREE | JS_DTOA_EXP_AUTO;
        break;
    case JS_DTOA_EXPONENTIAL:
        if (n_digits == 0) {
            digits = 0;
            flags = JS_DTOA_FORMAT_FREE | JS_DTOA_EXP_ENABLED;
        } else {
            digits = n_digits;
            flags = JS_DTOA_FORMAT_FIXED | JS_DTOA_EXP_ENABLED;
        }
        break;
    case JS_DTOA_FIXED:
        digits = n_digits;
        flags = JS_DTOA_FORMAT_FRAC | JS_DTOA_EXP_DISABLED;
        break;
    case JS_DTOA_PRECISION:
        digits = n_digits;
        flags = JS_DTOA_FORMAT_FIXED | JS_DTOA_EXP_AUTO;
        break;
    default:
        abort();
    }
    len = px_dtoa(start, d, 10, digits, flags, &tmp_mem);

done:
    if (sign)
        start[-1] = '-';
    return js_new_string8_len(ctx, start - sign, len + sign);
}

'''
    text = text[:format_start] + infinite_impl + dtoa_impl + text[radix_start:]

    json_number = 's->token.u.num.val = js_float64(strtod((const char *)p_start, NULL));'
    json_number_replacement = '''{
        JSATODTempMem dtoa_tmp;
        s->token.u.num.val =
            js_float64(px_atod((const char *)p_start, NULL, 10, 0, &dtoa_tmp));
    }'''
    if json_number not in text:
        raise SystemExit("QuickJS-ng quickjs.c 缺少 JSON 数字解析入口")
    text = text.replace(json_number, json_number_replacement, 1)
    return text.encode("utf-8")


def prepare(project: Path, quickjs: Path, output: Path, core: Path) -> None:
    header = quickjs / "quickjs.h"
    if not header.is_file():
        raise SystemExit(f"QuickJS-ng 源码缺失: {quickjs}；请先准备 v0.10.1")
    text = header.read_text()
    version = tuple(int(re.search(rf"#define QJS_VERSION_{part}\s+(\d+)", text).group(1))
                    for part in ("MAJOR", "MINOR", "PATCH"))
    if version != (0, 10, 1):
        raise SystemExit(f"QuickJS-ng 版本不兼容: {version}，要求 (0, 10, 1)")
    for source in sorted(quickjs.iterdir()):
        if source.suffix not in (".c", ".h") and source.name != "LICENSE":
            continue
        data = source.read_bytes()
        if source.name == "cutils.h":
            # 本运行时只有一个 JS 线程，无 Worker/Atomics；不要求 NuttX pthread。
            data = data.replace(b"#if defined(EMSCRIPTEN) || defined(__wasi__)",
                                b"#if defined(EMSCRIPTEN) || defined(__wasi__) || defined(__NuttX__)")
        if source.name == "quickjs.c":
            data = adapt_quickjs(data)
        write_if_changed(output / "quickjs-ng" / source.name, data)
    if not core.is_file():
        raise SystemExit(f"共享 prelude 缺失: {core}")
    embed(core, output / "prelude_core.h", "px_core_prelude")
    embed(project / "src/prelude.js", output / "prelude_nuttx.h", "px_nuttx_prelude")
    # 固定沿用原ESP-IDF发布包中的公开CA集合，离线构建校验来源摘要。
    roots = project / "certs/mozilla-idf-20250225.pem"
    manifest = json.loads((project / "certs/manifest.json").read_text())
    if hashlib.sha256(roots.read_bytes()).hexdigest() != manifest["sha256"]:
        raise SystemExit("内置CA包摘要不匹配")
    embed(roots, output / "tls_ca_bundle.h", "px_tls_ca_bundle")


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quickjs-dir", type=Path)
    parser.add_argument("--repo-root", type=Path, default=project.parent)
    parser.add_argument("--output", type=Path, default=project / "generated")
    args = parser.parse_args()
    quickjs = args.quickjs_dir or project / "quickjs-ng"
    if not quickjs.is_dir() and not args.quickjs_dir:
        quickjs = args.repo_root / "firmware/components/jsvm/quickjs-ng"
    core = project / "shared/prelude_core.js"
    if not core.is_file():
        core = args.repo_root / "firmware/components/jsvm/src/prelude_core.js"
    prepare(project, quickjs.resolve(), args.output.resolve(), core)
    from prepare_text import prepare as prepare_fonts
    prepare_fonts(project, args.repo_root.resolve(), args.output.resolve())
    from prepare_images import prepare as prepare_images
    prepare_images(project, args.repo_root.resolve(), args.output.resolve())
    from prepare_builtin_apps import prepare as prepare_builtin_apps
    prepare_builtin_apps(project, args.repo_root.resolve(), args.output.resolve())
    print(f"QuickJS-ng 0.10.1 / FFI prelude 已准备: {args.output}")


if __name__ == "__main__":
    main()
