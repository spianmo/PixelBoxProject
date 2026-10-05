#!/usr/bin/env python3
"""只在独立临时目录编译网络核心，以真实回环socket测试；每命令限60秒。"""
from pathlib import Path
import argparse
import errno
import os
import shlex
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'))
    args=parser.parse_args()
    project=Path(__file__).resolve().parents[1]
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include')]
    if args.sanitize: flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    cc=shlex.split(os.environ.get('CC','cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-net-test-') as temporary:
        build=Path(temporary)
        def run(command):subprocess.run(command,check=True,timeout=60)
        run([*cc,*flags,'-Dgetaddrinfo=px_test_getaddrinfo','-Dsetsockopt=px_test_setsockopt','-c',str(project/'src/net.c'),'-o',str(build/'net.o')])
        run([*cc,*flags,str(project/'tests/test_net.c'),str(project/'src/tls.c'),str(build/'net.o'),'-lpthread','-o',str(build/'test_net')])
        run([str(build/'test_net')])
        run([str(build/'test_net'),'no-tcp-options'])
        fallback_redirects=['-Dgetaddrinfo=px_fallback_getaddrinfo','-Dfreeaddrinfo=px_fallback_freeaddrinfo',
                            '-Dconnect=px_fallback_connect','-Dpoll=px_fallback_poll','-Dclose=px_fallback_close']
        run([*cc,*flags,*fallback_redirects,'-c',str(project/'src/net.c'),'-o',str(build/'fallback.o')])
        run([*cc,*flags,str(project/'tests/test_net_fallback.c'),
             str(build/'fallback.o'),'-lpthread','-o',str(build/'test_fallback')])
        run([str(build/'test_fallback')])
        # 任务组各有fd表，真实TCP/UDP回环不能靠宿主pthread共享fd侥幸通过。
        worker_flags=[*flags,'-I'+str(project/'tests')]
        run([*cc,*worker_flags,'-DPX_NET_TEST_KTHREAD','-DPX_NET_TEST_REDIRECT',
             '-include',str(project/'tests/net_worker_test_platform.h'),'-c',str(project/'src/net.c'),
             '-o',str(build/'net_worker.o')])
        fixture=project/'tests/net_worker_test_platform.c'
        run([*cc,*worker_flags,str(project/'tests/test_net.c'),str(fixture),str(project/'src/tls.c'),
             str(build/'net_worker.o'),'-lpthread','-o',str(build/'test_net_independent')])
        run([str(build/'test_net_independent')])
        run([*cc,*worker_flags,str(project/'tests/test_net_worker.c'),str(fixture),str(project/'src/tls.c'),
             str(build/'net_worker.o'),'-lpthread','-o',str(build/'test_net_worker')])
        for scenario in ('transfer','getfilep','dup2','import','pending_cancel','owner_exit'):
            run([str(build/'test_net_worker'),scenario])
        for scenario,error in (('launch_fail',-errno.EAGAIN),('launch_raw_fail',-1)):
            result=subprocess.run([str(build/'test_net_worker'),scenario],check=True,timeout=60,capture_output=True,text=True)
            expected=f'[pixelbox.net] stage=worker-create error={error} stack=16384 tls=0 udp=0'
            assert result.stderr.splitlines()==[expected]*12, result.stderr
            print(result.stdout.strip())
    print('主机网络回环及8组独立任务/fd移交/失败回收/启动诊断测试通过；不是NuttX真机验证')

if __name__=='__main__':main()
