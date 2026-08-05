/**
 * test_main.cpp — hal_display 宿主机单测
 *
 * 覆盖: 颜色转换 / 基础绘图与裁剪 / blit(缩放+colorKey+源裁剪) /
 * pxfont 加载与查找 / UTF-8 文本渲染与测量 / PNG(含 alpha) / GIF 多帧。
 *
 * 运行: ./build_run.sh (见同目录)
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "hal_display/gfx.hpp"
#include "hal_display/image_decode.hpp"
#include "hal_display/pxfont.h"

static int g_failed = 0;
static int g_total = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_total;                                                           \
        if (!(cond)) {                                                       \
            ++g_failed;                                                      \
            fprintf(stderr, "[FAIL] %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                    \
    } while (0)

static std::vector<uint8_t> read_file(const std::string &path)
{
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) {
        fprintf(stderr, "无法打开 %s\n", path.c_str());
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    const long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> buf(static_cast<size_t>(n));
    if (fread(buf.data(), 1, buf.size(), f) != buf.size()) exit(2);
    fclose(f);
    return buf;
}

static int count_color(const gfx::Surface &s, uint16_t c)
{
    int n = 0;
    for (int y = 0; y < s.h; ++y)
        for (int x = 0; x < s.w; ++x)
            if (s.row(y)[x] == c) ++n;
    return n;
}

/* ------------------------------------------------------------ */

static void test_color()
{
    // 565 可精确往返的颜色
    const uint32_t exact[] = {0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF};
    for (uint32_t c : exact) CHECK(gfx::to888(gfx::to565(c)) == c);
    // 任意色往返后分量误差 <= 8/4/8
    const uint32_t c = 0x123456;
    const uint32_t r = gfx::to888(gfx::to565(c));
    CHECK(abs(static_cast<int>((r >> 16) & 0xFF) - 0x12) <= 8);
    CHECK(abs(static_cast<int>((r >> 8) & 0xFF) - 0x34) <= 4);
    CHECK(abs(static_cast<int>(r & 0xFF) - 0x56) <= 8);
}

static void test_primitives()
{
    gfx::Surface s;
    CHECK(gfx::create_surface(&s, 32, 24));
    const uint16_t RED = gfx::to565(0xFF0000), WHT = gfx::to565(0xFFFFFF);

    gfx::clear(s, WHT);
    CHECK(count_color(s, WHT) == 32 * 24);

    // fill_rect + 越界裁剪
    gfx::fill_rect(s, -4, -4, 10, 10, RED);   // 左上越界 → 6x6
    CHECK(count_color(s, RED) == 36);
    gfx::clear(s, 0);
    gfx::fill_rect(s, 30, 22, 100, 100, RED);  // 右下越界 → 2x2
    CHECK(count_color(s, RED) == 4);

    // set/get
    gfx::set_pixel(s, 5, 5, WHT);
    CHECK(gfx::get_pixel(s, 5, 5) == WHT);
    CHECK(gfx::get_pixel(s, -1, 0) == 0);
    CHECK(gfx::get_pixel(s, 32, 0) == 0);

    // 直线: 水平/垂直/对角端点与像素数
    gfx::clear(s, 0);
    gfx::draw_line(s, 2, 3, 12, 3, RED);
    CHECK(count_color(s, RED) == 11);
    gfx::clear(s, 0);
    gfx::draw_line(s, 4, 2, 4, 9, RED);
    CHECK(count_color(s, RED) == 8);
    gfx::clear(s, 0);
    gfx::draw_line(s, 0, 0, 7, 7, RED);
    CHECK(gfx::get_pixel(s, 0, 0) == RED && gfx::get_pixel(s, 7, 7) == RED);
    CHECK(count_color(s, RED) == 8);
    // 越界直线不崩溃
    gfx::draw_line(s, -10, -10, 50, 40, RED);

    // 矩形描边: 周长像素数
    gfx::clear(s, 0);
    gfx::draw_rect(s, 1, 1, 10, 8, RED);
    CHECK(count_color(s, RED) == 2 * 10 + 2 * (8 - 2));

    // 圆: 上下左右四极点
    gfx::clear(s, 0);
    gfx::draw_circle(s, 16, 12, 5, RED);
    CHECK(gfx::get_pixel(s, 16, 7) == RED && gfx::get_pixel(s, 16, 17) == RED);
    CHECK(gfx::get_pixel(s, 11, 12) == RED && gfx::get_pixel(s, 21, 12) == RED);
    gfx::clear(s, 0);
    gfx::fill_circle(s, 16, 12, 5, RED);
    const int n5 = count_color(s, RED);
    CHECK(n5 >= 69 && n5 <= 89);  // πr² ≈ 78.5 附近
    CHECK(gfx::get_pixel(s, 16, 12) == RED);

    gfx::destroy_surface(&s);
    CHECK(s.px == nullptr);
}

