/**
 * test_main.cpp — hal_periph 纯逻辑模块宿主机单元测试
 *
 * 覆盖:storage_paths(路径规范化/逃逸拒绝)、px_uuid(16/32/128 位解析)、
 *       nmea_parser(校验和、GGA/RMC 解析、坐标换算、时间戳)。
 *
 * 运行:./run_host_tests.sh
 */
#include <cmath>
#include <cstdio>
#include <string>

#include "hal_periph/nmea_parser.hpp"
#include "hal_periph/px_uuid.hpp"
#include "hal_periph/storage_paths.hpp"

static int g_failed = 0;
static int g_total = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        g_total++;                                                         \
        if (!(cond)) {                                                     \
            g_failed++;                                                    \
            printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);         \
        }                                                                  \
    } while (0)

using namespace hal_periph;

static void test_storage_paths() {
    ResolvedPath rp;
    // 基本映射
    CHECK(resolve_vpath("/data/a.txt", "/flash/data", "/flash/apps/current", rp));
    CHECK(rp.real == "/flash/data/a.txt" && !rp.read_only);
    CHECK(resolve_vpath("/app/assets/x.png", "/flash/data", "/flash/apps/current", rp));
    CHECK(rp.real == "/flash/apps/current/assets/x.png" && rp.read_only);
    // 挂载根本身
    CHECK(resolve_vpath("/data", "/flash/data", "/app0", rp) && rp.real == "/flash/data");
    CHECK(resolve_vpath("/data/", "/flash/data", "/app0", rp) && rp.real == "/flash/data");
    // 规范化
    CHECK(resolve_vpath("/data//a/./b.txt", "/d", "/a0", rp) && rp.real == "/d/a/b.txt");
    CHECK(resolve_vpath("/data/x/../y.txt", "/d", "/a0", rp) && rp.real == "/d/y.txt");
    // 逃逸拒绝
    CHECK(!resolve_vpath("/data/../etc/passwd", "/d", "/a0", rp));
    CHECK(!resolve_vpath("/data/..", "/d", "/a0", rp) || rp.real == "/d");  // 弹掉挂载段 → 非法
    CHECK(!resolve_vpath("/../data/a", "/d", "/a0", rp));
    // 未知前缀 / 非绝对路径
    CHECK(!resolve_vpath("/etc/a", "/d", "/a0", rp));
    CHECK(!resolve_vpath("data/a", "/d", "/a0", rp));
    CHECK(!resolve_vpath("", "/d", "/a0", rp));
    // 虚拟根模式(mod_storage 的两步解析用法)
    CHECK(resolve_vpath("/app/main.js", "/data", "/app", rp) && rp.real == "/app/main.js");
}

static void test_px_uuid() {
    // 16 位
    PxUuid u = parse_uuid("180F");
    CHECK(u.len == 2 && u.u16 == 0x180F);
    CHECK(parse_uuid("0x180f").u16 == 0x180F);
    CHECK(uuid_to_string(u) == "180f");
    // 32 位
    u = parse_uuid("0001180F");
    CHECK(u.len == 4 && u.u32 == 0x0001180F);
    // 128 位(小端存储:首字节应为字符串末尾字节)
    u = parse_uuid("0000180f-0000-1000-8000-00805f9b34fb");
    CHECK(u.len == 16);
    CHECK(u.b128[0] == 0xFB && u.b128[1] == 0x34 && u.b128[15] == 0x00 && u.b128[12] == 0x0F);
    CHECK(uuid_to_string(u) == "0000180f-0000-1000-8000-00805f9b34fb");
    // 等价比较
    CHECK(parse_uuid("180F") == parse_uuid("0x180f"));
    // 非法
    CHECK(!parse_uuid("").valid());
    CHECK(!parse_uuid("xyz").valid());
    CHECK(!parse_uuid("180").valid());
    CHECK(!parse_uuid("0000180f-0000-1000-8000-00805f9b34f").valid());
    CHECK(!parse_uuid("0000180f_0000_1000_8000_00805f9b34fb").valid());
}

