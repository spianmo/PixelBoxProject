/* 此替身只验证真实worker的异步边界；不会把预设候选称作实际语音识别。 */
#include "pixelbox_wakeword.h"
#include "pixelbox_mn7_abi.h"
#include "pixelbox_mn7_memory.h"
#include "wakeword_memory_backend.h"
#include "pixelbox_watchdog.h"
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char *scenario;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static bool blocked, release_detect;
static int created, destroyed, detected, cleans, registers, unregisters, beats, launches;
static int token;
static esp_mn_results_t results;
static bool mode(const char *name) { return !strcmp(scenario,name); }

int px_watchdog_register(uint32_t *id) { if (mode("watchdog")) return -ENOSPC; ++registers; *id = 1; return 0; }
int px_watchdog_begin(uint32_t id) { assert(id == 1); return 0; }
int px_watchdog_beat(uint32_t id) { assert(id == 1); pthread_mutex_lock(&lock); ++beats; pthread_mutex_unlock(&lock); return 0; }
int px_watchdog_end(uint32_t id) { assert(id == 1); return 0; }
int px_watchdog_unregister(uint32_t id) { assert(id == 1); ++unregisters; return 0; }
struct launch { int (*entry)(int,char **); };
static void *run(void *p) { struct launch job = *(struct launch *)p; free(p); job.entry(0,NULL); return NULL; }
int kthread_create(const char *name,int priority,int stack,int (*entry)(int,char **),char *const args[])
{
  assert(!strcmp(name,"px-wakeword") && priority == 105 && stack >= 32768 && !args);
  ++launches;
  if (mode("launch")) { errno = EDOM; return -EAGAIN; }
  struct launch *job = malloc(sizeof(*job)); assert(job); job->entry = entry;
  pthread_t thread; assert(!pthread_create(&thread,NULL,run,job)); assert(!pthread_detach(thread)); return 42;
}
int px_mn7_model_builtin(void) { return mode("model") ? -EBADMSG : 0; }
void px_mn7_model_unload(void) {}
void px_mn7_model_forget(void) {}
static model_iface_data_t *create(const char *name,int duration)
{
  assert(!strcmp(name,"mn7_cn") && duration == 6000); ++created;
  if (mode("oom_create")) {
    /* 与已反汇编的 fst_state_alloc 相同：不检查NULL，guard必须先退出。 */
    int *p=px_mn7_malloc(PX_MN7_WORKSPACE_BYTES); *p=1; abort();
  }
  return mode("create") ? NULL : (model_iface_data_t *)&token;
}
static void destroy(model_iface_data_t *m) { assert(m == (model_iface_data_t *)&token); ++destroyed; esp_mn_commands_free(); }
static int rate(model_iface_data_t *m) { (void)m; return mode("rate") ? 8000 : 16000; }
static int chunk(model_iface_data_t *m) { (void)m; return mode("chunk") ? 4097 : 160; }
static int threshold(model_iface_data_t *m,float value) { (void)m; assert(value == .6f); return mode("threshold") ? -1 : 0; }
static int check(model_iface_data_t *m,const char *s) { (void)m; assert(!strcmp(s,"ni hao")); return !mode("command"); }
static esp_mn_error_t *commands(model_iface_data_t *m,esp_mn_node_t *node)
{
  (void)m; static esp_mn_error_t ok;
  assert(node && node->next && node->next->phrase->command_id == 1 && !node->next->next);
  return &ok;
}
static void clean(model_iface_data_t *m) { (void)m; pthread_mutex_lock(&lock); ++cleans; pthread_mutex_unlock(&lock); }
static esp_mn_results_t *get_results(model_iface_data_t *m) { (void)m; return &results; }
static esp_mn_state_t detect(model_iface_data_t *m,int16_t *pcm)
{
  (void)m;
  pthread_mutex_lock(&lock); ++detected;
  if ((mode("blocked") || mode("backlog")) && detected == 1) {
    blocked = true; pthread_cond_broadcast(&changed);
    while (!release_detect) pthread_cond_wait(&changed,&lock);
  }
  int calls = detected; pthread_cond_broadcast(&changed); pthread_mutex_unlock(&lock);
  if (mode("oom_detect")) {
    int *p=px_mn7_malloc(PX_MN7_WORKSPACE_BYTES); *p=1; abort();
  }
  if (mode("candidate")) {
    results.num = 1; results.command_id[0] = calls == 1 ? 2 : 1;
    results.prob[0] = calls == 2 ? NAN : calls == 3 ? .59f : .8f;
    return ESP_MN_STATE_DETECTED;
  }
  if (mode("terminal_wake") || mode("terminal_cancel")) {
    results.num = 1; results.command_id[0] = 1; results.prob[0] = .8f;
    return ESP_MN_STATE_DETECTED;
  }
  if (mode("terminal_error")) return (esp_mn_state_t)99;
  if (mode("preroll")) assert(pcm[0] == 0 || pcm[0] == 1000);
  return ESP_MN_STATE_DETECTING;
}
const esp_mn_iface_t esp_sr_multinet7_quantized = {
  .create=create,.destroy=destroy,.get_samp_rate=rate,.get_samp_chunksize=chunk,
  .set_det_threshold=threshold,.check_speech_command=check,.set_speech_commands=commands,
  .detect=detect,.get_results=get_results,.clean=clean
};
static struct px_wakeword_event next_event(int kind)
{
  struct px_wakeword_event event;
  for (int i = 0; i < 3000; ++i) {
    int r = px_wakeword_poll(&event); assert(r >= 0);
    if (r) { assert(event.kind == kind); return event; }
    usleep(1000);
  }
  fprintf(stderr,"event wait timeout: %s\n",scenario); abort();
}
static void feed(uint32_t id,int value,size_t samples)
{
  uint8_t bytes[16384]; assert(samples <= 8192);
  for (size_t i = 0; i < samples; ++i) { bytes[i*2] = value & 255; bytes[i*2+1] = ((unsigned)value >> 8) & 255; }
  assert(!px_wakeword_feed(id,bytes,samples*2));
}
static int read_counter(int *counter) { pthread_mutex_lock(&lock); int n=*counter; pthread_mutex_unlock(&lock); return n; }
static bool is_blocked(void) { pthread_mutex_lock(&lock); bool b=blocked; pthread_mutex_unlock(&lock); return b; }
static void await_calls(int count)
{
  for (int i=0;i<2000;++i) { if (read_counter(&detected) >= count) return; usleep(1000); }
  abort();
}
static void unblock(void) { pthread_mutex_lock(&lock); release_detect = true; pthread_cond_broadcast(&changed); pthread_mutex_unlock(&lock); }
int main(int argc,char **argv)
{
  assert(argc == 2); scenario = argv[1]; uint32_t id=0;
  const char *requested=scenario;
  assert(px_wakeword_available());
  assert(px_wakeword_start(" ni hao",.6f,&id) == -EINVAL);
  assert(px_wakeword_start("ni  hao",.6f,&id) == -EINVAL);
  assert(px_wakeword_start("ni hao",NAN,&id) == -EINVAL);
  int result = px_wakeword_start("ni hao",.6f,&id);
  if (mode("launch")) { assert(result == -EAGAIN && !px_wakeword_busy() && launches == 1); goto pass; }
  assert(!result && id && launches == 1);
  if (mode("oom_create") || mode("oom_detect")) {
    bool during_detect=mode("oom_detect");
    for (int attempt=0;attempt<3;++attempt) {
      if (during_detect) { next_event(PX_WAKEWORD_READY); feed(id,1000,160); }
      assert(next_event(PX_WAKEWORD_ERROR).error==-ENOMEM);
      assert(!px_wakeword_quiesce(2000) && !px_test_backing_live && !px_test_internal_live);
      px_wakeword_stop(id); assert(!px_wakeword_quiesce(2000));
      if (attempt<2) assert(!px_wakeword_start("ni hao",.6f,&id));
    }
    /* 完整构造或检测后OOM都不能调用半初始化对象destroy；随后正常启动/停止。 */
    assert(created==3 && destroyed==0 && registers==unregisters);
    scenario="cancel"; assert(!px_wakeword_start("ni hao",.6f,&id));
    next_event(PX_WAKEWORD_READY); px_wakeword_stop(id); assert(!px_wakeword_quiesce(2000));
    assert(created==4 && destroyed==1 && !px_test_backing_live); goto pass;
  }
  if (mode("cancel")) { px_wakeword_stop(id); assert(!px_wakeword_quiesce(2000)); struct px_wakeword_event e; assert(!px_wakeword_poll(&e)); goto finish; }
  int error = mode("watchdog") ? -ENOSPC : mode("model") ? -EBADMSG : mode("create") ? -ENOMEM :
              (mode("rate") || mode("chunk")) ? -EPROTO : (mode("command") || mode("threshold")) ? -EINVAL : 0;
  if (error) { struct px_wakeword_event e=next_event(PX_WAKEWORD_ERROR); assert(e.error == error); goto finish; }
  assert(next_event(PX_WAKEWORD_READY).job_id == id);
  if (mode("terminal_wake") || mode("terminal_error") || mode("terminal_cancel")) {
    feed(id,1000,160); assert(!px_wakeword_quiesce(2000));
    /* 终止事件尚未轮询时送入尾帧，必须保留事件，不向micHub伪报ECANCELED。 */
    uint8_t bytes[320] = {0};
    assert(!px_wakeword_feed(id,bytes,sizeof(bytes)));
    assert(px_wakeword_feed(id + 1,bytes,sizeof(bytes)) == -ECANCELED);
    if (mode("terminal_cancel")) {
      px_wakeword_stop(id);
      struct px_wakeword_event e; assert(!px_wakeword_poll(&e));
    } else {
      struct px_wakeword_event e=next_event(mode("terminal_error") ? PX_WAKEWORD_ERROR : PX_WAKEWORD_DETECTED);
      assert(e.job_id == id && e.error == (mode("terminal_error") ? -EPROTO : 0));
      if (mode("terminal_wake")) assert(e.probability == .8f);
    }
    assert(px_wakeword_feed(id,bytes,sizeof(bytes)) == -ECANCELED); goto finish;
  }
  if (mode("timeout")) { assert(next_event(PX_WAKEWORD_ERROR).error == -ETIMEDOUT); goto finish; }
  if (mode("candidate")) {
    for (int i=1;i<=4;++i) { feed(id,-1234,160); await_calls(i); }
    struct px_wakeword_event e=next_event(PX_WAKEWORD_DETECTED); assert(e.probability == .8f); assert(detected == 4 && cleans == 3); goto finish;
  }
  if (mode("blocked") || mode("backlog")) {
    feed(id,0,160);
    for (int i=0;i<1000 && !is_blocked();++i) usleep(1000);
    pthread_mutex_lock(&lock); assert(blocked); int previous_beats = beats; pthread_mutex_unlock(&lock);
    if (mode("blocked")) {
      px_wakeword_stop(id); assert(px_wakeword_quiesce(10) == -ETIMEDOUT);
      assert(px_wakeword_busy() && !destroyed && read_counter(&beats) == previous_beats);
      unblock(); assert(!px_wakeword_quiesce(2000)); goto finish;
    }
    feed(id,10,8192); feed(id,20,8192); unblock(); await_calls(2); assert(read_counter(&cleans) >= 1);
  }
  if (mode("preroll")) {
    for (int i=1;i<=50;++i) { feed(id,0,160); await_calls(i); }
    feed(id,1000,160); await_calls(71); assert(read_counter(&cleans) == 1);
  }
  if (mode("stale")) {
    px_wakeword_stop(id); assert(!px_wakeword_quiesce(2000));
    uint32_t second; assert(!px_wakeword_start("ni hao",.6f,&second)); assert(second != id);
    next_event(PX_WAKEWORD_READY); uint8_t bytes[320]={0}; assert(px_wakeword_feed(id,bytes,sizeof(bytes)) == -ECANCELED);
    px_wakeword_stop(id); assert(px_wakeword_busy()); id=second;
  }
  px_wakeword_stop(id); assert(!px_wakeword_quiesce(2000));
finish:
  assert(!px_wakeword_quiesce(2000)); assert(!px_wakeword_busy());
  assert(registers == unregisters);
  assert(!px_test_backing_live && !px_test_internal_live);
  if (!mode("create")) assert(created == destroyed);
pass:
  printf("PASS wakeword %s (worker contract only)\n",requested); return 0;
}
