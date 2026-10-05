#ifndef PIXELBOX_AUDIO_DECODE_H
#define PIXELBOX_AUDIO_DECODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

struct px_audio_decoder;

/* 输入由调用者持有到 close；解码器仅缓存一帧，不展开整个文件。
 * 支持 RIFF/WAVE PCM8/16 和 MPEG Layer III；输出双声道 PCM16LE。
 * MP3 解码函数内部使用较大的栈，调用线程至少预留 32 KiB。
 */
int px_audio_decoder_open(const void *bytes, size_t length,
                           struct px_audio_decoder **decoder,
                           unsigned *sample_rate, unsigned *channels);
ssize_t px_audio_decoder_read(struct px_audio_decoder *decoder, void *output,
                              size_t frames, bool *finished);
void px_audio_decoder_close(struct px_audio_decoder *decoder);

#endif
