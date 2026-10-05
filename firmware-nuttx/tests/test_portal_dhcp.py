#!/usr/bin/env python3
"""真实上游 DHCPD 补丁、版本锁定和 C 生命周期故障注入；不操作真机。"""
from pathlib import Path
import argparse
import importlib.util
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    script = project / 'scripts/portal_dhcp_patch.py'
    spec = importlib.util.spec_from_file_location('portal_dhcp_patch', script)
    patch = importlib.util.module_from_spec(spec); spec.loader.exec_module(patch)
    original = (project.parent / '.deps/apps/netutils/dhcpd/dhcpd.c').read_text()
    updated = patch.patch_source(original)
    assert updated != original and patch.patch_source(updated) == updated
    for bad in [original.replace('int dhcpd_run(', 'int drift_run(', 1),
                updated.replace('  return 1;', '  return 0;', 1),
                updated.replace('  return result;', '  return 999;', 1),
                updated.replace('atomic_t                  ds_state;', 'uint8_t ds_state;')]:
        try:
            patch.patch_source(bad)
        except ValueError:
            pass
        else:
            raise AssertionError('DHCP patch accepted drift')
    functions = '\n\n'.join(patch.function(updated, name)[2] for name in patch.ORIGINAL) + '\n' + patch.HELPER
    source = (project / 'tests/test_portal_dhcp.c').read_text().replace('/* PATCHED_FUNCTIONS */', functions)
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror']
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-portal-dhcp-') as directory:
        root = Path(directory); snapshot = root / 'dhcpd.c'; snapshot.write_text(original)
        subprocess.run(['python3', str(script), str(snapshot)], check=True, timeout=60)
        before = snapshot.stat().st_mtime_ns
        subprocess.run(['python3', str(script), str(snapshot)], check=True, timeout=60)
        assert snapshot.stat().st_mtime_ns == before
        link = root / 'source-link.c'; link.symlink_to(snapshot)
        refused = subprocess.run(['python3', str(script), str(link)], capture_output=True, text=True, timeout=60)
        assert refused.returncode != 0 and snapshot.stat().st_mtime_ns == before
        test = root / 'test.c'; test.write_text(source)
        binary = root / 'test'
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, str(test), '-lpthread', '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary)], check=True, timeout=60)
    print('DHCPD patch exact-version, idempotence, drift and symlink guards passed')


if __name__ == '__main__':
    main()
