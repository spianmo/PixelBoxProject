#!/usr/bin/env python3
"""独立编译RFC6455核心并验证；每个命令限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--sanitize',choices=('undefined','address,undefined'));args=parser.parse_args()
    project=Path(__file__).resolve().parents[1]
    flags=['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include')]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-ws-test-') as temporary:
        output=str(Path(temporary)/'ws')
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,str(project/'src/ws.c'),str(project/'tests/test_ws.c'),'-o',output],check=True,timeout=60)
        subprocess.run([output],check=True,timeout=60)
if __name__=='__main__':main()
