#ifndef PIXELBOX_WAKEWORD_H
#define PIXELBOX_WAKEWORD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum px_wakeword_event_kind { PX_WAKEWORD_READY = 1, PX_WAKEWORD_DETECTED, PX_WAKEWORD_ERROR };
struct px_wakeword_event { uint32_t job_id; int kind, error; float probability; };
bool px_wakeword_available(void);
bool px_wakeword_busy(void);
int px_wakeword_start(const char *pinyin, float threshold, uint32_t *job_id);
int px_wakeword_feed(uint32_t job_id, const uint8_t *pcm16le, size_t bytes);
int px_wakeword_poll(struct px_wakeword_event *event);
void px_wakeword_stop(uint32_t job_id); /* 0 停止全部；不取消仍持有模型的线程。 */
int px_wakeword_quiesce(unsigned timeout_ms);
#endif
