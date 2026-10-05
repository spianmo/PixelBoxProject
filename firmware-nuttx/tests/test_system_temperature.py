#!/usr/bin/env python3
"""用寄存器/ROM函数替身验证温度换算和有界采样，不访问宿主或板载硬件。"""
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
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-DPX_SYSTEM_TEMPERATURE_TEST', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'), '-I' + str(project / 'tests')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-temperature-') as temporary:
        executable = Path(temporary) / 'test'
        subprocess.run([*cc, *flags, str(project / 'src/system_temperature.c'), str(project / 'tests/test_system_temperature.c'), '-lpthread', '-lm', '-o', str(executable)], check=True, timeout=60)
        for mode in ('positive', 'negative', 'uncalibrated', 'error', 'nan'):
            subprocess.run([str(executable), mode], check=True, timeout=60)

if __name__ == '__main__':
    main()
