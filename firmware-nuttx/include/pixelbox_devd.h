#ifndef PIXELBOX_NUTTX_DEVD_H
#define PIXELBOX_NUTTX_DEVD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct px_devd;
struct px_devd_config {
  const char *storage_root; /* 默认 /data/apps，含 staging/current/prev。 */
  unsigned port; /* 0分配临时端口，产品传8765。 */
  const char *name,*model,*firmware,*ip,*mac;
  bool advertise; /* 显式启用局域网 mDNS；零初始化的宿主测试不发送组播。 */
  void (*notify_action)(void *opaque); /* 解锁后调用；不得阻塞或操作JSContext。 */
  void *opaque;
};
enum px_devd_action_type {PX_DEVD_RESTART=1,PX_DEVD_STOP,PX_DEVD_SETTINGS,PX_DEVD_EVAL,
  PX_DEVD_PUSH_PREPARE,PX_DEVD_PUSH_COMMIT,PX_DEVD_PUSH_ABORT};
struct px_devd_action {enum px_devd_action_type type;uint64_t token;char *code;};

/* 独立16KiB线程拥有网络、存储和JSON上下文，不依赖应用VM或NSH。
 * start会等到监听成功或真实失败；调用方负责网络和storage_root父目录就绪。
 * stop前停止外部消费者/日志生产者，stop join服务线程后销毁自身。 */
int px_devd_start(const struct px_devd_config *config,struct px_devd **out);
void px_devd_stop(struct px_devd *service);
unsigned px_devd_port(struct px_devd *service);
/* 线程安全纯C邮箱，1=取到，0=空；接收方必须action_free。
 * 由唯一启动监督器消费并管理应用，EVAL code/token可再转交VM的纯C邮箱。
 * eval仅在应用JSContext所属线程执行，再complete_eval；不能跨线程持JSValue。 */
int px_devd_take_action(struct px_devd *service,struct px_devd_action *out);
void px_devd_action_free(struct px_devd_action *action);
int px_devd_complete_eval(struct px_devd *service,uint64_t token,bool success,const char *text);
/* PREPARE 只携带纯 C token；监督者 stop/reap 旧 VM 后确认，devd 才能访问 staging。
 * COMMIT/ABORT 消费后 release；上传期间留一个控制邮箱槽，保证失败仍可恢复旧应用。 */
int px_devd_complete_push_pause(struct px_devd *service,uint64_t token,int error);
void px_devd_release_push(struct px_devd *service,uint64_t token);
/* 0=存在已提交应用，-ENOENT=尚无；输出均为NUL结尾，不截断。 */
int px_devd_current_app(struct px_devd *service,char *root,size_t root_capacity,
                        char *entry,size_t entry_capacity);
void px_devd_log(struct px_devd *service,const char *level,const char *tag,const char *message);
void px_devd_state(struct px_devd *service,const char *state,const char *error);
void px_devd_network(struct px_devd *service,const char *ip,const char *mac,size_t heap_free);
#endif
