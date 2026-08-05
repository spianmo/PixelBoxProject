/**
 * PixelBox bindings_audio — 虚拟路径解析实现
 */
#include "path_resolve.hpp"

#include <cstdio>
#include <cstring>

// appmgr 官方解析接口(可选,弱符号):返回 0 成功
extern "C" int appmgr_resolve_path(const char* vpath, char* out, size_t out_len)
    __attribute__((weak));

namespace pxjs {

bool resolve_vpath(const char* vpath, char* out, size_t cap) {
    if (!vpath || !out || cap == 0) return false;
    // 拒绝路径穿越
    if (strstr(vpath, "..") != nullptr) return false;

    if (appmgr_resolve_path) {
        return appmgr_resolve_path(vpath, out, cap) == 0;
    }

    // 兜底映射(与 appmgr 约定一致)
    if (strncmp(vpath, "/app/", 5) == 0) {
        return snprintf(out, cap, "/flash/apps/current/%s", vpath + 5) < static_cast<int>(cap);
    }
    if (strncmp(vpath, "/data/", 6) == 0) {
        return snprintf(out, cap, "/flash/data/%s", vpath + 6) < static_cast<int>(cap);
    }
    if (strcmp(vpath, "/data") == 0) {
        return snprintf(out, cap, "/flash/data") < static_cast<int>(cap);
    }
    if (strncmp(vpath, "/flash/", 7) == 0) {  // 已是物理路径,直接放行
        return snprintf(out, cap, "%s", vpath) < static_cast<int>(cap);
    }
    return false;
}

}  // namespace pxjs
