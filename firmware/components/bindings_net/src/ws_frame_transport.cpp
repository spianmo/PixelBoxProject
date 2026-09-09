#include "ws_frame_transport.hpp"

#include <algorithm>
#include <map>
#include <mutex>

#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_transport_ws.h"

namespace {
std::mutex registry_mutex;
std::map<esp_transport_handle_t, esp_transport_handle_t> streams;
}

void ws_frame_transport_register(esp_transport_handle_t ws, esp_transport_handle_t stream) {
  std::lock_guard<std::mutex> lock(registry_mutex);
  streams.emplace(ws, stream);
}

void ws_frame_transport_unregister(esp_transport_handle_t ws) {
  std::lock_guard<std::mutex> lock(registry_mutex);
  streams.erase(ws);
}

extern "C" int __real_esp_transport_ws_send_raw(esp_transport_handle_t,
    ws_transport_opcodes_t, const char*, int, int);

// 仍由 esp_websocket_client 的 TX 锁串行调用，握手、TLS、收包、控制帧及分片
// 生命周期不变。一次提交完整掩码帧，避免 TCP_NODELAY 把短帧头单独发成一个包。
extern "C" int __wrap_esp_transport_ws_send_raw(esp_transport_handle_t ws,
    ws_transport_opcodes_t opcode, const char* payload, int len, int timeout_ms) {
  esp_transport_handle_t stream = nullptr;
  {
    std::lock_guard<std::mutex> lock(registry_mutex);
    auto it = streams.find(ws);
    if (it != streams.end()) stream = it->second;
  }
  if (!stream) return __real_esp_transport_ws_send_raw(ws, opcode, payload, len, timeout_ms);
  if (len < 0 || len > 65536 || (len && !payload)) return -1;
  const size_t header = len <= 125 ? 6 : len < 65536 ? 8 : 14;
  const size_t size = header + size_t(len);
  auto* frame = static_cast<uint8_t*>(heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!frame) frame = static_cast<uint8_t*>(heap_caps_malloc(size, MALLOC_CAP_8BIT));
  if (!frame) return -1;
  frame[0] = uint8_t(opcode);
  frame[1] = 0x80 | (len <= 125 ? len : len < 65536 ? 126 : 127);
  if (header == 8) {
    frame[2] = uint8_t(len >> 8); frame[3] = uint8_t(len);
  } else if (header == 14) {
    for (int i = 0; i < 8; ++i) frame[2 + i] = uint8_t(uint64_t(len) >> (56 - i * 8));
  }
  uint8_t* mask = frame + header - 4;
  esp_fill_random(mask, 4);
  for (int i = 0; i < len; ++i) frame[header + i] = uint8_t(payload[i]) ^ mask[i % 4];

  // 部分写必须继续同一帧的剩余字节；不可交给上层作为新 WebSocket 帧重发。
  const int64_t deadline = esp_timer_get_time() + int64_t(timeout_ms) * 1000;
  size_t written = 0;
  while (written < size) {
    if (written && timeout_ms >= 0 && esp_timer_get_time() >= deadline) break;
    int remaining_ms = timeout_ms < 0 ? -1 : int(std::max<int64_t>(0,
        (deadline - esp_timer_get_time() + 999) / 1000));
    if (esp_transport_poll_write(stream, remaining_ms) <= 0) break;
    remaining_ms = timeout_ms < 0 ? -1 : int(std::max<int64_t>(0,
        (deadline - esp_timer_get_time() + 999) / 1000));
    const int count = esp_transport_write(stream, reinterpret_cast<char*>(frame + written),
        size - written, remaining_ms);
    if (count <= 0) break;
    written += count;
  }
  heap_caps_free(frame);
  return written == size ? len : -1;
}
