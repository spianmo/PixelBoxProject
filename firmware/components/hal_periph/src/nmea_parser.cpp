/**
 * nmea_parser.cpp — NMEA 0183 解析实现(纯逻辑)
 */
#include "hal_periph/nmea_parser.hpp"

#include <cstdlib>
#include <cstring>

namespace hal_periph {

// ---------- 工具 ----------

static int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/** ddmm.mmmm / dddmm.mmmm → 十进制度;dir 为 N/S/E/W */
static bool parse_coord(const std::string& v, const std::string& dir, double& out) {
    if (v.empty() || dir.empty()) return false;
    const char* s = v.c_str();
    char* end = nullptr;
    double raw = strtod(s, &end);
    if (end == s) return false;
    double deg = static_cast<double>(static_cast<int>(raw / 100.0));
    double min = raw - deg * 100.0;
    double d = deg + min / 60.0;
    if (dir == "S" || dir == "W") d = -d;
    return true && (out = d, true);
}

static double to_num(const std::string& v, double defv = 0.0) {
    if (v.empty()) return defv;
    char* end = nullptr;
    double d = strtod(v.c_str(), &end);
    return end == v.c_str() ? defv : d;
}

// Howard Hinnant days_from_civil 算法(公历 → 自 1970-01-01 的天数)
int64_t NmeaParser::civil_to_unix_ms(int y, int mo, int d, int h, int mi, double sec) {
    y -= mo <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);              // [0, 399]
    const unsigned doy = (153u * static_cast<unsigned>(mo + (mo > 2 ? -3 : 9)) + 2u) / 5u +
                         static_cast<unsigned>(d) - 1u;                     // [0, 365]
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;             // [0, 146096]
    const int64_t days = era * 146097 + static_cast<int64_t>(doe) - 719468;
    int64_t ms = days * 86400000LL + h * 3600000LL + mi * 60000LL +
                 static_cast<int64_t>(sec * 1000.0);
    return ms;
}

// ---------- 主流程 ----------

void NmeaParser::feed(const char* data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        char c = data[i];
        if (c == '\n') {
            if (!line_.empty() && line_.back() == '\r') line_.pop_back();
            if (!line_.empty()) handle_line(line_);
            line_.clear();
        } else {
            if (line_.size() < 120) {
                line_.push_back(c);
            } else {
                line_.clear();  // 异常超长行, 丢弃防溢出
            }
        }
    }
}

void NmeaParser::handle_line(const std::string& line) {
    // 形如 $GNRMC,....*hh
    if (line.size() < 9 || line[0] != '$') return;
    size_t star = line.rfind('*');
    if (star == std::string::npos || star + 3 > line.size()) return;
    int hi = hexv(line[star + 1]);
    int lo = hexv(line[star + 2]);
    if (hi < 0 || lo < 0) return;
    uint8_t want = static_cast<uint8_t>((hi << 4) | lo);
    uint8_t sum = 0;
    for (size_t i = 1; i < star; i++) sum ^= static_cast<uint8_t>(line[i]);
    if (sum != want) return;  // 校验失败, 整句丢弃

    // 切字段(不含 $ 与 *hh)
    std::string body = line.substr(1, star - 1);
    static constexpr int MAX_FIELDS = 24;
    std::string fields[MAX_FIELDS];
    int n = 0;
    size_t start = 0;
    while (n < MAX_FIELDS) {
        size_t comma = body.find(',', start);
        if (comma == std::string::npos) {
            fields[n++] = body.substr(start);
            break;
        }
        fields[n++] = body.substr(start, comma - start);
        start = comma + 1;
    }
    if (n == 0) return;

    // talker 无关(GP/GN/BD...), 只看语句类型后三位
    const std::string& type = fields[0];
    if (type.size() < 5) return;
    std::string kind = type.substr(type.size() - 3);
    if (kind == "GGA") {
        parse_gga(fields, n);
    } else if (kind == "RMC") {
        parse_rmc(fields, n);
    }
}

/**
 * GGA: 0=xxGGA 1=utc 2=lat 3=N/S 4=lng 5=E/W 6=quality 7=numSV 8=HDOP
 *      9=alt 10=M ...
 */
void NmeaParser::parse_gga(const std::string* f, int n) {
    if (n < 10) return;
    int quality = static_cast<int>(to_num(f[6], 0));
    fix_.satellites = static_cast<int>(to_num(f[7], 0));
    fix_.hdop = static_cast<float>(to_num(f[8], 0));
    fix_.altitude_m = static_cast<float>(to_num(f[9], 0));
    bool has = quality > 0;
    if (has) {
        double lat, lng;
        if (parse_coord(f[2], f[3], lat) && parse_coord(f[4], f[5], lng)) {
            fix_.lat = lat;
            fix_.lng = lng;
        }
    }
    if (on_sentence) on_sentence(has);
}

/**
 * RMC: 0=xxRMC 1=utc(hhmmss.ss) 2=A/V 3=lat 4=N/S 5=lng 6=E/W
 *      7=speed(kn) 8=course 9=date(ddmmyy)
 */
void NmeaParser::parse_rmc(const std::string* f, int n) {
    if (n < 10) return;
    bool active = (f[2] == "A");
    if (active) {
        double lat, lng;
        if (parse_coord(f[3], f[4], lat) && parse_coord(f[5], f[6], lng)) {
            fix_.lat = lat;
            fix_.lng = lng;
        }
        fix_.speed_mps = static_cast<float>(to_num(f[7], 0) * 0.514444);  // 节 → m/s
        fix_.course = static_cast<float>(to_num(f[8], 0));

        // 时间戳:date=ddmmyy + utc=hhmmss.ss
        const std::string& t = f[1];
        const std::string& dt = f[9];
        if (t.size() >= 6 && dt.size() >= 6) {
            int h = (t[0] - '0') * 10 + (t[1] - '0');
            int mi = (t[2] - '0') * 10 + (t[3] - '0');
            double sec = to_num(t.substr(4), 0);
            int d = (dt[0] - '0') * 10 + (dt[1] - '0');
            int mo = (dt[2] - '0') * 10 + (dt[3] - '0');
            int y = 2000 + (dt[4] - '0') * 10 + (dt[5] - '0');
            fix_.timestamp_ms = civil_to_unix_ms(y, mo, d, h, mi, sec);
        }
        fix_.valid = true;
        if (on_fix) on_fix(fix_);
    } else {
        fix_.valid = false;
    }
    if (on_sentence) on_sentence(active);
}

}  // namespace hal_periph
