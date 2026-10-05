"""ESP32-S3 ROM 下载会话的可重复软件复位，兼容 esptool 4.x/5.x。"""
import time


def reset_esp32s3(esp) -> None:
    """仅接收已经同步的 S3 ROM 对象；不打开串口，不读写 Flash/eFuse。"""
    if getattr(esp, "CHIP_NAME", None) != "ESP32-S3":
        raise ValueError("ROM watchdog reset is restricted to ESP32-S3")
    # 先清 USB 强制下载标志，再用 RTC 全系统复位重新采样启动引脚。
    # 寄存器顺序与 Espressif esptool 的 ESP32S3ROM.watchdog_reset 一致；
    # 4.8.1 没有该方法，因此不能把无人值守恢复依赖于方法是否存在。
    esp.write_reg(esp.RTC_CNTL_OPTION1_REG, 0,
                  esp.RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK)
    esp.write_reg(esp.RTC_CNTL_WDTWPROTECT_REG, esp.RTC_CNTL_WDT_WKEY)
    esp.write_reg(esp.RTCCNTL_BASE_REG + 0x009C, 2000)
    esp.write_reg(esp.RTC_CNTL_WDTCONFIG0_REG,
                  (1 << 31) | (5 << 28) | (1 << 8) | 2)
    esp.write_reg(esp.RTC_CNTL_WDTWPROTECT_REG, 0)
    time.sleep(0.5)
