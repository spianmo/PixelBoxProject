#!/usr/bin/env python3
"""验证归档状态门禁与实际生成对象，不访问真机、不改主构建目录。"""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROJECT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(PROJECT/'tools'))
import prepare_wakeword as subject

class PrepareTests(unittest.TestCase):
    def symbols(self):
        state=[f'00000000 {size:08x} b {name}' for name,size in subject.LIBRARY_STATE.items()]
        state += [f'00000000 {size:08x} d {name}' for name,size in subject.LIBRARY_TABLES.items()]
        state += ['00000000 00000013 T _ZN2dl4base7dotprodEPfS1_S1_ii']
        return '\n'.join(state)

    def test_state_and_cpp_fail_closed(self):
        valid=self.symbols(); subject.audit_symbols(valid)
        for changed in [valid+'\n00000000 00000004 b hidden_pointer',
                        valid.replace('00000004 b hufzip_lock','00000008 b hufzip_lock'),
                        valid.replace('sigmoid_table_4_4','unknown_table'),
                        valid+'\n00000000 00000020 T _Zunreviewed_cpp_raii']:
            with self.subTest(changed=changed[-70:]),self.assertRaises(RuntimeError):
                subject.audit_symbols(changed)

    def test_actual_archive_and_idempotent_output(self):
        with tempfile.TemporaryDirectory(prefix='px-mn7-prepare-test-') as name:
            target=Path(name)
            report=subject.prepare(PROJECT,PROJECT.parent,target)
            self.assertIsNone(report['memory']['measured_device_peak'])
            files=sorted((target/'wakeword').iterdir())
            first={p.name:(hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_mtime_ns) for p in files}
            subject.prepare(PROJECT,PROJECT.parent,target)
            second={p.name:(hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_mtime_ns) for p in files}
            self.assertEqual(first,second)
            nm=subject.toolchain().removesuffix('gcc')+'nm'
            symbols=subprocess.run([nm,'-S',str(target/'wakeword/multinet7.o')],capture_output=True,text=True,check=True,timeout=60).stdout
            for key in subject.LIBRARY_STATE:
                self.assertRegex(symbols,r'\bB px_mn7_state_'+key+r'\b')
            for original in ['malloc','calloc','free','strdup','fopen']:
                self.assertNotRegex(symbols,r'\bU '+original+r'\n')
                self.assertRegex(symbols,r'\bU px_mn7_'+original+r'\n')
            source=(target/'wakeword/cJSON.c').read_text()
            self.assertIn('#define malloc px_mn7_malloc',source)
            self.assertIn('global_error.json = NULL',source)

if __name__=='__main__': unittest.main()
