/**
 * appmgr.cpp — littlefs 挂载 / 应用包加载 / 热更新 staging 原子切换 / VM 热重启编排
 *
 * 目录约定 (architecture.md §4.3):
 *   /flash/data          → px.storage.fs 的 /data
 *   /flash/apps/current  → 当前应用包 (manifest.json + main.js + assets/…)
 *   /flash/apps/staging  → 推送中的新包
 *   /flash/apps/prev     → 上一版本 (原子切换时保留一份)
 */
#include "appmgr/appmgr.h"

#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "mbedtls/sha256.h"

#include "jsvm/jsvm.hpp"

static const char *TAG = "appmgr";

#define FLASH_BASE   "/flash"
#define DATA_DIR     "/flash/data"
#define APPS_DIR     "/flash/apps"
#define CURRENT_DIR  "/flash/apps/current"
#define STAGING_DIR  "/flash/apps/staging"
#define PREV_DIR     "/flash/apps/prev"

/* 内置欢迎应用 / 设置页 (EMBED_TXTFILES, NUL 结尾) */
extern const char _binary_default_app_js_start[];
extern const char _binary_settings_app_js_start[];

namespace {

std::mutex s_mutex;
appmgr_manifest_t s_manifest = {};
bool s_has_app = false;
bool s_staging_active = false;
bool s_settings_mode = false;  /* true = 入口切到内置设置页 (系统按键切换) */

appmgr_state_t s_state = APPMGR_STATE_STOPPED;
constexpr int kMaxStateCbs = 4;
appmgr_state_cb_t s_state_cbs[kMaxStateCbs] = {};

/* ------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------ */

bool path_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

bool is_dir(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

esp_err_t ensure_dir(const char *path)
{
    if (is_dir(path)) {
        return ESP_OK;
    }
    if (mkdir(path, 0777) != 0 && !is_dir(path)) {
        ESP_LOGE(TAG, "mkdir 失败: %s", path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

/** 递归创建 path 的父目录 (path 本身是文件) */
esp_err_t ensure_parent_dirs(const std::string &path)
{
    size_t pos = strlen(FLASH_BASE) + 1; /* 跳过挂载点 */
    for (;;) {
        pos = path.find('/', pos);
        if (pos == std::string::npos) {
            break;
        }
        std::string dir = path.substr(0, pos);
        esp_err_t err = ensure_dir(dir.c_str());
        if (err != ESP_OK) {
            return err;
        }
        pos++;
    }
    return ESP_OK;
}

/** 递归删除目录 (或文件) */
void remove_recursive(const char *path)
{
    struct stat st;
    if (stat(path, &st) != 0) {
        return;
    }
    if (!S_ISDIR(st.st_mode)) {
        unlink(path);
        return;
    }
    DIR *dir = opendir(path);
    if (dir) {
        struct dirent *ent;
        while ((ent = readdir(dir)) != nullptr) {
            if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) {
                continue;
            }
            std::string child = std::string(path) + "/" + ent->d_name;
            remove_recursive(child.c_str());
        }
        closedir(dir);
    }
    rmdir(path);
}

/** 相对路径消毒: 拒绝绝对路径 / ".." / 空段 */
bool sanitize_rel_path(const char *rel, std::string &out)
{
    if (!rel || !rel[0] || rel[0] == '/') {
        return false;
    }
    std::string s(rel);
    size_t start = 0;
    while (start <= s.size()) {
        size_t end = s.find('/', start);
        std::string seg = s.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (seg.empty() || seg == "." || seg == "..") {
            return false;
        }
        if (end == std::string::npos) {
            break;
        }
        start = end + 1;
    }
    out = s;
    return true;
}

bool read_file_string(const char *path, std::string &out)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        return false;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size < 0) {
        fclose(f);
        return false;
    }
    out.resize((size_t)size);
    size_t rd = size > 0 ? fread(&out[0], 1, (size_t)size, f) : 0;
    fclose(f);
    if (rd != (size_t)size) {
        return false;
    }
    return true;
}

/** 解析 manifest.json → appmgr_manifest_t */
bool parse_manifest(const char *json, appmgr_manifest_t *out)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    const cJSON *id = cJSON_GetObjectItem(root, "id");
    const cJSON *name = cJSON_GetObjectItem(root, "name");
    const cJSON *ver = cJSON_GetObjectItem(root, "version");
    const cJSON *entry = cJSON_GetObjectItem(root, "entry");
    snprintf(out->id, sizeof(out->id), "%s",
             cJSON_IsString(id) ? id->valuestring : "unknown");
    snprintf(out->name, sizeof(out->name), "%s",
             cJSON_IsString(name) ? name->valuestring : out->id);
    snprintf(out->version, sizeof(out->version), "%s",
             cJSON_IsString(ver) ? ver->valuestring : "0.0.0");
    snprintf(out->entry, sizeof(out->entry), "%s",
             cJSON_IsString(entry) && entry->valuestring[0] ? entry->valuestring : "main.js");
    cJSON_Delete(root);
    return true;
}

/** 从 /flash/apps/current 重载 manifest 缓存 */
void reload_current_manifest()
{
    std::lock_guard<std::mutex> lk(s_mutex);
    s_has_app = false;
    std::string json;
    if (read_file_string(CURRENT_DIR "/manifest.json", json) &&
        parse_manifest(json.c_str(), &s_manifest)) {
        s_has_app = true;
        return;
    }
    /* 内置欢迎应用信息 */
    memset(&s_manifest, 0, sizeof(s_manifest));
    snprintf(s_manifest.id, sizeof(s_manifest.id), "com.pixelbox.welcome");
    snprintf(s_manifest.name, sizeof(s_manifest.name), "欢迎");
    /* esp_app_desc 的 version 为 char[32], 目标缓冲 24 字节,
     * 用 strlcpy 显式截断, 避免 -Wformat-truncation 告警 */
    strlcpy(s_manifest.version, esp_app_get_description()->version,
            sizeof(s_manifest.version));
    snprintf(s_manifest.entry, sizeof(s_manifest.entry), "main.js");
}

/* ------------------------------------------------------------
 * 状态机
 * ------------------------------------------------------------ */

void set_state(appmgr_state_t st, const char *error)
{
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        if (s_state == st) {
            return;
        }
        s_state = st;
    }
    ESP_LOGI(TAG, "应用状态 → %s%s%s", appmgr_state_name(st),
             error ? ": " : "", error ? error : "");
    for (auto cb : s_state_cbs) {
        if (cb) {
            cb(st, error);
        }
    }
}

