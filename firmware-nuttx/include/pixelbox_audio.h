#ifndef PIXELBOX_AUDIO_H
#define PIXELBOX_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct px_audio_result {
  uint32_t job_id;
  int error; /* 0=自然结束，-ECANCELED=停止，其余为负 errno。 */
  bool started; /* 编码文件仅在硬件 START 成功后发送一次 started 事件。 */
};

/* 单路 ES8311 播放。后台只访问自有 PCM，不访问 JS。
 * shutdown 请求异步停止，避免驱动的 STOP/join 阻塞 JS 主线程。
 * 资源安全回收前，init/新播放返回 -EBUSY；主机返回 -ENOTSUP。
 */
int px_audio_init(void);
void px_audio_shutdown(void);
/* 有界等待后台真实回收；超时为 -ETIMEDOUT，不释放仍被 DMA 引用的内存。 */
int px_audio_quiesce(unsigned timeout_ms);
int px_audio_set_volume(int percent);
int px_audio_get_volume(void);

/* 音量 0..100 夹紧；闲置时缓存，在下次开始播放时应用。
 * PCM16LE 在调用返回前完整复制；默认参数由调用方传入。
 * 采样率支持 8000/11025/12000/16000/22050/24000/32000/44100/48000。
 * 同时最多一个作业；结果未 poll 或驱动仍在回收时返回 -EBUSY。
 */
int px_audio_tone(float frequency, unsigned duration_ms, int volume,
                  uint32_t *job_id);
int px_audio_play_pcm(const void *pcm, size_t bytes, unsigned sample_rate,
                      unsigned channels, uint32_t *job_id);
/* 完整复制编码数据；后台逐帧解码 WAV/MP3。解析/设备错误通过 poll 返回。 */
int px_audio_play_encoded(const void *encoded, size_t bytes, uint32_t *job_id);

/* 流拥有 64 KiB 环形缓冲；feed 整块复制或返回 -EAGAIN，不悄悄丢数据。
 * end 表示 EOF，最后的硬件 COMPLETE 到达后才报告自然结束。
 * 超过 30 秒没有新数据则超时；pause 期间不计超时。
 */
int px_audio_stream_open(unsigned sample_rate, unsigned channels,
                         uint32_t *job_id);
int px_audio_stream_feed(uint32_t job_id, const void *pcm, size_t bytes);
int px_audio_stream_end(uint32_t job_id);
int px_audio_buffered_ms(uint32_t job_id);
int px_audio_pause(uint32_t job_id, bool paused);
int px_audio_stop(uint32_t job_id);
void px_audio_stop_all(void);
bool px_audio_playing(uint32_t job_id); /* job_id==0 查询任意作业。 */

/* 1=一个开始/终结事件，0=暂无，负 errno=参数/模块错误。
 * 取消与超时会及时报告；后台未完成安全回收时，新播放仍 -EBUSY。
 */
int px_audio_poll(struct px_audio_result *result);

/* I2S0 时钟仲裁：ES7210 固定 16k 采集时，仅允许同率播放并发。
 * acquire/release 覆盖整个 RX DMA 生命周期，不能在尚有回调时提前释放。
 */
int px_audio_capture_acquire(void);
void px_audio_capture_release(void);

#endif
