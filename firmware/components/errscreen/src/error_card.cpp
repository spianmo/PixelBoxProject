/**
 * error_card.cpp — 异常卡片绘制 (纯 gfx, 宿主机可编译, 见 error_card.hpp)
 */
#include "errscreen/error_card.hpp"

#include <string>
#include <vector>

namespace errscreen {

namespace {

/* 配色: 深红黑底 + 红色强调, 与 wifi_portal 的深色系同源但一眼可分 */
constexpr uint32_t C_BG = 0x1a0e10;      // 卡片底
constexpr uint32_t C_HEAD = 0x9b1c1c;    // 顶部标题条 / 横幅底
constexpr uint32_t C_BORDER = 0xff5a5a;  // 描边
constexpr uint32_t C_TITLE = 0xffffff;   // 标题字
constexpr uint32_t C_SUB = 0xe0b4b4;     // 应用名/版本
constexpr uint32_t C_MSG = 0xff9a9a;     // 错误摘要
constexpr uint32_t C_STACK = 0xa88f92;   // 堆栈
constexpr uint32_t C_FOOT_BG = 0x2a1416; // 底部提示条
constexpr uint32_t C_FOOT = 0xc8a8a8;    // 底部提示字
constexpr uint32_t C_DIVIDER = 0x5a2b2b;

constexpr const char *kDefaultHint = "键2 重启应用 · 键1 设置页";

/** 逻辑短边 ≥442 (旋转到横向的大屏) 时整体放大一档, 与 wifi_portal 同口径 */
int ui_scale(int w, int h)
{
    return ((w < h ? w : h) >= 442) ? 2 : 1;
}

int line_height(const pxfont_t *f, int scale)
{
    return f ? f->height * scale : 0;
}

/** UTF-8 码点边界表 (每项 = 该码点结束处的字节下标) */
std::vector<size_t> cp_bounds(const std::string &s)
{
    std::vector<size_t> b;
    const char *base = s.c_str();
    const char *p = base;
    while (*p) {
        gfx::utf8_next(&p);
        b.push_back(static_cast<size_t>(p - base));
    }
    return b;
}

int text_width(const std::string &s, const gfx::TextStyle &st)
{
    int w = 0, h = 0;
    gfx::measure_text(s.c_str(), st, &w, &h);
    return w;
}

/** 按像素宽度截断 (超出补 "…"), 单行用 —— 堆栈行走这条 */
std::string fit_text(const std::string &in, const gfx::TextStyle &st, int max_w)
{
    if (in.empty() || text_width(in, st) <= max_w) return in;
    const std::vector<size_t> b = cp_bounds(in);
    for (size_t i = b.size(); i-- > 0;) {
        std::string cand = in.substr(0, b[i]) + "…";
        if (text_width(cand, st) <= max_w) return cand;
    }
    return std::string("…");
}

/**
 * 按像素宽度折行 (贪心): 优先在空格处断开, 无空格 (纯 CJK / 长路径) 则按
 * 码点硬断。返回行数不超过 max_lines, 被砍掉的部分在末行补 "…"。
 */
std::vector<std::string> wrap_text(const std::string &in, const gfx::TextStyle &st,
                                   int max_w, int max_lines)
{
    std::vector<std::string> out;
    if (in.empty() || max_w <= 0 || max_lines <= 0) return out;

    const std::vector<size_t> b = cp_bounds(in);
    size_t start = 0;      // 当前行起始字节
    size_t last_space = 0; // 当前行内最后一个空格之后的字节位置 (0 = 无)
    for (size_t i = 0; i < b.size(); ++i) {
        const size_t end = b[i];
        if (in[end - 1] == ' ') last_space = end;

        if (text_width(in.substr(start, end - start), st) <= max_w) continue;

        /* 越界: 回退到上一个码点边界 (至少留一个码点, 避免死循环) */
        size_t cut = (i > 0 && b[i - 1] > start) ? b[i - 1] : end;
        /* 有空格且不至于把行砍掉一大半时, 优先在空格处断 */
        if (last_space > start && last_space > start + (cut - start) / 3) cut = last_space;

        out.push_back(in.substr(start, cut - start));
        start = cut;
        last_space = 0;
        if (static_cast<int>(out.size()) >= max_lines) break;
    }
    if (start < in.size() && static_cast<int>(out.size()) < max_lines) {
        out.push_back(in.substr(start));
        start = in.size();
    }
    if (start < in.size() && !out.empty()) {
        out.back() = fit_text(out.back() + "…", st, max_w);
    }
    return out;
}

/** message 首行 = 摘要, 其余 = 堆栈 (逐行 trim 前导空白) */
void split_message(const char *message, std::string &summary, std::vector<std::string> &stack)
{
    summary.clear();
    stack.clear();
    if (!message) return;
    const std::string s(message);
    size_t pos = 0;
    while (pos <= s.size()) {
        size_t nl = s.find('\n', pos);
        std::string line = s.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        size_t lead = line.find_first_not_of(" \t");
        line = (lead == std::string::npos) ? std::string() : line.substr(lead);
        if (summary.empty() && !line.empty()) {
            summary = line;
        } else if (!line.empty()) {
            stack.push_back(line);
        }
        if (nl == std::string::npos) break;
        pos = nl + 1;
    }
    if (summary.empty()) summary = "未知错误";
}

std::string app_line(const CardInfo &info)
{
    std::string s = (info.app && info.app[0]) ? info.app : "未知应用";
    if (info.version && info.version[0]) {
        s += " v";
        s += info.version;
    }
    return s;
}

gfx::TextStyle make_style(const pxfont_t *f, int scale, uint32_t rgb, gfx::Align align)
{
    gfx::TextStyle st{};
    st.font = f;
    st.scale = scale;
    st.c565 = gfx::to565(rgb);
    st.align = align;
    return st;
}

}  // namespace

int banner_height(int w, int h)
{
    const int s = ui_scale(w, h);
    /* 两行 12px 文本 + 上下留白 + 底边线 */
    return 12 * s * 2 + 10 * s + 2;
}

void render_fatal_card(gfx::Surface &fb, int w, int h, const Fonts &fonts, const CardInfo &info)
{
    if (!fb.px || !fonts.f12 || !fonts.f16 || w <= 0 || h <= 0) return;

    const int s = ui_scale(w, h);
    const int pad = 8 * s;
    const int max_w = w - pad * 2;

    const gfx::TextStyle title = make_style(fonts.f16, s * 2, C_TITLE, gfx::Align::Center);
    const gfx::TextStyle sub = make_style(fonts.f12, s, C_SUB, gfx::Align::Center);
    const gfx::TextStyle msg = make_style(fonts.f16, s, C_MSG, gfx::Align::Left);
    const gfx::TextStyle stk = make_style(fonts.f12, s, C_STACK, gfx::Align::Left);
    const gfx::TextStyle foot = make_style(fonts.f12, s, C_FOOT, gfx::Align::Center);

    const int title_h = line_height(fonts.f16, title.scale);
    const int sub_h = line_height(fonts.f12, sub.scale);
    const int msg_h = line_height(fonts.f16, msg.scale);
    const int stk_h = line_height(fonts.f12, stk.scale);
    const int head_h = title_h + 10 * s;
    const int foot_h = sub_h + 10 * s;

    /* ---- 底: 卡片 + 顶部标题条 + 底部提示条 + 描边 ---- */
    gfx::clear(fb, gfx::to565(C_BG));
    gfx::fill_rect(fb, 0, 0, w, head_h, gfx::to565(C_HEAD));
    gfx::fill_rect(fb, 0, h - foot_h, w, foot_h, gfx::to565(C_FOOT_BG));
    gfx::draw_rect(fb, 0, 0, w, h, gfx::to565(C_BORDER));
    gfx::draw_rect(fb, 1, 1, w - 2, h - 2, gfx::to565(C_BORDER));

    std::string head = "应用异常";
    if (info.repeat > 1) head += " ×" + std::to_string(info.repeat);
    gfx::draw_text(fb, head.c_str(), w / 2, 5 * s, title);

    int y = head_h + 6 * s;
    gfx::draw_text(fb, fit_text(app_line(info), sub, max_w).c_str(), w / 2, y, sub);
    y += sub_h + 6 * s;
    gfx::fill_rect(fb, pad, y, max_w, 1, gfx::to565(C_DIVIDER));
    y += 6 * s;

    /* ---- 摘要 (折行, 最多 5 行) ---- */
    std::string summary;
    std::vector<std::string> stack;
    split_message(info.message, summary, stack);

    for (const std::string &line : wrap_text(summary, msg, max_w, 5)) {
        gfx::draw_text(fb, line.c_str(), pad, y, msg);
        y += msg_h + 2 * s;
    }
    y += 4 * s;

    /* ---- 堆栈 (逐行截断, 填满到提示条上方) ---- */
    const int stack_bottom = h - foot_h - 4 * s;
    for (const std::string &line : stack) {
        if (y + stk_h > stack_bottom) {
            gfx::draw_text(fb, "…", pad, y, stk);
            break;
        }
        gfx::draw_text(fb, fit_text(line, stk, max_w).c_str(), pad, y, stk);
        y += stk_h + 1 * s;
    }

    /* ---- 底部提示 ---- */
    const char *hint = (info.hint && info.hint[0]) ? info.hint : kDefaultHint;
    gfx::draw_text(fb, hint, w / 2, h - foot_h + 5 * s, foot);
}

void render_banner(gfx::Surface &fb, int w, int h, const Fonts &fonts, const CardInfo &info)
{
    if (!fb.px || !fonts.f12 || w <= 0 || h <= 0) return;

    const int s = ui_scale(w, h);
    const int bh = banner_height(w, h);
    const int pad = 6 * s;
    const int max_w = w - pad * 2;

    const gfx::TextStyle head = make_style(fonts.f12, s, C_TITLE, gfx::Align::Left);
    const gfx::TextStyle body = make_style(fonts.f12, s, 0xffd8d8, gfx::Align::Left);
    const int lh = line_height(fonts.f12, s);

    gfx::fill_rect(fb, 0, 0, w, bh, gfx::to565(C_HEAD));
    gfx::fill_rect(fb, 0, bh - 2, w, 2, gfx::to565(C_BORDER));

    std::string title = "应用异常";
    if (info.repeat > 1) title += " ×" + std::to_string(info.repeat);
    title += "  (5 秒后自动隐藏)";

    std::string summary;
    std::vector<std::string> stack;
    split_message(info.message, summary, stack);

    int y = 4 * s;
    gfx::draw_text(fb, fit_text(title, head, max_w).c_str(), pad, y, head);
    y += lh + 2 * s;
    gfx::draw_text(fb, fit_text(summary, body, max_w).c_str(), pad, y, body);
}

}  // namespace errscreen
