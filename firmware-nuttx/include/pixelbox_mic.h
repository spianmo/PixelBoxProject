#ifndef PIXELBOX_MIC_H
#define PIXELBOX_MIC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct px_mic_frame {
  uint8_t *data; /* poll 成功后归调用方，使用 free 释放。 */
  size_t bytes;
  unsigned sample_rate;
};

bool px_mic_available(void);
/* 启动成功表示任务已接管；codec prepare/增益 I2C 错误经 poll 异步报告。 */
int px_mic_start(unsigned sample_rate, unsigned frame_ms);
void px_mic_stop(void); /* 异步停止；最后 RX 回调前保留缓冲及 I2S 时钟占用。 */
/* 仅观察真实回收状态；超时为 -ETIMEDOUT，调用前先请求 stop。 */
int px_mic_quiesce(unsigned timeout_ms);
bool px_mic_active(void);
bool px_mic_busy(void);
int px_mic_set_gain(int percent);
/* 1=至多 max_frames 个完整 PCM16LE 单声道帧；0=暂无；负 errno=一次错误。
 * max_frames=1 保持单帧语义；大于1仅合并已就绪帧，不额外等待。 */
int px_mic_poll(struct px_mic_frame *frame, unsigned max_frames);

/* 板级 prepare：ES7210 MIC1/2、slave Philips I2S16；I2S0 RX 双声道，
 * 16k，MCLK=4096000；保证只有录音时 BCLK/WS 仍连续有效。
 */
#if defined(__NuttX__) || defined(PX_MIC_TEST)
struct i2s_dev_s;
bool pixelbox_board_mic_available(void);
int pixelbox_board_mic_prepare(unsigned rate, int gain, struct i2s_dev_s **out);
int pixelbox_board_mic_set_gain(int gain);
void pixelbox_board_mic_cancel(void);
void pixelbox_board_mic_powerdown(void);
#endif

#endif
