"""验证补丁幂等、漂移失败关闭，以及无主机时输出有界。"""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "usbserial_patch", Path(__file__).parents[1] / "scripts/usbserial_patch.py")
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


def extract_function(source: str, name: str) -> str:
    import re
    match = re.search(r"^(?:static[^\n]*|void)\b[^;{}]*?\b" + name +
                      r"\([^;{}]*\)\s*\{", source, re.M)
    if not match:
        raise AssertionError(f"找不到待验证函数 {name}")
    end = source.index("{", match.start()) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end] + "\n"


class UsbSerialPatchTests(unittest.TestCase):
    def test_sdk_idempotence_and_no_source_write(self):
        source = Path(__file__).parents[2] / ".deps/nuttx" / patch.RELATIVE
        original = source.read_bytes()
        serial_source = source.parents[4] / patch.SERIAL_RELATIVE
        serial_original = serial_source.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / patch.RELATIVE
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
            serial = root / patch.SERIAL_RELATIVE
            serial.parent.mkdir(parents=True)
            serial.write_bytes(serial_original)
            patch.apply_usbserial_patch(root)
            first = target.read_bytes()
            first_serial = serial.read_bytes()
            patch.apply_usbserial_patch(root)
            self.assertEqual(first, target.read_bytes())
            self.assertEqual(first_serial, serial.read_bytes())
            self.assertIn(b"uart_wait_txspace", first_serial)
            self.assertIn(b"BUFFERSIZE 2048", first)
        self.assertEqual(original, source.read_bytes())
        self.assertEqual(serial_original, serial_source.read_bytes())

    def test_drift_does_not_write_partial_patch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / patch.RELATIVE
            target.parent.mkdir(parents=True)
            target.write_text(patch.BUFFER_OLD + "\nunknown output function")
            original = target.read_bytes()
            with self.assertRaises(ValueError):
                patch.apply_usbserial_patch(root)
            self.assertEqual(original, target.read_bytes())

    def test_upper_half_drift_keeps_both_sources_unchanged(self):
        sdk = Path(__file__).parents[2] / ".deps/nuttx"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            usb = root / patch.RELATIVE
            serial = root / patch.SERIAL_RELATIVE
            usb.parent.mkdir(parents=True)
            serial.parent.mkdir(parents=True)
            usb.write_bytes((sdk / patch.RELATIVE).read_bytes())
            serial.write_text("unknown upper-half revision")
            original = usb.read_bytes()
            with self.assertRaises(ValueError):
                patch.apply_usbserial_patch(root)
            self.assertEqual(original, usb.read_bytes())
            self.assertEqual("unknown upper-half revision", serial.read_text())

    def test_upstream_write_rejected(self):
        sdk = Path(__file__).parents[2] / ".deps/nuttx"
        with self.assertRaises(ValueError):
            patch.apply_usbserial_patch(sdk)

    def test_normal_usb_write_irq_backpressure_and_uart_regression(self):
        sdk = Path(__file__).parents[2] / ".deps/nuttx"
        serial = patch.patched_text((sdk / patch.SERIAL_RELATIVE).read_text(),
                                    patch.SERIAL_REPLACEMENTS)
        functions = "\n".join(extract_function(serial, name) for name in (
            "uart_usb_console", "uart_wait_txspace", "uart_putxmitchar",
            "uart_putchars", "uart_irqwrite", "uart_irqwritev", "uart_writev"))
        functions += extract_function((sdk / "drivers/serial/serial_io.c").read_text(),
                                      "uart_xmitchars")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "serial.c"
            executable = Path(tmp) / "serial-test"
            source.write_text(SERIAL_STUBS + functions + SERIAL_CASES)
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-Wno-sign-compare", "-fsanitize=undefined", str(source),
                            "-o", str(executable)], check=True, timeout=30)
            subprocess.run([str(executable)], check=True, timeout=5)

    def test_output_timeout_and_recovery(self):
        source = """
#include <assert.h>
#include <stdbool.h>
static unsigned int waits, sent, ready_after;
static int g_uart_usbserial;
static bool esp32s3_txready(int *dev) { (void)dev; return waits >= ready_after; }
static void up_udelay(unsigned int us) { assert(us == 1); waits++; }
static void esp32s3_send(int *dev, int ch) { (void)dev; assert(ch == 'a'); sent++; }
static void output(char ch) {
""" + patch.WRITE_NEW + """
}
int main(void) {
  ready_after = 100000;
  output('a');
  assert(waits == 2000 && sent == 0);
  waits = 0; ready_after = 3;
  output('a');
  assert(waits == 3 && sent == 1);
  output('a');
  assert(waits == 3 && sent == 2);
}
"""
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "usb.c"
            exe = Path(tmp) / "usb"
            file.write_text(source)
            subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", str(file), "-o", str(exe)],
                           check=True, timeout=30)
            subprocess.run([str(exe)], check=True, timeout=5)


