/* 独立宿主回归：直接提取原 gfx.cpp 文字实现作为像素兼容基线。 */
#include "pixelbox_text.h"
#include "hal_display/gfx.hpp"

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#define CHECK(condition) do { if (!(condition)) { \
  std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
  std::exit(1); } } while (0)

/* 参考实现仅替换 LVGL 的最底层写像素操作，字形和布局直接使用原源码。 */
namespace gfx {
void set_pixel(Surface &s, int x, int y, uint16_t c)
{
  if (s.contains(x, y)) s.row(y)[x] = c;
}
void fill_rect(Surface &s, int x, int y, int w, int h, uint16_t c)
{
  for (int row = std::max(y, 0); row < std::min(y + h, s.h); ++row)
    for (int col = std::max(x, 0); col < std::min(x + w, s.w); ++col)
      s.row(row)[col] = c;
}
void draw_rect(Surface &s, int x, int y, int w, int h, uint16_t c)
{
  if (w <= 0 || h <= 0) return;
  fill_rect(s, x, y, w, 1, c);
  if (h > 1) fill_rect(s, x, y + h - 1, w, 1, c);
  if (h > 2) {
    fill_rect(s, x, y + 1, 1, h - 2, c);
    if (w > 1) fill_rect(s, x + w - 1, y + 1, 1, h - 2, c);
  }
}
}

#include "pixelbox_text_reference.inc"

static void dimensions()
{
  px_text_metrics m{};
  CHECK(px_text_measure("AB", nullptr, &m) == 0);
  CHECK(m.width == 16 && m.height == 16);
  CHECK(px_text_measure("", nullptr, &m) == 0 && m.width == 0 && m.height == 0);
  CHECK(px_text_measure("A\nABC", nullptr, &m) == 0 && m.width == 24 && m.height == 32);
  CHECK(px_text_measure("A\n", nullptr, &m) == 0 && m.width == 8 && m.height == 16);
  CHECK(px_text_measure("\n\n", nullptr, &m) == 0 && m.width == 0 && m.height == 32);
  px_text_style st{"pixel12", 0xffffff, 1, PX_TEXT_LEFT, false};
  CHECK(px_text_measure("中A", &st, &m) == 0 && m.width == 20 && m.height == 12);
  st.font = "pixel16";
  CHECK(px_text_measure("中a", &st, &m) == 0 && m.width == 24 && m.height == 16);
  st.font = "unknown-font";
  CHECK(px_text_measure("A", &st, &m) == 0 && m.width == 8 && m.height == 16);
  st.scale = INT_MIN;
  CHECK(px_text_measure("A", &st, &m) == 0 && m.width == 8 && m.height == 16);
  st.scale = INT_MAX;
  CHECK(px_text_measure("A", &st, &m) == 0 && m.width == 64 && m.height == 128);
  const std::string too_many_lines(static_cast<size_t>(INT_MAX / 128) + 1, '\n');
  CHECK(px_text_measure(too_many_lines.c_str(), &st, &m) == -EOVERFLOW);
  CHECK(px_text_measure(nullptr, nullptr, &m) == -EINVAL);
  CHECK(px_text_measure("A", nullptr, nullptr) == -EINVAL);
}

static void buffer_guards()
{
  std::vector<uint32_t> buffer(40, 0x123456);
  const auto original = buffer;
  CHECK(px_text_draw(nullptr, 40, 4, 4, 4, "A", 0, 0, nullptr) == -EINVAL);
  CHECK(px_text_draw(buffer.data(), 15, 4, 4, 4, "A", 0, 0, nullptr) == -EINVAL);
  CHECK(px_text_draw(buffer.data(), 40, 4, 4, 3, "A", 0, 0, nullptr) == -EINVAL);
  CHECK(px_text_draw(buffer.data(), 40, 0, 4, 4, "A", 0, 0, nullptr) == -EINVAL);
  CHECK(px_text_draw(buffer.data(), 40, 4, 4, 4, nullptr, 0, 0, nullptr) == -EINVAL);
  CHECK(px_text_draw(buffer.data(), 40, INT_MAX, INT_MAX, INT_MAX, "A", 0, 0, nullptr) < 0);
  CHECK(buffer == original);
  for (int x : {INT_MIN, INT_MAX}) for (int y : {INT_MIN, INT_MAX}) {
    CHECK(px_text_draw(buffer.data(), 40, 4, 4, 4, "ABC", x, y, nullptr) == 0);
    CHECK(buffer == original);
  }
  /* 透明背景及完整24位颜色：文字覆盖和周边哨兵都必须保持精确值。 */
  px_text_style st{"pixel8", 0x1234ab, 1, PX_TEXT_LEFT, false};
  std::vector<uint32_t> colors(16 * 20 + 2, 0xaabbcc);
  CHECK(px_text_draw(colors.data() + 1, colors.size() - 2, 8, 16, 20, "A", 0, 0, &st) == 0);
  CHECK(colors.front() == 0xaabbcc && colors.back() == 0xaabbcc);
  CHECK(std::count(colors.begin(), colors.end(), 0x1234ab) > 10);
  for (int y = 0; y < 16; ++y) for (int x = 8; x < 20; ++x)
    CHECK(colors[1 + y * 20 + x] == 0xaabbcc);
}

