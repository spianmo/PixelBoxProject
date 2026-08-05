# PixelBox hal_audio — ES8311 音频 HAL(采集/混音/解码)
idf_component_register(
    SRCS
        "src/hal_audio.cpp"
        "src/audio_source.cpp"
        "src/wav.cpp"
        "src/decode_stream.cpp"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        hal_common
        esp_driver_i2s
        esp_http_client
        esp-tls
        mbedtls
        heap
)
