#!/usr/bin/env python3
"""独立编译真实framebuffer FFI与QuickJS，以设备替身验证脏区/失败重试。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    parser.add_argument('--optimize', choices=('0', '1', '2', '3', 's'), default='1')
    parser.add_argument('--split-gap', type=int, choices=(0, 1, 2, 4, 8), default=8,
                        help='planner vertical merge gap (default: 8)')
    parser.add_argument('--planner-only', action='store_true',
                        help='only run the synthetic Wi-Fi planner benchmark')
    parser.add_argument('--fast-path-only', action='store_true',
                        help='only run the known-clean and solid-change regressions')
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    with tempfile.TemporaryDirectory(prefix='pixelbox-framebuffer-delta-') as directory:
        root = Path(directory)
        headers = {
            'nuttx/config.h': '''#pragma once
#define CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER 1
#define CONFIG_INTERPRETERS_PIXELBOX_FB_DEVICE "/dev/test-fb"
#define CONFIG_FB_UPDATE 1
''',
            'nuttx/video/fb.h': '''#pragma once
#include <stdint.h>
#include <stddef.h>
#define FB_FMT_RGB16_565 1
#define FB_FMT_RGB24 2
#define FB_FMT_RGB32 3
#define FBIOGET_VIDEOINFO 100
#define FBIOGET_PLANEINFO 101
#define FBIO_UPDATE 102
#define FBIOGET_POWER 103
#define FBIOSET_POWER 104
struct fb_videoinfo_s { int fmt; uint16_t xres,yres; };
struct fb_planeinfo_s { unsigned bpp; size_t stride,fblen; };
struct fb_area_s { uint16_t x,y,w,h; };
''',
        }
        for name, source in headers.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source)
        flags = ['-std=c11', '-D__NuttX__', '-O' + args.optimize, '-g', '-Wall', '-Wextra', '-Werror',
                 '-I' + str(root), '-I' + str(project / 'include'), '-I' + str(library.parent / 'generated/quickjs-ng')]
        if args.sanitize:
            flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
        flags += [f'-DFRAMEBUFFER_SPLIT_GAP={args.split_gap}']
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, str(project / 'tests/test_framebuffer_delta.c'),
                        str(library), '-lpthread', '-lm', '-o', str(root / 'test')], check=True, timeout=60)
        command = [str(root / 'test')]
        if args.planner_only:
            command.append('planner')
        elif args.fast_path_only:
            command.append('fast-path')
        subprocess.run(command, check=True, timeout=60)


if __name__ == '__main__':
    main()
