"""独立音频任务/健康进度替身；主机线程不冒充真实 NuttX task group 验证。"""

HEADER = r'''
#ifndef AUDIO_WORKER_TEST_PLATFORM_H
#define AUDIO_WORKER_TEST_PLATFORM_H
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
typedef int (*main_t)(int, char **);
int kthread_create(const char *, int, int, main_t, char * const []);
extern atomic_int test_worker_create_error, test_worker_register_error;
struct test_worker_status {
  unsigned registered, active, beats, ends, created, stack;
  uint64_t progress_ms;
};
struct test_worker_status test_worker_snapshot(void);
bool test_worker_is_task(void);
#endif
'''

SOURCE = r'''
#include "audio_worker_test_platform.h"
#include "pixelbox_watchdog.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

atomic_int test_worker_create_error, test_worker_register_error;
static pthread_mutex_t worker_lock = PTHREAD_MUTEX_INITIALIZER;
static struct test_worker_status status;
static bool registered, active;
static uint32_t current_handle;
static _Thread_local bool independent;

static uint64_t milliseconds(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}
struct test_worker_status test_worker_snapshot(void) {
  pthread_mutex_lock(&worker_lock);
  struct test_worker_status value = status;
  pthread_mutex_unlock(&worker_lock); return value;
}
bool test_worker_is_task(void) { return independent; }
struct task_entry { main_t main; };
static void *run_task(void *data) {
  struct task_entry *entry = data; main_t fn = entry->main; free(entry);
  independent = true; fn(0, NULL); return NULL;
}
int kthread_create(const char *name, int priority, int stack, main_t entry,
                    char * const argv[]) {
  assert(!strcmp(name,"px-audio") || !strcmp(name,"px-mic"));
  assert(priority==110 && (stack==8192 || stack==32768) && !argv);
  /* NuttX kthread 直接返回负 errno；污染 errno 确认生产代码不误读它。 */
  if(test_worker_create_error) { errno=EDOM; return test_worker_create_error; }
  struct task_entry *data = malloc(sizeof(*data)); assert(data); data->main=entry;
  pthread_t thread; pthread_attr_t attr; pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr,PTHREAD_CREATE_DETACHED);
  int error=pthread_create(&thread,&attr,run_task,data);pthread_attr_destroy(&attr);
  if(error){free(data);return -error;}
  pthread_mutex_lock(&worker_lock);
  ++status.created;status.stack=(unsigned)stack;
  pthread_mutex_unlock(&worker_lock);return 100;
}
int px_watchdog_register(uint32_t *handle) {
  assert(independent);
  if(test_worker_register_error)return test_worker_register_error;
  pthread_mutex_lock(&worker_lock);assert(!registered);
  registered=true;active=false;*handle=++current_handle;++status.registered;
  pthread_mutex_unlock(&worker_lock);return 0;
}
int px_watchdog_begin(uint32_t handle) {
  assert(independent);pthread_mutex_lock(&worker_lock);
  assert(registered&&handle==current_handle&&!active);active=true;
  ++status.active;status.progress_ms=milliseconds();
  pthread_mutex_unlock(&worker_lock);return 0;
}
int px_watchdog_beat(uint32_t handle) {
  assert(independent);pthread_mutex_lock(&worker_lock);
  assert(registered&&handle==current_handle&&active);++status.beats;
  status.progress_ms=milliseconds();pthread_mutex_unlock(&worker_lock);return 0;
}
int px_watchdog_end(uint32_t handle) {
  assert(independent);pthread_mutex_lock(&worker_lock);
  assert(registered&&handle==current_handle&&active);active=false;
  --status.active;++status.ends;pthread_mutex_unlock(&worker_lock);return 0;
}
int px_watchdog_unregister(uint32_t handle) {
  assert(independent);pthread_mutex_lock(&worker_lock);
  assert(registered&&handle==current_handle&&!active);registered=false;
  --status.registered;pthread_mutex_unlock(&worker_lock);return 0;
}
'''
