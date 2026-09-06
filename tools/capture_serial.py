"""Capture serial diagnostics without toggling the board's reset lines."""
import argparse
import time
from pathlib import Path

import serial

parser = argparse.ArgumentParser()
parser.add_argument("--port", default="COM3")
parser.add_argument("--seconds", type=float, default=45)
parser.add_argument("--output", default="firmware/build/serial-login.log")
args = parser.parse_args()
port = serial.Serial(port=None, baudrate=115200, timeout=0.2)
port.dtr = False
port.rts = False
port.port = args.port
port.open()
print(f"Capturing {args.port} for {args.seconds:g}s", flush=True)
try:
    deadline = time.monotonic() + args.seconds
    with Path(args.output).open("ab") as output:
        while time.monotonic() < deadline:
            data = port.read(max(1, port.in_waiting))
            if data:
                output.write(data)
                output.flush()
finally:
    port.close()
print(f"Capture complete: {args.output}", flush=True)
