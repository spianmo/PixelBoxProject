#!/usr/bin/env python3
"""借用已构建QuickJS静态库，在独立临时目录验证图片FFI；每个命令最多60秒。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import os
import tempfile
import sys

from PIL import Image
from test_images import command, fixtures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("quickjs_library", type=Path)
    parser.add_argument("--sanitize", choices=("undefined", "address,undefined"))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    headers = library.parent / "generated/quickjs-ng"
    assert library.is_file() and (headers / "quickjs.h").is_file()
    with tempfile.TemporaryDirectory(prefix="pixelbox-image-binding-") as temporary:
        directory = Path(temporary)
        generated = directory / "generated"
        command([sys.executable, str(project / "tools/prepare_images.py"), "--output", str(generated)])
        flags = ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror"]
        if args.sanitize:
            flags.extend(["-fsanitize=" + args.sanitize, "-fno-sanitize-recover=all"])
        compiler = shlex.split(os.environ.get("CC", "cc"))
        sources = [project / "src/image.c", project / "src/image_binding.c", project / "tests/test_image_binding.c"]
        sources.extend(generated / "images" / name for name in ("pngle.c", "miniz.c", "gifdec.c", "tjpgd.c"))
        executable = directory / "binding"
        command([*compiler, *flags, "-I" + str(project / "include"), "-I" + str(headers),
                 "-I" + str(generated / "images"), *map(str, sources), str(library), "-lm", "-lpthread", "-o", str(executable)])
        fixtures(directory)
        frames = [Image.new("P", (512, 512), value) for value in range(1, 6)]
        palette = [value for index in range(256) for value in (index, 0, 0)]
        for frame in frames: frame.putpalette(palette)
        frames[0].save(directory / "too-many-bytes.gif", save_all=True, append_images=frames[1:],
                       duration=100, disposal=1, optimize=False)
        names = ["rgb.png", "alpha.png", "444.jpg", "animation.gif", "too-many-bytes.gif"]
        data = {name: list((directory / name).read_bytes()) for name in names}
        script = directory / "binding.js"
        script.write_text("const fixtures=" + json.dumps(data, separators=(",", ":")) + ";\n" + r"""
function assert(condition, message='assertion failed') {if(!condition)throw new Error(message);}
function throws(callback) {let caught=false;try{callback();}catch(e){caught=true;}assert(caught,'expected exception');}
const bytes=name=>new Uint8Array(fixtures[name]);
const rgb=bytes('rgb.png');
const padded=new Uint8Array(rgb.length+14);padded.set(rgb,7);
const decoded=native.decodeImage(padded.subarray(7,7+rgb.length));
assert(decoded.width===17 && decoded.height===13 && decoded.alpha===null);
assert(new Uint32Array(decoded.pixels)[0]===0);
rgb.fill(0);assert(new Uint32Array(decoded.pixels)[1]===0x110007);
const alpha=native.decodeImage(bytes('alpha.png').buffer);
assert(new Uint8Array(alpha.alpha)[0]===0x1c);
assert(native.decodeImage(bytes('444.jpg')).width===17);
for(const value of [null,1,'path',new Uint16Array(3),new Uint8Array(0),bytes('rgb.png').subarray(0,15)])throws(()=>native.decodeImage(value));
Object.defineProperty(Object.prototype,'width',{set(){throw new Error('unexpected setter');},configurable:true});
Object.defineProperty(Array.prototype,'0',{set(){throw new Error('unexpected array setter');},configurable:true});
let frames;
try {frames=native.loadGifFrames(bytes('animation.gif'));}
finally {delete Object.prototype.width;delete Array.prototype[0];}
assert(frames.length===4 && frames[0].duration===100 && frames[1].duration===20 && frames[2].duration===150);
const before=new Uint32Array(frames[1].pixels)[0];new Uint32Array(frames[0].pixels)[0]=0x123456;
assert(new Uint32Array(frames[1].pixels)[0]===before);
throws(()=>native.loadGifFrames(bytes('too-many-bytes.gif')));
const baseline=gc();for(let i=0;i<200;i++)native.decodeImage(bytes('alpha.png'));
assert(gc()<baseline+65536,'decoded buffers must be freed by GC');
""")
        command([str(executable), str(script)])


if __name__ == "__main__":
    main()