static void test_blit()
{
    gfx::Surface src, dst;
    CHECK(gfx::create_surface(&src, 4, 4));
    CHECK(gfx::create_surface(&dst, 16, 16));
    const uint16_t RED = gfx::to565(0xFF0000), GRN = gfx::to565(0x00FF00);

    gfx::fill_rect(src, 0, 0, 2, 4, RED);
    gfx::fill_rect(src, 2, 0, 2, 4, GRN);

    // 1:1 拷贝
    gfx::blit(dst, src, 1, 1, {});
    CHECK(count_color(dst, RED) == 8 && count_color(dst, GRN) == 8);
    CHECK(gfx::get_pixel(dst, 1, 1) == RED && gfx::get_pixel(dst, 4, 4) == GRN);

    // 2x 最近邻放大
    gfx::clear(dst, 0);
    gfx::BlitOpts o2;
    o2.dw = 8;
    o2.dh = 8;
    gfx::blit(dst, src, 0, 0, o2);
    CHECK(count_color(dst, RED) == 32 && count_color(dst, GRN) == 32);

    // colorKey: 跳过红色
    gfx::clear(dst, 0);
    gfx::BlitOpts ok;
    ok.color_key = RED;
    gfx::blit(dst, src, 0, 0, ok);
    CHECK(count_color(dst, RED) == 0 && count_color(dst, GRN) == 8);

    // 源裁剪: 只取绿色半边
    gfx::clear(dst, 0);
    gfx::BlitOpts oc;
    oc.sx = 2;
    oc.sw = 2;
    gfx::blit(dst, src, 0, 0, oc);
    CHECK(count_color(dst, GRN) == 8 && count_color(dst, RED) == 0);

    // 目标越界裁剪
    gfx::clear(dst, 0);
    gfx::blit(dst, src, 14, 14, {});
    CHECK(count_color(dst, RED) + count_color(dst, GRN) == 4);

    gfx::destroy_surface(&src);
    gfx::destroy_surface(&dst);
}

static pxfont_t g_font8, g_font16;
static std::vector<uint8_t> g_font8_data, g_font16_data;

static void test_font(const char *fonts_dir)
{
    g_font8_data = read_file(std::string(fonts_dir) + "/pixel8.pxf");
    CHECK(pxfont_load(g_font8_data.data(), g_font8_data.size(), &g_font8));
    CHECK(g_font8.height == 16);
    const pxfont_glyph_t *ga = pxfont_find(&g_font8, 'A');
    CHECK(ga && ga->advance == 8 && ga->width == 8);
    CHECK(pxfont_find(&g_font8, 0x4E2D) == nullptr);  // ASCII 字表无 "中"

    g_font16_data = read_file(std::string(fonts_dir) + "/pixel16.pxf");
    CHECK(pxfont_load(g_font16_data.data(), g_font16_data.size(), &g_font16));
    CHECK(g_font16.height == 16);
    const pxfont_glyph_t *gz = pxfont_find(&g_font16, 0x4E2D);  // 中
    CHECK(gz && gz->advance == 16);
    const pxfont_glyph_t *gx = pxfont_find(&g_font16, 'x');
    CHECK(gx && gx->advance == 8);

    // pixel12: 缤纷像素 12px, ASCII 6 宽 / 汉字 12 宽
    static std::vector<uint8_t> font12_data = read_file(std::string(fonts_dir) + "/pixel12.pxf");
    static pxfont_t font12;
    CHECK(pxfont_load(font12_data.data(), font12_data.size(), &font12));
    CHECK(font12.height == 12);
    const pxfont_glyph_t *g12a = pxfont_find(&font12, 'A');
    CHECK(g12a && g12a->advance == 6);
    const pxfont_glyph_t *g12z = pxfont_find(&font12, 0x4E2D);  // 中
    CHECK(g12z && g12z->advance == 12);
    CHECK(pxfont_find(&font12, 0x3002) != nullptr);  // 。 (标点集)
    CHECK(pxfont_find(&font12, 0xFF01) != nullptr);  // ! (全角段)

    // 损坏数据拒绝
    uint8_t bad[16] = {'X', 'X', 'X', 'X'};
    pxfont_t f;
    CHECK(!pxfont_load(bad, sizeof(bad), &f));
}

