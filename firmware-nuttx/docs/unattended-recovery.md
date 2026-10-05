# 原生 USB 无人值守恢复

适用板型：ESP32-S3-Touch-AMOLED-2.16，原生 USB Serial/JTAG，Simple Boot，16 MiB Flash。
本工具使用已存在的项目 Python 环境；不升级全局 esptool，不写 eFuse，不擦全片，不格式化。

## 已构建镜像的刷写

先关闭占用目标串口的监视器。`--output` 必须是全新目录，保留每次尝试的完整证据：

```sh
.deps/nuttx-venv/bin/python firmware-nuttx/scripts/flash_recover.py \
  --image firmware-nuttx/build/esp32s3/nuttx.bin \
  --port /dev/cu.usbmodem2101 \
  --output firmware-nuttx/build/recovery/attempt-001
```

使用 runner 导出的外层镜像及同目录的 `.elf`、`.config`、`.heap.json` 校验资料；
内部构建树的镜像没有这组绑定资料，不能作为无人值守刷写入口。
脚本在打开串口前校验镜像芯片、RAM checksum、ROM SHA-256、长度和内部堆边界。只允许镜像位于
`[0, 0x800000)`；既有 LittleFS `[0x800000, 0x1000000)` 不参与备份或写入。
备份长度按实际镜像向上取整到 MiB，最大不超过前 8 MiB。镜像先复制到证据目录，
后续构建修改原 `.bin` 不会替换正在刷写的内容。

顺序固定为：读取原内容 → 核对备份长度和 SHA → 写入 offset 0 → 独立 verify_flash →
清 RTC 强制下载标志并触发 RTC watchdog 全系统复位 → 被动等候同一 USB 路径及 NSH。
esptool 每步最多 180 秒；启动默认最多 30 秒，`--startup-timeout` 可设 1..120 秒。
等待串口时不操作 DTR/RTS，也不重新发送任何输入。

## 失败后的判断

先读输出目录的 `state.json`，不要仅凭进程最终退出码决定是否重刷。

| 最后完成的 phase | 已确认事实 | 后续动作 |
| --- | --- | --- |
| `prepared` | 尚未完成备份 | 查 backup.log；没有完整备份就不继续写入 |
| `backed_up` | 原镜像已备份 | 写入可能尚未执行或未完整完成；核对 write.log |
| `written` | 写入命令成功，但独立校验未确认 | 查 verify.log，先重新核验镜像与 Flash |
| `verified` | 独立校验通过，启动尚未确认 | 若仍处于 ROM，使用下方 reset-only；不要重复烧同一镜像 |
| `reset_sent` | 已发软件复位，尚未收到 NSH | 查 boot.log、USB 路径；不要自动再次改写 Flash |
| `booted` | 收到 NSH 提示符 | 继续 devd/网络/外设验收；不等于显示和声学效果通过 |

`rom_reset.py` 使用 Espressif RTC watchdog 的寄存器顺序，兼容没有
`ESP32S3ROM.watchdog_reset()` 方法的本地 esptool 4.8.1。
USB 在复位期间短暂消失属于可重试的枚举过程，必须等待，不能立即判断硬件断连。

已确认设备停留在 ROM 下载模式时，只恢复启动：

```sh
.deps/nuttx-venv/bin/python firmware-nuttx/scripts/flash_recover.py \
  --reset-only --port /dev/cu.usbmodem2101 \
  --output firmware-nuttx/build/recovery/reset-001
```

`reset-only` 不会强行把正在运行的固件切到下载态，也不读取或写入 Flash。若设备已在
NSH 正常运行，使用其 `reboot` 命令即可请求软件重启。物理按键不是正常刷写步骤。

## 回归

```sh
python3 firmware-nuttx/tests/test_flash_recover.py
python3 firmware-nuttx/tests/test_rom_reset.py
```

宿主测试覆盖损坏/越界镜像不碰串口、不完整备份禁止刷写、校验失败不复位、复位失败
保留 verified 状态、原文件变化不替换刷写快照、既有证据目录不可覆盖、reset-only 不写
Flash，以及老版本 ROM 对象的寄存器顺序和错误中止。真机验收以具体镜像和日志为准。
