/**
 * appmgr/appmgr.h — 应用包管理公开接口
 *
 * 职责:
 *   - littlefs 挂载 /flash, 初始化 /flash/data 与 /flash/apps 目录
 *   - 应用包加载 (manifest.json + main.js), 无应用时运行内置欢迎应用
 *   - /data 与 /app 虚拟路径映射 (供 bindings_periph 的 px.storage.fs 使用)
 *   - 热更新: staging 落盘 → 校验 → 原子切换 → 仅重启 JS VM
 *
 * 线程安全: staging_* 系列约定由单一调用方 (devd) 串行使用;
 *           resolve/manifest/state 可从任意线程调用。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** 当前应用 manifest 摘要 (来自 pixelbox.json) */
typedef struct {
    char id[64];
    char name[64];
    char version[24];
    char entry[64]; /*!< 入口文件, 默认 "main.js" */
} appmgr_manifest_t;

/** 应用状态 (devd app.state 事件语义) */
typedef enum {
    APPMGR_STATE_STOPPED = 0,
    APPMGR_STATE_RUNNING,
    APPMGR_STATE_UPDATING,
    APPMGR_STATE_CRASHED,
} appmgr_state_t;

/**
 * 初始化: 挂载 littlefs → 建目录 → 注册 jsvm 入口提供者与状态监听。
 * 必须在 jsvm::start() 之前调用。
 */
esp_err_t appmgr_init(void);

/**
 * 读取当前应用 manifest。
 * @return true = 存在用户应用; false = 无用户应用 (运行内置欢迎应用,
 *         out 中填充内置应用信息)
 */
bool appmgr_current_manifest(appmgr_manifest_t *out);

/**
 * 虚拟路径解析: "/data/…" → "/flash/data/…", "/app/…" → "/flash/apps/current/…"。
 * 拒绝 ".." 越界与未知前缀 (返回 ESP_ERR_INVALID_ARG)。
 */
esp_err_t appmgr_resolve_path(const char *virt, char *out, size_t out_len);

/* ---------------- 热更新 staging (devd push 流程) ---------------- */

/** 开始接收新包: 清空 staging 目录并写入 manifest.json (原文) */
esp_err_t appmgr_staging_begin(const char *manifest_json);

/** 写入文件分块 (rel_path 为包内相对路径, offset 为字节偏移) */
esp_err_t appmgr_staging_write(const char *rel_path, uint32_t offset,
                               const void *data, size_t len);

/** 校验单个文件: 大小 + SHA-256 */
esp_err_t appmgr_staging_verify_file(const char *rel_path, uint32_t size,
                                     const uint8_t sha256[32]);

/** 提交: 原子切换 staging → current, 并热重启 JS VM */
esp_err_t appmgr_staging_commit(void);

/** 放弃本次推送, 清理 staging */
void appmgr_staging_abort(void);

/* ---------------- 生命周期 ---------------- */

/** 卸载已推送的应用 (删除 current/prev 包) 并热重启回欢迎页 */
esp_err_t appmgr_uninstall_app(void);

/** 打开内置设置页 (入口切换 + VM 热重启; 幂等) */
void appmgr_open_settings(void);

/** 关闭设置页回到当前应用/欢迎页 (幂等) */
void appmgr_close_settings(void);

/** 当前是否在设置页 */
bool appmgr_in_settings(void);

/** 热重启 JS VM (重新加载当前应用) */
void appmgr_restart_app(void);

/** 停止应用 (JS VM 停止, 固件保持运行等待新包) */
void appmgr_stop_app(void);

appmgr_state_t appmgr_get_state(void);

/** 状态名 ("running"/"stopped"/"updating"/"crashed") */
const char *appmgr_state_name(appmgr_state_t st);

/** 状态变化回调 (devd 订阅; error 可为 NULL; 回调可能来自任意线程) */
typedef void (*appmgr_state_cb_t)(appmgr_state_t state, const char *error);
void appmgr_on_state(appmgr_state_cb_t cb);

#ifdef __cplusplus
}
#endif
