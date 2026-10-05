/* WAV / MP3 解码与设备、JS 解耦；输入校验错误直接传播给播放作业。 */
#include "pixelbox_audio_decode.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#define MINIMP3_IMPLEMENTATION
#include "../vendor/minimp3/minimp3.h"

struct px_audio_decoder {
  const uint8_t *data;
  size_t length;
  size_t position;
  unsigned rate;
  unsigned channels;
  unsigned bits;
  bool mp3;
  mp3dec_t state;
  mp3d_sample_t samples[MINIMP3_MAX_SAMPLES_PER_FRAME];
  size_t sample_frames;
  size_t sample_position;
};

static uint16_t read16(const uint8_t *p)
{
  return p[0] | (uint16_t)p[1] << 8;
}

static uint32_t read32(const uint8_t *p)
{
  return read16(p) | (uint32_t)read16(p + 2) << 16;
}

static void write16(uint8_t *p, int16_t value)
{
  p[0] = (uint8_t)value;
  p[1] = (uint8_t)((uint16_t)value >> 8);
}

static bool valid_rate(unsigned rate)
{
  return rate == 8000 || rate == 11025 || rate == 12000 || rate == 16000 ||
         rate == 22050 || rate == 24000 || rate == 32000 || rate == 44100 ||
         rate == 48000;
}

static int open_wav(struct px_audio_decoder *decoder)
{
  const uint8_t *data = decoder->data;
  if (decoder->length < 12 || memcmp(data + 8, "WAVE", 4)) return -EBADMSG;
  size_t riff = read32(data + 4);
  if (riff < 4 || riff > decoder->length - 8) return -EBADMSG;
  size_t limit = riff + 8;
  bool format = false;
  for (size_t offset = 12; offset < limit;) {
    if (limit - offset < 8) return -EBADMSG;
    const uint8_t *chunk = data + offset;
    size_t bytes = read32(chunk + 4);
    offset += 8;
    if (bytes > limit - offset) return -EBADMSG;
    if (!memcmp(chunk, "fmt ", 4)) {
      if (format || bytes < 16) return -EBADMSG;
      if (read16(data + offset) != 1) return -ENOTSUP;
      decoder->channels = read16(data + offset + 2);
      decoder->rate = read32(data + offset + 4);
      decoder->bits = read16(data + offset + 14);
      if (!valid_rate(decoder->rate) ||
          (decoder->channels != 1 && decoder->channels != 2) ||
          (decoder->bits != 8 && decoder->bits != 16)) return -ENOTSUP;
      unsigned alignment = decoder->channels * decoder->bits / 8;
      if (read16(data + offset + 12) != alignment ||
          read32(data + offset + 8) != decoder->rate * alignment)
        return -EBADMSG;
      format = true;
    } else if (!memcmp(chunk, "data", 4)) {
      if (!format || !bytes || bytes % (decoder->channels * decoder->bits / 8))
        return -EBADMSG;
      decoder->position = offset;
      decoder->length = offset + bytes;
      return 0;
    }
    offset += bytes;
    if (bytes & 1) {
      if (offset == limit) return -EBADMSG;
      ++offset;
    }
  }
  return -EBADMSG;
}

/* 首帧建立格式；后续帧不接受采样率/声道突变，避免错误时钟播放。 */
static int next_mp3_frame(struct px_audio_decoder *decoder)
{
  while (decoder->position < decoder->length) {
    size_t left = decoder->length - decoder->position;
    if (left < 4 || left > INT_MAX) return -EBADMSG;
    mp3dec_frame_info_t info = {0};
    int count = mp3dec_decode_frame(&decoder->state,
      decoder->data + decoder->position, (int)left, decoder->samples, &info);
    if (info.frame_bytes <= 0 || (size_t)info.frame_bytes > left ||
        info.frame_offset || info.layer != 3 || !valid_rate((unsigned)info.hz) ||
        (info.channels != 1 && info.channels != 2)) return -EBADMSG;
    if (decoder->rate && (decoder->rate != (unsigned)info.hz ||
                         decoder->channels != (unsigned)info.channels))
      return -ENOTSUP;
    decoder->rate = (unsigned)info.hz;
    decoder->channels = (unsigned)info.channels;
    decoder->position += (size_t)info.frame_bytes;
    if (count > 0) {
      decoder->sample_frames = (size_t)count;
      decoder->sample_position = 0;
      return 1;
    }
  }
  decoder->sample_frames = 0;
  decoder->sample_position = 0;
  return 0;
}