static void test_text()
{
    gfx::Surface s;
    CHECK(gfx::create_surface(&s, 128, 64));
    gfx::TextStyle st;
    st.font = &g_font8;
    st.c565 = gfx::to565(0xFFFFFF);

    // 测量: ASCII 8px 步进
    int w = 0, h = 0;
    gfx::measure_text("AB", st, &w, &h);
    CHECK(w == 16 && h == 16);
    gfx::measure_text("", st, &w, &h);
    CHECK(w == 0 && h == 0);
    // 多行: 取最宽行
    gfx::measure_text("A\nABC", st, &w, &h);
    CHECK(w == 24 && h == 32);
    // 尾部换行不加行
    gfx::measure_text("A\n", st, &w, &h);
    CHECK(h == 16);

    // scale=2
    st.scale = 2;
    gfx::measure_text("A", st, &w, &h);
    CHECK(w == 16 && h == 32);
    st.scale = 1;

    // 渲染: 'A' 有笔画且在字格内
    gfx::draw_text(s, "A", 0, 0, st);
    int lit = 0;
    for (int y = 0; y < 16; ++y)
        for (int x = 0; x < 8; ++x)
            if (gfx::get_pixel(s, x, y)) ++lit;
    CHECK(lit >= 10 && lit <= 60);

    // 中文 (pixel16): 步进 16
    st.font = &g_font16;
    gfx::measure_text("中a", st, &w, &h);
    CHECK(w == 16 + 8 && h == 16);

    // 未收录字形 → 豆腐块 (不崩溃, 有像素)
    gfx::clear(s, 0);
    st.font = &g_font8;
    gfx::draw_text(s, "中", 0, 0, st);  // pixel8 无中文
    CHECK(count_color(s, st.c565) > 0);

    // align: center/right 锚点 (只验证不同 align 落点不同且不崩溃)
    gfx::clear(s, 0);
    st.align = gfx::Align::Center;
    gfx::draw_text(s, "AB", 64, 0, st);
    CHECK(gfx::get_pixel(s, 40, 4) == 0);  // 左侧远处应无像素
    st.align = gfx::Align::Right;
    gfx::clear(s, 0);
    gfx::draw_text(s, "AB", 64, 0, st);
    // 右对齐: 全部像素应在 x < 64
    for (int y = 0; y < 16; ++y)
        for (int x = 64; x < 128; ++x)
            if (s.row(y)[x]) { CHECK(false); y = 16; break; }

    // UTF-8 解码
    const char *p = "a中\xF0\x9F\x98\x80";  // a, 中, 😀(SMP)
    CHECK(gfx::utf8_next(&p) == 'a');
    CHECK(gfx::utf8_next(&p) == 0x4E2D);
    CHECK(gfx::utf8_next(&p) == 0x1F600);
    CHECK(gfx::utf8_next(&p) == 0);
    const char *bad = "\xFF\x41";
    CHECK(gfx::utf8_next(&bad) == 0xFFFD);
    CHECK(gfx::utf8_next(&bad) == 'A');

    gfx::destroy_surface(&s);
}

