cmake_minimum_required(VERSION 3.20)
project(jsvm_host_tests LANGUAGES C CXX)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
enable_testing()

set(QJS_DIR ${CMAKE_CURRENT_LIST_DIR}/../quickjs-ng)
add_library(quickjs STATIC ${QJS_DIR}/quickjs.c ${QJS_DIR}/libregexp.c
    ${QJS_DIR}/libunicode.c ${QJS_DIR}/cutils.c ${QJS_DIR}/xsum.c)
target_include_directories(quickjs PUBLIC ${QJS_DIR})
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
target_compile_options(quickjs PRIVATE -O2 -fno-strict-aliasing)
if(NOT WIN32)
    target_link_libraries(quickjs PUBLIC m dl pthread)
endif()

add_executable(runtime_test runtime_test.cpp ../src/js_std.cpp ../src/project_points.cpp
    ../../bindings_net/src/js_helpers.cpp)
target_include_directories(runtime_test PRIVATE stubs ../include ../src
    ../../hal_common/include ../../bindings_net/src)
target_link_libraries(runtime_test PRIVATE quickjs)
target_compile_options(runtime_test PRIVATE -UNDEBUG)
add_test(NAME runtime COMMAND runtime_test)
set_tests_properties(runtime PROPERTIES TIMEOUT 60)

add_executable(qjs_bench qjs_bench.cpp ../src/project_points.cpp)
target_include_directories(qjs_bench PRIVATE stubs ../include ../src)
target_link_libraries(qjs_bench PRIVATE quickjs)
