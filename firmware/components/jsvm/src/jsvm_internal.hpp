/**
 * jsvm_internal.hpp — jsvm 组件内部接口 (勿被组件外引用)
 */
#pragma once

#include "jsvm/jsvm.hpp"

namespace jsvm {
namespace internal {

/* ---- js_std.cpp: 标准全局 (console/定时器/微任务/performance native 钩子) ---- */

/** VM 启动时安装标准全局 */
void install_std_globals(JSContext *ctx);

/** VM 拆除时释放标准全局持有的资源 (定时器 JSValue 等) */
void reset_std_state(JSContext *ctx);

/** 下一个定时器到期时刻 (esp_timer 微秒); 无定时器返回 -1 */
int64_t next_timer_deadline_us();

/** 执行所有到期定时器 (仅 JS 线程) */
void run_due_timers(JSContext *ctx);

/** 日志分发: 输出 ESP_LOG 并转发给已注册 sink (level: 0..3) */
void dispatch_log(int level, const char *tag, const char *msg);

} // namespace internal
} // namespace jsvm
