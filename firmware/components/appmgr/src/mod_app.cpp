/**
 * mod_app.cpp — px.app 模块 (与 appmgr 联动)
 *
 * 提供: name/id/version 字段、readAsset/readAssetText、onExit、exit
 */
#include <cstdio>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <utility>
#include <vector>

#include "esp_log.h"

#include "appmgr/appmgr.h"
#include "jsvm/jsvm.hpp"

static const char *TAG = "px.app";

namespace {

/* onExit 回调表 (仅 JS 线程访问; VM 拆除钩子中同步调用后清空) */
std::vector<std::pair<int, JSValue>> s_exit_cbs;
int s_next_exit_id = 1;

void app_teardown(JSContext *ctx)
{
    /* 应用即将被停止/热更新替换: 同步执行收尾回调 */
    for (auto &kv : s_exit_cbs) {
        JSValue ret = JS_Call(ctx, kv.second, JS_UNDEFINED, 0, nullptr);
        if (JS_IsException(ret)) {
            jsvm::dump_error(ctx);
        }
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, kv.second);
    }
    s_exit_cbs.clear();
}

/** 读取 /flash/apps/current/assets/<path>; 无用户应用/文件缺失返回 false */
bool read_asset_file(JSContext *ctx, JSValueConst path_val, std::string &out,
                     std::string &err_msg)
{
    const char *rel = JS_ToCString(ctx, path_val);
    if (!rel) {
        err_msg = "参数无法转换为字符串";
        return false;
    }
    std::string virt = std::string("/app/assets/") + rel;
    JS_FreeCString(ctx, rel);

    char full[192];
    if (appmgr_resolve_path(virt.c_str(), full, sizeof(full)) != ESP_OK) {
        err_msg = "非法资源路径: " + virt;
        return false;
    }

    FILE *f = fopen(full, "rb");
    if (!f) {
        err_msg = "ENOENT: 资源不存在: " + virt;
        return false;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size < 0) {
        fclose(f);
        err_msg = "资源读取失败: " + virt;
        return false;
    }
    out.resize((size_t)size);
    size_t rd = size > 0 ? fread(&out[0], 1, (size_t)size, f) : 0;
    fclose(f);
    if (rd != (size_t)size) {
        err_msg = "资源读取失败: " + virt;
        return false;
    }
    return true;
}

JSValue throw_app_error(JSContext *ctx, const std::string &msg)
{
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg.c_str()),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, e);
}

JSValue js_read_asset(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "readAsset 需要路径参数");
    }
    std::string data, err;
    if (!read_asset_file(ctx, argv[0], data, err)) {
        return throw_app_error(ctx, err);
    }
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *)data.data(), data.size());
}

JSValue js_read_asset_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "readAssetText 需要路径参数");
    }
    std::string data, err;
    if (!read_asset_file(ctx, argv[0], data, err)) {
        return throw_app_error(ctx, err);
    }
    return JS_NewStringLen(ctx, data.data(), data.size());
}

/** onExit 的退订函数 (func_data[0] = id) */
JSValue js_off_exit(JSContext *ctx, JSValueConst this_val, int argc,
                    JSValueConst *argv, int magic, JSValueConst *func_data)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, func_data[0]);
    for (auto it = s_exit_cbs.begin(); it != s_exit_cbs.end(); ++it) {
        if (it->first == id) {
            JS_FreeValue(ctx, it->second);
            s_exit_cbs.erase(it);
            break;
        }
    }
    return JS_UNDEFINED;
}

JSValue js_on_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "onExit 需要函数参数");
    }
    int id = s_next_exit_id++;
    s_exit_cbs.emplace_back(id, JS_DupValue(ctx, argv[0]));

    JSValue id_val = JS_NewInt32(ctx, id);
    JSValue unsub = JS_NewCFunctionData(ctx, js_off_exit, 0, 0, 1, &id_val);
    JS_FreeValue(ctx, id_val);
    return unsub;
}

JSValue js_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)ctx;
    (void)this_val;
    (void)argc;
    (void)argv;
    ESP_LOGI(TAG, "应用主动退出");
    appmgr_stop_app();
    return JS_UNDEFINED;
}

void app_init(JSContext *ctx, JSValue px)
{
    static bool s_hook_added = false;
    if (!s_hook_added) {
        s_hook_added = true;
        jsvm::add_teardown_hook(app_teardown);
    }

    appmgr_manifest_t mf;
    appmgr_current_manifest(&mf);

    JSValue app = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, app, "name", JS_NewString(ctx, mf.name));
    JS_SetPropertyStr(ctx, app, "id", JS_NewString(ctx, mf.id));
    JS_SetPropertyStr(ctx, app, "version", JS_NewString(ctx, mf.version));
    JS_SetPropertyStr(ctx, app, "readAsset",
                      JS_NewCFunction(ctx, js_read_asset, "readAsset", 1));
    JS_SetPropertyStr(ctx, app, "readAssetText",
                      JS_NewCFunction(ctx, js_read_asset_text, "readAssetText", 1));
    JS_SetPropertyStr(ctx, app, "onExit", JS_NewCFunction(ctx, js_on_exit, "onExit", 1));
    JS_SetPropertyStr(ctx, app, "exit", JS_NewCFunction(ctx, js_exit, "exit", 0));
    JS_SetPropertyStr(ctx, px, "app", app);
}

} // namespace

JSVM_REGISTER_MODULE((jsvm::Module{
    .name = "app",
    .priority = 1,
    .init = app_init,
    .prelude = nullptr,
}));
