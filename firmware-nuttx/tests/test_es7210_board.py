#!/usr/bin/env python3
"""编译板级真实 ES7210 初始化，核对格式、时钟、增益与 I2C 错误路径。"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
BOARD = PROJECT / "boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_board.c"
PREFIX = r'''
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define LOG_WARNING 1
#define PIXELBOX_ES7210_ADDR 0x40
#define ESP32S3_I2S_CAPTURE_START 1
#define ESP32S3_I2S_CAPTURE_STOP 2
#define syslog(...) ((void)0)
struct i2c_master_s {int unused;};
struct i2s_dev_s {int unused;};
static struct i2c_master_s bus;
static struct i2s_dev_s i2s;
static struct i2c_master_s*g_i2c=&bus;
static struct i2s_dev_s*g_i2s=&i2s;
static bool g_mic_ready=true;
static uint8_t registers[256];
static int failed_register=-1,clock_error,start_error,starts,stops,writes;
static unsigned mclk,rate;
static int pixelbox_i2c_write8(struct i2c_master_s*b,uint16_t addr,uint8_t r,uint8_t v){assert(b==&bus&&addr==0x40);if(r==failed_register)return -ENXIO;registers[r]=v;++writes;return 0;}
static int configure(struct i2s_dev_s*d,unsigned value,unsigned expected){assert(d==&i2s&&value==expected);return clock_error?clock_error:(int)value;}
static int clock_configure(struct i2s_dev_s*d,unsigned r){assert(d==&i2s);rate=r;return clock_error?clock_error:(int)r;}
static int mclk_configure(struct i2s_dev_s*d,unsigned r){assert(d==&i2s);mclk=r;return clock_error?clock_error:(int)r;}
static int control(struct i2s_dev_s*d,int cmd,int arg){assert(d==&i2s&&!arg);if(cmd==ESP32S3_I2S_CAPTURE_START){++starts;return start_error;}++stops;return 0;}
#define I2S_TXDATAWIDTH(d,n) configure(d,n,16)
#define I2S_RXDATAWIDTH(d,n) configure(d,n,16)
#define I2S_TXCHANNELS(d,n) configure(d,n,2)
#define I2S_RXCHANNELS(d,n) configure(d,n,2)
#define I2S_TXSAMPLERATE clock_configure
#define I2S_RXSAMPLERATE clock_configure
#define I2S_SETMCLKFREQUENCY mclk_configure
#define I2S_IOCTL control
'''
CHECKS = r'''
int main(void){
 struct i2s_dev_s*out=NULL;
 assert(pixelbox_board_mic_available());
 assert(pixelbox_board_mic_prepare(16000,70,&out)==0&&out==&i2s&&starts==1);
 assert(rate==16000&&mclk==4096000);
 assert(registers[0x11]==0x60&&registers[0x12]==0&&registers[0x08]==0);
 assert(registers[0x4b]==0&&registers[0x4c]==0xff&&registers[1]==0x34);
 assert(registers[0x43]==0x19&&registers[0x44]==0x19&&registers[0]==0x41);
 assert(registers[0x47]==8&&registers[0x48]==8&&registers[0x49]==0xff);
 assert(pixelbox_board_mic_set_gain(100)==0&&registers[0x43]==0x1e);
 assert(pixelbox_board_mic_set_gain(-9)==0&&registers[0x43]==0x10);
 pixelbox_board_mic_cancel();assert(stops==1);
 pixelbox_board_mic_powerdown();assert(stops==2&&registers[0x40]==0xc0&&registers[0x06]==7);
 failed_register=0x23;out=&i2s;
 assert(pixelbox_board_mic_prepare(16000,70,&out)==-ENXIO&&out==NULL);
 assert(registers[0x40]==0xc0&&registers[0x06]==7&&starts==1);
 failed_register=-1;start_error=-EIO;
 assert(pixelbox_board_mic_prepare(16000,70,&out)==-EIO&&out==NULL);
 assert(registers[0x40]==0xc0&&registers[0x06]==7&&starts==2);
 clock_error=-EIO;int before=writes;
 assert(pixelbox_board_mic_prepare(16000,70,&out)==-EIO&&writes==before);
 clock_error=0;g_mic_ready=false;
 assert(!pixelbox_board_mic_available());
 assert(pixelbox_board_mic_prepare(16000,70,&out)==-ENODEV);
 assert(pixelbox_board_mic_prepare(48000,70,&out)==-EINVAL);
 return 0;
}
'''

class ES7210BoardTests(unittest.TestCase):
    def test_real_board_register_and_error_paths(self):
        source = BOARD.read_text()
        begin = source.index("static int pixelbox_es7210_write")
        end = source.index("\n#else", begin)
        with tempfile.TemporaryDirectory(prefix="pixelbox-es7210-") as temporary:
            root = Path(temporary)
            (root / "test.c").write_text(PREFIX + source[begin:end] + CHECKS)
            result = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", str(root / "test.c"), "-o", str(root / "test")], text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(root / "test")], text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
