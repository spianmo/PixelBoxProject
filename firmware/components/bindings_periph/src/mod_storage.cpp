/**
 * mod_storage.cpp — px.storage 绑定(kv: NVS 命名空间 "pxapp";fs: LittleFS)
 *
 * kv 存储策略:
 *   - 统一使用 NVS blob(字符串上限比 nvs_set_str 的 4000B 更宽)
 *   - set(key, value):字符串原样存;number/boolean/object 走 JSON.stringify
 *   - get 返回原始字符串;getJSON 尝试 JSON.parse, 失败时返回原始字符串
 *     (即 set("k","hello") 后 getJSON("k") === "hello")
 *   - NVS 键长限制 15 字节, 超限抛 Error
 *
 * fs 虚拟路径:
 *   /data ↔ /flash/data(可写);/app ↔ 当前应用包目录(只读)
 *   路径先经 hal_periph::resolve_vpath 规范化(拒绝 .. 逃逸、判定只读),
 *   再交给 appmgr 公开的 appmgr_resolve_path() 做权威映射。
 */
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#include "appmgr/appmgr.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "hal_periph/storage_paths.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

[[maybe_unused]] static const char* TAG = "px.storage";

namespace {

constexpr const char* kNvsNamespace = "pxapp";
constexpr const char* kDataRoot = "/flash/data";

// ---------------------------------------------------------------
// kv (NVS)
// ---------------------------------------------------------------

nvs_handle_t s_nvs = 0;
bool s_nvs_ok = false;

bool ensure_nvs(JSContext* ctx) {
    if (s_nvs_ok) return true;
    esp_err_t err = nvs_open(kNvsNamespace, NVS_READWRITE, &s_nvs);
    if (err == ESP_ERR_NVS_NOT_INITIALIZED) {
        // 防御:正常情况下 main 已完成 nvs_flash_init
        if (nvs_flash_init() == ESP_OK) err = nvs_open(kNvsNamespace, NVS_READWRITE, &s_nvs);
    }
    if (err != ESP_OK) {
        JS_ThrowInternalError(ctx, "NVS 打开失败: %s", esp_err_to_name(err));
        return false;
    }
    s_nvs_ok = true;
    return true;
}

/** 校验 NVS 键;失败时已抛异常 */
bool check_key(JSContext* ctx, const std::string& key) {
    if (key.empty() || key.size() > 15) {
        JS_ThrowRangeError(ctx, "NVS 键长度须为 1~15 字节");
        return false;
    }
    return true;
}

/** 读取 blob 为字符串;不存在返回 false */
bool kv_read(const std::string& key, std::string& out) {
    size_t len = 0;
    if (nvs_get_blob(s_nvs, key.c_str(), nullptr, &len) != ESP_OK) return false;
    out.resize(len);
    if (len > 0 && nvs_get_blob(s_nvs, key.c_str(), out.data(), &len) != ESP_OK) return false;
    return true;
}

JSValue js_kv_get(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string key;
    if (argc < 1 || !pxb::to_string(ctx, argv[0], key)) return JS_ThrowTypeError(ctx, "key 须为字符串");
    if (!check_key(ctx, key) || !ensure_nvs(ctx)) return JS_EXCEPTION;
    std::string val;
    if (!kv_read(key, val)) return JS_NULL;
    return JS_NewStringLen(ctx, val.data(), val.size());
}

JSValue js_kv_get_json(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string key;
    if (argc < 1 || !pxb::to_string(ctx, argv[0], key)) return JS_ThrowTypeError(ctx, "key 须为字符串");
    if (!check_key(ctx, key) || !ensure_nvs(ctx)) return JS_EXCEPTION;
    std::string val;
    if (!kv_read(key, val)) return JS_NULL;
    JSValue parsed = JS_ParseJSON(ctx, val.data(), val.size(), "<pxapp-kv>");
    if (JS_IsException(parsed)) {
        // 非 JSON(如 set 时存的裸字符串)→ 返回原始字符串
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_NewStringLen(ctx, val.data(), val.size());
    }
    return parsed;
}

JSValue js_kv_set(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string key;
    if (argc < 2 || !pxb::to_string(ctx, argv[0], key)) {
        return JS_ThrowTypeError(ctx, "set(key, value) 需要 2 个参数");
    }
    if (!check_key(ctx, key) || !ensure_nvs(ctx)) return JS_EXCEPTION;

    std::string payload;
    if (JS_IsString(argv[1])) {
        if (!pxb::to_string(ctx, argv[1], payload)) return JS_EXCEPTION;
    } else {
        JSValue json = JS_JSONStringify(ctx, argv[1], JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsException(json)) return JS_EXCEPTION;
        if (JS_IsUndefined(json)) {
            JS_FreeValue(ctx, json);
            return JS_ThrowTypeError(ctx, "value 无法序列化为 JSON");
        }
        bool ok = pxb::to_string(ctx, json, payload);
        JS_FreeValue(ctx, json);
        if (!ok) return JS_EXCEPTION;
    }

    esp_err_t err = nvs_set_blob(s_nvs, key.c_str(), payload.data(), payload.size());
    if (err == ESP_OK) err = nvs_commit(s_nvs);
    if (err != ESP_OK) return JS_ThrowInternalError(ctx, "NVS 写入失败: %s", esp_err_to_name(err));
    return JS_UNDEFINED;
}

JSValue js_kv_remove(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string key;
    if (argc < 1 || !pxb::to_string(ctx, argv[0], key)) return JS_ThrowTypeError(ctx, "key 须为字符串");
    if (!check_key(ctx, key) || !ensure_nvs(ctx)) return JS_EXCEPTION;
    esp_err_t err = nvs_erase_key(s_nvs, key.c_str());
    if (err == ESP_OK) nvs_commit(s_nvs);
    // 不存在视为成功(幂等)
    return JS_UNDEFINED;
}

JSValue js_kv_keys(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!ensure_nvs(ctx)) return JS_EXCEPTION;
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    nvs_iterator_t it = nullptr;
    esp_err_t err = nvs_entry_find(NVS_DEFAULT_PART_NAME, kNvsNamespace, NVS_TYPE_ANY, &it);
    while (err == ESP_OK) {
        nvs_entry_info_t info;
        nvs_entry_info(it, &info);
        JS_SetPropertyUint32(ctx, arr, i++, JS_NewString(ctx, info.key));
        err = nvs_entry_next(&it);
    }
    nvs_release_iterator(it);
    return arr;
}

