# PixelBox voicechat — px.voice 语音对话(引擎 + JS 绑定)
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
idf_component_register(
    SRCS
        "src/voice_engine.cpp"
        "src/vad.cpp"
        "src/wakeword.cpp"
        "src/bindings_voice.cpp"
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
