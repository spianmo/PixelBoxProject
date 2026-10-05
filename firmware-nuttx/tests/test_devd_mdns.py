#!/usr/bin/env python3
"""mDNS 记录桩验证真实 devd 生命周期与应用提交，不使用组播网络。"""
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
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-I' + str(project / 'include'), '-I' + str(library.parent / 'generated/quickjs-ng')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    sources = ['src/net.c', 'src/tls.c', 'src/ws.c', 'src/store.c', 'src/sha256.c', 'tests/test_devd_mdns.c']
    with tempfile.TemporaryDirectory(prefix='pixelbox-devd-mdns-') as temporary:
        root = Path(temporary)
        binary = root / 'devd-mdns'
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags,
                        *[str(project / path) for path in sources], str(library), '-lm', '-lpthread', '-o', str(binary)],
                       check=True, timeout=60)
        subprocess.run([str(binary), str(root / 'service'), str(root / 'submit')], check=True, timeout=60)


if __name__ == '__main__':
    main()
