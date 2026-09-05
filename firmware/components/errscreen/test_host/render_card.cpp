/**
 * render_card.cpp — 宿主机渲染异常卡片样张 (PPM), 人工核对折行/截断/中文字形。
 *
 * 与真机像素一致: 用的是同一份 gfx + pxfont + error_card.cpp。
 * 运行见 build_run.sh。
 */
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "errscreen/error_card.hpp"

/* 屏幕尺寸由命令行给出: 368x448 (SH8601) 与 480x480 (CO5300) 都要核对,
   两者 ui_scale() 不同档 (1 vs 2), 版式/横幅高度差一倍。 */
static int W = 368;
static int H = 448;

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

static void write_ppm(const gfx::Surface &s, const std::string &path)
{
    FILE *f = fopen(path.c_str(), "wb");
    if (!f) {
        fprintf(stderr, "无法写入 %s\n", path.c_str());
        exit(2);
    }
    fprintf(f, "P6\n%d %d\n255\n", s.w, s.h);
    std::vector<uint8_t> row((size_t)s.w * 3);
    for (int y = 0; y < s.h; ++y) {
        const uint16_t *src = s.row(y);
        for (int x = 0; x < s.w; ++x) {
            const uint32_t rgb = gfx::to888(src[x]);
            row[x * 3 + 0] = (uint8_t)(rgb >> 16);
            row[x * 3 + 1] = (uint8_t)(rgb >> 8);
            row[x * 3 + 2] = (uint8_t)rgb;
        }
        fwrite(row.data(), 1, row.size(), f);
    }
    fclose(f);
    printf("  → %s\n", path.c_str());
}

/** 模拟应用正在绘制的一帧 (用来看横幅叠加在真实画面上的效果) */
static void fake_app_frame(gfx::Surface &s)
{
    gfx::clear(s, gfx::to565(0x101018));
    for (int i = 0; i < 12; ++i) {
        gfx::fill_rect(s, 20 + (i % 4) * 84, 90 + (i / 4) * 84, 64, 64,
                       gfx::to565(0x2a6df0 + (uint32_t)i * 0x001a00));
    }
}

int main(int argc, char **argv)
{
    const char *fonts_dir = argc > 1 ? argv[1] : "../../hal_display/fonts";
    const std::string out_dir = argc > 2 ? argv[2] : "out";
    if (argc > 4) {
        W = atoi(argv[3]);
        H = atoi(argv[4]);
    }
    /* 样张文件名带上尺寸, 两种屏可以并排比 */
    const std::string tag = "_" + std::to_string(W) + "x" + std::to_string(H);

    auto d12 = read_file((std::string(fonts_dir) + "/pixel12.pxf").c_str());
    auto d16 = read_file((std::string(fonts_dir) + "/pixel16.pxf").c_str());
    static pxfont_t f12, f16;
    if (!pxfont_load(d12.data(), d12.size(), &f12) ||
        !pxfont_load(d16.data(), d16.size(), &f16)) {
        fprintf(stderr, "字体加载失败\n");
        return 1;
    }
    errscreen::Fonts fonts{&f12, &f16};

    gfx::Surface s;
    if (!gfx::create_surface(&s, W, H)) return 1;

    /* 1. 真实案例: 用户日志里的 NVS 崩溃 */
    {
        errscreen::CardInfo info{};
        info.app = "电子拼豆";
        info.version = "1.0.0";
        info.message =
            "应用入口异常: RangeError: NVS 键长度须为 1~15 字节 (当前 \"perler.pattern.v2\" = 17 字节)\n"
            "    at getJSON (native)\n"
            "    at loadSavedPattern (/app/main.js:66:31)\n"
            "    at <eval> (/app/main.js:61:15)";
        errscreen::render_fatal_card(s, W, H, fonts, info);
        write_ppm(s, out_dir + "/card_nvs" + tag + ".ppm");
    }

    /* 2. 极端: 超长摘要 (折行) + 超长堆栈行 (截断) + 超多层 (溢出省略) */
    {
        errscreen::CardInfo info{};
        info.app = "一个名字特别长的示例应用用于测试省略号";
        info.version = "2.11.3-beta.4";
        std::string msg =
            "未捕获异常: TypeError: Cannot read properties of undefined "
            "(reading 'forEach') —— 这是一条故意写得非常长的中文错误摘要, "
            "用来检查按宽度折行以及超过最大行数之后的省略行为是否正确";
        for (int i = 0; i < 14; ++i) {
            msg += "\n    at someDeeplyNestedFunctionName" + std::to_string(i) +
                   " (/app/modules/very/deep/path/to/module" + std::to_string(i) + ".js:" +
                   std::to_string(100 + i) + ":" + std::to_string(i * 3) + ")";
        }
        info.message = msg.c_str();
        info.repeat = 7;
        errscreen::render_fatal_card(s, W, H, fonts, info);
        write_ppm(s, out_dir + "/card_long" + tag + ".ppm");
    }

    /* 3. 退化: 无应用名/无版本/无堆栈/纯英文 */
    {
        errscreen::CardInfo info{};
        info.message = "VM 创建失败: out of memory";
        errscreen::render_fatal_card(s, W, H, fonts, info);
        write_ppm(s, out_dir + "/card_minimal" + tag + ".ppm");
    }

    /* 4. 横幅叠加在应用画面上 (短) */
    {
        fake_app_frame(s);
        errscreen::CardInfo info{};
        info.message = "未捕获异常: ReferenceError: foo is not defined\n    at onFrame (/app/main.js:12:3)";
        errscreen::render_banner(s, W, H, fonts, info);
        write_ppm(s, out_dir + "/banner_short" + tag + ".ppm");
    }

    /* 5. 横幅: 长摘要 + 重复计数 (临界: 再多一次就升级为全屏卡片) */
    {
        fake_app_frame(s);
        errscreen::CardInfo info{};
        info.message =
            "未捕获异常: TypeError: 这是一条很长的中文错误摘要需要在横幅里被截断显示成省略号\n"
            "    at onFrame (/app/main.js:12:3)";
        info.repeat = 4;
        errscreen::render_banner(s, W, H, fonts, info);
        write_ppm(s, out_dir + "/banner_long" + tag + ".ppm");
    }

    printf("横幅高度 = %d px (屏幕 %dx%d)\n", errscreen::banner_height(W, H), W, H);
    gfx::destroy_surface(&s);
    return 0;
}
