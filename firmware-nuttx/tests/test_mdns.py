#!/usr/bin/env python3
"""独立临时目录编译mDNS真实UDP回环；所有子进程上限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import socket
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    sockets = [socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range(2)]
    for item in sockets:
        item.bind(('127.0.0.1', 0))
    ports = [item.getsockname()[1] for item in sockets]
    for item in sockets:
        item.close()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-DPX_MDNS_GROUP="127.0.0.1"', f'-DPX_MDNS_PORT={ports[0]}', f'-DPX_MDNS_BIND_PORT={ports[1]}',
             '-I' + str(project / 'include'), '-I' + str(project / 'tests')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-mdns-') as temporary:
        for platform in ([], ['-DPX_MDNS_TEST_KTHREAD']):
            binary = Path(temporary) / 'test'
            subprocess.run([*cc, *flags, *platform, str(project / 'tests/test_mdns.c'), '-lpthread', '-o', str(binary)], check=True, timeout=60)
            subprocess.run([str(binary)], check=True, timeout=60)


if __name__ == '__main__':
    main()
