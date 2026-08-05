/**
 * PixelBox bindings_audio — 虚拟路径解析(组件内私有)
 *
 * JS 侧路径约定(architecture.md §4.2):
 *   /app/...   → /flash/apps/current/...   (应用只读包)
 *   /data/...  → /flash/data/...           (可写目录)
 *
 * appmgr 若导出官方 C 接口 appmgr_resolve_path(弱符号),优先走 appmgr。
 */
#pragma once

#include <cstddef>

namespace pxjs {

/** 解析 JS 虚拟路径为文件系统绝对路径;非法路径返回 false */
bool resolve_vpath(const char* vpath, char* out, size_t cap);

}  // namespace pxjs