static void test_png(const char *fx_dir)
{
    // 4x4 四象限
    auto data = read_file(std::string(fx_dir) + "/rgb4x4.png");
    img::Decoded d;
    CHECK(img::decode(data.data(), data.size(), &d));
    CHECK(d.surf.w == 4 && d.surf.h == 4);
    CHECK(d.alpha == nullptr);
    CHECK(gfx::get_pixel(d.surf, 0, 0) == gfx::to565(0xFF0000));
    CHECK(gfx::get_pixel(d.surf, 3, 0) == gfx::to565(0x00FF00));
    CHECK(gfx::get_pixel(d.surf, 0, 3) == gfx::to565(0x0000FF));
    CHECK(gfx::get_pixel(d.surf, 3, 3) == gfx::to565(0xFFFFFF));
    img::free_decoded(&d);

    // alpha PNG: 左上透明
    auto data2 = read_file(std::string(fx_dir) + "/alpha2x2.png");
    img::Decoded d2;
    CHECK(img::decode(data2.data(), data2.size(), &d2));
    CHECK(d2.alpha != nullptr);
    CHECK((d2.alpha[0] & 0x80) == 0);        // (0,0) 透明
    CHECK((d2.alpha[0] & 0x40) != 0);        // (1,0) 不透明
    CHECK(gfx::get_pixel(d2.surf, 1, 0) == gfx::to565(0xFF0000));

    // blit 时按掩码跳过
    gfx::Surface dst;
    CHECK(gfx::create_surface(&dst, 4, 4));
    gfx::clear(dst, gfx::to565(0x00FF00));
    gfx::BlitOpts bo;
    bo.alpha = d2.alpha;
    gfx::blit(dst, d2.surf, 0, 0, bo);
    CHECK(gfx::get_pixel(dst, 0, 0) == gfx::to565(0x00FF00));  // 保底色
    CHECK(gfx::get_pixel(dst, 1, 0) == gfx::to565(0xFF0000));
    gfx::destroy_surface(&dst);
    img::free_decoded(&d2);

    // 损坏输入
    uint8_t junk[16] = {0x89, 'P', 'N', 'G', 0, 0, 0, 0};
    img::Decoded d3;
    CHECK(!img::decode(junk, sizeof(junk), &d3));
    // 嗅探
    CHECK(img::sniff(data.data(), data.size()) == img::Format::Png);
    const uint8_t jj[8] = {0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0};
    CHECK(img::sniff(jj, 8) == img::Format::Jpeg);
}

struct GifCollect {
    std::vector<gfx::Surface> frames;
    std::vector<int> delays;
};

static bool gif_sink(void *user, gfx::Surface f, int delay_ms)
{
    auto *c = static_cast<GifCollect *>(user);
    c->frames.push_back(f);
    c->delays.push_back(delay_ms);
    return true;
}

static void test_gif(const char *fx_dir)
{
    auto data = read_file(std::string(fx_dir) + "/anim3x2.gif");
    CHECK(img::sniff(data.data(), data.size()) == img::Format::Gif);
    GifCollect c;
    const int n = img::decode_gif(data.data(), data.size(), 16, gif_sink, &c);
    CHECK(n == 2);
    CHECK(c.frames.size() == 2);
    CHECK(c.frames[0].w == 3 && c.frames[0].h == 2);
    CHECK(gfx::get_pixel(c.frames[0], 1, 1) == gfx::to565(0xFF0000));
    CHECK(gfx::get_pixel(c.frames[1], 1, 1) == gfx::to565(0x0000FF));
    CHECK(c.delays[0] == 200 && c.delays[1] == 200);
    for (auto &f : c.frames) gfx::destroy_surface(&f);

    // 坏数据
    uint8_t junk[16] = {'G', 'I', 'F', '8', '9', 'a'};
    CHECK(img::decode_gif(junk, sizeof(junk), 4, gif_sink, &c) <= 0);
}

int main(int argc, char **argv)
{
    const char *fonts_dir = argc > 1 ? argv[1] : "../fonts";
    const char *fx_dir = argc > 2 ? argv[2] : "fixtures";
    test_color();
    test_primitives();
    test_blit();
    test_font(fonts_dir);
    test_text();
    test_png(fx_dir);
    test_gif(fx_dir);
    printf("%s: %d/%d 通过\n", g_failed ? "FAILED" : "OK", g_total - g_failed, g_total);
    return g_failed ? 1 : 0;
}
