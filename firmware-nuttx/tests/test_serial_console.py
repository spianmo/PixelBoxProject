#!/usr/bin/env python3
"""用 POSIX PTY 验证真实串口收发、无流控配置、断连和限时重连。"""
import importlib.util
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/serial_console.py"
SPEC = importlib.util.spec_from_file_location("serial_console", SCRIPT)
console = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(console)


def read_until(fd, expected, timeout=2.0):
    result = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.05, deadline - time.monotonic()))
        if ready:
            data = os.read(fd, 4096)
            if not data:
                break
            result.extend(data)
            if expected in result:
                return bytes(result)
            if len(result) > 65536:
                del result[:-65536]
    raise AssertionError(f"未在 {timeout}s 内收到 {expected!r}，末尾为 {bytes(result[-512:])!r}")


class SerialConsoleTests(unittest.TestCase):
    def setUp(self):
        self.master, self.slave = pty.openpty()
        self.port = os.ttyname(self.slave)
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=2)
        for fd in (self.master, self.slave):
            if fd is not None:
                os.close(fd)

    def start(self, *args, port=None):
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--port", port or self.port,
                                    *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        self.processes.append(process)
        return process

    def disconnect(self):
        os.close(self.master)
        self.master = None

    def test_raw_mode_clears_hupcl_echo_and_all_flow_control(self):
        original = termios.tcgetattr(self.slave)
        original[0] |= termios.IXON | termios.IXOFF
        original[2] |= termios.HUPCL | getattr(termios, "CRTSCTS", 0)
        original[3] |= termios.ICANON | termios.ECHO
        termios.tcsetattr(self.slave, termios.TCSANOW, original)
        fd = console.open_console(self.port)
        try:
            configured = termios.tcgetattr(fd)
            self.assertEqual(configured[0], 0)
            self.assertEqual(configured[1], 0)
            self.assertEqual(configured[3], 0)
            for name in ("HUPCL", "CRTSCTS", "CCTS_OFLOW", "CRTS_IFLOW", "CDTR_IFLOW",
                         "CDSR_OFLOW", "CCAR_OFLOW"):
                self.assertEqual(configured[2] & getattr(termios, name, 0), 0, name)
            self.assertEqual(configured[2] & (termios.CLOCAL | termios.CREAD),
                             termios.CLOCAL | termios.CREAD)
            self.assertFalse(os.get_blocking(fd))
            self.assertFalse(os.get_inheritable(fd))
        finally:
            os.close(fd)
        self.assertEqual(termios.tcgetattr(self.slave)[2] & termios.HUPCL, 0)

    def test_real_commands_stdin_and_live_output_without_local_echo(self):
        process = self.start("--duration", "0.6", "--command", "secret-command",
                             "--command", "status")
        received = read_until(self.master, b"secret-command\rstatus\r")
        self.assertEqual(received, b"secret-command\rstatus\r")
        os.write(self.master, "设备已就绪\r\n".encode())
        output = read_until(process.stdout.fileno(), "设备已就绪".encode())
        self.assertIsNone(process.poll(), "日志必须在进程结束前实时输出")
        process.stdin.write(b"help\r")
        process.stdin.flush()
        self.assertEqual(read_until(self.master, b"help\r"), b"help\r")
        remaining, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 0, errors.decode())
        self.assertNotIn(b"secret-command", output + remaining + errors)

    def test_stdin_eof_keeps_receiving_until_duration(self):
        process = self.start("--duration", "0.35")
        read_until(process.stderr.fileno(), "已连接".encode())
        process.stdin.close()
        process.stdin = None
        os.write(self.master, b"late log\n")
        output, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 0, errors.decode())
        self.assertIn(b"late log", output)

    def test_duration_is_bounded_without_data(self):
        started = time.monotonic()
        process = self.start("--duration", "0.15")
        _, errors = process.communicate(timeout=2)
        elapsed = time.monotonic() - started
        self.assertEqual(process.returncode, 0, errors.decode())
        self.assertGreaterEqual(elapsed, 0.12)
        self.assertLess(elapsed, 1.5)

    def test_disconnect_returns_specific_code_immediately(self):
        process = self.start("--duration", "5")
        read_until(process.stderr.fileno(), "已连接".encode())
        self.disconnect()
        _, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 3, errors.decode())
        self.assertIn("串口已断开".encode(), errors)

    def test_wait_reconnect_timeout_is_bounded(self):
        process = self.start("--duration", "5", "--wait-reconnect", "0.2")
        read_until(process.stderr.fileno(), "已连接".encode())
        started = time.monotonic()
        self.disconnect()
        _, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 4, errors.decode())
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertIn("等待端口超时".encode(), errors)

    def test_global_deadline_caps_initial_wait_and_reconnect(self):
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as directory:
            process = self.start("--duration", "0.15", "--wait-reconnect", "5",
                                 port=str(Path(directory) / "absent"))
            _, errors = process.communicate(timeout=2)
            self.assertEqual(process.returncode, 4, errors.decode())
            self.assertLess(time.monotonic() - started, 1.5)
        process = self.start("--duration", "0.25", "--wait-reconnect", "5")
        read_until(process.stderr.fileno(), "已连接".encode())
        started = time.monotonic()
        self.disconnect()
        _, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 4, errors.decode())
        self.assertLess(time.monotonic() - started, 1.5)

    def test_ctrl_c_closes_with_clear_exit_code(self):
        process = self.start("--duration", "5")
        read_until(process.stderr.fileno(), "已连接".encode())
        process.send_signal(signal.SIGINT)
        _, errors = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 130, errors.decode())
        self.assertIn("已中断".encode(), errors)

    def test_reconnect_same_path_does_not_replay_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "console"
            link.symlink_to(self.port)
            process = self.start("--duration", "1.2", "--wait-reconnect", "0.6",
                                 "--command", "once", port=str(link))
            self.assertEqual(read_until(self.master, b"once\r"), b"once\r")
            self.disconnect()
            read_until(process.stderr.fileno(), "等待重新连接".encode())
            new_master, new_slave = pty.openpty()
            try:
                replacement = Path(directory) / "next"
                replacement.symlink_to(os.ttyname(new_slave))
                replacement.replace(link)
                read_until(process.stderr.fileno(), "已重新连接".encode())
                os.write(new_master, b"reconnected\n")
                read_until(process.stdout.fileno(), b"reconnected\n")
                self.assertEqual(select.select([new_master], [], [], 0.1)[0], [])
                process.stdin.write(b"fresh\r")
                process.stdin.flush()
                self.assertEqual(read_until(new_master, b"fresh\r"), b"fresh\r")
                _, errors = process.communicate(timeout=2)
                self.assertEqual(process.returncode, 0, errors.decode())
            finally:
                os.close(new_master)
                os.close(new_slave)

    def test_invalid_duration_or_missing_port_fails_without_wait(self):
        for duration in ("0", "-1", "nan", "inf"):
            with self.subTest(duration=duration):
                process = self.start("--duration", duration)
                process.communicate(timeout=2)
                self.assertEqual(process.returncode, 2)
        with tempfile.TemporaryDirectory() as directory:
            process = self.start("--duration", "5", port=str(Path(directory) / "absent"))
            process.communicate(timeout=2)
            self.assertEqual(process.returncode, 2)
            regular_file = Path(directory) / "not-a-tty"
            regular_file.write_text("regular file")
            process = self.start("--duration", "5", port=str(regular_file))
            _, errors = process.communicate(timeout=2)
            self.assertEqual(process.returncode, 2, errors.decode())
            self.assertNotIn(b"Traceback", errors)


if __name__ == "__main__":
    unittest.main()
