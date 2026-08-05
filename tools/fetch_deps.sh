#!/usr/bin/env bash
# ============================================================
# PixelBox 依赖拉取脚本
#
# 用途: 将 quickjs-ng 源码 (固定 tag v0.10.1) vendored 到
#       firmware/components/jsvm/quickjs-ng/
#
# 说明:
#   - quickjs-ng 以源码方式编入 jsvm 组件, 不作为 git submodule,
#     方便离线构建与版本锁定。
#   - 若直连 github 失败, 会自动依次尝试以下镜像加速前缀:
#       https://ghfast.top/  https://gh-proxy.com/  (常见 github 反代)
#     如你有自己的代理, 也可以先 export HTTPS_PROXY=... 再运行本脚本。
#   - 重复执行是安全的: 已存在且 tag 正确则直接跳过。
# ============================================================
set -euo pipefail

QJS_TAG="v0.10.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${REPO_ROOT}/firmware/components/jsvm/quickjs-ng"

# 候选源: 官方地址优先, 失败后逐个尝试镜像
CANDIDATES=(
  "https://github.com/quickjs-ng/quickjs.git"
  "https://ghfast.top/https://github.com/quickjs-ng/quickjs.git"
  "https://gh-proxy.com/https://github.com/quickjs-ng/quickjs.git"
)

echo "[fetch_deps] 目标目录: ${DEST}"

# 已存在且 tag 匹配则跳过
if [ -f "${DEST}/quickjs.h" ]; then
  if [ -d "${DEST}/.git" ]; then
    CUR_TAG="$(git -C "${DEST}" describe --tags --exact-match 2>/dev/null || true)"
    if [ "${CUR_TAG}" = "${QJS_TAG}" ]; then
      echo "[fetch_deps] quickjs-ng ${QJS_TAG} 已存在, 跳过。"
      exit 0
    fi
    echo "[fetch_deps] 现有版本 (${CUR_TAG:-未知}) 与 ${QJS_TAG} 不符, 重新拉取..."
    rm -rf "${DEST}"
  else
    echo "[fetch_deps] 目录已存在 (非 git clone, 可能为手工拷贝), 保留不动。"
    echo "[fetch_deps] 如需强制刷新: rm -rf '${DEST}' 后重跑本脚本。"
    exit 0
  fi
fi

mkdir -p "$(dirname "${DEST}")"

OK=0
for URL in "${CANDIDATES[@]}"; do
  echo "[fetch_deps] 尝试 clone: ${URL}"
  if git clone --depth 1 --branch "${QJS_TAG}" "${URL}" "${DEST}"; then
    OK=1
    break
  fi
  rm -rf "${DEST}"
done

if [ "${OK}" != "1" ]; then
  echo "[fetch_deps] 错误: 所有源均 clone 失败。请检查网络或设置 HTTPS_PROXY 后重试。" >&2
  exit 1
fi

echo "[fetch_deps] 完成: quickjs-ng ${QJS_TAG} -> ${DEST}"
