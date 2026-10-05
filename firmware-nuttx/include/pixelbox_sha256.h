#ifndef PIXELBOX_NUTTX_SHA256_H
#define PIXELBOX_NUTTX_SHA256_H
#include <stddef.h>
#include <stdint.h>
struct px_sha256_state {uint32_t state[8];uint64_t bytes;uint8_t block[64];size_t used;};
void px_sha256_init(struct px_sha256_state *state);
void px_sha256_update(struct px_sha256_state *state,const void *bytes,size_t length);
void px_sha256_final(struct px_sha256_state *state,uint8_t digest[32]);
void px_sha256(const uint8_t *data,size_t length,uint8_t out[32]);
#endif
