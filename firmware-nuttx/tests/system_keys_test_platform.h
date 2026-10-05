#ifndef PIXELBOX_SYSTEM_KEYS_TEST_PLATFORM_H
#define PIXELBOX_SYSTEM_KEYS_TEST_PLATFORM_H
#include "pixelbox_power.h"
#include <stdbool.h>
#include <stdint.h>
int px_keys_test_kthread_create(const char *name, int priority, int stack,
                                 int (*entry)(int, char **), char *const argv[]);
int pixelbox_board_button_read(unsigned index, bool *pressed);
int px_keys_test_power_poll(struct px_button_event *event);
void px_system_keys_test_inject(const struct px_button_event *event, uint64_t now);
#define kthread_create px_keys_test_kthread_create
#define px_power_poll_key px_keys_test_power_poll
#endif
