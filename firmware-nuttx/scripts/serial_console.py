#!/usr/bin/env python3
"""限时监控原生 USB 串口，不主动切换 DTR/RTS 或触发芯片复位。"""
import argparse
import codecs
import errno
import math
import os
import select
import sys
import termios
import time
from typing import TextIO


POLL_SECONDS = 0.1
MAX_PENDING_BYTES = 65536
DISCONNECT_ERRORS = {errno.EIO, errno.ENXIO, errno.ENODEV, errno.EBADF}
WAITABLE_OPEN_ERRORS = DISCONNECT_ERRORS | {errno.ENOENT}


class SerialDisconnected(Exception):
    pass


def open_console(port: str) -> int:
    """只设置串口的数据格式，保持控制线不受程序主动操纵。"""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attributes = termios.tcgetattr(fd)
        attributes[0] = 0
        attributes[1] = 0
        attributes[3] = 0
        clear = termios.CSIZE | termios.PARENB | termios.CSTOPB | termios.HUPCL
        for name in ("CRTSCTS", "CCTS_OFLOW", "CRTS_IFLOW", "CDTR_IFLOW",
                     "CDSR_OFLOW", "CCAR_OFLOW"):
            clear |= getattr(termios, name, 0)
        attributes[2] = (attributes[2] & ~clear) | termios.CS8 | termios.CREAD | termios.CLOCAL
        attributes[4] = termios.B115200
        attributes[5] = termios.B115200
        attributes[6][termios.VMIN] = 0
        attributes[6][termios.VTIME] = 0
        # 不刷新接收缓冲，避免丢失启动日志；关闭时不恢复 HUPCL。
        termios.tcsetattr(fd, termios.TCSANOW, attributes)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _status(stream: TextIO, message: str) -> None:
    print(message, file=stream, flush=True)


def _connect(port: str, deadline: float, wait: float, reconnect: bool,
             errors: TextIO) -> tuple[int | None, bytes, int]:
    if reconnect and wait == 0:
        return None, b"", 3
    wait_deadline = min(deadline, time.monotonic() + wait)
    announced = reconnect
    if reconnect:
        _status(errors, "等待重新连接：" + port)
    first_attempt = True
    while True:
        if not first_attempt and time.monotonic() >= wait_deadline:
            _status(errors, "等待端口超时。")
            return None, b"", 4
        first_attempt = False
        fd = None
        try:
            fd = open_console(port)
            # 已断开的设备节点可能仍可 open；立即 EOF 不能算重连成功。
            # 探测时收到的启动数据会交给输出函数，不刷新、不丢弃。
            data = b""
            if select.select([fd], [], [], 0)[0]:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        raise OSError(errno.ENXIO, os.strerror(errno.ENXIO))
                except BlockingIOError:
                    pass
            _status(errors, ("已重新连接：" if reconnect else "已连接：") + port)
            return fd, data, 0
        except (OSError, termios.error) as error:
            if fd is not None:
                os.close(fd)
            error_number = getattr(error, "errno", error.args[0])
            if wait == 0 or error_number not in WAITABLE_OPEN_ERRORS:
                _status(errors, f"无法打开串口：{port}（{error}）")
                return None, b"", 2
        if not announced:
            _status(errors, ("等待重新连接：" if reconnect else "等待端口出现：") + port)
            announced = True
        remaining = wait_deadline - time.monotonic()
        if remaining <= 0:
            _status(errors, "等待端口超时。")
            return None, b"", 4
        time.sleep(min(POLL_SECONDS, remaining))


def run_console(port: str, duration: float = 60.0, commands: tuple[str, ...] = (),
                wait_reconnect: float = 0.0, stdin_fd: int | None = 0,
                output: TextIO | None = None, errors: TextIO | None = None) -> int:
    output = sys.stdout if output is None else output
    errors = sys.stderr if errors is None else errors
    deadline = time.monotonic() + duration
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    fd = None
    reconnect = False
    commands_sent = False
    pending = bytearray()

    def emit(data: bytes = b"", *, final: bool = False) -> None:
        text = decoder.decode(data, final=final)
        if text:
            output.write(text)
            output.flush()
        if final:
            decoder.reset()

    try:
        while time.monotonic() < deadline:
            if fd is None:
                fd, initial_data, result = _connect(
                    port, deadline, wait_reconnect, reconnect, errors)
                if fd is None:
                    return result
                emit(initial_data)
                if not commands_sent:
                    for command in commands:
                        pending.extend(command.rstrip("\r\n").encode("utf-8") + b"\r")
                    commands_sent = True
            readers = [fd]
            if stdin_fd is not None and len(pending) < MAX_PENDING_BYTES:
                readers.append(stdin_fd)
            remaining = max(0.0, deadline - time.monotonic())
            try:
                readable, writable, _ = select.select(
                    readers, [fd] if pending else [], [], min(POLL_SECONDS, remaining))
                if fd in readable:
                    try:
                        data = os.read(fd, 4096)
                    except BlockingIOError:
                        data = None
                    if data == b"":
                        raise SerialDisconnected
                    if data:
                        emit(data)
                if stdin_fd is not None and stdin_fd in readable:
                    data = os.read(stdin_fd, 4096)
                    if data:
                        pending.extend(data)
                    else:
                        # 管道输入结束后继续收日志，直到全局时限结束。
                        stdin_fd = None
                if fd in writable and pending:
                    try:
                        written = os.write(fd, pending[:4096])
                    except BlockingIOError:
                        written = None
                    if written == 0:
                        raise SerialDisconnected
                    if written:
                        del pending[:written]
            except InterruptedError:
                continue
            except (OSError, SerialDisconnected) as error:
                if isinstance(error, OSError) and error.errno not in DISCONNECT_ERRORS:
                    raise
                emit(final=True)
                _status(errors, f"串口已断开：{port}")
                os.close(fd)
                fd = None
                reconnect = True
                # 断开后丢弃未完成输入，禁止自动重放命令或半条命令。
                pending.clear()
                if wait_reconnect == 0:
                    return 3
        if fd is None and reconnect:
            _status(errors, "等待端口超时。")
            return 4
        _status(errors, "已达到运行时限。")
        return 0
    except KeyboardInterrupt:
        _status(errors, "已中断。")
        return 130
    except (OSError, ValueError) as error:
        _status(errors, f"串口监控失败：{error}")
        return 2
    finally:
        emit(final=True)
        if fd is not None:
            os.close(fd)


def _seconds(value: str, *, zero: bool = False) -> float:
    result = float(value)
    if not math.isfinite(result) or result < 0 or (result == 0 and not zero):
        raise argparse.ArgumentTypeError("秒数必须为有限" + ("非负数" if zero else "正数"))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="准确的 macOS/Linux 串口路径")
    parser.add_argument("--duration", type=_seconds, default=60.0, help="全程运行时限，默认 60 秒")
    parser.add_argument("--command", action="append", default=[], help="首连后发送一次；可重复指定")
    parser.add_argument("--wait-reconnect", type=lambda value: _seconds(value, zero=True),
                        default=0.0, metavar="SECONDS", help="限时等待同一路径重现；默认断开即退出")
    args = parser.parse_args()
    try:
        stdin_fd = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        stdin_fd = None
    return run_console(args.port, args.duration, tuple(args.command),
                       args.wait_reconnect, stdin_fd)


if __name__ == "__main__":
    raise SystemExit(main())
