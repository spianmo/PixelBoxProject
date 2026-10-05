cmake_minimum_required(VERSION 3.20)
project(pixelbox_nuttx_host LANGUAGES C)
set(CMAKE_C_STANDARD 11)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
find_package(Threads REQUIRED)
set(PX_QUICKJS_DIR "" CACHE PATH "QuickJS-ng v0.10.1 source directory")
option(PX_ENABLE_PORTAL "Build the explicitly requested Wi-Fi provisioning portal" OFF)
option(PX_ENABLE_TIMED_SLEEP "Build the bounded timer deep-sleep service binding" OFF)
option(PX_ENABLE_MULTINET7 "Build the real Xtensa MultiNet7 backend (NuttX runner only)" OFF)
# 此入口只构建宿主运行时，不能把模型替身当成启用真实 Xtensa 推理。
if(PX_ENABLE_MULTINET7)
  message(FATAL_ERROR "MultiNet7 requires the NuttX Xtensa ABI; use scripts/nuttx.py build --target esp32s3-multinet7 --nuttx-path <nuttx> --apps-path <apps>")
endif()
set(PX_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." CACHE PATH "PixelBox repository root for shared resources")
set(PX_GENERATED "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(PREPARE_ARGS --repo-root "${PX_REPO_ROOT}" --output "${PX_GENERATED}")
if(PX_QUICKJS_DIR)
  list(APPEND PREPARE_ARGS --quickjs-dir "${PX_QUICKJS_DIR}")
endif()
execute_process(COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare.py" ${PREPARE_ARGS}
  RESULT_VARIABLE PREPARE_RESULT)
if(NOT PREPARE_RESULT EQUAL 0)
  message(FATAL_ERROR "Failed to prepare QuickJS-ng/preludes")
endif()
# prelude 修改后自动重新配置，避免生成头文件与源码不同步。
set(PX_CORE_PRELUDE "${CMAKE_CURRENT_SOURCE_DIR}/shared/prelude_core.js")
if(NOT EXISTS "${PX_CORE_PRELUDE}")
  set(PX_CORE_PRELUDE "${PX_REPO_ROOT}/firmware/components/jsvm/src/prelude_core.js")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
  src/prelude.js src/prelude_wifi.js src/prelude_portal.js src/prelude_power.js src/prelude_audio.js src/prelude_image.js
  src/prelude_net.js src/prelude_mdns.js src/prelude_http.js src/prelude_ota.js src/prelude_ws.js src/prelude_mic.js
  src/prelude_system_net.js src/prelude_speech_transport.js src/prelude_speech.js src/prelude_voice.js
  certs/mozilla-idf-20250225.pem certs/manifest.json
  tools/prepare.py tools/prepare_text.py tools/prepare_images.py tools/prepare_builtin_apps.py
  shared/settings_app.js shared/default_app.js
  "${PX_REPO_ROOT}/firmware/components/appmgr/src/settings_app.js"
  "${PX_REPO_ROOT}/firmware/components/appmgr/src/default_app.js" "${PX_CORE_PRELUDE}")
add_library(pixelbox_quickjs STATIC
  "${PX_GENERATED}/quickjs-ng/quickjs.c" "${PX_GENERATED}/quickjs-ng/cutils.c"
  "${PX_GENERATED}/quickjs-ng/libregexp.c" "${PX_GENERATED}/quickjs-ng/libunicode.c"
  "${PX_GENERATED}/quickjs-ng/xsum.c"
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor/quickjs-dtoa/dtoa.c")
target_include_directories(pixelbox_quickjs PUBLIC
  "${PX_GENERATED}/quickjs-ng"
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor/quickjs-dtoa")
target_compile_definitions(pixelbox_quickjs PRIVATE _GNU_SOURCE)
target_compile_options(pixelbox_quickjs PRIVATE -fno-strict-aliasing -Wno-unused-parameter)
target_link_libraries(pixelbox_quickjs PUBLIC Threads::Threads m ${CMAKE_DL_LIBS})
add_executable(pixelbox src/main.c src/runtime.c src/sha256.c src/framebuffer.c src/projection.c src/canvas.c
  src/service.c src/devd.c src/store.c
  src/system_keys.c src/builtin_apps.c
  src/text.c src/text_binding.c src/wifi.c src/wifi_binding.c src/audio.c src/audio_binding.c src/audio_decode.c
  src/power.c src/power_binding.c src/image.c src/image_binding.c
  src/net.c src/net_binding.c src/tls.c src/ws.c src/ws_binding.c
  src/mdns.c src/mdns_binding.c
  src/ble.c src/ble_nimble.c src/ble_binding.c
  src/watchdog.c src/mic.c src/mic_binding.c
  src/system_net.c src/system_net_binding.c src/system_temperature.c
  "${PX_GENERATED}/images/pngle.c" "${PX_GENERATED}/images/miniz.c"
  "${PX_GENERATED}/images/gifdec.c" "${PX_GENERATED}/images/tjpgd.c"
  "${PX_GENERATED}/pxfont.c")
target_include_directories(pixelbox PRIVATE include "${PX_GENERATED}" "${PX_GENERATED}/images")
target_compile_definitions(pixelbox PRIVATE _GNU_SOURCE)
if(PX_ENABLE_TIMED_SLEEP)
  target_sources(pixelbox PRIVATE src/sleep.c src/sleep_binding.c)
  target_compile_definitions(pixelbox PRIVATE PX_TIMED_SLEEP)
endif()
if(PX_ENABLE_PORTAL)
  target_sources(pixelbox PRIVATE src/softap.c src/portal.c src/portal_platform.c src/portal_binding.c)
  target_compile_definitions(pixelbox PRIVATE PX_SERVICE_PORTAL)
endif()
target_compile_options(pixelbox PRIVATE -Wall -Wextra -Werror -fno-strict-aliasing)
target_link_libraries(pixelbox PRIVATE pixelbox_quickjs)
enable_testing()
add_test(NAME nuttx_ffi COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_runtime.py" "$<TARGET_FILE:pixelbox>")
set_tests_properties(nuttx_ffi PROPERTIES TIMEOUT 60)
add_test(NAME nuttx_ota COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_ota.py" "$<TARGET_FILE:pixelbox>")
set_tests_properties(nuttx_ota PROPERTIES TIMEOUT 60)
add_test(NAME nuttx_portal_build COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_portal_build.py"
  "$<TARGET_FILE:pixelbox>" "${PX_ENABLE_PORTAL}")
set_tests_properties(nuttx_portal_build PROPERTIES TIMEOUT 60)
add_test(NAME nuttx_multinet7_disabled COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_wakeword_build.py"
  "$<TARGET_FILE:pixelbox>")
set_tests_properties(nuttx_multinet7_disabled PROPERTIES TIMEOUT 60)
add_test(NAME nuttx_sleep_build COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_sleep_build.py"
  "$<TARGET_FILE:pixelbox>" "${PX_ENABLE_TIMED_SLEEP}")
set_tests_properties(nuttx_sleep_build PROPERTIES TIMEOUT 60)
