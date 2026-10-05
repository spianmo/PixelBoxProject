#ifndef PIXELBOX_PORTAL_STACK_PROBE_H
#define PIXELBOX_PORTAL_STACK_PROBE_H
#include <pthread.h>
#include <stddef.h>
size_t px_test_portal_worker_stack(void *(*entry)(void *));
int px_stack_probe_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *, size_t);
int px_stack_probe_join(pthread_t, void **);
#endif
