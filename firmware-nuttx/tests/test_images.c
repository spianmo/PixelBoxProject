#include "pixelbox_image.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { \
  fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); exit(2); \
} } while (0)

static void write_u32(uint32_t value)
{
  uint8_t bytes[4] = {value, value >> 8, value >> 16, value >> 24};
  CHECK(fwrite(bytes, 1, 4, stdout) == 4);
}

static void emit(const struct px_image *image)
{
  write_u32(image->width); write_u32(image->height); write_u32(image->duration_ms);
  for (unsigned y = 0; y < image->height; ++y)
    for (unsigned x = 0; x < image->width; ++x) {
      const uint32_t color = image->pixels[(size_t)y * image->width + x];
      const uint8_t opaque = !image->alpha ||
        (image->alpha[(size_t)y * ((image->width + 7) / 8) + x / 8] & (0x80u >> (x % 8)));
      const uint8_t bytes[4] = {color >> 16, color >> 8, color, opaque ? 255 : 0};
      CHECK(fwrite(bytes, 1, 4, stdout) == 4);
    }
}

static void limits_test(const uint8_t *data, size_t length)
{
  struct px_image image = {0};
  struct px_image_limits limits = {0};
  limits.max_input_bytes = length - 1;
  CHECK(px_image_decode(data, length, &limits, &image) == -EFBIG);
  limits.max_input_bytes = 0; limits.max_pixels = 1;
  CHECK(px_image_decode(data, length, &limits, &image) == -EFBIG);
  limits.max_pixels = 0; limits.max_dimension = 1;
  CHECK(px_image_decode(data, length, &limits, &image) == -EFBIG);
  limits.max_dimension = 0; limits.max_working_bytes = 1;
  CHECK(px_image_decode(data, length, &limits, &image) == -EFBIG);
  CHECK(!image.pixels && !image.alpha && !image.width && !image.height);
  if (px_image_sniff(data, length) == PX_IMAGE_GIF) {
    limits.max_working_bytes = 0; limits.max_frames = 1;
    struct px_gif *gif = NULL;
    CHECK(px_gif_open(data, length, &limits, &gif) == -EFBIG);
    CHECK(!gif);
  }
  CHECK(px_image_decode(NULL, length, NULL, &image) == -EINVAL);
  CHECK(px_image_decode(data, length, NULL, NULL) == -EINVAL);
  px_image_free(&image); px_image_free(&image); px_image_free(NULL); px_gif_close(NULL);
}

static void truncated_test(const uint8_t *data, size_t length)
{
  for (size_t count = 0; count < length; ++count) {
    struct px_image image = {0};
    const int result = px_image_decode(data, count, NULL, &image);
    if (result >= 0) fprintf(stderr, "截断在%zu/%zu被错误接受\n", count, length);
    CHECK(result < 0);
    CHECK(!image.pixels && !image.alpha && !image.width && !image.height);
  }
}

static void mutated_test(const uint8_t *data, size_t length)
{
  uint8_t *copy = malloc(length);
  CHECK(copy);
  uint32_t seed = 0x173159;
  const struct px_image_limits limits = {64 * 1024, 128 * 128, 512 * 1024, 128, 16};
  for (unsigned round = 0; round < 2000; ++round) {
    memcpy(copy, data, length);
    seed = seed * 1664525 + 1013904223;
    const size_t position = seed % length;
    seed = seed * 1664525 + 1013904223;
    copy[position] ^= (uint8_t)(1u << (seed % 8));
    struct px_image image = {0};
    (void)px_image_decode(copy, length, &limits, &image);
    px_image_free(&image);
    if (px_image_sniff(copy, length) == PX_IMAGE_GIF) {
      struct px_gif *gif = NULL;
      if (!px_gif_open(copy, length, &limits, &gif)) {
        unsigned frames = 0;
        while (px_gif_next(gif, &image) == 1) {
          CHECK(++frames <= 16);
          px_image_free(&image);
        }
        px_image_free(&image);
        px_gif_close(gif);
      }
    }
  }
  free(copy);
}

int main(int argc, char **argv)
{
  CHECK(argc >= 3);
  FILE *file = fopen(argv[2], "rb");
  CHECK(file && !fseek(file, 0, SEEK_END));
  const long file_size = ftell(file);
  CHECK(file_size > 0 && !fseek(file, 0, SEEK_SET));
  const size_t length = (size_t)file_size;
  uint8_t *data = malloc(length);
  CHECK(data && fread(data, 1, length, file) == length);
  fclose(file);
  int result = 0;
  if (!strcmp(argv[1], "limits")) limits_test(data, length);
  else if (!strcmp(argv[1], "truncated")) truncated_test(data, length);
  else if (!strcmp(argv[1], "mutated")) mutated_test(data, length);
  else if (!strcmp(argv[1], "gif")) {
    struct px_gif *gif = NULL;
    result = px_gif_open(data, length, NULL, &gif);
    if (!result) {
      struct px_image first = {0}, image = {0};
      result = px_gif_next(gif, &first);
      if (result == 1) {
        const uint32_t first_pixel = first.pixels[0];
        emit(&first);
        while ((result = px_gif_next(gif, &image)) == 1) {
          CHECK(first.pixels[0] == first_pixel);
          emit(&image);
          px_image_free(&image);
        }
        px_image_free(&first);
      }
      px_gif_close(gif);
    }
  } else {
    struct px_image image = {0};
    result = px_image_decode(data, length, NULL, &image);
    if (!result && argc == 4) result = px_image_apply_color_key(&image, strtoul(argv[3], NULL, 16));
    if (!result) emit(&image);
    px_image_free(&image);
  }
  free(data);
  if (result < 0) { fprintf(stderr, "image error: %d\n", result); return 1; }
  return 0;
}
