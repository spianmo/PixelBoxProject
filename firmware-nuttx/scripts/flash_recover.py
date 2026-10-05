#!/usr/bin/env python3
"""ESP32-S3 原生 USB 无人值守刷写：备份、独立校验、RTC 软件复位。"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

from simple_boot_image import validate_image
from rom_reset import reset_esp32s3
from serial_console import open_console
from nuttx import validate_heap_evidence

STORAGE_OFFSET = 0x800000
# 原生 USB CDC 在连续读取约 400 KiB 后会偶发断流；失败时降级为 64 KiB 子块，
# 让每块传输时间足够短，并保留正常路径的单块备份行为。
BACKUP_CHUNK_SIZE = 0x100000
SAFE_BACKUP_CHUNK_SIZE = 0x10000
ESPTOOL_RETRIES = 3
TRANSIENT_SERIAL_ERRORS = (
    "device reports readiness to read",
    "device disconnected",
    "could not open",
    "failed to connect",
    "serial exception",
    "resource temporarily unavailable",
)


def esptool_python() -> str:
    """选择含有 esptool 的 Python，避免系统 Python 遮蔽项目刷写环境。"""
    override = os.environ.get("ESPTOOL_PYTHON")
    candidates = [Path(override)] if override else []
    candidates.append(Path(sys.executable))
    project_root = Path(__file__).resolve().parents[2]
    candidates.extend([
        project_root / ".deps" / "nuttx-venv" / "bin" / "python",
        project_root / ".deps" / "nuttx-venv" / "bin" / "python3",
    ])
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            probe = subprocess.run(
                [str(candidate), "-c", "import esptool"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0:
            return str(candidate)
    raise RuntimeError("找不到含 esptool 的 Python；请设置 ESPTOOL_PYTHON 或准备 .deps/nuttx-venv")


def image_metadata(data: bytes) -> dict:
    if not data or len(data) >= STORAGE_OFFSET:
        raise ValueError("镜像必须完整位于前 8 MiB，不能触碰已有文件系统")
    digest = validate_image(data)
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "romSha256": digest, "backupBytes": (len(data) + 0xFFFFF) & ~0xFFFFF}


def save_state(output: Path, state: dict) -> None:
    pending = output / "state.pending.json"
    pending.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    pending.replace(output / "state.json")


def _wait_for_port(port: str, timeout: float = 8.0) -> None:
    """等待原生 USB 节点重新可打开；不操作 DTR/RTS。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            descriptor = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            os.close(descriptor)
            return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"等待 USB 串口重新出现超时：{port}")


def esptool_step(output: Path, port: str, baud: int, phase: str, arguments: list[str]) -> None:
    # 首次步骤负责从 NuttX 切到 ROM/stub；后续步骤复用 stub，避免每个分块都触发 USB 断开。
    before = "usb_reset" if phase == "backup" else "no_reset"
    command = [esptool_python(), "-m", "esptool", "--chip", "esp32s3", "--port", port,
               "--baud", str(baud), "--before", before, "--after", "no_reset"]
    log_path = output / f"{phase}.log"
    for attempt in range(1, ESPTOOL_RETRIES + 1):
        with log_path.open("a" if attempt > 1 else "w") as log:
            if attempt > 1:
                log.write(f"\n[recover] retry {attempt}/{ESPTOOL_RETRIES}\n")
            result = subprocess.run(command + arguments, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=180)
        if result.returncode == 0:
            print(f"[recover] {phase} 通过", flush=True)
            return
        failure = log_path.read_text(errors="replace").lower()
        transient = any(marker in failure for marker in TRANSIENT_SERIAL_ERRORS)
        if not transient or attempt == ESPTOOL_RETRIES:
            raise RuntimeError(f"{phase} 失败（{result.returncode}），详见 {log_path}")
        # USB-JTAG 复位会让节点短暂消失；下一轮重新打开同一路径再连接。
        time.sleep(0.3)
        _wait_for_port(port)
    raise AssertionError("unreachable")


def backup_flash(output: Path, port: str, baud: int, length: int) -> Path:
    """分块读取应用区，避免原生 USB CDC 长时间连续传输时断流。"""
    backup = output / "backup.bin"
    with backup.open("wb") as merged:
        offset = 0
        chunk_index = 0
        while offset < length:
            size = min(BACKUP_CHUNK_SIZE, length - offset)
            # 第一块沿用 backup.log，后续块单独记录，便于定位具体断流位置。
            phase = "backup" if chunk_index == 0 else f"backup-{chunk_index:04d}"
            chunk = output / f"backup-{chunk_index:04d}.bin"
            try:
                esptool_step(output, port, baud, phase,
                             ["read_flash", hex(offset), hex(size), str(chunk)])
                data = chunk.read_bytes()
                if len(data) != size:
                    raise ValueError(f"备份分块长度不完整：offset={offset:#x}, expected={size}, got={len(data)}")
                merged.write(data)
            except RuntimeError:
                # 原生 USB CDC 可能在一个大块中途断开；从同一偏移重新开始，
                # 用小块读取并逐块合并，避免要求用户重新按 BOOT/PWR。
                if size <= SAFE_BACKUP_CHUNK_SIZE:
                    raise
                safe_offset = offset
                safe_index = chunk_index
                while safe_offset < offset + size:
                    safe_size = min(SAFE_BACKUP_CHUNK_SIZE, offset + size - safe_offset)
                    safe_phase = "backup" if safe_index == 0 else f"backup-{safe_index:04d}"
                    safe_chunk = output / f"backup-{safe_index:04d}.bin"
                    esptool_step(output, port, baud, safe_phase,
                                 ["read_flash", hex(safe_offset), hex(safe_size), str(safe_chunk)])
                    safe_data = safe_chunk.read_bytes()
                    if len(safe_data) != safe_size:
                        raise ValueError(
                            f"备份分块长度不完整：offset={safe_offset:#x}, "
                            f"expected={safe_size}, got={len(safe_data)}"
                        )
                    merged.write(safe_data)
                    safe_offset += safe_size
                    safe_index += 1
                chunk_index = safe_index - 1
            offset += size
            chunk_index += 1
    return backup


