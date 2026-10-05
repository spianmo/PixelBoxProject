# 无控制线串口监控

ESP32-S3 原生 USB Serial/JTAG 会根据主机的 DTR/RTS 控制序列进入下载模式或复位。`serial_console.py` 使用 macOS/Linux 的 `os.open` 与 `termios` 读取串口，设置 raw、115200 8N1，清除 HUPCL 和硬件/软件流控，不调用 TIOCM、DTR、RTS、reset 或烧录操作。

在仓库根目录运行，下列端口名称需替换为当前真实路径：

```sh
python3 firmware-nuttx/scripts/serial_console.py --port /dev/cu.usbmodem101
```

默认运行 60 秒。标准输入直接转发到设备，可键入 NSH 命令并按回车；管道输入结束后仍会继续接收日志，直到时限结束。设备输出实时写入 stdout，连接状态和错误写入 stderr。Ctrl+C 返回 130。

无人值守采集可设置全局时限和首连命令：

```sh
python3 firmware-nuttx/scripts/serial_console.py \
  --port /dev/cu.usbmodem101 --duration 30 \
  --command 'uptime' --command 'ps' </dev/null
```

`--command` 可重复，每条命令结尾补一个回车，仅在第一次成功连接后发送一次。工具不主动打印命令文本；设备自行回显的内容属于接收数据，会原样输出。命令和键盘输入共享同一发送队列。

默认在设备断开时立即返回。需要等待重新枚举时，显式设置等待秒数：

```sh
python3 firmware-nuttx/scripts/serial_console.py \
  --port /dev/cu.usbmodem101 --duration 120 --wait-reconnect 10 </dev/null
```

该选项也适用于初始端口尚未出现的情况。每次最多等待指定秒数，且始终受 `--duration` 的全局时限约束；只重新打开相同路径，不搜索或选择其他串口，不自动复位。若系统为设备分配了不同路径，需要重新指定 `--port`。断开时丢弃未发送完的输入，重连后不重放命令，避免重复执行。

| 退出码 | 含义 |
| --- | --- |
| 0 | 连接期间达到全局时限，正常结束 |
| 2 | 参数、端口打开或本地 I/O 错误 |
| 3 | 设备断开，未启用等待重连 |
| 4 | 等待端口出现或重连超时，包括等待期间达到全局时限 |
| 130 | 用户按 Ctrl+C 中断 |

关闭时不恢复 HUPCL，避免 close 引发挂断控制线。操作系统或 USB 驱动在打开设备时的内部行为不由 Python 控制；本工具的保证是不会额外发出 DTR/RTS 切换请求。pySerial 的 `rtscts=False`/`dsrdtr=False` 只代表关闭流控，并不阻止其 `open()` 主动设置控制线，所以不能替代这个监控入口。

本工具不修改固件、全局串口配置或系统权限。测试仅使用 PTY：

```sh
python3 -m unittest discover -s firmware-nuttx/tests -p 'test_serial_console.py' -v
```

真机稳定性验收需要独立记录运行时长、应用请求成功情况和复位日志。JTAG/OpenOCD 的 halt 回调可能禁用看门狗，不将连接过调试器后的存活时间当成看门狗通过证据。

## 固件在没有读取者时的日志行为

`scripts/usbserial_patch.py` 只修补隔离构建快照，保留上游 `.deps`。ESP32-S3 原生 USB 控制台的软件缓冲为 2048 字节；主机不读取时，普通发送锁或发送空间等待 20ms 后丢弃日志，避免 `fprintf/fflush` 阻塞应用。IRQ/idle 的一次 `writev` 共用 2ms 等待预算，早期单字符输出也有 2ms 上限。该策略允许丢日志，不适合作为可靠二进制传输通道；普通 UART 和非阻塞写入的原有语义保留。

2026-10-03 真机验证：关闭读取器，分八轮输出约 64KiB 日志，每轮 70–92ms 返回；随后持续 35 秒，原 VM、定时器和画面计数均推进，显示错误为零，重新读取后 NSH 健康回声成功。证据 `tmp/native12-usb-backpressure/result.json`。这项测试覆盖日志背压，不覆盖物理断线或掉电恢复。
