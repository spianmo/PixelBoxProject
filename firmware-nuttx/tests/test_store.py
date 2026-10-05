#!/usr/bin/env python3
"""独立临时目录验证staging/current/prev事务；每命令限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--sanitize',choices=('undefined','address,undefined'));args=parser.parse_args()
    project=Path(__file__).resolve().parents[1];flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include')]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    cc=shlex.split(os.environ.get('CC','cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-store-test-') as temporary:
        build=Path(temporary);binary=build/'store'
        def run(args):subprocess.run(args,check=True,timeout=60)
        run([*cc,*flags,'-Drenameat=px_test_renameat','-c',str(project/'src/store.c'),'-o',str(build/'store.o')])
        run([*cc,*flags,str(project/'src/sha256.c'),str(project/'tests/test_store.c'),str(build/'store.o'),'-o',str(binary)])
        run([str(binary),str(build/'apps')])
if __name__=='__main__':main()