JSValue js_kv_clear(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!ensure_nvs(ctx)) return JS_EXCEPTION;
    esp_err_t err = nvs_erase_all(s_nvs);
    if (err == ESP_OK) err = nvs_commit(s_nvs);
    if (err != ESP_OK) return JS_ThrowInternalError(ctx, "NVS 清空失败: %s", esp_err_to_name(err));
    return JS_UNDEFINED;
}

// ---------------------------------------------------------------
// fs (LittleFS, POSIX)
// ---------------------------------------------------------------

/** 解析虚拟路径;write_op=true 时拒绝 /app;失败已抛异常 */
bool resolve_arg(JSContext* ctx, JSValueConst v, bool write_op, std::string& out) {
    std::string vpath;
    if (!pxb::to_string(ctx, v, vpath)) {
        JS_ThrowTypeError(ctx, "path 须为字符串");
        return false;
    }
    // 第一步:规范化(拒绝 .. 逃逸)并判定只读挂载。
    // 传入虚拟根 "/data"、"/app" → rp.real 即规范化后的虚拟路径。
    hal_periph::ResolvedPath rp;
    if (!hal_periph::resolve_vpath(vpath, "/data", "/app", rp)) {
        JS_ThrowPlainError(ctx, "非法路径 (须以 /data 或 /app 开头且不得越界): %s", vpath.c_str());
        return false;
    }
    if (write_op && rp.read_only) {
        JS_ThrowPlainError(ctx, "EACCES: /app 为只读目录");
        return false;
    }
    // 第二步:appmgr 权威映射到实际文件系统路径。
    char real[160];
    if (appmgr_resolve_path(rp.real.c_str(), real, sizeof(real)) != ESP_OK) {
        JS_ThrowPlainError(ctx, "路径解析失败: %s", vpath.c_str());
        return false;
    }
    out = real;
    return true;
}

