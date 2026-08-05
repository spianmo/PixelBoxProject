# PixelBox bindings_audio — px.audio JS 绑定
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
idf_component_register(
    SRCS
        "src/bindings_audio.cpp"
        "src/path_resolve.cpp"
    PRIV_REQUIRES
        jsvm
        hal_audio
    WHOLE_ARCHIVE
)
