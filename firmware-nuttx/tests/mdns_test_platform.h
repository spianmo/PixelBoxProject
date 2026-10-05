#ifndef PIXELBOX_MDNS_TEST_PLATFORM_H
#define PIXELBOX_MDNS_TEST_PLATFORM_H
int px_test_kthread_create(const char *name, int priority, int stack_size,
                           int (*entry)(int, char **), char *const arguments[]);
#define kthread_create px_test_kthread_create
#endif