/** 读整个文件;失败返回 false(未抛异常) */
bool read_file(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) return false;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) {
        fclose(f);
        return false;
    }
    out.resize(static_cast<size_t>(sz));
    size_t rd = sz > 0 ? fread(out.data(), 1, out.size(), f) : 0;
    fclose(f);
    return rd == out.size();
}

bool write_file(const std::string& path, const void* data, size_t len, const char* mode) {
    FILE* f = fopen(path.c_str(), mode);
    if (f == nullptr) return false;
    size_t wr = len > 0 ? fwrite(data, 1, len, f) : 0;
    int rc = fclose(f);
    return wr == len && rc == 0;
}

JSValue js_fs_read_text(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], false, path)) return JS_EXCEPTION;
    std::vector<uint8_t> data;
    if (!read_file(path, data)) return JS_ThrowPlainError(ctx, "ENOENT: 无法读取 %s", path.c_str());
    return JS_NewStringLen(ctx, reinterpret_cast<const char*>(data.data()), data.size());
}

JSValue js_fs_read_bytes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], false, path)) return JS_EXCEPTION;
    std::vector<uint8_t> data;
    if (!read_file(path, data)) return JS_ThrowPlainError(ctx, "ENOENT: 无法读取 %s", path.c_str());
    return JS_NewArrayBufferCopy(ctx, data.data(), data.size());
}

JSValue js_fs_write_text(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path, text;
    if (argc < 2 || !resolve_arg(ctx, argv[0], true, path)) return JS_EXCEPTION;
    if (!pxb::to_string(ctx, argv[1], text)) return JS_EXCEPTION;
    if (!write_file(path, text.data(), text.size(), "wb")) {
        return JS_ThrowPlainError(ctx, "EIO: 写入失败 %s", path.c_str());
    }
    return JS_UNDEFINED;
}

JSValue js_fs_write_bytes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 2 || !resolve_arg(ctx, argv[0], true, path)) return JS_EXCEPTION;
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, argv[1], &data, &len)) return JS_EXCEPTION;
    if (!write_file(path, data, len, "wb")) {
        return JS_ThrowPlainError(ctx, "EIO: 写入失败 %s", path.c_str());
    }
    return JS_UNDEFINED;
}

JSValue js_fs_append(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 2 || !resolve_arg(ctx, argv[0], true, path)) return JS_EXCEPTION;
    bool ok;
    if (JS_IsString(argv[1])) {
        std::string text;
        if (!pxb::to_string(ctx, argv[1], text)) return JS_EXCEPTION;
        ok = write_file(path, text.data(), text.size(), "ab");
    } else {
        const uint8_t* data = nullptr;
        size_t len = 0;
        if (!jsvm::get_binary(ctx, argv[1], &data, &len)) return JS_EXCEPTION;
        ok = write_file(path, data, len, "ab");
    }
    if (!ok) return JS_ThrowPlainError(ctx, "EIO: 追加失败 %s", path.c_str());
    return JS_UNDEFINED;
}

JSValue js_fs_exists(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], false, path)) return JS_EXCEPTION;
    struct stat st;
    return JS_NewBool(ctx, ::stat(path.c_str(), &st) == 0);
}

JSValue js_fs_remove(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], true, path)) return JS_EXCEPTION;
    struct stat st;
    if (::stat(path.c_str(), &st) != 0) {
        return JS_ThrowPlainError(ctx, "ENOENT: %s", path.c_str());
    }
    int rc = S_ISDIR(st.st_mode) ? ::rmdir(path.c_str()) : ::unlink(path.c_str());
    if (rc != 0) {
        return JS_ThrowPlainError(ctx, "%s: 删除失败 %s",
                                  errno == ENOTEMPTY ? "ENOTEMPTY" : "EIO", path.c_str());
    }
    return JS_UNDEFINED;
}