static size_t compatibility(const char *fonts_dir, const char *selected)
{
  const char *samples[] = {"", "AB", "Wi-Fi 连接", "中a。！", "A\nAB\n\nC\n",
                           "\n", "🙂", "\xff", "\xe4\xb8"};
  const int origins[][2] = {{0, 0}, {48, 3}, {-7, -5}, {95, 58}, {32, -40}};
  size_t cases = 0;
  for (const char *name : {"pixel8", "pixel12", "pixel16"}) {
    if (selected && std::strcmp(name, selected)) continue;
    std::fprintf(stderr, "文字像素基线：%s\n", name);
    std::ifstream file(std::string(fonts_dir) + "/" + name + ".pxf", std::ios::binary);
    CHECK(file.good());
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
    pxfont_t font{};
    CHECK(pxfont_load(bytes.data(), bytes.size(), &font));
    for (int scale = 1; scale <= 8; ++scale) for (bool smooth : {false, true})
      for (int align = 0; align < 3; ++align) for (const char *sample : samples) {
        px_text_style st{name, 0x00ff00, scale, static_cast<px_text_align>(align), smooth};
        gfx::TextStyle ref;
        ref.font = &font; ref.c565 = gfx::to565(st.color); ref.scale = scale;
        ref.align = static_cast<gfx::Align>(align); ref.smooth = smooth;
        px_text_metrics actual{};
        int expected_w, expected_h;
        CHECK(px_text_measure(sample, &st, &actual) == 0);
        gfx::measure_text(sample, ref, &expected_w, &expected_h);
        CHECK(actual.width == expected_w && actual.height == expected_h);
        for (const auto &origin : origins) {
          constexpr int w = 96, h = 64, stride = 101;
          constexpr uint32_t background = 0x123456;
          std::vector<uint32_t> pixels(stride * h + 2, background);
          std::vector<uint16_t> ref_pixels(stride * h, 0);
          gfx::Surface surface{ref_pixels.data(), w, h, stride};
          CHECK(px_text_draw(pixels.data() + 1, stride * h, w, h, stride,
                             sample, origin[0], origin[1], &st) == 0);
          gfx::draw_text(surface, sample, origin[0], origin[1], ref);
          CHECK(pixels.front() == background && pixels.back() == background);
          for (size_t i = 0; i < ref_pixels.size(); ++i) {
            const uint32_t expected = ref_pixels[i] ? st.color : background;
            if (pixels[i + 1] != expected) {
              std::fprintf(stderr, "%s scale=%d smooth=%d align=%d text=%s origin=%d,%d pixel=%zu\n",
                           name, scale, smooth, align, sample, origin[0], origin[1], i);
              CHECK(pixels[i + 1] == expected);
            }
          }
          ++cases;
        }
      }
  }
  return cases;
}

int main(int argc, char **argv)
{
  CHECK(argc == 2 || argc == 3);
  std::fprintf(stderr, "文字布局与边界检查\n");
  dimensions();
  buffer_guards();
  const size_t cases = compatibility(argv[1], argc == 3 ? argv[2] : nullptr);
  CHECK(cases > 0);
  std::printf("文字回归通过：%zu 组原 gfx 像素兼容案例；布局、颜色、裁剪与缓冲区边界通过。\n", cases);
  return 0;
}
