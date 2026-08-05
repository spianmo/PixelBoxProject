/**
 * fonts.cpp — 内置字体惰性加载 (EMBED_FILES 产物)
 *
 * CMake EMBED_FILES 生成的符号命名规则: fonts/pixel8.pxf →
 * _binary_pixel8_pxf_start / _binary_pixel8_pxf_end。
 */
#include "hal_display/fonts.h"

#include <cstring>

extern "C" {
extern const uint8_t _binary_pixel8_pxf_start[];
extern const uint8_t _binary_pixel8_pxf_end[];
extern const uint8_t _binary_pixel12_pxf_start[];
extern const uint8_t _binary_pixel12_pxf_end[];
extern const uint8_t _binary_pixel16_pxf_start[];
extern const uint8_t _binary_pixel16_pxf_end[];
}

namespace {

struct Slot {
    const uint8_t *start;
    const uint8_t *end;
    pxfont_t font;
    bool loaded;
    bool ok;
};

Slot s_slots[3] = {
    {_binary_pixel8_pxf_start, _binary_pixel8_pxf_end, {}, false, false},
    {_binary_pixel12_pxf_start, _binary_pixel12_pxf_end, {}, false, false},
    {_binary_pixel16_pxf_start, _binary_pixel16_pxf_end, {}, false, false},
};

}  // namespace

extern "C" const pxfont_t *pxfonts_get(pxfont_id_t id)
{
    if (id < PXFONT_PIXEL8 || id > PXFONT_PIXEL16) return nullptr;
    Slot &s = s_slots[id];
    if (!s.loaded) {
        s.ok = pxfont_load(s.start, static_cast<size_t>(s.end - s.start), &s.font);
        s.loaded = true;
    }
    return s.ok ? &s.font : nullptr;
}

extern "C" const pxfont_t *pxfonts_by_name(const char *name)
{
    if (!name) return nullptr;
    if (strcmp(name, "pixel8") == 0) return pxfonts_get(PXFONT_PIXEL8);
    if (strcmp(name, "pixel12") == 0) return pxfonts_get(PXFONT_PIXEL12);
    if (strcmp(name, "pixel16") == 0) return pxfonts_get(PXFONT_PIXEL16);
    return nullptr;
}