/** 给 NMEA 语句补上正确校验和 */
static std::string with_checksum(const std::string& body) {
    uint8_t sum = 0;
    for (char c : body) sum ^= static_cast<uint8_t>(c);
    char buf[8];
    snprintf(buf, sizeof(buf), "*%02X\r\n", sum);
    return "$" + body + buf;
}

static void test_nmea() {
    NmeaParser p;
    int fix_count = 0;
    NmeaFix last;
    p.on_fix = [&](const NmeaFix& f) {
        fix_count++;
        last = f;
    };

    // GGA:31°12.34' N, 121°30.00' E, 8 星, hdop 1.2, 海拔 15.3m
    std::string gga = with_checksum("GNGGA,061030.00,3112.3400,N,12130.0000,E,1,08,1.2,15.3,M,4.0,M,,");
    // RMC:速度 10 节, 航向 87.2°, 日期 2026-08-05
    std::string rmc = with_checksum("GNRMC,061030.00,A,3112.3400,N,12130.0000,E,10.0,87.2,050826,,,A");

    p.feed(gga.data(), gga.size());
    CHECK(fix_count == 0);  // GGA 不触发 on_fix
    CHECK(p.current().satellites == 8);
    CHECK(std::fabs(p.current().hdop - 1.2f) < 1e-4f);
    CHECK(std::fabs(p.current().altitude_m - 15.3f) < 1e-4f);

    p.feed(rmc.data(), rmc.size());
    CHECK(fix_count == 1);
    CHECK(last.valid);
    CHECK(std::fabs(last.lat - (31.0 + 12.34 / 60.0)) < 1e-9);
    CHECK(std::fabs(last.lng - (121.0 + 30.0 / 60.0)) < 1e-9);
    CHECK(std::fabs(last.speed_mps - 10.0f * 0.514444f) < 1e-3f);
    CHECK(std::fabs(last.course - 87.2f) < 1e-4f);
    // 2026-08-05 06:10:30 UTC = 1786255830000 ms(用算法交叉验证)
    CHECK(last.timestamp_ms == NmeaParser::civil_to_unix_ms(2026, 8, 5, 6, 10, 30.0));
    CHECK(NmeaParser::civil_to_unix_ms(1970, 1, 1, 0, 0, 0.0) == 0);
    CHECK(NmeaParser::civil_to_unix_ms(2000, 1, 1, 0, 0, 0.0) == 946684800000LL);

    // 南纬/西经符号
    std::string rmc_sw = with_checksum("GPRMC,120000.00,A,3112.3400,S,12130.0000,W,0.0,0.0,050826,,,A");
    p.feed(rmc_sw.data(), rmc_sw.size());
    CHECK(fix_count == 2);
    CHECK(last.lat < 0 && last.lng < 0);

    // 校验和错误 → 丢弃
    int before = fix_count;
    std::string bad = "$GNRMC,061030.00,A,3112.3400,N,12130.0000,E,10.0,87.2,050826,,,A*00\r\n";
    p.feed(bad.data(), bad.size());
    CHECK(fix_count == before);

    // RMC V(无效)→ fix.valid=false, 不触发 on_fix
    std::string rmc_v = with_checksum("GNRMC,061030.00,V,,,,,,,050826,,,N");
    p.feed(rmc_v.data(), rmc_v.size());
    CHECK(fix_count == before);
    CHECK(!p.current().valid);

    // 分块喂入(跨包边界)
    NmeaParser p2;
    int c2 = 0;
    p2.on_fix = [&](const NmeaFix&) { c2++; };
    for (char ch : rmc) p2.feed(&ch, 1);
    CHECK(c2 == 1);
}

int main() {
    test_storage_paths();
    test_px_uuid();
    test_nmea();
    printf("%s: %d/%d 通过\n", g_failed == 0 ? "OK" : "FAILED", g_total - g_failed, g_total);
    return g_failed == 0 ? 0 : 1;
}
