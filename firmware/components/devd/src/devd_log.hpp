/**
 * devd_log.hpp — 日志环形缓冲 (devd 组件内部)
 *
 * 汇聚两路日志:
 *   1) jsvm LogSink (console.* 结构化输出, tag="js")
 *   2) esp_log vprintf 钩子 (全部 ESP_LOG, 解析出 level/tag/msg;
 *      tag=="js" 的行跳过, 避免与 1) 重复)
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace devd_log {

/** 初始化环形缓冲 (容量 CONFIG_DEVD_LOG_RING) */
void init();

/** 安装 esp_log vprintf 钩子 (原始输出仍照常打到串口) */
void install_vprintf_hook();

/** 追加一条结构化日志 (线程安全); level: 0=debug 1=info 2=warn 3=error */
void push(int level, const char *tag, const char *msg);

/**
 * 收集 seq > since_seq 的条目, 每条格式化为 devd 协议事件 JSON:
 *   {"event":"log","data":{"level":"info","tag":"js","msg":"...","ts":123}}
 * @return 收集后最新 seq
 */
uint32_t collect_json(uint32_t since_seq, std::vector<std::string> &out);

/** 当前最新 seq (0 = 无日志) */
uint32_t last_seq();

/** 新日志到达通知 (必须非阻塞; 从任意任务上下文调用) */
void set_notify(void (*fn)());

} // namespace devd_log
