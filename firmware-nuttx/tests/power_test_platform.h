#ifndef PIXELBOX_POWER_TEST_PLATFORM_H
#define PIXELBOX_POWER_TEST_PLATFORM_H

#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <nuttx/i2c/i2c_master.h>

int px_power_test_open(const char *path, int flags);
int px_power_test_close(int fd);
int px_power_test_ioctl(int fd, int command, unsigned long argument);

#ifdef PX_POWER_TEST_FILE
struct file { unsigned identity; };
int px_power_test_file_open(struct file *file, const char *path, int flags);
int px_power_test_file_close(struct file *file);
int px_power_test_file_ioctl(struct file *file, int command, unsigned long argument);
#define file_open px_power_test_file_open
#define file_close px_power_test_file_close
#define file_ioctl px_power_test_file_ioctl
#else
#define open px_power_test_open
#define close px_power_test_close
#define ioctl px_power_test_ioctl
#endif

#endif