void vm_state_listener(jsvm::VmState st, const char *error)
{
    switch (st) {
    case jsvm::VmState::Running:
        set_state(APPMGR_STATE_RUNNING, nullptr);
        break;
    case jsvm::VmState::Crashed: {
        set_state(APPMGR_STATE_CRASHED, error);
        /* 设置页崩溃自恢复: 退出设置模式重启回应用/欢迎页, 避免 VM 停死黑屏。
         * 仅对内置设置页兜底 —— 用户应用崩溃保持 crashed 等 devd 处置;
         * 回退目标再崩时 s_settings_mode 已为 false, 不会形成重启循环。 */
        bool fallback = false;
        {
            std::lock_guard<std::mutex> lk(s_mutex);
            if (s_settings_mode) {
                s_settings_mode = false;
                fallback = true;
            }
        }
        if (fallback) {
            ESP_LOGW(TAG, "设置页崩溃, 回退应用/欢迎页");
            jsvm::request_restart();
        }
        break;
    }
    case jsvm::VmState::Stopped:
    default:
        set_state(APPMGR_STATE_STOPPED, nullptr);
        break;
    }
}

/* ------------------------------------------------------------
 * jsvm 入口提供者
 * ------------------------------------------------------------ */

bool entry_provider(jsvm::EntrySource &out)
{
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        if (s_settings_mode) {
            out.source = _binary_settings_app_js_start;
            out.filename = "<builtin:settings>";
            ESP_LOGI(TAG, "运行内置设置页");
            return true;
        }
    }

    reload_current_manifest();

    appmgr_manifest_t mf;
    bool has_app;
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        mf = s_manifest;
        has_app = s_has_app;
    }

    if (has_app) {
        std::string entry_path = std::string(CURRENT_DIR) + "/" + mf.entry;
        if (read_file_string(entry_path.c_str(), out.source)) {
            out.filename = std::string("/app/") + mf.entry;
            ESP_LOGI(TAG, "加载应用: %s v%s (%s)", mf.id, mf.version, mf.entry);
            return true;
        }
        ESP_LOGE(TAG, "入口文件读取失败: %s, 回退内置欢迎应用", entry_path.c_str());
    }

    /* 内置欢迎应用 */
    out.source = _binary_default_app_js_start;
    out.filename = "<builtin:welcome>";
    ESP_LOGI(TAG, "运行内置欢迎应用");
    return true;
}

} // namespace

/* ------------------------------------------------------------
 * 公开接口
 * ------------------------------------------------------------ */

