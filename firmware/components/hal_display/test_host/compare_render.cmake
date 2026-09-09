# 基准由迁移前 1d14263 的 gfx 渲染，比较 RGB 输出而非内部 RGB565 字节序。
execute_process(COMMAND "${RENDER}" "${FONTS}" "${OUTPUT}" RESULT_VARIABLE result)
if(NOT result EQUAL 0)
    message(FATAL_ERROR "渲染样张失败: ${result}")
endif()
file(SHA256 "${OUTPUT}" actual)
if(NOT actual STREQUAL "6936025f9c320b36163508eb02fa2772f4baa7b24053f30fa62c6039c9391b6b")
    message(FATAL_ERROR "像素兼容性回归：${actual}")
endif()
