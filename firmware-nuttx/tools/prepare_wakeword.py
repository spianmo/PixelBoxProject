#!/usr/bin/env python3
"""离线收敛真实 MN7 依赖并只读嵌入原模型；不写设备，不修改任何分区。"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

MODEL_SHA256 = "87c77c650bbafbfb63f7cca4979f70302ef34078429635d01f716f5ae01b8e5b"
LIBRARY_HASHES = {
    "libmultinet.a": "7b8bb0f34bd4e809fc450f608dfd76327a5107432f07c711e559de75036a9d6f",
    "libdl_lib.a": "2acee444ec84efd9700ae9314461d1802988871afb878dec76d95bbb5d5f4b4f",
    "libfst.a": "775ea29a30a3f92a3992fdbf7037f218abe244dd01d624c92e1ac1527c625471",
    "libhufzip.a": "ca435f564dfd0c83993bf0e12399935d5ba25a5b1f951792297f086eee69376d",
    "libc_speech_features.a": "72e3411a09005a63c9c363269836f17e3c3747a6c4bc7d9752434f9f31bbfd34",
    "libespressif__esp-dl.a": "035deeb4f3f40b463cac9f102dce30ab9fc710cb43d7f9a0b5c5f60827eb96dd",
    "libespressif__dl_fft.a": "b24243c4d0333b53670462f624f7cd4dfdf7c2ceace1bf84e585b180a784bb12",
}
LIBRARY_STATE = {name: 4 for name in (
    "hufzip_lock", "index_buf_model", "index_head_num", "model_params", "model_params_ptr", "model_params_type")}
LIBRARY_TABLES = {"sigmoid_table_4_4": 0x100, "sigmoid_table_5_8": 0x1630,
                  "tanh_table_3_5": 0x100, "tanh_table_4_8": 0xbca}
CJSON_HASHES = {"cJSON.c": "607e756460fa0de37d20a7a9181f2de29c97bfb7ce5a0e6c2f548243836cd852",
                "cJSON.h": "25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee"}

def audit_symbols(output: str) -> None:
    rows = [line.split() for line in output.splitlines()]
    state = {row[3]: int(row[1], 16) for row in rows if len(row) == 4 and row[2] in "bBCc"}
    tables = {row[3]: int(row[1], 16) for row in rows if len(row) == 4 and row[2] in "dD"}
    cpp = {row[-1] for row in rows if row and row[-1].startswith("_Z")}
    if state != LIBRARY_STATE or tables != LIBRARY_TABLES or cpp != {"_ZN2dl4base7dotprodEPfS1_S1_ii"}:
        raise RuntimeError("MN7 可变状态或 C++ 调用闭包变化，需重新审计 OOM 回收边界")

def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)

def toolchain(compiler: str | None = None) -> str:
    if compiler:
        return str(Path(compiler).resolve())
    found = shutil.which("xtensa-esp32s3-elf-gcc")
    if found:
        return found
    candidates = sorted(Path.home().glob(".espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin/xtensa-esp32s3-elf-gcc"))
    if len(candidates) == 1:
        return str(candidates[0])
    raise RuntimeError("请通过 --cc 指定与 NuttX 一致的 xtensa-esp32s3-elf-gcc")

def prepare(project: Path, repo: Path, output: Path, compiler: str | None = None) -> dict:
    project, repo, output = project.resolve(), repo.resolve(), output.resolve() / "wakeword"
    sr = repo / "firmware/managed_components/espressif__esp-sr"
    manifest = (sr / "idf_component.yml").read_text()
    if "2.5.3" not in manifest:
        raise RuntimeError("MN7 ABI 审计仅适用本仓库 ESP-SR 2.5.3")
    model = (repo / "firmware/build/srmodels/srmodels.bin").read_bytes()
    if hashlib.sha256(model).hexdigest() != MODEL_SHA256:
        raise RuntimeError("MN7 原始模型摘要不匹配，禁止静默接受其他模型")
    sources = [sr / "lib/esp32s3" / ("lib" + n + ".a") for n in
               ("multinet", "dl_lib", "fst", "hufzip", "c_speech_features")]
    sources += [repo / "firmware/build/esp-idf" / n / ("lib" + n + ".a")
                for n in ("espressif__esp-dl", "espressif__dl_fft")]
    for path in sources:
        if not path.is_file():
            raise RuntimeError(f"缺少已构建的原始推理依赖：{path}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != LIBRARY_HASHES[path.name]:
            raise RuntimeError(f"未审计的 MN7 归档变更：{path}")
    cc = toolchain(compiler); ld = cc.removesuffix("gcc") + "ld"
    objcopy = cc.removesuffix("gcc") + "objcopy"
    nm = cc.removesuffix("gcc") + "nm"
    output.mkdir(parents=True, exist_ok=True)
    report = {"model_sha256": MODEL_SHA256, "model_bytes": len(model),
              "libraries": {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}
    # selector 真实返回原库 vtable，避免通用选择器同时拉入 MN5/MN6。
    with tempfile.TemporaryDirectory(prefix="px-mn7-prepare-") as directory:
        tmp = Path(directory)
        # 选择器随模型放入 IROM，libc 可位于 IRAM；必须与 NuttX 一样允许跨段长调用。
        subprocess.run([cc, "-Os", "-mlongcalls", "-ffunction-sections", "-fdata-sections", "-I", str(project / "include"),
                        "-c", str(project / "src/wakeword_selector.c"), "-o", str(tmp / "selector.o")], check=True, timeout=60)
        subprocess.run([ld, "-r", "--gc-sections", "-u", "esp_sr_multinet7_quantized", "-o", str(tmp / "multinet7.o"),
                        str(tmp / "selector.o"), "--start-group", *map(str, sources), "--end-group"], check=True, timeout=60)
        symbols = subprocess.run([nm, "-S", str(tmp / "multinet7.o")], check=True, text=True, capture_output=True, timeout=60).stdout
        audit_symbols(symbols)
        # 仅重定向真推理闭包，不改变系统 malloc 或其它组件的能力语义。
        arguments = []
        for name in ("malloc", "calloc", "realloc", "strdup", "free", "fopen"):
            arguments += ["--redefine-sym", f"{name}=px_mn7_{name}"]
        for name in LIBRARY_STATE:
            arguments += ["--redefine-sym", f"{name}=px_mn7_state_{name}"]
        subprocess.run([objcopy, *arguments, str(tmp / "multinet7.o")], check=True, timeout=60)
        # objcopy 在重命名后按新名字匹配 binding；单独一步避免局部 BSS 无法链接。
        arguments = [item for name in LIBRARY_STATE for item in ("--globalize-symbol", f"px_mn7_state_{name}")]
        subprocess.run([objcopy, *arguments, str(tmp / "multinet7.o")], check=True, timeout=60)
        final_symbols = subprocess.run([nm, "-S", str(tmp / "multinet7.o")], check=True, text=True, capture_output=True, timeout=60).stdout
        for name in LIBRARY_STATE:
            if not re.search(r"\bB px_mn7_state_" + re.escape(name) + r"$", final_symbols, re.MULTILINE):
                raise RuntimeError(f"MN7 状态字未正确导出：{name}")
        write(output / "multinet7.o", (tmp / "multinet7.o").read_bytes())
    state_header = ["/* 自动生成：只适用已审计归档的六个状态字。 */", "#include <string.h>",
                    "void px_mn7_cjson_state_reset(void);"]
    state_header += [f"extern unsigned char px_mn7_state_{name}[{size}];" for name, size in LIBRARY_STATE.items()]
    state_header += ["static inline void px_mn7_library_state_reset(void)", "{"]
    state_header += [f"  memset(px_mn7_state_{name}, 0, {size});" for name, size in LIBRARY_STATE.items()]
    state_header += ["  px_mn7_cjson_state_reset();", "}", ""]
    write(output / "library_state.h", "\n".join(state_header).encode())
    write(output / "srmodels.bin", model)
    path = str(output / "srmodels.bin").replace("\\", "\\\\").replace('"', '\\"')
    assembly = '.section .rodata.px_mn7_archive,"a",@progbits\n.balign 16\n.global px_mn7_archive\n.global px_mn7_archive_end\npx_mn7_archive:\n.incbin "' + path + '"\npx_mn7_archive_end:\n'
    write(output / "model.S", assembly.encode())
    digest = ",".join("0x" + MODEL_SHA256[i:i + 2] for i in range(0, 64, 2))
    write(output / "model_manifest.h", ("/* 自动生成；只读模型的完整 SHA256。 */\nstatic const uint8_t px_mn7_archive_sha256[32] = {" + digest + "};\n").encode())
    # cJSON 源码以 NuttX libc 重新编译，避免预编译 Newlib _ctype_ 的表布局依赖。
    cjson = repo / "firmware/managed_components/espressif__cjson/cJSON"
    for name in ("cJSON.c", "cJSON.h"):
        data = (cjson / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != CJSON_HASHES[name]:
            raise RuntimeError(f"cJSON 源码变更，需重新审计 allocator 和静态状态：{name}")
        if name == "cJSON.c":
            marker = b'#include "cJSON.h"'
            if data.count(marker) != 1:
                raise RuntimeError("cJSON allocator 注入位置不唯一")
            data = data.replace(marker, marker + b'\n#include "pixelbox_mn7_memory.h"\n#define malloc px_mn7_malloc\n#define free px_mn7_free\n#define realloc px_mn7_realloc\n')
            data += '\n/* OOM 后指针不再有效；下次解析前清空独占 cJSON 状态。 */\nvoid px_mn7_cjson_state_reset(void)\n{\n  global_error.json = NULL; global_error.position = 0; cJSON_InitHooks(NULL);\n}\n'.encode()
        write(output / name, data)
    report["memory"] = {"budget_bytes": 4 * 1024 * 1024, "measured_device_peak": None,
                        "state_reset": list(LIBRARY_STATE), "library_allocator_redirected": True,
                        "file_loading": "unsupported"}
    write(output / "manifest.json", (json.dumps(report, indent=2) + "\n").encode())
    return report

if __name__ == "__main__":
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=project.parent)
    parser.add_argument("--output", type=Path, default=project / "generated")
    parser.add_argument("--cc")
    args = parser.parse_args()
    print(json.dumps(prepare(project, args.repo_root, args.output, args.cc), indent=2))
