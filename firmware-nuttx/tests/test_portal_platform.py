#!/usr/bin/env python3
"""编译门户真实 NuttX 平台分支，以宿主桩验证参数和错误传播。"""
from pathlib import Path
import argparse
import os
import shlex
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', choices=('undefined',))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='pixelbox-portal-platform-') as directory:
        root = Path(directory); (root / 'nuttx').mkdir(); (root / 'netutils').mkdir()
        (root / 'nuttx/config.h').write_text('''
#define FAR
#define CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP 1
#define CONFIG_NETUTILS_DHCPD 1
#define CONFIG_NET_BINDTODEVICE 1
#define CONFIG_NETUTILS_DHCPD_NETMASK 0xffffff00
#define CONFIG_NETUTILS_DHCPD_ROUTERIP 0xc0a80401
#define CONFIG_NETUTILS_DHCPD_DNSIP 0
''')
        shutil.copyfile(project.parent / '.deps/apps/include/netutils/dhcpd.h', root / 'netutils/dhcpd.h')
        (root / 'netutils/netlib.h').write_text('#include <stdint.h>\nint netlib_getmacaddr(const char *, uint8_t *);\n')
        flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D__NuttX__', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
                 '-I' + str(root), '-I' + str(project / 'include')]
        if args.sanitize:
            flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
        binary = root / 'test'
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, str(project / 'src/portal_platform.c'),
                        str(project / 'tests/test_portal_platform.c'), '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary)], check=True, timeout=60)


if __name__ == '__main__':
    main()
