#ifndef PIXELBOX_NUTTX_SERVICE_H
#define PIXELBOX_NUTTX_SERVICE_H

#include "pixelbox.h"
#include "pixelbox_devd.h"
#include "pixelbox_portal.h"
#include <stdbool.h>
#include <stdint.h>

#ifdef __NuttX__
#include <nuttx/config.h>
/* VM 与 NSH 命令共用同一栈配置，QuickJS 的栈上限由 runtime 按一半设置。 */
#define PX_SERVICE_APP_STACK_BYTES CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE
#else
#define PX_SERVICE_APP_STACK_BYTES (32u * 1024u)
#endif
#define PX_SERVICE_HOST_STACK_BYTES (1024u * 1024u)
#define PX_SERVICE_EVAL_CAPACITY 8u

struct px_service;
struct px_service_vm;
struct px_service_network { char ip[64], mac[32]; size_t heap_free; };
struct px_service_config {
  struct px_devd_config devd; /* notify_action/opaque由监督者接管。 */
  struct px_options app; /* 仅作运行参数模板；current优先，app_root非NULL可作无current时回退。 */
  int (*run_app)(const struct px_options *options); /* 通常为px_run，只在独立app任务调用。 */
  bool start_on_boot;
  int app_priority; /* NuttX任务优先级，0使用100。 */
  /* 监督线程启动即读、随后最多每秒一次；只读缓存/统计，不得阻塞、等待网络或调用JS。
   * 返回0更新devd hello，负值保留上次值；opaque需活到destroy结束。
   */
  int (*network_status)(void *opaque, struct px_service_network *out);
  void *network_opaque;
  /* 默认关闭。还需编译 PX_SERVICE_PORTAL；未编译时 enable 返回 -ENOTSUP。
   * run 在常驻任务初始化门户；成功后才开放系统配网键。
   * credentials_path 在 create 时复制；不要另外初始化门户 singleton。
   */
  bool enable_portal;
  struct px_portal_config portal;
  /* 默认 NULL。VM/门户回收后只检查是否可睡，失败不销毁 devd。
   * 必须有界且无副作用；真正睡眠由 run 返回并销毁 devd 后的调用方执行。 */
  int (*prepare_sleep)(void *opaque, uint32_t duration_ms);
  void *sleep_opaque;
};
struct px_service_status {
  bool supervising, shutting_down, app_present, vm_active, app_stopping;
  uint64_t generation;
  int last_app_result;
  bool portal_enabled, portal_pending, portal_owned;
  enum px_portal_phase portal_phase;
  int portal_error;
  uint32_t sleep_duration_ms;
  bool sleep_ready;
  int sleep_error;
};
struct px_service_eval { uint64_t token; char *code; };

/* 一个进程/固件只允许一个监督者。create启动devd；run由8KiB boot任务常驻调用。
 * run是唯一devd动作消费者，应用使用独立64KiB NuttX task，host pthread至少1MiB。
 * 无current且无回退app_root时保持空闲，仍可响应后续push/restart。
 */
int px_service_create(const struct px_service_config *config, struct px_service **out);
int px_service_run(struct px_service *service);
void px_service_request_shutdown(struct px_service *service); /* 线程安全、只请求协作退出。 */
int px_service_destroy(struct px_service *service); /* run结束并join监督线程后调用；运行中返回-EBUSY。 */
unsigned px_service_port(struct px_service *service);
int px_service_get_status(struct px_service *service, struct px_service_status *out);
/* run 返回后读取一次性睡眠授权；先成功 destroy，再关闭 mDNS 并进入平台睡眠。 */
int px_service_take_sleep(struct px_service *service, uint32_t *duration_ms);

/* runtime在本线程进入px_run后获取一次；非托管NSH诊断VM得到NULL，不抢动作。
 * vm句柄只在run_app调用期间有效，不能保存到其它线程或下一代VM。
 * 本接口不使用pthread TLS，兼容当前CONFIG_TLS_NELEM=0。
 */
struct px_service_vm *px_service_vm_current(void);
int px_service_vm_enter(struct px_service_vm *vm); /* JSContext就绪后标记active；NULL为无操作。 */
void px_service_vm_leave(struct px_service_vm *vm); /* JS清理结束后调用；wrapper还会兜底执行。 */
bool px_service_vm_should_stop(const struct px_service_vm *vm); /* 中断回调只读atomic标记，无锁。 */
int px_service_vm_request_sleep(struct px_service_vm *vm, uint32_t duration_ms);
int px_service_vm_take_eval(struct px_service_vm *vm, struct px_service_eval *out); /* 1/0/负errno；VM线程专用。 */
void px_service_eval_free(struct px_service_eval *request); /* take后由VM释放code。 */
int px_service_vm_complete_eval(struct px_service_vm *vm, uint64_t token,
                               bool success, const char *text); /* 同步复制text，不传JSValue。 */
void px_service_vm_abandon_eval(struct px_service_vm *vm, uint64_t token); /* 错误文本也无法提交时清除inflight，防止永久EBUSY。 */
void px_service_vm_log(struct px_service_vm *vm, const char *level,
                       const char *tag, const char *message); /* 同步复制，NULL句柄为无操作。 */

#endif