extern "C" esp_err_t appmgr_init(void)
{
    esp_vfs_littlefs_conf_t conf = {};
    conf.base_path = FLASH_BASE;
    conf.partition_label = "storage";
    conf.format_if_mount_failed = true;
    conf.dont_mount = false;

    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "littlefs 挂载失败: %s", esp_err_to_name(err));
        return err;
    }

    size_t total = 0, used = 0;
    if (esp_littlefs_info(conf.partition_label, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "littlefs 已挂载 %s: %u/%u KB", FLASH_BASE,
                 (unsigned)(used / 1024), (unsigned)(total / 1024));
    }

    ensure_dir(DATA_DIR);
    ensure_dir(APPS_DIR);
    /* 清理上次可能残留的 staging */
    remove_recursive(STAGING_DIR);

    reload_current_manifest();

    jsvm::set_entry_provider(entry_provider);
    jsvm::set_vm_state_listener(vm_state_listener);
    return ESP_OK;
}

extern "C" bool appmgr_current_manifest(appmgr_manifest_t *out)
{
    std::lock_guard<std::mutex> lk(s_mutex);
    if (out) {
        *out = s_manifest;
    }
    return s_has_app;
}

extern "C" esp_err_t appmgr_resolve_path(const char *virt, char *out, size_t out_len)
{
    if (!virt || !out || out_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    const char *base = nullptr;
    const char *rest = nullptr;
    if (strcmp(virt, "/data") == 0) {
        base = DATA_DIR;
        rest = "";
    } else if (strncmp(virt, "/data/", 6) == 0) {
        base = DATA_DIR;
        rest = virt + 6;
    } else if (strcmp(virt, "/app") == 0) {
        base = CURRENT_DIR;
        rest = "";
    } else if (strncmp(virt, "/app/", 5) == 0) {
        base = CURRENT_DIR;
        rest = virt + 5;
    } else {
        return ESP_ERR_INVALID_ARG;
    }

    if (rest[0]) {
        std::string clean;
        if (!sanitize_rel_path(rest, clean)) {
            return ESP_ERR_INVALID_ARG;
        }
        if (snprintf(out, out_len, "%s/%s", base, clean.c_str()) >= (int)out_len) {
            return ESP_ERR_INVALID_SIZE;
        }
    } else {
        if (snprintf(out, out_len, "%s", base) >= (int)out_len) {
            return ESP_ERR_INVALID_SIZE;
        }
    }
    return ESP_OK;
}

/* ---------------- 热更新 staging ---------------- */

extern "C" esp_err_t appmgr_staging_begin(const char *manifest_json)
{
    if (!manifest_json) {
        return ESP_ERR_INVALID_ARG;
    }
    appmgr_manifest_t mf;
    if (!parse_manifest(manifest_json, &mf)) {
        ESP_LOGE(TAG, "manifest 解析失败");
        return ESP_ERR_INVALID_ARG;
    }

    remove_recursive(STAGING_DIR);
    esp_err_t err = ensure_dir(APPS_DIR);
    if (err == ESP_OK) {
        err = ensure_dir(STAGING_DIR);
    }
    if (err != ESP_OK) {
        return err;
    }

    FILE *f = fopen(STAGING_DIR "/manifest.json", "wb");
    if (!f) {
        return ESP_FAIL;
    }
    size_t len = strlen(manifest_json);
    size_t wr = fwrite(manifest_json, 1, len, f);
    fclose(f);
    if (wr != len) {
        return ESP_FAIL;
    }

    s_staging_active = true;
    ESP_LOGI(TAG, "staging 开始: %s v%s", mf.id, mf.version);
    return ESP_OK;
}

extern "C" esp_err_t appmgr_staging_write(const char *rel_path, uint32_t offset,
                                          const void *data, size_t len)
{
    if (!s_staging_active) {
        return ESP_ERR_INVALID_STATE;
    }
    std::string clean;
    if (!sanitize_rel_path(rel_path, clean)) {
        return ESP_ERR_INVALID_ARG;
    }
    std::string full = std::string(STAGING_DIR) + "/" + clean;
    esp_err_t err = ensure_parent_dirs(full);
    if (err != ESP_OK) {
        return err;
    }

    /* r+b 追加写指定偏移; 文件不存在则创建 */
    FILE *f = fopen(full.c_str(), "r+b");
    if (!f) {
        f = fopen(full.c_str(), "wb");
    }
    if (!f) {
        ESP_LOGE(TAG, "staging 打开失败: %s", full.c_str());
        return ESP_FAIL;
    }
    if (fseek(f, (long)offset, SEEK_SET) != 0) {
        fclose(f);
        return ESP_FAIL;
    }
    size_t wr = fwrite(data, 1, len, f);
    fclose(f);
    return wr == len ? ESP_OK : ESP_FAIL;
}

extern "C" esp_err_t appmgr_staging_verify_file(const char *rel_path, uint32_t size,
                                                const uint8_t sha256[32])
{
    if (!s_staging_active) {
        return ESP_ERR_INVALID_STATE;
    }
    std::string clean;
    if (!sanitize_rel_path(rel_path, clean)) {
        return ESP_ERR_INVALID_ARG;
    }
    std::string full = std::string(STAGING_DIR) + "/" + clean;

    struct stat st;
    if (stat(full.c_str(), &st) != 0 || (uint32_t)st.st_size != size) {
        ESP_LOGE(TAG, "校验失败 (大小不符): %s (期望 %u, 实际 %ld)",
                 clean.c_str(), (unsigned)size, (long)(stat(full.c_str(), &st) == 0 ? st.st_size : -1));
        return ESP_ERR_INVALID_SIZE;
    }

    FILE *f = fopen(full.c_str(), "rb");
    if (!f) {
        return ESP_FAIL;
    }
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);
    uint8_t buf[1024];
    size_t rd;
    while ((rd = fread(buf, 1, sizeof(buf), f)) > 0) {
        mbedtls_sha256_update(&sha, buf, rd);
    }
    fclose(f);
    uint8_t digest[32];
    mbedtls_sha256_finish(&sha, digest);
    mbedtls_sha256_free(&sha);

    if (memcmp(digest, sha256, 32) != 0) {
        ESP_LOGE(TAG, "校验失败 (SHA-256 不符): %s", clean.c_str());
        return ESP_ERR_INVALID_CRC;
    }
    return ESP_OK;
}

