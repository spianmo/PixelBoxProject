/**
 * px_uuid.cpp — BLE UUID 字符串解析实现(纯逻辑)
 */
#include "hal_periph/px_uuid.hpp"

#include <cstdio>
#include <cstring>

namespace hal_periph {

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool PxUuid::operator==(const PxUuid& o) const {
    if (len != o.len) return false;
    switch (len) {
        case 2: return u16 == o.u16;
        case 4: return u32 == o.u32;
        case 16: return memcmp(b128, o.b128, 16) == 0;
        default: return false;
    }
}

PxUuid parse_uuid(const std::string& in) {
    PxUuid out;
    std::string s = in;
    // 去掉 0x/0X 前缀
    if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s = s.substr(2);

    // 128 位:8-4-4-4-12
    if (s.size() == 36) {
        static const int dash_pos[4] = {8, 13, 18, 23};
        for (int p : dash_pos) {
            if (s[static_cast<size_t>(p)] != '-') return out;
        }
        // 去掉 '-' 后共 32 个 hex 字符 = 16 字节;字符串是大端书写,
        // NimBLE value[] 为小端 → 从字符串末尾往前填。
        uint8_t tmp[16];
        int bi = 0;
        for (size_t i = 0; i < s.size() && bi < 16;) {
            if (s[i] == '-') { i++; continue; }
            if (i + 1 >= s.size()) return out;
            int hi = hex_val(s[i]);
            int lo = hex_val(s[i + 1]);
            if (hi < 0 || lo < 0) return out;
            tmp[bi++] = static_cast<uint8_t>((hi << 4) | lo);
            i += 2;
        }
        if (bi != 16) return out;
        for (int k = 0; k < 16; k++) out.b128[k] = tmp[15 - k];  // 反转为小端
        out.len = 16;
        return out;
    }

    // 16 位 (4 hex) / 32 位 (8 hex)
    if (s.size() == 4 || s.size() == 8) {
        uint32_t v = 0;
        for (char c : s) {
            int h = hex_val(c);
            if (h < 0) return out;
            v = (v << 4) | static_cast<uint32_t>(h);
        }
        if (s.size() == 4) {
            out.len = 2;
            out.u16 = static_cast<uint16_t>(v);
        } else {
            out.len = 4;
            out.u32 = v;
        }
        return out;
    }

    return out;  // 无效
}

std::string uuid_to_string(const PxUuid& u) {
    char buf[40];
    switch (u.len) {
        case 2:
            snprintf(buf, sizeof(buf), "%04x", u.u16);
            return buf;
        case 4:
            snprintf(buf, sizeof(buf), "%08x", static_cast<unsigned>(u.u32));
            return buf;
        case 16: {
            // b128 为小端 → 字符串按大端书写
            const uint8_t* b = u.b128;
            snprintf(buf, sizeof(buf),
                     "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                     b[15], b[14], b[13], b[12], b[11], b[10], b[9], b[8],
                     b[7], b[6], b[5], b[4], b[3], b[2], b[1], b[0]);
            return buf;
        }
        default:
            return "";
    }
}

}  // namespace hal_periph
