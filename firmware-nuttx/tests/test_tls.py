#!/usr/bin/env python3
"""真实TLS回环测试：临时CA签发、OpenSSL服务端、mbedTLS客户端，无外网依赖。"""
from pathlib import Path
import argparse
import datetime
import os
import shlex
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time


def command(argv, **kwargs):
    return subprocess.run(argv, check=True, timeout=60, **kwargs)


def certificates(directory):
    openssl = shutil.which("openssl")
    if not openssl:
        raise SystemExit("需要 openssl 来临时签发测试证书")

    def run(*args):
        command([openssl, *args], cwd=directory, stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE)

    for name in ("ca", "wrong-ca", "server"):
        run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-out", name + ".key")
    for name in ("ca", "wrong-ca"):
        run("req", "-new", "-x509", "-key", name + ".key", "-out", name + ".pem",
            "-days", "30", "-subj", "/CN=Pixelbox Test " + name,
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    run("req", "-new", "-key", "server.key", "-out", "server.csr",
        "-subj", "/CN=localhost")
    (directory / "index").write_text("")
    (directory / "serial").write_text("01\n")
    (directory / "ca.conf").write_text("""[ca]
default_ca = issuer
[issuer]
database = index
serial = serial
new_certs_dir = .
certificate = ca.pem
private_key = ca.key
default_md = sha256
default_days = 7
unique_subject = no
policy = policy
x509_extensions = server
[policy]
commonName = supplied
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
""")
    now = datetime.datetime.now(datetime.timezone.utc)
    intervals = {
        "valid": (now - datetime.timedelta(days=1), now + datetime.timedelta(days=7)),
        "expired": (now - datetime.timedelta(days=7), now - datetime.timedelta(days=1)),
        "future": (now + datetime.timedelta(days=1), now + datetime.timedelta(days=7)),
    }
    for name, (start, end) in intervals.items():
        run("ca", "-batch", "-notext", "-config", "ca.conf", "-in", "server.csr",
            "-out", name + ".pem", "-startdate", start.strftime("%Y%m%d%H%M%SZ"),
            "-enddate", end.strftime("%Y%m%d%H%M%SZ"))


def run_server(binary, directory, scenario):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.maximum_version = ssl.TLSVersion.TLSv1_2
    certificate = scenario if scenario in ("expired", "future") else "valid"
    context.load_cert_chain(directory / (certificate + ".pem"), directory / "server.key")
    errors = []
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(20)
        port = listener.getsockname()[1]

        def serve():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(20)
                    if scenario == "stall":
                        while connection.recv(4096):
                            pass
                        return
                    try:
                        stream = context.wrap_socket(connection, server_side=True)
                    except ssl.SSLError:
                        if scenario in ("hostname", "wrong_ca", "expired", "future",
                                        "clock_back", "clock_forward", "clock_lost"):
                            return
                        raise
                    with stream:
                        if scenario in ("echo", "default_echo", "rebind"):
                            received = bytearray()
                            while len(received) < 12345:
                                part = stream.recv(12345 - len(received))
                                assert part
                                received.extend(part)
                            assert received == bytes(i % 251 for i in range(12345))
                            stream.sendall(bytes(i % 239 for i in range(12000)))
                            try:
                                stream.unwrap().close()
                            except ssl.SSLEOFError:
                                pass  # 客户端free不等待close_notify；已发送的notify仍须被识别。
                        elif scenario == "truncated":
                            stream.sendall(b"payload")
                            os.close(stream.detach())
                        elif scenario == "pressure":
                            time.sleep(0.3)
                            received = 0
                            while received < 1024 * 1024:
                                part = stream.recv(32768)
                                assert part and all(byte == 0x5A for byte in part)
                                received += len(part)
                            assert received == 1024 * 1024
                            stream.sendall(b"K")
                        else:
                            # 验证失败的客户端在本地终止；服务端可先完成自己的握手。
                            try:
                                stream.recv(1)
                            except ssl.SSLError:
                                pass
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        ca = directory / ("wrong-ca.pem" if scenario == "wrong_ca" else "ca.pem")
        command([str(binary), scenario, str(port), str(ca)])
        thread.join(timeout=25)
        assert not thread.is_alive(), "TLS服务端未退出"
        if errors:
            raise errors[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", choices=("undefined", "address,undefined"))
    parser.add_argument("--mbedtls-prefix", type=Path,
                        default=Path(os.environ.get("MBEDTLS_PREFIX", "/opt/homebrew/opt/mbedtls@3")))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    prefix = args.mbedtls_prefix
    if not (prefix / "include/mbedtls/ssl.h").is_file():
        raise SystemExit("需要mbedTLS 3.6开发库；用--mbedtls-prefix指定已有安装，不自动安装依赖")
    flags = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
             "-I" + str(project / "include"), "-I" + str(prefix / "include")]
    if args.sanitize:
        flags += ["-fsanitize=" + args.sanitize, "-fno-sanitize-recover=all"]
    cc = shlex.split(os.environ.get("CC", "cc"))
    with tempfile.TemporaryDirectory(prefix="pixelbox-tls-test-") as temporary:
        build = Path(temporary)
        certificates(build)
        # stub分支也必须独立可编译，未接TLS时不能意外依赖第三方符号。
        command([*cc, *flags, "-c", str(project / "src/tls.c"), "-o", str(build / "stub.o")])
        command([*cc, *flags, "-DPX_TLS_MBEDTLS", "-Dtime=px_test_tls_time",
                 '-DPX_TLS_CA_FILE="' + str(build / "default-ca.pem") + '"',
                 "-c", str(project / "src/tls.c"), "-o", str(build / "tls.o")])
        binary = build / "test_tls"
        command([*cc, *flags, str(project / "tests/test_tls.c"), str(build / "tls.o"),
                 str(prefix / "lib/libmbedtls.a"), str(prefix / "lib/libmbedx509.a"),
                 str(prefix / "lib/libmbedcrypto.a"), "-lpthread", "-o", str(binary)])
        command([str(binary), "missing", "0", str(build / "ca.pem")])
        shutil.copyfile(build / "ca.pem", build / "default-ca.pem")
        command([str(binary), "local", "0", str(build / "ca.pem")])
        for scenario in ("echo", "rebind", "truncated", "pressure", "hostname", "wrong_ca",
                         "expired", "future", "clock_back", "clock_forward", "clock_lost", "stall"):
            run_server(binary, build, scenario)
        # 使用产品的150张公开CA验证实际嵌入内容，覆盖文件错误绝不能触发回退。
        pem = (project / "certs/mozilla-idf-20250225.pem").read_bytes() + b"\0"
        (build / "tls_ca_bundle.h").write_text(
            "static const char px_tls_ca_bundle[]={" + ",".join(map(str, pem)) + "};\n")
        ca_override = build / "override.pem"
        command([*cc, *flags, "-DPX_TLS_MBEDTLS", "-DPX_TLS_BUILTIN_CA",
                 "-Dtime=px_test_tls_time", "-I" + str(build),
                 '-DPX_TLS_CA_FILE="' + str(ca_override) + '"',
                 "-c", str(project / "src/tls.c"), "-o", str(build / "builtin.o")])
        builtin = build / "test_builtin"
        command([*cc, *flags, str(project / "tests/test_tls.c"), str(build / "builtin.o"),
                 str(prefix / "lib/libmbedtls.a"), str(prefix / "lib/libmbedx509.a"),
                 str(prefix / "lib/libmbedcrypto.a"), "-lpthread", "-o", str(builtin)])
        command([str(builtin), "default_ok", "0", str(build / "ca.pem")])
        ca_override.write_text("damaged certificate override\n")
        command([str(builtin), "default_bad", "0", str(build / "ca.pem")])
        ca_override.write_bytes(b"")
        command([str(builtin), "default_bad", "0", str(build / "ca.pem")])
        shutil.copyfile(build / "ca.pem", ca_override)
        run_server(builtin, build, "default_echo")
    print("18 TLS场景通过（真实握手后换fd传输、CA回退/覆盖、失败关闭与资源释放）")


if __name__ == "__main__":
    main()
