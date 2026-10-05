#!/usr/bin/env python3
"""宿主门户32KiB栈压力：真实TCP/QuickJS，guard页和sentinel；不是Xtensa高水位。"""
from pathlib import Path
import argparse
import json
import platform
import subprocess
import sys
import tempfile


def summarize(rows):
    result = {}
    for requested in sorted({row['requested_bytes'] for row in rows}):
        group = [row for row in rows if row['requested_bytes'] == requested]
        for row in group:
            assert row['used_bytes'] + row['free_bytes'] == row['stack_bytes'], row
            assert 0 < row['used_bytes'] < row['stack_bytes'], row
        result[str(requested)] = {
            'threads': len(group), 'stack_bytes': sorted({row['stack_bytes'] for row in group}),
            'max_used_bytes': max(row['used_bytes'] for row in group),
            'min_free_bytes': min(row['free_bytes'] for row in group),
        }
    controller = result['32768']
    assert controller['stack_bytes'] == [32768], controller
    assert controller['threads'] >= 15, controller
    assert controller['min_free_bytes'] >= 8192, controller
    assert result['8192']['min_free_bytes'] >= 4096, result['8192']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined',), default='undefined')
    parser.add_argument('--report', type=Path, help='保存宿主ABI、每线程写入高水位及汇总JSON')
    args = parser.parse_args()
    tests = Path(__file__).resolve().parent
    command = [sys.executable, str(tests / 'test_portal_runtime.py'), str(args.quickjs_library.resolve()),
               '--sanitize', args.sanitize]
    # 原三AP断言仍实际执行；压力场景使用单独编译宏，避免把旧回归改成只测大数组。
    subprocess.run(command, check=True, timeout=60)
    with tempfile.TemporaryDirectory(prefix='pixelbox-portal-stack-') as temporary:
        log = Path(temporary) / 'stack.jsonl'
        subprocess.run([*command, '--stack-probe-log', str(log)], check=True, timeout=60)
        rows = [json.loads(line) for line in log.read_text().splitlines()]
        report = {'platform': platform.platform(), 'machine': platform.machine(),
                  'measurement': 'host pthread guard pages and sentinel written extent; not Xtensa',
                  'xtensa_runtime_measured': False, 'sanitizer': args.sanitize,
                  'summary': summarize(rows), 'threads': rows}
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: value for key, value in report.items() if key != 'threads'}, indent=2))
    print('PASS portal host stack margin, 32-AP/24-output limit, bounded deep JSON and original regression')


if __name__ == '__main__':
    main()
