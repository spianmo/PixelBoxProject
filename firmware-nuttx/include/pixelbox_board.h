/* PixelBox Micro-雪 2.16 board initialization entry point. */

#ifndef PIXELBOX_BOARD_H
#define PIXELBOX_BOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* QMI8658 原始样本：加速度单位 g，角速度单位 dps。 */
struct pixelbox_imu_sample
{
  float ax;
  float ay;
  float az;
  float gx;
  float gy;
  float gz;
};

/* 触摸事件类型与 sdk/types/pixelbox.d.ts 的字符串值一一对应。 */
enum pixelbox_touch_event_type
{
  PIXELBOX_TOUCH_DOWN = 1,
  PIXELBOX_TOUCH_MOVE = 2,
  PIXELBOX_TOUCH_UP = 3,
};

struct pixelbox_touch_event
{
  enum pixelbox_touch_event_type type;
  unsigned short x;
  unsigned short y;
};

#ifdef __NuttX__
int pixelbox_board_initialize(void);
/*
 * 板级 I2C 首次探测状态：0=仍在后台探测，1=探测流程已结束（外设可用性
 * 仍需分别查询），负 errno=worker 创建或控制器初始化失败。该状态只描述
 * “首次探测是否完成”，不会把缺少某个可选外设误报成启动失败。
 */
int pixelbox_board_io_status(void);
bool pixelbox_board_imu_available(void);
int pixelbox_board_imu_read(struct pixelbox_imu_sample *sample);
bool pixelbox_board_touch_available(void);
int pixelbox_board_touch_read(struct pixelbox_touch_event *event);
/* index 0=BOOT(GPIO0)，1=USER(GPIO18)，低电平表示按下。 */
int pixelbox_board_button_read(unsigned index, bool *pressed);
struct i2s_dev_s;
bool pixelbox_board_mic_available(void);
int pixelbox_board_mic_prepare(unsigned rate, int gain, struct i2s_dev_s **out);
int pixelbox_board_mic_set_gain(int gain);
void pixelbox_board_mic_cancel(void);
void pixelbox_board_mic_powerdown(void);
bool pixelbox_board_display_available(void);
int pixelbox_board_display_initialize(void);
/* 像素为 RGB565 字节流，按面板传输顺序排列，每行 width * 2 字节。 */
int pixelbox_board_display_write(int x, int y, int width, int height,
                                 const uint8_t *pixels, size_t length);
/* 亮度裁剪到 0..100；getter 返回当前值或负 errno。 */
int pixelbox_board_display_set_brightness(int percent);
int pixelbox_board_display_get_brightness(void);
/* 旋转只接受 0/90/180/270；改变角度清空逻辑帧缓冲，下一次 flush 提交。 */
int pixelbox_board_display_set_rotation(int degrees);
int pixelbox_board_display_get_rotation(void);
#endif

#endif /* PIXELBOX_BOARD_H */