JSValue js_fs_mkdir(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], true, path)) return JS_EXCEPTION;
    if (::mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
        return JS_ThrowPlainError(ctx, "EIO: mkdir 失败 %s", path.c_str());
    }
    return JS_UNDEFINED;
}

/** 构造 PxFileStat 对象 */
JSValue make_stat_obj(JSContext* ctx, const char* name, const struct stat& st) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "name", JS_NewString(ctx, name));
    JS_SetPropertyStr(ctx, o, "size", JS_NewInt64(ctx, static_cast<int64_t>(st.st_size)));
    JS_SetPropertyStr(ctx, o, "isDir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
    JS_SetPropertyStr(ctx, o, "mtime",
                      JS_NewInt64(ctx, static_cast<int64_t>(st.st_mtime) * 1000));
    return o;
}

JSValue js_fs_read_dir(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], false, path)) return JS_EXCEPTION;
    DIR* dir = opendir(path.c_str());
    if (dir == nullptr) return JS_ThrowPlainError(ctx, "ENOENT: 目录不存在 %s", path.c_str());

    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string child = path + "/" + ent->d_name;
        struct stat st = {};
        ::stat(child.c_str(), &st);
        JS_SetPropertyUint32(ctx, arr, i++, make_stat_obj(ctx, ent->d_name, st));
    }
    closedir(dir);
    return arr;
}

JSValue js_fs_stat(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    std::string path;
    if (argc < 1 || !resolve_arg(ctx, argv[0], false, path)) return JS_EXCEPTION;
    struct stat st = {};
    if (::stat(path.c_str(), &st) != 0) return JS_NULL;
    // name 取路径最后一段
    size_t pos = path.find_last_of('/');
    const char* name = pos == std::string::npos ? path.c_str() : path.c_str() + pos + 1;
    return make_stat_obj(ctx, name, st);
}

// ---------------------------------------------------------------
// 模块注册
// ---------------------------------------------------------------

void storage_init(JSContext* ctx, JSValue px) {
    // 确保 /flash/data 存在(LittleFS 已由 appmgr/main 挂载到 /flash)
    ::mkdir(kDataRoot, 0755);

    JSValue storage = JS_NewObject(ctx);

    JSValue kv = JS_NewObject(ctx);
    pxb::def_fn(ctx, kv, "get", js_kv_get, 1);
    pxb::def_fn(ctx, kv, "getJSON", js_kv_get_json, 1);
    pxb::def_fn(ctx, kv, "set", js_kv_set, 2);
    pxb::def_fn(ctx, kv, "remove", js_kv_remove, 1);
    pxb::def_fn(ctx, kv, "keys", js_kv_keys, 0);
    pxb::def_fn(ctx, kv, "clear", js_kv_clear, 0);
    JS_SetPropertyStr(ctx, storage, "kv", kv);

    JSValue fs = JS_NewObject(ctx);
    pxb::def_fn(ctx, fs, "readText", js_fs_read_text, 1);
    pxb::def_fn(ctx, fs, "readBytes", js_fs_read_bytes, 1);
    pxb::def_fn(ctx, fs, "writeText", js_fs_write_text, 2);
    pxb::def_fn(ctx, fs, "writeBytes", js_fs_write_bytes, 2);
    pxb::def_fn(ctx, fs, "append", js_fs_append, 2);
    pxb::def_fn(ctx, fs, "exists", js_fs_exists, 1);
    pxb::def_fn(ctx, fs, "remove", js_fs_remove, 1);
    pxb::def_fn(ctx, fs, "mkdir", js_fs_mkdir, 1);
    pxb::def_fn(ctx, fs, "readDir", js_fs_read_dir, 1);
    pxb::def_fn(ctx, fs, "stat", js_fs_stat, 1);
    JS_SetPropertyStr(ctx, storage, "fs", fs);

    JS_SetPropertyStr(ctx, px, "storage", storage);
    ESP_LOGD(TAG, "px.storage 就绪");
}

const jsvm::Module s_module = {
    .name = "storage",
    .priority = 10,
    .init = storage_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
