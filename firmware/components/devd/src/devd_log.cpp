/* devd_log.cpp — 日志环形缓冲 + esp_log vprintf 钩子 */
#include "devd_log.hpp"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sys/time.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "hal_common/px_alloc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace devd_log {

namespace {

struct Entry {
    uint32_t seq;
    int64_t ts_ms;
    int8_t level;
    char tag[16];
    char *msg; /* PSRAM strdup */
};

std::mutex s_mutex;
Entry *s_ring;
int s_capacity;
int s_head;  /* 下一个写入位置 */
int s_count; /* 有效条目数 */
uint32_t s_seq;
void (*s_notify)();

vprintf_like_t s_orig_vprintf;
std::atomic<void *> s_hook_task{nullptr}; /* 递归保护 (同任务重入时跳过入环) */

int64_t now_ms()
{
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

char *psram_strdup(const char *s)
{
    size_t len = strlen(s) + 1;
    /* PSRAM 优先, 无 PSRAM 目标自动落内部堆 */
    char *p = (char *)px_alloc_prefer_psram(len);
    if (p) {
        memcpy(p, s, len);
    }
    return p;
}

const char *level_name(int8_t level)
{
    switch (level) {
    case 0:
        return "debug";
    case 2:
        return "warn";
    case 3:
        return "error";
    default:
        return "info";
    }
}

/**
 * 解析 ESP_LOG 行: "\x1b[0;32mI (306) main: message\x1b[0m\n"
 * 成功返回 true 并填充 level/tag/msg 起点。
 */
bool parse_esp_log_line(char *line, int *level, char *tag, size_t tag_len,
                        const char **msg)
{
    char *p = line;
    /* 跳过 ANSI 颜色前缀 */
    while (p[0] == '\x1b' && p[1] == '[') {
        char *m = strchr(p + 2, 'm');
        if (!m) {
            break;
        }
        p = m + 1;
    }
    int lv;
    switch (p[0]) {
    case 'V':
    case 'D':
        lv = 0;
        break;
    case 'I':
        lv = 1;
        break;
    case 'W':
        lv = 2;
        break;
    case 'E':
        lv = 3;
        break;
    default:
        return false;
    }
    if (p[1] != ' ' || p[2] != '(') {
        return false;
    }
    char *close = strchr(p + 3, ')');
    if (!close || close[1] != ' ') {
        return false;
    }
    char *tstart = close + 2;
    char *colon = strstr(tstart, ": ");
    if (!colon) {
        return false;
    }
    size_t tl = (size_t)(colon - tstart);
    if (tl >= tag_len) {
        tl = tag_len - 1; /* 超长 tag 截断 */
    }
    memcpy(tag, tstart, tl);
    tag[tl] = '\0';

    char *m = colon + 2;
    /* 去掉尾部 ANSI 复位与换行 */
    char *reset = strstr(m, "\x1b[0m");
    if (reset) {
        *reset = '\0';
    }
    size_t ml = strlen(m);
    while (ml > 0 && (m[ml - 1] == '\n' || m[ml - 1] == '\r')) {
        m[--ml] = '\0';
    }
    *level = lv;
    *msg = m;
    return true;
}

int vprintf_hook(const char *fmt, va_list args)
{
    /* 1. 原样输出到串口 */
    int ret = 0;
    if (s_orig_vprintf) {
        va_list copy;
        va_copy(copy, args);
        ret = s_orig_vprintf(fmt, copy);
        va_end(copy);
    }

    /* 2. 递归保护: 入环过程中产生的日志只打串口 */
    void *self = xTaskGetCurrentTaskHandle();
    if (s_hook_task.load() == self) {
        return ret;
    }
    s_hook_task.store(self);

    char buf[512];
    va_list copy2;
    va_copy(copy2, args);
    vsnprintf(buf, sizeof(buf), fmt, copy2);
    va_end(copy2);

    int level = 1;
    char tag[16] = "sys";
    const char *msg = buf;
    if (parse_esp_log_line(buf, &level, tag, sizeof(tag), &msg)) {
        /* console.* 已通过 jsvm LogSink 结构化入环, 跳过 tag="js" 避免重复 */
        if (strcmp(tag, "js") != 0) {
            push(level, tag, msg);
        }
    } else {
        /* 非标准格式 (裸 printf 等): 原样入环 */
        size_t ml = strlen(buf);
        while (ml > 0 && (buf[ml - 1] == '\n' || buf[ml - 1] == '\r')) {
            buf[--ml] = '\0';
        }
        if (ml > 0) {
            push(1, "sys", buf);
        }
    }

    s_hook_task.store(nullptr);
    return ret;
}

} // namespace

void init()
{
    std::lock_guard<std::mutex> lk(s_mutex);
    if (s_ring) {
        return;
    }
    s_capacity = CONFIG_DEVD_LOG_RING;
    s_ring = (Entry *)px_calloc_prefer_psram(s_capacity, sizeof(Entry));
    s_head = 0;
    s_count = 0;
    s_seq = 0;
}

void install_vprintf_hook()
{
    if (!s_orig_vprintf) {
        s_orig_vprintf = esp_log_set_vprintf(vprintf_hook);
    }
}

void push(int level, const char *tag, const char *msg)
{
    if (!msg) {
        return;
    }
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        if (!s_ring) {
            return;
        }
        Entry &e = s_ring[s_head];
        if (e.msg) {
            free(e.msg); /* 覆盖最旧条目 */
        }
        e.seq = ++s_seq;
        e.ts_ms = now_ms();
        e.level = (int8_t)level;
        snprintf(e.tag, sizeof(e.tag), "%s", tag ? tag : "sys");
        e.msg = psram_strdup(msg);
        s_head = (s_head + 1) % s_capacity;
        if (s_count < s_capacity) {
            s_count++;
        }
    }
    if (s_notify) {
        s_notify();
    }
}

uint32_t collect_json(uint32_t since_seq, std::vector<std::string> &out)
{
    std::lock_guard<std::mutex> lk(s_mutex);
    if (!s_ring || s_count == 0) {
        return s_seq;
    }
    int start = (s_head - s_count + s_capacity) % s_capacity;
    for (int i = 0; i < s_count; i++) {
        Entry &e = s_ring[(start + i) % s_capacity];
        if (!e.msg || e.seq <= since_seq) {
            continue;
        }
        cJSON *root = cJSON_CreateObject();
        cJSON_AddStringToObject(root, "event", "log");
        cJSON *data = cJSON_AddObjectToObject(root, "data");
        cJSON_AddStringToObject(data, "level", level_name(e.level));
        cJSON_AddStringToObject(data, "tag", e.tag);
        cJSON_AddStringToObject(data, "msg", e.msg);
        cJSON_AddNumberToObject(data, "ts", (double)e.ts_ms);
        cJSON_AddNumberToObject(data, "seq", (double)e.seq);
        char *json = cJSON_PrintUnformatted(root);
        cJSON_Delete(root);
        if (json) {
            out.emplace_back(json);
            cJSON_free(json);
        }
    }
    return s_seq;
}

uint32_t last_seq()
{
    std::lock_guard<std::mutex> lk(s_mutex);
    return s_seq;
}

void set_notify(void (*fn)())
{
    s_notify = fn;
}

} // namespace devd_log
