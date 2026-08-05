/**
 * render_demo.cpp — 用 gfx 引擎在宿主机渲染一张 368x448 样张 (PNG 无依赖,
 * 输出 PPM), 人工核对字体/图形效果。
 *
 * 编译运行 (build_run.sh 之后):
 *   c++ -std=c++17 -O1 -I../include render_demo.cpp build/gfx.o build/pxfont.o -o build/demo
 *   ./build/demo ../fonts demo.ppm
 */
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "hal_display/gfx.hpp"
#include "hal_display/pxfont.h"

static std::vector<uint8_t> read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "无法打开 %s\n", path);
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> buf((size_t)n);
    if (fread(buf.data(), 1, buf.size(), f) != buf.size()) exit(2);
    fclose(f);
    return buf;
}

int main(int argc, char **argv)
{
    const char *fonts_dir = argc > 1 ? argv[1] : "../fonts";
    const char *out = argc > 2 ? argv[2] : "demo.ppm";

    auto d8 = read_file((std::string(fonts_dir) + "/pixel8.pxf").c_str());
    auto d12 = read_file((std::string(fonts_dir) + "/pixel12.pxf").c_str());
    auto d16 = read_file((std::string(fonts_dir) + "/pixel16.pxf").c_str());
    pxfont_t f8, f12, f16;
    if (!pxfont_load(d8.data(), d8.size(), &f8) || !pxfont_load(d12.data(), d12.size(), &f12) ||
        !pxfont_load(d16.data(), d16.size(), &f16)) {
        fprintf(stderr, "字体加载失败\n");
        return 1;
    }

    gfx::Surface s;
    gfx::create_surface(&s, 368, 448);
    gfx::clear(s, gfx::to565(0x101018));

    // 标题栏
    gfx::fill_rect(s, 0, 0, 368, 40, gfx::to565(0x202040));
    gfx::TextStyle st;
    st.font = &f16;
    st.c565 = gfx::to565(0xFFD866);
    st.scale = 1;
    st.align = gfx::Align::Center;
    gfx::draw_text(s, "PixelBox 像素盒", 184, 12, st);

    // pixel12 中文段落
    st.font = &f12;
    st.align = gfx::Align::Left;
    st.c565 = gfx::to565(0xFFFFFF);
    gfx::draw_text(s, "pixel12: 你好,世界!桌面像素动画小盒子。\n支持 GB2312 一级汉字与常用标点……", 8, 56, st);

    // pixel8 ASCII
    st.font = &f8;
    st.c565 = gfx::to565(0x88FF88);
    gfx::draw_text(s, "pixel8: The quick brown fox 0123456789", 8, 92, st);

    // pixel16 放大
    st.font = &f16;
    st.scale = 2;
    st.c565 = gfx::to565(0x66CCFF);
    gfx::draw_text(s, "缤纷像素", 8, 120, st);
    st.scale = 1;

    // 图形
    gfx::draw_rect(s, 8, 170, 100, 60, gfx::to565(0xFF5555));
    gfx::fill_rect(s, 16, 178, 84, 44, gfx::to565(0x552222));
    gfx::fill_circle(s, 180, 200, 28, gfx::to565(0x55FF55));
    gfx::draw_circle(s, 180, 200, 34, gfx::to565(0x22AA22));
    for (int i = 0; i < 8; ++i) {
        gfx::draw_line(s, 240, 170 + i * 8, 360, 230 - i * 8, gfx::to565(0xFFAA00));
    }

    // 渐变 (HSV 环)
    for (int x = 0; x < 352; ++x) {
        const int hue = x * 360 / 352;
        const int c = hue < 120 ? hue : (hue < 240 ? hue - 120 : hue - 240);
        const uint8_t a = static_cast<uint8_t>(255 - c * 255 / 120);
        const uint8_t b = static_cast<uint8_t>(c * 255 / 120);
        uint32_t rgb = hue < 120 ? (a << 16) | (b << 8) : hue < 240 ? (a << 8) | b : (b << 16) | a;
        gfx::fill_rect(s, 8 + x, 250, 1, 24, gfx::to565(rgb));
    }

    // 对齐演示
    st.font = &f12;
    st.c565 = gfx::to565(0xCCCCCC);
    gfx::draw_line(s, 184, 290, 184, 380, gfx::to565(0x444444));
    st.align = gfx::Align::Left;
    gfx::draw_text(s, "左对齐 left", 184, 296, st);
    st.align = gfx::Align::Center;
    gfx::draw_text(s, "居中 center", 184, 320, st);
    st.align = gfx::Align::Right;
    gfx::draw_text(s, "右对齐 right", 184, 344, st);

    // 缩放文本
    st.align = gfx::Align::Left;
    st.scale = 3;
    st.c565 = gfx::to565(0xFF88CC);
    gfx::draw_text(s, "30fps", 8, 390, st);

    // 输出 PPM
    FILE *f = fopen(out, "wb");
    fprintf(f, "P6\n%d %d\n255\n", s.w, s.h);
    for (int y = 0; y < s.h; ++y) {
        for (int x = 0; x < s.w; ++x) {
            const uint32_t c = gfx::to888(s.row(y)[x]);
            const uint8_t rgb[3] = {static_cast<uint8_t>(c >> 16), static_cast<uint8_t>(c >> 8),
                                    static_cast<uint8_t>(c)};
            fwrite(rgb, 1, 3, f);
        }
    }
    fclose(f);
    gfx::destroy_surface(&s);
    printf("样张已输出: %s\n", out);
    return 0;
}
