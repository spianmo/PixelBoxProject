#include "hal_audio/ima_adpcm.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>

int main() {
    const uint8_t one[] = {0x00, 0x80};
    assert((hal_audio::encode_ima_adpcm(one, 2) == std::vector<uint8_t>{1,0,0,128,0,0}));
    assert(hal_audio::encode_ima_adpcm(one, 1).empty());
    assert(hal_audio::encode_ima_adpcm(nullptr, 2).empty());
    std::vector<uint8_t> silence(8192);
    assert(hal_audio::encode_ima_adpcm(silence.data(), silence.size()).size() == 2054);
    silence.push_back(0); silence.push_back(0);
    assert(hal_audio::encode_ima_adpcm(silence.data(), silence.size()).empty());

    // 固定 128ms 音频供模拟器编码器逐字节对照、Android 解码器检查时长及量化误差。
    std::vector<uint8_t> pcm(4096);
    for (int i = 0; i < 2048; ++i) {
        const int16_t sample = static_cast<int16_t>(std::lround(12000 * std::sin(2 * 3.141592653589793 * 500 * i / 16000)));
        pcm[2*i] = sample; pcm[2*i+1] = sample >> 8;
    }
    const auto encoded = hal_audio::encode_ima_adpcm(pcm.data(), pcm.size());
    assert(encoded.size() == 1030);
    assert(encoded[0] == 0 && encoded[1] == 8 && encoded[5] == 0);
    // 每块独立；其他输入不能影响同一块的编码结果。
    hal_audio::encode_ima_adpcm(one, 2);
    assert(encoded == hal_audio::encode_ima_adpcm(pcm.data(), pcm.size()));
    for (uint8_t b : encoded) std::printf("%02x", b);
    std::puts("");
}