def reboot_rom(port: str) -> None:
    # 与所有 esptool 子命令共用同一项目解释器，确保导入版本一致。
    tool_python = esptool_python()
    if tool_python != sys.executable:
        paths = subprocess.check_output(
            [tool_python, "-c", "import site,sys; print('\\n'.join(site.getsitepackages()))"],
            text=True,
            timeout=10,
        ).splitlines()
        for path in reversed([item for item in paths if item]):
            if path not in sys.path:
                sys.path.insert(0, path)
    from esptool.targets.esp32s3 import ESP32S3ROM
    rom = ESP32S3ROM(port, 115200)
    try:
        rom.connect(mode="no_reset", attempts=2)
        rom._port.timeout = 0.2
        reset_esp32s3(rom)
    finally:
        rom._port.close()


def wait_for_nsh(port: str, output: Path, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    descriptor = None
    disconnected = {errno.ENOENT, errno.ENODEV, errno.ENXIO, errno.EIO}
    with (output / "boot.log").open("wb") as log:
        tail = b""
        try:
            while time.monotonic() < deadline:
                try:
                    if descriptor is None:
                        descriptor = open_console(port)
                    if not select.select([descriptor], [], [], 0.1)[0]:
                        continue
                    data = os.read(descriptor, 8192)
                    if not data:
                        raise OSError(errno.ENXIO, "USB 正在重新枚举")
                    log.write(data)
                    log.flush()
                    combined = tail + data
                    if b"nsh>" in combined:
                        return
                    tail = combined[-64:]
                except BlockingIOError:
                    continue
                except OSError as error:
                    if error.errno not in disconnected:
                        raise
                    if descriptor is not None:
                        os.close(descriptor)
                        descriptor = None
                    tail = b""
                    time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        finally:
            if descriptor is not None:
                os.close(descriptor)
    raise TimeoutError("软件复位后未在时限内观察到 NSH；镜像校验结果仍保留，勿盲目重刷")


def recover(image: Path | None, port: str, output: Path, baud: int = 460800,
            startup_timeout: float = 30) -> dict:
    # 校验先于打开串口；输出目录要求全新，失败备份和已确认状态不可被重试覆盖。
    data = image.read_bytes() if image is not None else None
    state = image_metadata(data) if data is not None else {}
    output.mkdir(parents=True, exist_ok=False)
    state.update(port=port, phase="prepared", resetOnly=data is None)
    save_state(output, state)
    try:
        if data is not None:
            snapshot = output / "firmware.bin"
            snapshot.write_bytes(data)
            # 先核对与待写快照绑定的 ELF/配置和真实内部堆边界；失败时不碰设备。
            # 不能拿当前构建树的 ELF 为另一份旧镜像背书。
            state["internalHeap"] = validate_heap_evidence(image, snapshot)
            save_state(output, state)
            backup = backup_flash(output, port, baud, state["backupBytes"])
            previous = backup.read_bytes()
            if len(previous) != state["backupBytes"]:
                raise ValueError("备份长度不完整，未开始写入")
            state.update(phase="backed_up", backupSha256=hashlib.sha256(previous).hexdigest())
            save_state(output, state)
            esptool_step(output, port, baud, "write", ["write_flash", "--flash_mode", "keep",
                         "--flash_freq", "keep", "--flash_size", "keep", "0", str(snapshot)])
            state["phase"] = "written"
            save_state(output, state)
            esptool_step(output, port, baud, "verify", ["verify_flash", "0", str(snapshot)])
            state["phase"] = "verified"
            save_state(output, state)
        reboot_rom(port)
        state["phase"] = "reset_sent"
        save_state(output, state)
        wait_for_nsh(port, output, startup_timeout)
        state["phase"] = "booted"
        save_state(output, state)
        return state
    except BaseException as error:
        # 保留最后完成阶段。尤其 written/verified 后出错，不能误报未刷写或自动重写。
        state["error"] = str(error)
        save_state(output, state)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--image", type=Path)
    choice.add_argument("--reset-only", action="store_true", help="仅恢复已处于 ROM 下载模式的设备，不写 Flash")
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", type=Path, required=True, help="全新的产物目录，已有目录不覆盖")
    parser.add_argument("--baud", type=int, default=460800)
    parser.add_argument("--startup-timeout", type=float, default=30)
    args = parser.parse_args()
    if not 1200 <= args.baud <= 4000000 or not 1 <= args.startup_timeout <= 120:
        parser.error("baud 范围 1200..4000000，startup-timeout 范围 1..120 秒")
    try:
        state = recover(args.image, args.port, args.output.resolve(), args.baud, args.startup_timeout)
        print(f"[recover] NSH 启动已确认；证据目录：{args.output.resolve()}")
        return 0 if state["phase"] == "booted" else 1
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[recover] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
