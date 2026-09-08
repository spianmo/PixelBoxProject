#include <cassert>
#include <iostream>
#include "speech_protocol.hpp"
#include "hal_net/ws_message.hpp"

int main() {
    using Message = hal_net::WsMessage;
    using Result = Message::Result;
    Message message(20);
    // UTF-8 和 JSON 可以同时跨传输缓冲、RFC continuation 帧，最后一帧才可交付。
    const std::string body = "{\"Text\":\"你好\"}";
    assert(message.feed(1, false, 0, 11, body.data(), 10) == Result::Pending);
    assert(message.feed(1, false, 10, 11, body.data() + 10, 1) == Result::Pending);
    assert(message.feed(0, true, 0, body.size() - 11, body.data() + 11, body.size() - 11) == Result::Complete);
    assert(std::string(message.bytes.begin(), message.bytes.end()) == body);
    assert(message.type == 1);
    assert(message.feed(2, true, 0, 0, nullptr, 0) == Result::Complete);
    assert(message.bytes.empty() && message.type == 2);
    assert(message.feed(0, true, 0, 0, nullptr, 0) == Result::Invalid);
    Message oversized(2);
    assert(oversized.feed(1, true, 0, 3, "abc", 3) == Result::Invalid);
    Message missing;
    assert(missing.feed(1, true, 0, 4, "ab", 2) == Result::Pending);
    assert(missing.feed(1, true, 3, 4, "d", 1) == Result::Invalid);
    Message interrupted;
    assert(interrupted.feed(1, false, 0, 1, "a", 1) == Result::Pending);
    assert(interrupted.feed(1, true, 0, 1, "b", 1) == Result::Invalid);

    const auto audio = speech::speech_audio("id", "2026-09-08T01:02:03Z", reinterpret_cast<const uint8_t*>("pcm"), 3);
    const size_t header_size = (audio[0] << 8) | audio[1];
    assert(audio.size() == 2 + header_size + 3);
    assert(std::string(audio.end() - 3, audio.end()) == "pcm");
    assert(std::string(audio.begin() + 2, audio.begin() + 2 + header_size).find("Path: audio\r\n") == 0);
    const auto eos = speech::speech_audio("id", "timestamp", nullptr, 0);
    assert(eos.size() == 2 + size_t((eos[0] << 8) | eos[1]));

    speech::SpeechResponse response;
    const auto frame = [](const char* path, const char* json, const char* id = "id") {
        return speech::speech_headers(path, id, "timestamp") + "Content-Type: application/json\r\n\r\n" + json;
    };
    assert(response.feed(frame("speech.hypothesis", "{\"Text\":\"你好\"}"), "id"));
    assert(response.partial == "你好" && response.text.empty() && !response.ended);
    assert(!response.feed(frame("speech.phrase", "{\"RecognitionStatus\":\"Success\",\"DisplayText\":\"旧轮\"}", "stale"), "id"));
    assert(response.text.empty());
    assert(response.feed(frame("speech.phrase", "{\"RecognitionStatus\":\"Success\",\"DisplayText\":\"你好。\"}"), "id"));
    assert(response.text == "你好。" && !response.ended);
    assert(response.feed(frame("speech.hypothesis", "{\"Text\":\"天气\"}"), "id"));
    assert(response.partial == "你好。天气");
    assert(response.feed(frame("speech.phrase", "{\"RecognitionStatus\":\"Success\",\"DisplayText\":\"天气好。\"}"), "id"));
    assert(!response.feed(frame("speech.phrase", "{\"RecognitionStatus\":\"EndOfDictation\"}"), "id"));
    assert(response.error.empty());
    response.feed("pAtH: turn.end\r\nx-requestid: id\r\n\r\n", "id");
    assert(response.ended && response.text == "你好。天气好。");
    speech::SpeechResponse malformed;
    malformed.feed(frame("speech.hypothesis", "{"), "id");
    assert(!malformed.error.empty());
    speech::SpeechResponse bounded;
    bounded.feed(frame("speech.hypothesis", ("{\"Text\":\"" + std::string(32769, 'x') + "\"}").c_str()), "id");
    assert(!bounded.error.empty() && bounded.partial.empty());
    std::cout << "speech streaming protocol and WebSocket fragmentation passed\n";
}
