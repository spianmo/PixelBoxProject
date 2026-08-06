# PixelBox hal_audio — ES8311 音频 HAL(采集/混音/解码)
#
# 多目标: PX_ENABLE_AUDIO=n (默认 C6) 时不编译任何源文件 (纯头文件组件),
# bindings_audio/voicechat 同步切换为 ENOTSUP 桩, codec/解码器不参与链接。
if(CONFIG_PX_ENABLE_AUDIO)
    set(srcs
        "src/hal_audio.cpp"
        "src/audio_source.cpp"
        "src/wav.cpp"
        "src/decode_stream.cpp")
else()
    set(srcs "")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        hal_common
        esp_driver_i2s
        esp_http_client
        esp-tls
        mbedtls
        heap
)
