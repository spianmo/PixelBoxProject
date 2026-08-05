# PixelBox bindings_screen — px.screen JS 绑定
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
idf_component_register(
    SRCS
        "src/bindings_screen.cpp"
        "src/path_resolve.cpp"
    PRIV_REQUIRES
        jsvm
        hal_display
        esp_timer
        heap
        log
    EMBED_TXTFILES
        "src/prelude_screen.js"
    WHOLE_ARCHIVE
)
