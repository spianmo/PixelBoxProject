#pragma once

#include <cctype>
#include <cstring>
#include <string>
#include <vector>

#include "cJSON.h"

namespace speech {

inline std::string speech_headers(const std::string& path, const std::string& id, const std::string& timestamp) {
    return "Path: " + path + "\r\nX-RequestId: " + id + "\r\nX-Timestamp: " + timestamp + "\r\n";
}

inline std::vector<uint8_t> speech_audio(const std::string& id, const std::string& timestamp,
                                        const uint8_t* pcm, size_t size) {
    // 对齐 Azure Speech SDK：两字节大端头长、CRLF 头、二进制音频；空正文表示输入结束。
    const auto header = speech_headers("audio", id, timestamp) + (size ? "Content-Type: audio/x-wav\r\n" : "");
    std::vector<uint8_t> frame{uint8_t(header.size() >> 8), uint8_t(header.size())};
    frame.insert(frame.end(), header.begin(), header.end());
    if (size) frame.insert(frame.end(), pcm, pcm + size);
    return frame;
}

struct SpeechResponse {
    std::string text, partial, error;
    bool ended = false;
    bool feed(const std::string& message, const std::string& request_id) {
        const auto split = message.find("\r\n\r\n");
        if (split == std::string::npos) { error = "Azure 语音消息格式错误"; return false; }
        std::string path, id;
        size_t start = 0;
        while (start < split) {
            const auto end = message.find("\r\n", start);
            const auto colon = message.find(':', start);
            if (colon != std::string::npos && colon < end) {
                auto name = message.substr(start, colon - start);
                for (auto& ch : name) ch = std::tolower(static_cast<unsigned char>(ch));
                auto value = message.substr(colon + 1, end - colon - 1);
                const auto first = value.find_first_not_of(" \t");
                value = first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \t") - first + 1);
                if (name == "path") path = value;
                else if (name == "x-requestid") id = value;
            }
            start = end + 2;
        }
        if (id != request_id) return false;
        if (path == "turn.end") { ended = true; return false; }
        if (path != "speech.hypothesis" && path != "speech.phrase") return false;
        auto* json = cJSON_ParseWithLength(message.data() + split + 4, message.size() - split - 4);
        if (!json) { error = "Azure 语音响应格式错误"; return false; }
        const auto* value = cJSON_GetObjectItemCaseSensitive(json, path == "speech.hypothesis" ? "Text" : "DisplayText");
        const auto* status = cJSON_GetObjectItemCaseSensitive(json, "RecognitionStatus");
        bool changed = false;
        if (path == "speech.hypothesis" || (cJSON_IsString(status) && std::strcmp(status->valuestring, "Success") == 0)) {
            if (cJSON_IsString(value)) {
                const std::string next = text + value->valuestring;
                if (next.size() > 32768) error = "Azure 识别响应超出限制";
                else {
                    changed = partial != next;
                    partial = next;
                    if (path == "speech.phrase") text = next;
                }
            }
        } else if (cJSON_IsString(status) && std::strcmp(status->valuestring, "NoMatch") != 0
                && std::strcmp(status->valuestring, "InitialSilenceTimeout") != 0
                && std::strcmp(status->valuestring, "EndOfDictation") != 0) error = "Azure 语音识别失败";
        cJSON_Delete(json);
        return changed;
    }
};

}  // namespace speech
