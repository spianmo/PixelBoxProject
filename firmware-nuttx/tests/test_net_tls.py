#!/usr/bin/env python3
"""在临时目录验证POSIX网络事件与TLS的真实组合；不连接外网，每命令限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from test_tls import certificates

def command(args,**kwargs):return subprocess.run(args,check=True,timeout=60,**kwargs)
def scenario(binary,directory,name):
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version=context.maximum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(directory/'valid.pem',directory/'server.key')
    errors=[]
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(10)
        port=listener.getsockname()[1]
        def serve():
            try:
                raw,_=listener.accept();raw.settimeout(15)
                with raw:
                    if name in ('timeout','destroy','missing'):
                        while raw.recv(4096):pass
                        return
                    try:stream=context.wrap_socket(raw,server_side=True)
                    except ssl.SSLError:
                        if name in ('hostname','wrong_ca'):return
                        raise
                    with stream:
                        if name in ('hostname','wrong_ca'):
                            try:stream.recv(1)
                            except ssl.SSLError:pass
                            return
                        if name=='truncated':stream.sendall(b'payload');os.close(stream.detach());return
                        total=1024*1024 if name=='pressure' else 65536
                        if name=='pressure':time.sleep(.3)
                        received=bytearray()
                        while len(received)<total:
                            part=stream.recv(total-len(received));assert part;received.extend(part)
                        assert received==(b'\x5a'*total if name=='pressure' else bytes(i%251 for i in range(total)))
                        stream.sendall(b'K' if name=='pressure' else bytes(i%239 for i in range(12000)))
                        try:stream.unwrap().close()
                        except ssl.SSLEOFError:pass
            except BaseException as error:errors.append(error)
        thread=threading.Thread(target=serve,daemon=True);thread.start()
        command([str(binary),name,str(port)]);thread.join(timeout=20)
        assert not thread.is_alive(),'TLS服务端未退出'
        if errors:raise errors[0]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'))
    parser.add_argument('--mbedtls-prefix',type=Path,default=Path(os.environ.get('MBEDTLS_PREFIX','/opt/homebrew/opt/mbedtls@3')))
    args=parser.parse_args();project=Path(__file__).resolve().parents[1];prefix=args.mbedtls_prefix
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include'),'-I'+str(prefix/'include')]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    cc=shlex.split(os.environ.get('CC','cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-net-tls-') as temporary:
        build=Path(temporary);certificates(build)
        command([*cc,*flags,'-Dsocket=px_test_tls_socket','-c',str(project/'src/net.c'),'-o',str(build/'net.o')])
        command([*cc,*flags,'-DPX_TLS_MBEDTLS','-DPX_TLS_CA_FILE="'+str(build/'active-ca.pem')+'"','-c',str(project/'src/tls.c'),'-o',str(build/'tls.o')])
        binary=build/'test_net_tls'
        command([*cc,*flags,str(project/'tests/test_net_tls.c'),str(build/'net.o'),str(build/'tls.o'),
                 str(prefix/'lib/libmbedtls.a'),str(prefix/'lib/libmbedx509.a'),str(prefix/'lib/libmbedcrypto.a'),'-lpthread','-o',str(binary)])
        scenario(binary,build,'missing');shutil.copyfile(build/'ca.pem',build/'active-ca.pem')
        for name in ('echo','pressure','hostname','timeout','destroy','truncated'):scenario(binary,build,name)
        shutil.copyfile(build/'wrong-ca.pem',build/'active-ca.pem');scenario(binary,build,'wrong_ca')
        # 同样的真实TLS服务端，客户端改走独立任务fd表及struct file发布/导入。
        worker_flags=[*flags,'-I'+str(project/'tests')]
        redirects=['-DPX_NET_TEST_KTHREAD','-DPX_NET_TEST_REDIRECT','-include',
                   str(project/'tests/net_worker_test_platform.h')]
        command([*cc,*worker_flags,*redirects,'-c',str(project/'src/net.c'),'-o',str(build/'net_worker.o')])
        worker_ca=build/'worker-ca.pem'
        command([*cc,*worker_flags,*redirects,'-DPX_TLS_MBEDTLS','-DPX_TLS_CA_FILE="'+str(worker_ca)+'"',
                 '-c',str(project/'src/tls.c'),'-o',str(build/'tls_worker.o')])
        worker_binary=build/'test_net_tls_worker'
        command([*cc,*worker_flags,'-DPX_NET_TEST_KTHREAD',str(project/'tests/test_net_tls.c'),
                 str(project/'tests/net_worker_test_platform.c'),str(build/'net_worker.o'),str(build/'tls_worker.o'),
                 str(prefix/'lib/libmbedtls.a'),str(prefix/'lib/libmbedx509.a'),str(prefix/'lib/libmbedcrypto.a'),
                 '-lpthread','-o',str(worker_binary)])
        scenario(worker_binary,build,'missing');shutil.copyfile(build/'ca.pem',worker_ca)
        for name in ('echo','pressure','hostname','timeout','destroy','truncated'):scenario(worker_binary,build,name)
        shutil.copyfile(build/'wrong-ca.pem',worker_ca);scenario(worker_binary,build,'wrong_ca')
    print('16个网络+TLS整链场景通过：普通pthread/独立任务fd移交、真实握手及加密传输、背压、失败回收；非真机验证')

if __name__=='__main__':main()
