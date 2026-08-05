# appmgr — littlefs 挂载 + 应用包管理 + 热更新 staging 原子切换 + px.app 模块
idf_component_register(
    SRCS
        src/appmgr.cpp
        src/mod_app.cpp
    INCLUDE_DIRS include
    EMBED_TXTFILES src/default_app.js
    REQUIRES jsvm
    PRIV_REQUIRES json mbedtls esp_app_format
    WHOLE_ARCHIVE)