# 从真实 serial.c 提取函数，桩仅替换调度、硬件寄存器和内核同步原语。
SERIAL_STUBS = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <termios.h>
#include <limits.h>
#ifndef SSIZE_MAX
#define SSIZE_MAX INTPTR_MAX
#endif
#define FAR
#define OK 0
#define CONFIG_ARCH_CHIP_ESP32S3 1
#define CONFIG_ESP32S3_USBSERIAL 1
#define MSEC2TICK(x) (x)
typedef unsigned irqstate_t;
struct uart_dev_s;
struct ops_s { ssize_t (*sendbuf)(struct uart_dev_s*,const void*,size_t); };
struct buffer_s { uint16_t head,tail,size; char *buffer; int lock; };
typedef struct uart_dev_s { struct buffer_s xmit; int xmitsem; unsigned tc_oflag; struct ops_s *ops; } uart_dev_t;
struct inode { uart_dev_t *i_private; };
struct file { struct inode *f_inode; int f_oflags; };
struct uio { struct iovec *uio_iov; int uio_iovcnt; size_t uio_resid,offset; };
static unsigned mutex_calls,timed_mutex_calls,unlocks,sem_calls,timed_sem_calls,poll_wakes;
static unsigned delay_us,tx_polls,ready_after,critical,irq_depth;
static unsigned sent_count,scheduled,timeout_ms;
static bool reader,timedout_lock;
static int wait_error;
static char sent[10000];
static char usb_buffer[8],uart_buffer[8];
static struct ops_s ops;
uart_dev_t g_uart_usbserial;
static uart_dev_t uart;
static uart_dev_t *current;
static bool tx_enabled;
static void uart_xmitchars(uart_dev_t *dev);
static irqstate_t enter_critical_section(void) { return critical++; }
static void leave_critical_section(irqstate_t prev) { assert(critical==prev+1); critical=prev; }
static bool up_interrupt_context(void) { return irq_depth!=0; }
static bool sched_idletask(void) { return false; }
static void up_udelay(unsigned usec) { assert(usec==1); ++delay_us; }
static bool uart_txready(uart_dev_t *dev) { (void)dev; ++tx_polls; return reader && tx_polls>ready_after; }
static void uart_send(uart_dev_t *dev,int ch) { (void)dev; assert(sent_count<sizeof(sent)); sent[sent_count++]=(char)ch; }
static ssize_t uart_sendbuf(uart_dev_t *dev,const void *b,size_t n) { return dev->ops->sendbuf(dev,b,n); }
static void uart_enabletxint(uart_dev_t *dev) { current=dev; tx_enabled=true; }
static void uart_disabletxint(uart_dev_t *dev) { (void)dev; tx_enabled=false; }
static void uart_datasent(uart_dev_t *dev) { (void)dev; ++poll_wakes; }
static int nxmutex_lock(int *m) { (void)m; ++mutex_calls; return 0; }
static int nxmutex_timedlock(int *m,unsigned ms) { (void)m; assert(ms==20); ++timed_mutex_calls; return timedout_lock ? -ETIMEDOUT:0; }
static void nxmutex_unlock(int *m) { (void)m; ++unlocks; }
static int nxsem_wait(int *s) { (void)s; ++sem_calls; assert(current && tx_enabled); ++scheduled; uart_xmitchars(current); return wait_error; }
static int nxsem_tickwait(int *s,unsigned ticks) {
  (void)s; assert(critical && ticks==20 && tx_enabled); ++timed_sem_calls;
  timeout_ms+=ticks; ++scheduled;
  if(wait_error) return wait_error;
  if(!reader) return -ETIMEDOUT;
  uart_xmitchars(current); return 0;
}
static void uio_advance(struct uio *uio,size_t n) { assert(n<=uio->uio_resid); uio->offset+=n; uio->uio_resid-=n; }
static void uio_copyto(struct uio *uio,size_t offset,void *out,size_t size) {
  size_t p=uio->offset+offset;
  for(int i=0;i<uio->uio_iovcnt;i++) {
    if(p<uio->uio_iov[i].iov_len) { assert(size<=uio->uio_iov[i].iov_len-p); memcpy(out,(char*)uio->uio_iov[i].iov_base+p,size); return; }
    p-=uio->uio_iov[i].iov_len;
  }
  assert(0);
}
static void reset(void) {
  mutex_calls=timed_mutex_calls=unlocks=sem_calls=timed_sem_calls=poll_wakes=0;
  delay_us=tx_polls=ready_after=critical=irq_depth=sent_count=scheduled=timeout_ms=0;
  reader=true;timedout_lock=false;wait_error=0;tx_enabled=false;
  memset(sent,0,sizeof(sent)); memset(&g_uart_usbserial,0,sizeof(g_uart_usbserial));
  g_uart_usbserial.xmit=(struct buffer_s){0,0,sizeof(usb_buffer),usb_buffer,0};g_uart_usbserial.ops=&ops;
  uart=g_uart_usbserial;uart.xmit.buffer=uart_buffer;
}
'''

SERIAL_CASES = r'''
static ssize_t put(uart_dev_t *dev,const char *s,int flags,size_t *remain) {
 struct inode node={dev};struct file f={&node,flags};struct iovec v={(void*)s,strlen(s)};
 struct uio u={&v,1,v.iov_len,0}; ssize_t n=uart_writev(&f,&u);*remain=u.uio_resid;return n;
}
int main(void) {
 setbuf(stdout,NULL); size_t remain; const char *hello="healthy usb console log, complete";
 reset();assert(put(&g_uart_usbserial,hello,0,&remain)==(ssize_t)strlen(hello));uart_xmitchars(&g_uart_usbserial);
 assert(remain==0&&sent_count==strlen(hello)&&!memcmp(sent,hello,sent_count));assert(timed_sem_calls>0&&sem_calls==0);
 reset(); reader=false;g_uart_usbserial.xmit.head=7;
 assert(put(&g_uart_usbserial,"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",0,&remain)==64);
 assert(remain==0&&timed_sem_calls==1&&timeout_ms==20&&scheduled==1&&poll_wakes==1&&sent_count==0);
 assert(g_uart_usbserial.xmit.head==g_uart_usbserial.xmit.tail&&critical==0&&unlocks==1);
 reader=true;assert(put(&g_uart_usbserial,"back",0,&remain)==4);uart_xmitchars(&g_uart_usbserial);assert(sent_count==4&&!memcmp(sent,"back",4));
 reset();timedout_lock=true;assert(put(&g_uart_usbserial,"discard",0,&remain)==7);assert(remain==0&&unlocks==0&&timed_sem_calls==0);
 timedout_lock=false;assert(put(&g_uart_usbserial,"ok",0,&remain)==2);uart_xmitchars(&g_uart_usbserial);assert(sent_count==2&&!memcmp(sent,"ok",2));
 reset();reader=false;g_uart_usbserial.xmit.head=7;assert(put(&g_uart_usbserial,"x",O_NONBLOCK,&remain)==-EAGAIN);
 assert(remain==1&&timed_sem_calls==0&&g_uart_usbserial.xmit.tail==0);
 reset();reader=false;g_uart_usbserial.xmit.head=7;wait_error=-EINTR;assert(put(&g_uart_usbserial,"x",0,&remain)==-EINTR);assert(poll_wakes==0);
 reset();assert(put(&uart,hello,0,&remain)==(ssize_t)strlen(hello));uart_xmitchars(&uart);
 assert(remain==0&&sent_count==strlen(hello)&&!memcmp(sent,hello,sent_count)&&mutex_calls==1&&timed_mutex_calls==0&&sem_calls>0&&timed_sem_calls==0);
 reset();reader=false;irq_depth=1;g_uart_usbserial.tc_oflag=OPOST|ONLCR;
 assert(put(&g_uart_usbserial,"first\nsecond\nlast\n",0,&remain)==18);assert(delay_us==2000&&sent_count==0&&critical==0);
 reset();reader=false;irq_depth=1;struct iovec vectors[2]={{"abc\n",4},{"def\n",4}};struct uio u={vectors,2,8,0};
 struct inode node={&g_uart_usbserial};struct file f={&node,0};g_uart_usbserial.tc_oflag=OPOST|ONLCR;
 assert(uart_writev(&f,&u)==8);assert(delay_us==2000&&sent_count==0&&critical==0);
 reset();irq_depth=1;ready_after=7;assert(put(&uart,"uart",0,&remain)==4);assert(delay_us==0&&sent_count==4&&!memcmp(sent,"uart",4));
 reset();irq_depth=1;ready_after=3;assert(put(&g_uart_usbserial,"usb",0,&remain)==3);assert(delay_us==3&&sent_count==3&&!memcmp(sent,"usb",3));
 puts("10 cases passed: healthy/backpressure/recovery/lock timeout/nonblock/signal/UART/IRQ budget/shared-iovec/IRQ recovery");
}
'''

if __name__ == "__main__":
    unittest.main()
