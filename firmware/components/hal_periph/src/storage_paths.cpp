/**
 * storage_paths.cpp — 虚拟路径解析实现(纯逻辑)
 */
#include "hal_periph/storage_paths.hpp"

#include <vector>

namespace hal_periph {

bool resolve_vpath(const std::string& vpath,
                   const std::string& data_root,
                   const std::string& app_root,
                   ResolvedPath& out) {
    if (vpath.empty() || vpath[0] != '/') return false;
    if (vpath.find('\0') != std::string::npos) return false;

    // 逐段切分并规范化
    std::vector<std::string> segs;
    size_t i = 1;
    while (i <= vpath.size()) {
        size_t j = vpath.find('/', i);
        if (j == std::string::npos) j = vpath.size();
        std::string seg = vpath.substr(i, j - i);
        if (seg.empty() || seg == ".") {
            // 忽略空段与当前目录
        } else if (seg == "..") {
            if (segs.empty()) return false;  // 弹出挂载根 → 逃逸, 拒绝
            segs.pop_back();
        } else {
            segs.push_back(std::move(seg));
        }
        i = j + 1;
    }

    if (segs.empty()) return false;  // 只有 "/" 没有挂载前缀

    const std::string& mount = segs[0];
    const std::string* root = nullptr;
    if (mount == "data") {
        root = &data_root;
        out.read_only = false;
    } else if (mount == "app") {
        root = &app_root;
        out.read_only = true;
    } else {
        return false;
    }

    // ".." 不允许弹出挂载段本身:上面 pop 逻辑允许 /data/x/../y,
    // 但若把 "data" 段弹掉了(segs 变空后又 push), 前缀就不再是 data/app,
    // 此处 mount 检查天然覆盖该情况。
    out.real = *root;
    for (size_t k = 1; k < segs.size(); k++) {
        out.real += '/';
        out.real += segs[k];
    }
    return true;
}

}  // namespace hal_periph
