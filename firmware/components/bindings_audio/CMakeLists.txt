# PixelBox bindings_audio — px.audio JS 绑定
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
#
# 多目标: PX_ENABLE_AUDIO=n (默认 C6) 时编 ENOTSUP 桩 (API 表面对齐 d.ts)
if(CONFIG_PX_ENABLE_AUDIO)
    set(srcs "src/bindings_audio.cpp" "src/path_resolve.cpp")
else()
    set(srcs "src/bindings_audio_stub.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    PRIV_REQUIRES
        jsvm
        hal_audio
    WHOLE_ARCHIVE
)
