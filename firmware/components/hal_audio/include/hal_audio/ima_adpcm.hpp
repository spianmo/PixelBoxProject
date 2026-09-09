#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <vector>

namespace hal_audio {
// 独立 IMA ADPCM 块：样本数 u16、首样本 i16、步长索引 u8、保留字节 0，均为小端。
// 每块自带解码状态，不依赖上一块；取消、重连和切账号都不会串用编码状态。
inline std::vector<uint8_t> encode_ima_adpcm(const uint8_t* pcm, size_t size) {
    static constexpr int steps[] = {
        7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,
        80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,
        494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,
        2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,
        8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,
        27086,29794,32767
    };
    static constexpr int shifts[] = {-1,-1,-1,-1,2,4,6,8};
    if (!pcm || !size || size > 8192 || size % 2) return {};
    const size_t count = size / 2;
    auto sample = [&](size_t i) { return int(static_cast<int16_t>(pcm[2*i] | (pcm[2*i+1] << 8))); };
    int predicted = sample(0), index = 0;
    // 首块按初始变化选择步长，避免每 128ms 从最小步长爬升造成接缝失真。
    if (count > 1) {
        const int initial = std::abs(sample(1) - predicted);
        while (index < 88 && steps[index] < initial) ++index;
    }
    std::vector<uint8_t> encoded(6 + count / 2, 0);
    encoded[0] = count; encoded[1] = count >> 8;
    encoded[2] = pcm[0]; encoded[3] = pcm[1]; encoded[4] = index;
    for (size_t i = 1; i < count; ++i) {
        int delta = sample(i) - predicted;
        int code = delta < 0 ? 8 : 0;
        if (delta < 0) delta = -delta;
        int step = steps[index], change = step >> 3;
        for (int bit = 4; bit; bit >>= 1, step >>= 1) {
            if (delta >= step) { code |= bit; delta -= step; change += step; }
        }
        predicted = std::clamp(predicted + ((code & 8) ? -change : change), -32768, 32767);
        index = std::clamp(index + shifts[code & 7], 0, 88);
        encoded[6 + (i-1)/2] |= code << (((i-1) % 2) * 4);
    }
    return encoded;
}
} // namespace hal_audio
