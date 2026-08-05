# ============================================================
# jsvm — QuickJS-ng 集成 + JS 事件循环 + 模块注册表 + fw-core 模块
#
# quickjs-ng 源码由 tools/fetch_deps.sh vendored 到本目录下
# (固定 tag v0.10.1), 以源码方式编入。
#
# 注意: 组件 CMakeLists 会在 IDF 依赖展开 (early expansion) 阶段被
# 提前 include, 此时 CMAKE_CURRENT_SOURCE_DIR 指向工程目录而非本组件,
# 必须使用 CMAKE_CURRENT_LIST_DIR 解析组件内路径。
# ============================================================

set(QJS_DIR ${CMAKE_CURRENT_LIST_DIR}/quickjs-ng)

if(NOT EXISTS ${QJS_DIR}/quickjs.c)
    message(FATAL_ERROR
        "未找到 quickjs-ng 源码: ${QJS_DIR}\n"
        "请先在仓库根目录执行:  tools/fetch_deps.sh")
endif()

set(QJS_SRCS
    ${QJS_DIR}/quickjs.c
    ${QJS_DIR}/libregexp.c
    ${QJS_DIR}/libunicode.c
    ${QJS_DIR}/cutils.c
    ${QJS_DIR}/xsum.c)

idf_component_register(
    SRCS
        src/jsvm.cpp
        src/js_std.cpp
        src/mod_system.cpp
        src/mod_util.cpp
        ${QJS_SRCS}
    INCLUDE_DIRS include ${QJS_DIR}
    PRIV_INCLUDE_DIRS src
    EMBED_TXTFILES src/prelude_core.js
    REQUIRES hal_common
    PRIV_REQUIRES mbedtls esp_timer esp_hw_support esp_system driver esp_app_format pthread
    WHOLE_ARCHIVE)

# quickjs-ng 编译选项: 版本宏由 quickjs.h 内 QJS_VERSION_* 提供, 无需额外定义;
# 关闭其上游默认告警噪音, 避免被 IDF 告警配置打断编译。
# xtensa GCC14 上 int32_t 定义为 long, quickjs-ng 上游按 int 使用指针,
# 需额外抑制 incompatible-pointer-types 升级为错误。
set_source_files_properties(${QJS_SRCS} PROPERTIES COMPILE_OPTIONS
    "-D_GNU_SOURCE;-Wno-error;-Wno-error=incompatible-pointer-types;-Wno-unused-parameter;-Wno-unused-variable;-Wno-unused-but-set-variable;-Wno-sign-compare;-Wno-implicit-fallthrough;-Wno-missing-field-initializers;-Wno-format;-Wno-format-truncation;-Wno-maybe-uninitialized;-Wno-char-subscripts")