extern "C" esp_err_t appmgr_staging_commit(void)
{
    if (!s_staging_active) {
        return ESP_ERR_INVALID_STATE;
    }
    set_state(APPMGR_STATE_UPDATING, nullptr);

    /* 原子切换: prev ← current ← staging */
    remove_recursive(PREV_DIR);
    if (path_exists(CURRENT_DIR)) {
        if (rename(CURRENT_DIR, PREV_DIR) != 0) {
            ESP_LOGW(TAG, "current → prev 重命名失败, 直接删除旧包");
            remove_recursive(CURRENT_DIR);
        }
    }
    if (rename(STAGING_DIR, CURRENT_DIR) != 0) {
        ESP_LOGE(TAG, "staging → current 重命名失败");
        /* 尝试回滚 */
        if (path_exists(PREV_DIR)) {
            rename(PREV_DIR, CURRENT_DIR);
        }
        s_staging_active = false;
        set_state(APPMGR_STATE_CRASHED, "热更新切换失败");
        return ESP_FAIL;
    }
    s_staging_active = false;

    reload_current_manifest();
    ESP_LOGI(TAG, "热更新完成, 重启 JS VM");
    jsvm::request_restart();
    return ESP_OK;
}

extern "C" void appmgr_staging_abort(void)
{
    s_staging_active = false;
    remove_recursive(STAGING_DIR);
}

/* ---------------- 生命周期 ---------------- */

extern "C" esp_err_t appmgr_uninstall_app(void)
{
    remove_recursive(CURRENT_DIR);
    remove_recursive(PREV_DIR);
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        s_has_app = false;
        memset(&s_manifest, 0, sizeof(s_manifest));
        s_settings_mode = false; /* 直接回欢迎页而非设置页 */
    }
    ESP_LOGI(TAG, "已清空推送的应用, 回到欢迎页");
    jsvm::request_restart();
    return ESP_OK;
}

extern "C" void appmgr_open_settings(void)
{
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        s_settings_mode = true;
    }
    /* 刻意不做幂等短路: 已在设置模式再按键1 = 重载设置页,
     * 设置页若曾黑屏/异常可用键1 自救 */
    jsvm::request_restart();
}

extern "C" void appmgr_close_settings(void)
{
    {
        std::lock_guard<std::mutex> lk(s_mutex);
        if (!s_settings_mode) return;
        s_settings_mode = false;
    }
    jsvm::request_restart();
}

extern "C" bool appmgr_in_settings(void)
{
    std::lock_guard<std::mutex> lk(s_mutex);
    return s_settings_mode;
}

extern "C" void appmgr_restart_app(void)
{
    jsvm::request_restart();
}

extern "C" void appmgr_stop_app(void)
{
    jsvm::request_stop();
}

extern "C" appmgr_state_t appmgr_get_state(void)
{
    std::lock_guard<std::mutex> lk(s_mutex);
    return s_state;
}

extern "C" const char *appmgr_state_name(appmgr_state_t st)
{
    switch (st) {
    case APPMGR_STATE_RUNNING:
        return "running";
    case APPMGR_STATE_UPDATING:
        return "updating";
    case APPMGR_STATE_CRASHED:
        return "crashed";
    case APPMGR_STATE_STOPPED:
    default:
        return "stopped";
    }
}

extern "C" void appmgr_on_state(appmgr_state_cb_t cb)
{
    for (auto &slot : s_state_cbs) {
        if (!slot) {
            slot = cb;
            return;
        }
    }
    ESP_LOGW(TAG, "状态回调槽位已满");
}