static int open_mp3(struct px_audio_decoder *decoder)
{
  const uint8_t *data = decoder->data;
  if (decoder->length >= 3 && !memcmp(data, "ID3", 3)) {
    if (decoder->length < 10 || data[3] < 2 || data[3] > 4 ||
        (data[6] | data[7] | data[8] | data[9]) & 0x80) return -EBADMSG;
    size_t tag = (size_t)data[6] << 21 | (size_t)data[7] << 14 |
                 (size_t)data[8] << 7 | data[9];
    if (data[3] == 4 && (data[5] & 0x10)) tag += 10;
    if (tag > decoder->length - 10) return -EBADMSG;
    decoder->position = tag + 10;
  }
  /* ID3v1 是尾部元数据，不应把它送给帧同步器并误报损坏。 */
  if (decoder->length - decoder->position >= 128 &&
      !memcmp(data + decoder->length - 128, "TAG", 3)) decoder->length -= 128;
  mp3dec_init(&decoder->state);
  int result = next_mp3_frame(decoder);
  return result > 0 ? 0 : result < 0 ? result : -EBADMSG;
}

int px_audio_decoder_open(const void *bytes, size_t length,
                           struct px_audio_decoder **out,
                           unsigned *sample_rate, unsigned *channels)
{
  if (!out || !sample_rate || !channels || !bytes || !length || length > INT_MAX)
    return -EINVAL;
  *out = NULL;
  struct px_audio_decoder *decoder = calloc(1, sizeof(*decoder));
  if (!decoder) return -ENOMEM;
  decoder->data = bytes;
  decoder->length = length;
  decoder->mp3 = length < 4 || memcmp(bytes, "RIFF", 4);
  int result = decoder->mp3 ? open_mp3(decoder) : open_wav(decoder);
  if (result < 0) { free(decoder); return result; }
  *sample_rate = decoder->rate;
  *channels = decoder->channels;
  *out = decoder;
  return 0;
}

ssize_t px_audio_decoder_read(struct px_audio_decoder *decoder, void *output,
                              size_t frames, bool *finished)
{
  if (!decoder || !output || !frames || frames > INT_MAX / 4 || !finished)
    return -EINVAL;
  uint8_t *out = output;
  size_t count = 0;
  *finished = false;
  if (!decoder->mp3) {
    size_t width = decoder->bits / 8;
    size_t stride = width * decoder->channels;
    size_t left = (decoder->length - decoder->position) / stride;
    if (frames > left) frames = left;
    for (; count < frames; ++count) {
      const uint8_t *p = decoder->data + decoder->position;
      int16_t first = width == 2 ? (int16_t)read16(p) : (int16_t)(((int)p[0] - 128) * 256);
      int16_t second = first;
      if (decoder->channels == 2)
        second = width == 2 ? (int16_t)read16(p + 2) : (int16_t)(((int)p[1] - 128) * 256);
      write16(out + count * 4, first);
      write16(out + count * 4 + 2, second);
      decoder->position += stride;
    }
    *finished = decoder->position == decoder->length;
  } else {
    while (count < frames) {
      if (decoder->sample_position == decoder->sample_frames) {
        int next = next_mp3_frame(decoder);
        if (next < 0) return next;
        if (!next) { *finished = true; break; }
      }
      size_t index = decoder->sample_position * decoder->channels;
      write16(out + count * 4, decoder->samples[index]);
      write16(out + count * 4 + 2,
        decoder->samples[index + (decoder->channels == 2 ? 1 : 0)]);
      ++decoder->sample_position;
      ++count;
    }
    /* 缓冲恰好装满最后一帧时也标记 FINAL，无需额外静音补包。 */
    if (decoder->sample_position == decoder->sample_frames) {
      int next = next_mp3_frame(decoder);
      if (next < 0) return next;
      if (!next) *finished = true;
    }
  }
  return (ssize_t)count;
}

void px_audio_decoder_close(struct px_audio_decoder *decoder)
{
  free(decoder);
}
