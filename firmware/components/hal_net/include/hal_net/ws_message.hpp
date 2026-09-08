#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace hal_net {

// ESP-IDF 的一次 DATA 事件可能只是帧的一部分；FIN 才表示整条消息结束。
class WsMessage {
public:
    enum class Result { Pending, Complete, Invalid };
    explicit WsMessage(size_t limit = 262144) : limit_(limit) {}
    Result feed(int opcode, bool fin, int offset, int frame_size, const char* data, int size) {
        if (size < 0 || offset < 0 || frame_size < 0 || offset > frame_size
                || size > frame_size - offset || (size && !data)) return Result::Invalid;
        if (offset == 0) {
            if (frame_open_) return Result::Invalid;
            if (opcode == 1 || opcode == 2) {
                if (active_) return Result::Invalid;
                bytes.clear(); type = opcode; active_ = true;
            } else if (opcode != 0 || !active_) return Result::Invalid;
            frame_open_ = true; offset_ = 0; frame_size_ = frame_size;
        }
        if (!frame_open_ || offset != offset_ || frame_size != frame_size_
                || static_cast<size_t>(size) > limit_ - bytes.size()) return Result::Invalid;
        if (size) bytes.insert(bytes.end(), data, data + size);
        offset_ += size;
        if (offset_ != frame_size_) return Result::Pending;
        frame_open_ = false;
        if (!fin) return Result::Pending;
        active_ = false;
        return Result::Complete;
    }
    std::vector<uint8_t> bytes;
    int type = 0;
private:
    size_t limit_;
    int offset_ = 0, frame_size_ = 0;
    bool active_ = false, frame_open_ = false;
};

}  // namespace hal_net
