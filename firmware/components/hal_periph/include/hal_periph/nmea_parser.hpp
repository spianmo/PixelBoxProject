/**
 * nmea_parser.hpp — NMEA 0183 解析器(GGA/RMC, 纯逻辑, 可在宿主机单测)
 *
 * 特性:
 *   - 逐块喂入字节流, 内部按行组包(容忍 \r\n / \n)
 *   - '*' 后两位十六进制校验和验证, 不合法整句丢弃
 *   - RMC 提供 lat/lng/speed/course/日期时间;GGA 提供 sats/hdop/alt/质量
 *   - 聚合出 PxGpsFix 所需全部字段;时间戳用自带的 civil→unix 转换(无 timegm 依赖)
 */
#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace hal_periph {

struct NmeaFix {
    double lat = 0.0;
    double lng = 0.0;
    float altitude_m = 0.0f;
    float speed_mps = 0.0f;
    float course = 0.0f;
    int satellites = 0;
    float hdop = 0.0f;
    int64_t timestamp_ms = 0;  ///< Unix 毫秒(来自 RMC 日期+时间)
    bool valid = false;        ///< 当前是否有效定位(RMC=A 且 GGA quality>0 至少其一)
};

class NmeaParser {
public:
    /** 每收到一条通过校验的 GGA/RMC 语句后回调(参数 = 该句是否携带有效定位) */
    std::function<void(bool sentence_has_fix)> on_sentence;
    /** 聚合 fix 更新且有效时回调(RMC 更新位置后触发) */
    std::function<void(const NmeaFix&)> on_fix;

    /** 喂入原始字节流 */
    void feed(const char* data, size_t len);

    /** 当前聚合状态(可能 valid=false) */
    const NmeaFix& current() const { return fix_; }

    /** UTC civil 时间 → Unix 毫秒(公开静态便于单测) */
    static int64_t civil_to_unix_ms(int y, int mo, int d, int h, int mi, double sec);

private:
    void handle_line(const std::string& line);
    void parse_gga(const std::string* f, int n);
    void parse_rmc(const std::string* f, int n);

    std::string line_;
    NmeaFix fix_;
};

}  // namespace hal_periph
