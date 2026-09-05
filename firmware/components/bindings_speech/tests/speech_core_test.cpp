#include "speech_core.hpp"

#include <array>
#include <cassert>
#include <iostream>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char** argv) {
    struct FakeMultinet {
        bool create = true, destroy = true, get_samp_rate = true, get_samp_chunksize = true;
        bool set_det_threshold = true, detect = true, get_results = true, clean = true;
        bool set_speech_commands = true, check_speech_command = true;
        void (*switch_loader_mode)() = nullptr;
    } iface;
    assert(speech::has_required_multinet_api(&iface));
    iface.detect = false;
    assert(!speech::has_required_multinet_api(&iface));
    assert(!speech::has_required_multinet_api(static_cast<FakeMultinet*>(nullptr)));
    const std::array<uint8_t, 32> digest{};
    assert(speech::digest_matches(digest.data(), std::string(64, '0').c_str()));
    assert(!speech::digest_matches(digest.data(), std::string(64, '1').c_str()));

    std::vector<uint8_t> missing(512, 0xff);
    assert(!speech::valid_model_archive(missing.data(), missing.size()));
    assert(!speech::valid_model_archive(nullptr, 0));
    if (argc > 1) {
        std::ifstream input(argv[1], std::ios::binary);
        assert(input.good());
        std::vector<uint8_t> model{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        speech::ModelPayloads payloads;
        assert(speech::valid_model_archive(model.data(), model.size(), &payloads));
        for (const auto& payload : payloads) assert(payload.data && payload.size > 0);
        for (size_t cut : {size_t(3), size_t(40), size_t(100), model.size() - 1})
            assert(!speech::valid_model_archive(model.data(), cut));
        auto bad = model;
        std::fill(bad.begin() + 72, bad.begin() + 76, 0xff);
        assert(!speech::valid_model_archive(bad.data(), bad.size()));
        bad = model;
        std::fill(bad.begin() + 76, bad.begin() + 80, 0xff);
        assert(!speech::valid_model_archive(bad.data(), bad.size()));
        bad = model;
        std::fill(bad.begin() + 40, bad.begin() + 72, 'a');
        assert(!speech::valid_model_archive(bad.data(), bad.size()));
        bad = model;
        std::fill(bad.begin() + 72, bad.begin() + 76, 0);
        assert(!speech::valid_model_archive(bad.data(), bad.size()));
        std::cout << "speech model: actual archive/truncation/erased/offset overflow/optional interface checks passed\n";
    }
    assert(speech::valid_region("eastasia"));
    assert(speech::valid_region("chinaeast2"));
    for (const auto* invalid : {"", "EastAsia", "eastasia.evil", "eastasia/path", "eastasia\r\nX:foo"}) assert(!speech::valid_region(invalid));
    assert(speech::valid_name("zh-CN-XiaoxiaoNeural"));
    assert(!speech::valid_name("zh-CN'><audio src='https://invalid'/>"));
    assert(speech::xml_escape("<>&\"'") == "&lt;&gt;&amp;&quot;&apos;");
    assert(speech::xml_escape("你好小川") == "你好小川");

    std::array<uint8_t, 44> wav{};
    speech::wav_header(wav.data(), 32000);
    assert(std::memcmp(wav.data(), "RIFF", 4) == 0);
    assert(std::memcmp(wav.data() + 8, "WAVEfmt ", 8) == 0);
    assert(wav[22] == 1 && wav[34] == 16);
    const auto u32 = [&wav](int at) { uint32_t value = 0; for (int i = 0; i < 4; i++) value |= uint32_t(wav[at + i]) << (8 * i); return value; };
    assert(u32(4) == 32036 && u32(24) == 16000 && u32(28) == 32000 && u32(40) == 32000);

    std::array<int16_t, 160> silent{};
    std::array<int16_t, 160> spoken{};
    spoken.fill(6000);
    speech::Vad vad(800);
    for (int i = 0; i < 1000; i++) assert(!vad.feed(silent.data(), silent.size()));
    assert(!vad.heard);
    for (int i = 0; i < 18; i++) assert(!vad.feed(spoken.data(), spoken.size()));
    assert(vad.heard && vad.level > 0);
    for (int i = 0; i < 79; i++) assert(!vad.feed(silent.data(), silent.size()));
    assert(vad.feed(silent.data(), silent.size()));

    speech::Vad impulse(800);
    for (int i = 0; i < 5; i++) impulse.feed(spoken.data(), spoken.size());
    for (int i = 0; i < 100; i++) impulse.feed(silent.data(), silent.size());
    assert(!impulse.heard);
    std::cout << "speech core: region/SSML/WAV/VAD/impulse checks passed\n";
}
