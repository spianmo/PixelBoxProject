#!/usr/bin/env python3
"""在临时目录验证NTP真实UDP回环；替换clock_settime避免改变宿主时间。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'), '-I' + str(project / 'tests')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-system-net-') as temporary:
        directory = Path(temporary)
        def run(command):
            subprocess.run(command, check=True, timeout=60)
        for platform in ([], ['-DPX_SYSTEM_NET_TEST_KTHREAD']):
            run([*cc, *flags, *platform, '-Dgetaddrinfo=px_test_getaddrinfo',
                 '-Dclock_settime=px_test_clock_settime', '-Dclock_gettime=px_test_clock_gettime',
                 '-Dclock_getres=px_test_clock_getres', '-c', str(project / 'src/system_net.c'), '-o', str(directory / 'system_net.o')])
            run([*cc, *flags, *platform, str(project / 'tests/test_system_net.c'), str(directory / 'system_net.o'), '-lpthread', '-o', str(directory / 'test')])
            run([str(directory / 'test')])

if __name__ == '__main__':
    main()
