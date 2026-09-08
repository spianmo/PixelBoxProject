#include "speech_core.hpp"

#include <array>
#include <cassert>
#include <iostream>
#include <fstream>
#include <iterator>
#include <limits>
#include <thread>
#include <vector>

static std::vector<uint8_t> wake_model_fixture() {
    std::vector<uint8_t> bytes(163, 0);
    const auto put_u32 = [&bytes](size_t at, uint32_t value) {
        for (int i = 0; i < 4; i++) bytes[at + i] = uint8_t(value >> (8 * i));
    };
    put_u32(0, 1);
    std::memcpy(bytes.data() + 4, "mn5q8_cn", 9);
    put_u32(36, 3);
    const char* names[] = {"mn5q8_index", "mn5q8_data", "_MODEL_INFO_"};
    for (size_t i = 0; i < 3; i++) {
        std::memcpy(bytes.data() + 40 + 40 * i, names[i], std::strlen(names[i]));
        put_u32(72 + 40 * i, 160 + i);
        put_u32(76 + 40 * i, 1);
    }
    return bytes;
}

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
    auto fixture = wake_model_fixture();
    speech::ModelPayloads expected_payloads;
    assert(speech::valid_model_archive(fixture.data(), fixture.size(), &expected_payloads));
    assert(expected_payloads.size() == 3);
    auto wrong_model = fixture;
    std::memset(wrong_model.data() + 4, 0, 32);
    std::memcpy(wrong_model.data() + 4, "mn7_cn", 6);
    assert(!speech::valid_model_archive(wrong_model.data(), wrong_model.size()));
    auto duplicate = fixture;
    std::memcpy(duplicate.data() + 80, duplicate.data() + 40, 32);
    assert(!speech::valid_model_archive(duplicate.data(), duplicate.size()));
    assert(speech::wake_backlog_drop_samples(2560, false) == 0);
    assert(speech::wake_backlog_drop_samples(8192, false) == 5632);
    assert(speech::wake_backlog_drop_samples(8192, true) == 8192);
    assert(speech::wake_backlog_drop_samples(0, true) == 0);
    // 真机 MN5Q8 曾以 0.306/0.490 返回 DETECTED；低概率候选不能绕过应用门限。
    assert(!speech::wake_match(1, 0.306f, 0.70f));
    assert(!speech::wake_match(1, 0.699f, 0.70f));
    assert(speech::wake_match(1, 0.70f, 0.70f));
    assert(speech::wake_match(1, 0.895f, 0.70f));
    assert(!speech::wake_match(2, 0.99f, 0.70f));
    assert(!speech::wake_match(1, std::numeric_limits<float>::quiet_NaN(), 0.70f));
    // 模拟推理落后半秒：丢弃旧前缀后仍保留最新 160 ms；发生缺口则重置整段上下文。
    size_t queued = 8192;
    queued -= speech::wake_backlog_drop_samples(queued, false);
    assert(queued == 2560 && speech::wake_backlog_drop_samples(queued, false) == 0);

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
    // 唤醒配置完全由业务提供，固件只校验模型能接受的参数边界。
    assert(speech::validate_wake_config(speech::WakeConfig{}) != nullptr);
    speech::WakeConfig wake{"你好小川", "ni hao xiao chuan", 0.30};
    assert(speech::validate_wake_config(wake) == nullptr);
    assert(speech::validate_wake_config({"小爱同学", "xiao ai tong xue", 0.15}) == nullptr);
    for (double threshold : {0.0, 0.15, 0.30, 0.70, 0.9999}) {
        wake.threshold = threshold;
        assert(speech::validate_wake_config(wake) == nullptr);
    }
    for (double threshold : {-0.01, 0.99991, 1.0, std::numeric_limits<double>::quiet_NaN(),
                             std::numeric_limits<double>::infinity()}) {
        wake.threshold = threshold;
        assert(speech::validate_wake_config(wake) != nullptr);
    }
    wake.threshold = 0.30;
    for (const std::string& phrase : {std::string{}, std::string(" "), std::string("hello\nworld"),
                                    std::string("hello\0world", 11), std::string(97, 'a')}) {
        auto invalid = wake;
        invalid.phrase = phrase;
        assert(speech::validate_wake_config(invalid) != nullptr);
    }
    for (const char* pinyin : {"", "n", "ni3 hao3", "ni  hao", " ni hao", "ni hao ", "Ni Hao", "ni\nhao", "你好"}) {
        auto invalid = wake;
        invalid.pinyin = pinyin;
        assert(speech::validate_wake_config(invalid) != nullptr);
    }
    auto invalid = wake;
    invalid.pinyin = std::string(64, 'a');
    assert(speech::validate_wake_config(invalid) != nullptr);
    invalid.pinyin = std::string("ni\0hao", 6);
    assert(speech::validate_wake_config(invalid) != nullptr);
    // 业务门限接纳真机日志中的三个候选，仍拒绝低于 0.30 的结果。
    assert(!speech::wake_match(1, 0.299f, wake.threshold));
    assert(speech::wake_match(1, 0.30f, wake.threshold));
    for (float probability : {0.317f, 0.467f, 0.624f})
        assert(speech::wake_match(1, probability, wake.threshold));
    // 512-sample 推理帧下保留七帧；环绕后按时间顺序回放，不能混入被丢弃的旧帧。
    constexpr size_t frame_samples = 512;
    const size_t prefix_frames = speech::WakePreroll::frame_capacity(frame_samples);
    assert(prefix_frames * frame_samples >= speech::kRate / 5);
    assert((prefix_frames - 1) * frame_samples < speech::kRate / 5);
    std::vector<int16_t> prefix_storage(prefix_frames * frame_samples + 2, -1);
    speech::WakePreroll prefix(prefix_storage.data() + 1, frame_samples);
    std::array<int16_t, frame_samples> prefix_frame{};
    int replayed = 0;
    prefix.replay([&](int16_t*) { replayed++; return false; });
    assert(replayed == 0);
    for (int i = 1; i <= 10; i++) {
        prefix_frame.fill(i);
        prefix.append(prefix_frame.data());
    }
    int expected_frame = 11 - static_cast<int>(prefix_frames);
    prefix.replay([&](int16_t* frame) {
        for (size_t i = 0; i < frame_samples; i++) assert(frame[i] == expected_frame);
        expected_frame++;
        replayed++;
        return false;
    });
    assert(replayed == static_cast<int>(prefix_frames) && expected_frame == 11);
    assert(prefix_storage.front() == -1 && prefix_storage.back() == -1);
    // 回放前导帧命中后立即停止，防止后续推理覆盖已有高分结果。
    replayed = 0;
    assert(prefix.replay([&](int16_t*) {
        replayed++;
        return speech::wake_match(1, replayed == 2 ? 0.85f : 0.10f, 0.70f);
    }));
    assert(replayed == 2);
    prefix.clear();
    replayed = 0;
    prefix.replay([&](int16_t*) { replayed++; return false; });
    assert(replayed == 0);
    prefix_frame.fill(100);
    prefix.append(prefix_frame.data());
    prefix.replay([&](int16_t* frame) { assert(frame[0] == 100); replayed++; return false; });
    assert(replayed == 1);
    speech::WakeAudioStats stats;
    assert(stats.rms() == 0 && stats.samples == 0 && stats.clipped == 0);
    const int16_t balanced[] = {-100, 100};
    stats.feed(balanced, 2);
    assert(stats.rms() == 100 && stats.peak == 100 && stats.samples == 2);
    const int16_t limits[] = {-32768, 32767};
    stats.feed(limits, 2);
    assert(stats.clipped == 2 && stats.peak == 32768);
    assert(stats.energy == 20000ULL + 32768ULL * 32768 + 32767ULL * 32767);
    stats = {};
    assert(stats.rms() == 0 && stats.peak == 0 && stats.clipped == 0);
    // 连续静音本身不重置；只在下一次发声前重置一次，短停顿不切断一句话。
    speech::WakeSpeechBoundary speech_boundary;
    assert(!speech_boundary.feed(nullptr, 0));
    for (int i = 0; i < 50; i++) assert(!speech_boundary.feed(silent.data(), silent.size()));
    assert(speech_boundary.feed(spoken.data(), spoken.size()));
    for (int i = 0; i < 350; i++) assert(!speech_boundary.feed(spoken.data(), spoken.size()));
    for (int i = 0; i < 30; i++) assert(!speech_boundary.feed(silent.data(), silent.size()));
    assert(!speech_boundary.feed(spoken.data(), spoken.size()));
    for (int i = 0; i < 50; i++) assert(!speech_boundary.feed(silent.data(), silent.size()));
    std::array<int16_t, 160> quiet_onset{};
    quiet_onset.fill(100);
    assert(!speech_boundary.feed(quiet_onset.data(), quiet_onset.size()));
    assert(speech_boundary.feed(spoken.data(), spoken.size()));
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

    // Desk-distance speech is quieter than the old 0.012 RMS onset threshold.
    speech::Vad quiet_voice(800);
    std::array<int16_t, 320> low_speech{}, noise{};
    for (size_t i = 0; i < low_speech.size(); ++i) {
        low_speech[i] = (i & 1) ? 220 : -220;
        noise[i] = (i & 1) ? 40 : -40;
    }
    for (int i = 0; i < 100; i++) assert(!quiet_voice.feed(noise.data(), noise.size()));
    assert(!quiet_voice.heard);
    for (int i = 0; i < 10; i++) assert(!quiet_voice.feed(low_speech.data(), low_speech.size()));
    assert(quiet_voice.heard);
    assert(quiet_voice.speech_start() == 32000);
    for (int i = 0; i < 39; i++) assert(!quiet_voice.feed(noise.data(), noise.size()));
    assert(quiet_voice.feed(noise.data(), noise.size()));
    if (argc > 2) {
        std::ifstream wav_file(argv[2], std::ios::binary);
        std::vector<uint8_t> recorded{std::istreambuf_iterator<char>(wav_file), std::istreambuf_iterator<char>()};
        assert(recorded.size() > 44 && std::memcmp(recorded.data(), "RIFF", 4) == 0);
        speech::Vad actual(800);
        size_t end = 44;
        for (; end + 640 <= recorded.size(); end += 640) {
            std::array<int16_t, 320> block;
            for (size_t i = 0; i < block.size(); i++) block[i] = int16_t(uint16_t(recorded[end + i * 2]) | uint16_t(recorded[end + i * 2 + 1]) << 8);
            if (actual.feed(block.data(), block.size())) break;
        }
        assert(actual.heard);
        std::cout << "device microphone fixture: speech detected, endpoint at " << (end - 44) / 32 << " ms\n";
    }

    // Reproduce a consumer stall longer than the old 16 KiB / 512 ms queue.
    std::vector<int16_t> captured(speech::kRate * 3, -1);
    speech::PcmCapture capture(captured.data(), captured.size());
    for (int i = 0; i < 200; i++) capture.feed(spoken.data(), spoken.size());
    for (int i = 0; i < 80; i++) capture.feed(silent.data(), silent.size());
    assert(capture.size() == 44800);
    assert(std::all_of(captured.begin(), captured.begin() + 32000, [](int16_t s) { return s == 6000; }));
    assert(std::all_of(captured.begin() + 32000, captured.begin() + 44800, [](int16_t s) { return s == 0; }));
    speech::Vad delayed(800);
    for (size_t at = 0; at < capture.size(); at += 160)
        assert(delayed.feed(captured.data() + at, 160) == (at + 160 == capture.size()));
    assert(delayed.heard);
    capture.stop();
    capture.feed(spoken.data(), spoken.size());
    assert(capture.size() == 44800 && captured[44800] == -1);

    std::array<int16_t, 323> bounded{};
    bounded.fill(-1);
    speech::PcmCapture full(bounded.data() + 1, 321);
    for (int i = 0; i < 4; i++) full.feed(spoken.data(), spoken.size());
    assert(full.size() == 321 && bounded.front() == -1 && bounded.back() == -1);
    assert(std::all_of(bounded.begin() + 1, bounded.end() - 1, [](int16_t s) { return s == 6000; }));
    speech::PcmCapture missing_storage(nullptr, 160);
    missing_storage.feed(spoken.data(), spoken.size());
    assert(missing_storage.size() == 0);

    // Published prefixes must be readable while later frames are being copied.
    std::vector<int16_t> concurrent(speech::kRate * 15, -1);
    speech::PcmCapture concurrent_capture(concurrent.data(), concurrent.size());
    std::thread producer([&] {
        for (size_t at = 0; at < concurrent.size(); at += spoken.size())
            concurrent_capture.feed(spoken.data(), spoken.size());
    });
    size_t checked = 0;
    while (checked < concurrent.size()) {
        const size_t published = concurrent_capture.size();
        while (checked < published) assert(concurrent[checked++] == 6000);
        std::this_thread::yield();
    }
    producer.join();
    std::cout << "speech capture: delayed VAD/no frame loss/capacity/cancel/concurrent publication checks passed\n";
    std::cout << "speech core: region/SSML/WAV/VAD/impulse checks passed\n";
}
