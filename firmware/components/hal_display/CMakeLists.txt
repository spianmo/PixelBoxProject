# ============================================================
# hal_display — AMOLED 显示 HAL (SH8601 QSPI) + 软件绘图引擎
#
#   - gfx.cpp / pxfont.c / image_decode.cpp 与 esp_lcd 解耦,
#     可在宿主机单测 (见 test_host/);
#   - 内置字体 (tools/fontgen 产物) 经 EMBED_FILES 编入 flash;
#   - vendored 第三方源码见 vendor/ (来源与许可见各文件头 / vendor/README.md)。
# ============================================================

idf_component_register(
    SRCS
        "src/gfx.cpp"
        "src/pxfont.c"
        "src/fonts.cpp"
        "src/image_decode.cpp"
        "src/hal_display.cpp"
        "vendor/pngle.c"
        "vendor/miniz.c"
        "vendor/gifdec.c"
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS vendor
    EMBED_FILES
        "fonts/pixel8.pxf"
        "fonts/pixel12.pxf"
        "fonts/pixel16.pxf"
    REQUIRES hal_common
    PRIV_REQUIRES driver esp_lcd esp_common log freertos heap
)

# miniz 裁剪: 只需要 tinfl (PNG inflate) 与 mz_crc32; 两个 TU 的宏必须一致
set(PX_MINIZ_DEFS
    "MINIZ_NO_STDIO;MINIZ_NO_TIME;MINIZ_NO_ARCHIVE_APIS;MINIZ_NO_ARCHIVE_WRITING_APIS")
set_source_files_properties(vendor/miniz.c vendor/pngle.c PROPERTIES
    COMPILE_DEFINITIONS "${PX_MINIZ_DEFS}")

# vendored 代码不受本项目告警门槛约束
# 注: IDF 以 -Werror=all 促升告警, 仅 -Wno-error 无法压回,
# gifdec 的 maybe-uninitialized 为 GCC 误报, 需显式关闭。
set_source_files_properties(vendor/pngle.c vendor/miniz.c vendor/gifdec.c PROPERTIES
    COMPILE_OPTIONS "-Wno-error;-Wno-unused-parameter;-Wno-sign-compare;-Wno-type-limits;-Wno-maybe-uninitialized")
