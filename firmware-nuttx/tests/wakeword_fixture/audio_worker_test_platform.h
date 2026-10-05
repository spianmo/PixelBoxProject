#ifndef PX_WAKEWORD_TEST_PLATFORM_H
#define PX_WAKEWORD_TEST_PLATFORM_H
int kthread_create(const char *, int, int, int (*)(int, char **), char *const []);
#endif
