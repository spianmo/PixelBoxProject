/**
 * storage_paths.hpp — px.storage.fs 虚拟路径解析(纯逻辑, 可在宿主机单测)
 *
 * 虚拟路径空间:
 *   "/data/..." → "<data_root>/..."  可读写 (默认 /flash/data)
 *   "/app/..."  → "<app_root>/..."   只读   (当前应用包目录, 由 appmgr 提供)
 *
 * 规则:
 *   - 输入必须以 /data 或 /app 开头("/data"、"/app" 本身也合法, 指挂载根)
 *   - 逐段规范化:"." 忽略;".." 弹栈, 弹出挂载根即判非法(禁止逃逸)
 *   - 空段(连续 //)忽略;不允许出现 NUL
 */
#pragma once

#include <string>

namespace hal_periph {

struct ResolvedPath {
    std::string real;   ///< 落到实际文件系统的绝对路径
    bool read_only;     ///< true = /app 只读挂载
};

/**
 * 解析虚拟路径。
 * @param vpath     JS 侧传入路径, 如 "/data/a/b.txt"
 * @param data_root /data 挂载点(不带尾斜杠), 如 "/flash/data"
 * @param app_root  /app 挂载点(不带尾斜杠), 如 "/flash/apps/current"
 * @param out       输出解析结果
 * @return false = 路径非法(前缀不对 / .. 逃逸 / 含 NUL)
 */
bool resolve_vpath(const std::string& vpath,
                   const std::string& data_root,
                   const std::string& app_root,
                   ResolvedPath& out);

}  // namespace hal_periph
