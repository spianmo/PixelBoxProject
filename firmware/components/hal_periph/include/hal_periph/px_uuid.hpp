/**
 * px_uuid.hpp — BLE UUID 字符串解析(纯逻辑, 可在宿主机单测)
 *
 * 支持:
 *   - 16 位:"180F" / "0x180F"(大小写不敏感)
 *   - 32 位:"0001180F" (8 个十六进制字符)
 *   - 128 位:"0000180f-0000-1000-8000-00805f9b34fb"(标准 8-4-4-4-12)
 *
 * bytes 存储:16/32 位存原值(小端语义由使用方处理);128 位按小端存
 * (与 NimBLE ble_uuid128_t.value 的字节序一致, 即字符串从右往左)。
 */
#pragma once

#include <cstdint>
#include <string>

namespace hal_periph {

struct PxUuid {
    uint8_t len = 0;        ///< 2 / 4 / 16 字节;0 = 无效
    uint16_t u16 = 0;       ///< len==2 时有效
    uint32_t u32 = 0;       ///< len==4 时有效
    uint8_t b128[16] = {};  ///< len==16 时有效(小端)

    bool valid() const { return len == 2 || len == 4 || len == 16; }
    bool operator==(const PxUuid& o) const;
};

/** 解析 UUID 字符串;失败返回 len==0 的无效值 */
PxUuid parse_uuid(const std::string& s);

/** 转回规范字符串(16 位 → "180f";128 位 → 标准小写 8-4-4-4-12) */
std::string uuid_to_string(const PxUuid& u);

}  // namespace hal_periph
