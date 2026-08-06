# PixelBox voicechat — px.voice 语音对话(引擎 + JS 绑定)
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
#
# 多目标: PX_ENABLE_AUDIO=n (默认 C6) 时编 ENOTSUP 桩 (API 表面对齐 d.ts),
# voice 引擎/esp_websocket_client/esp-sr 不参与链接。
if(CONFIG_PX_ENABLE_AUDIO)
    set(srcs
        "src/voice_engine.cpp"
        "src/vad.cpp"
        "src/wakeword.cpp"
        "src/bindings_voice.cpp")
else()
    set(srcs "src/bindings_voice_stub.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    PRIV_REQUIRES
        jsvm
        hal_audio
        json
        esp_timer
        esp-tls
        mbedtls
        esp_hw_support
    WHOLE_ARCHIVE
)
