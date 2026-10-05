#!/usr/bin/env python3
"""修复隔离快照的 USB 控制台日志背压；不修改上游 .deps。"""
from pathlib import Path

RELATIVE = "arch/xtensa/src/esp32s3/esp32s3_usbserial.c"
BUFFER_OLD = "/* The hardware buffer has a fixed size of 64 bytes */\n\n#define ESP32S3_USBCDC_BUFFERSIZE 64"
BUFFER_NEW = """/* 软件环形缓冲与 64 字节 USB 端点 FIFO 独立；容纳一条完整 NSH 命令。 */
#define ESP32S3_USBCDC_BUFFERSIZE 2048"""
WRITE_OLD = """  while (!esp32s3_txready(&g_uart_usbserial));

  esp32s3_send(&g_uart_usbserial, ch);"""
WRITE_NEW = """  /* 主机未读取 USB 时不能在早期日志或中断上下文永久卡死。 */
  unsigned int remaining = 2000;
  while (!esp32s3_txready(&g_uart_usbserial))
    {
      if (remaining-- == 0)
        {
          return;
        }

      up_udelay(1);
    }

  esp32s3_send(&g_uart_usbserial, ch);"""


SERIAL_RELATIVE = "drivers/serial/serial.c"

# 上下文整段匹配让补丁幂等，并在 NuttX 源码漂移时拒绝继续。
SERIAL_REPLACEMENTS = (
    ("""static void    uart_poll_notify(FAR uart_dev_t *dev, unsigned int min,
                                unsigned int max, pollevent_t eventset);

/* Write support */

static int     uart_putxmitchar(FAR uart_dev_t *dev, int ch,
                                bool oktoblock);
static inline ssize_t uart_irqwrite(FAR uart_dev_t *dev,
                                    FAR const char *buffer,
                                    size_t buflen);
static inline ssize_t uart_irqwritev(FAR uart_dev_t *dev,
                                     FAR struct uio *uio);
static int     uart_tcdrain(FAR uart_dev_t *dev,
""", """static void    uart_poll_notify(FAR uart_dev_t *dev, unsigned int min,
                                unsigned int max, pollevent_t eventset);

/* 只给 ESP32-S3 原生 USB 控制台限制日志背压；其他 UART 保持原语义。 */
static inline bool uart_usb_console(FAR uart_dev_t *dev)
{
#if defined(CONFIG_ARCH_CHIP_ESP32S3) && defined(CONFIG_ESP32S3_USBSERIAL)
  extern uart_dev_t g_uart_usbserial;
  return dev == &g_uart_usbserial;
#else
  (void)dev;
  return false;
#endif
}

/* 调用方已关闭中断并持有发送锁。USB 无读取者时丢弃旧日志，
 * 唤醒 poll 等待者；正常 UART 仍使用没有超时的可靠发送等待。 */
static int uart_wait_txspace(FAR uart_dev_t *dev)
{
  int ret;

  if (!uart_usb_console(dev))
    {
      return nxsem_wait(&dev->xmitsem);
    }

  ret = nxsem_tickwait(&dev->xmitsem, MSEC2TICK(20));
  if (ret == -ETIMEDOUT)
    {
      dev->xmit.tail = dev->xmit.head;
      uart_datasent(dev);
    }

  return ret;
}

/* Write support */

static int     uart_putxmitchar(FAR uart_dev_t *dev, int ch,
                                bool oktoblock);
static inline ssize_t uart_irqwrite(FAR uart_dev_t *dev,
                                    FAR const char *buffer,
                                    size_t buflen,
                                    FAR unsigned int *usb_wait_us);
static inline ssize_t uart_irqwritev(FAR uart_dev_t *dev,
                                     FAR struct uio *uio);
static int     uart_tcdrain(FAR uart_dev_t *dev,
"""),
    ("""              uart_dmatxavail(dev);
#endif
              uart_enabletxint(dev);
              ret = nxsem_wait(&dev->xmitsem);
              uart_disabletxint(dev);
            }

""", """              uart_dmatxavail(dev);
#endif
              uart_enabletxint(dev);
              ret = uart_wait_txspace(dev);
              uart_disabletxint(dev);
            }

"""),
    ("""               * become non-full will abort the transfer.
               */

              return -EINTR;
            }
        }
""", """               * become non-full will abort the transfer.
               */

              if (ret == -ETIMEDOUT && uart_usb_console(dev))
                {
                  return ret;
                }

              return -EINTR;
            }
        }
"""),
    (""" ****************************************************************************/

static inline void uart_putchars(FAR uart_dev_t *dev,
                                 FAR const void *buf, size_t len)
{
  FAR const char *pbuf = buf;

""", """ ****************************************************************************/

static inline void uart_putchars(FAR uart_dev_t *dev,
                                 FAR const void *buf, size_t len,
                                 FAR unsigned int *usb_wait_us)
{
  FAR const char *pbuf = buf;

"""),
    ("""    {
      while (!uart_txready(dev))
        {
        }

      if (dev->ops->sendbuf)
""", """    {
      while (!uart_txready(dev))
        {
          /* IRQ/idle 不能等待调度器唤醒；整次 IRQ 写入共享 2ms 预算。 */
          if (uart_usb_console(dev))
            {
              if (*usb_wait_us == 0)
                {
                  return;
                }

              --*usb_wait_us;
              up_udelay(1);
            }
        }

      if (dev->ops->sendbuf)
"""),
    ("""
static inline ssize_t uart_irqwrite(FAR uart_dev_t *dev,
                                    FAR const char *buffer,
                                    size_t buflen)
{
  size_t tail = 0;
  size_t head = buflen;
""", """
static inline ssize_t uart_irqwrite(FAR uart_dev_t *dev,
                                    FAR const char *buffer,
                                    size_t buflen,
                                    FAR unsigned int *usb_wait_us)
{
  size_t tail = 0;
  size_t head = buflen;
"""),
    ("""
          if ((ch == '\\r') && (dev->tc_oflag & OCRNL) != 0)
            {
              uart_putchars(dev, &buffer[tail], head - tail);
              uart_putchars(dev, "\\n", 1);
              tail = head + 1;
            }

""", """
          if ((ch == '\\r') && (dev->tc_oflag & OCRNL) != 0)
            {
              uart_putchars(dev, &buffer[tail], head - tail, usb_wait_us);
              uart_putchars(dev, "\\n", 1, usb_wait_us);
              tail = head + 1;
            }

"""),
    ("""
          if ((ch == '\\n') && (dev->tc_oflag & (ONLCR | ONLRET)) != 0)
            {
              uart_putchars(dev, &buffer[tail], head - tail);
              uart_putchars(dev, "\\r", 1);
              tail = head;
            }
        }
""", """
          if ((ch == '\\n') && (dev->tc_oflag & (ONLCR | ONLRET)) != 0)
            {
              uart_putchars(dev, &buffer[tail], head - tail, usb_wait_us);
              uart_putchars(dev, "\\r", 1, usb_wait_us);
              tail = head;
            }
        }
"""),
    ("""
  /* Output the character, using the low-level direct UART interfaces */

  uart_putchars(dev, &buffer[tail], head - tail);
  return buflen;
}

""", """
  /* Output the character, using the low-level direct UART interfaces */

  uart_putchars(dev, &buffer[tail], head - tail, usb_wait_us);
  return buflen;
}

"""),
    ("""  ssize_t total = 0;
  int iovcnt = uio->uio_iovcnt;
  int i;

  for (i = 0; i < iovcnt; i++)
    {
""", """  ssize_t total = 0;
  int iovcnt = uio->uio_iovcnt;
  int i;
  unsigned int usb_wait_us = 2000;

  for (i = 0; i < iovcnt; i++)
    {
"""),
    ("""          continue;
        }

      ssize_t written = uart_irqwrite(dev, iov->iov_base, iov->iov_len);
      if (written < 0)
        {
          error = written;
""", """          continue;
        }

      ssize_t written = uart_irqwrite(dev, iov->iov_base, iov->iov_len,
                                      &usb_wait_us);
      if (written < 0)
        {
          error = written;
"""),
    ("""              uart_dmatxavail(dev);
#endif
              uart_enabletxint(dev);
              ret = nxsem_wait(&dev->xmitsem);
              uart_disabletxint(dev);
            }
        }
""", """              uart_dmatxavail(dev);
#endif
              uart_enabletxint(dev);
              ret = uart_wait_txspace(dev);
              uart_disabletxint(dev);
            }
        }
"""),
    ("""
  /* Only one user can access dev->xmit.head at a time */

  ret = nxmutex_lock(&dev->xmit.lock);
  if (ret < 0)
    {
      /* A signal received while waiting for access to the xmit.head will
""", """
  /* Only one user can access dev->xmit.head at a time */

  ret = uart_usb_console(dev) ? nxmutex_timedlock(&dev->xmit.lock, 20) :
                               nxmutex_lock(&dev->xmit.lock);
  if (ret == -ETIMEDOUT && uart_usb_console(dev))
    {
      /* 另一个输出者占锁时也不能阻塞业务；只丢弃本次 USB 控制台输出。 */
      uio_advance(uio, buflen);
      return buflen;
    }
  if (ret < 0)
    {
      /* A signal received while waiting for access to the xmit.head will
"""),
    ("""
      if (ret < 0)
        {
          /* POSIX requires that we return -1 and errno set if no data was
           * transferred.  Otherwise, we return the number of bytes in the
           * interrupted transfer.
""", """
      if (ret < 0)
        {
          if (ret == -ETIMEDOUT && uart_usb_console(dev))
            {
              /* 当前 USB 日志在 20ms 内没有发送进展，丢弃余下内容；
               * 不向 stdio 返回短写/零写，避免 fflush 重试或粘滞错误。 */
              uio_advance(uio, buflen);
              break;
            }

          /* POSIX requires that we return -1 and errno set if no data was
           * transferred.  Otherwise, we return the number of bytes in the
           * interrupted transfer.
"""),
)


def patched_text(source: str, replacements) -> str:
    for old, new in replacements:
        if source.count(new) == 1:
            continue
        if source.count(old) != 1:
            raise ValueError("USB serial 源码版本已变化，拒绝不确定修补")
        source = source.replace(old, new, 1)
    return source


def apply_usbserial_patch(root: Path) -> None:
    path = root / RELATIVE
    if not path.is_file():
        return
    serial = root / SERIAL_RELATIVE
    pending = []
    # 先校验两份源码再写入，任何漂移都不会留下一半补丁。
    for target, replacements in (
        (path, ((BUFFER_OLD, BUFFER_NEW), (WRITE_OLD, WRITE_NEW))),
        (serial, SERIAL_REPLACEMENTS),
    ):
        if ".deps" in target.resolve().parts:
            raise ValueError("不能修补上游 .deps；请使用隔离构建快照")
        if not target.is_file():
            raise ValueError(f"缺少 USB serial 补丁输入：{target}")
        original = target.read_text()
        updated = patched_text(original, replacements)
        if updated != original:
            pending.append((target, updated))
    for target, updated in pending:
        target.write_text(updated)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    apply_usbserial_patch(parser.parse_args().root)
