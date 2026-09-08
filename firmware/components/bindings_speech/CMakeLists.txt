if(CONFIG_PX_ENABLE_SPEECH)
    set(srcs "src/bindings_speech.cpp" "src/speech_engine.cpp")
else()
    set(srcs "src/bindings_speech_stub.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    PRIV_INCLUDE_DIRS "src"
    PRIV_REQUIRES jsvm hal_audio hal_net espressif__esp_websocket_client esp_http_client esp-tls mbedtls json esp_timer
                  esp_partition espressif__esp-sr
    WHOLE_ARCHIVE
)

if(CONFIG_PX_ENABLE_SPEECH)
    if(NOT CONFIG_SR_MN_CN_MULTINET7_QUANT)
        message(FATAL_ERROR "PixelBox speech requires mn7_cn. Set CONFIG_SR_MN_CN_MULTINET7_QUANT=y and rebuild both firmware and srmodels.bin.")
    endif()
    idf_component_get_property(sr_dir espressif__esp-sr COMPONENT_DIR)
    set(model_dir "${sr_dir}/model/multinet_model/mn7_cn")
    foreach(model_file mn7_index mn7_data _MODEL_INFO_ vocab)
        if(NOT EXISTS "${model_dir}/${model_file}")
            message(FATAL_ERROR "PixelBox speech: MultiNet7 model file is missing: ${model_dir}/${model_file}")
        endif()
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${model_dir}/${model_file}")
        file(SHA256 "${model_dir}/${model_file}" "HASH_${model_file}")
    endforeach()
    configure_file("src/speech_model_hashes.hpp.in" "${CMAKE_CURRENT_BINARY_DIR}/speech_model_hashes.hpp" @ONLY)
    target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
endif()
