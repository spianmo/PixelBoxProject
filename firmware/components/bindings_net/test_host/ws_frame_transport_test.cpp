#include <algorithm>
#include <cassert>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <vector>
#include "esp_transport.h"
#include "ws_frame_transport.hpp"

extern "C" int __wrap_esp_transport_ws_send_raw(esp_transport_handle_t, int, const char*, int, int);

static int ws_object, stream_object;
static auto ws = static_cast<void*>(&ws_object);
static auto stream = static_cast<void*>(&stream_object);
static std::vector<uint8_t> wire;
static int calls = 0, max_write = 100000, fail_at = -1, poll_result = 1;
static int64_t now_us = 0;
static int write_delay_ms = 0;
static bool oom = false;
static std::vector<int> timeouts;

void* heap_caps_malloc(size_t size, int) { return oom ? nullptr : std::malloc(size); }
void heap_caps_free(void* ptr) { std::free(ptr); }
void esp_fill_random(void* ptr, size_t size) {
  for (size_t i = 0; i < size; ++i) static_cast<uint8_t*>(ptr)[i] = 0x91 + i;
}
int64_t esp_timer_get_time() { return now_us; }
int esp_transport_poll_write(esp_transport_handle_t t, int timeout) {
  assert(t == stream);
  timeouts.push_back(timeout);
  return timeout == 0 ? 0 : poll_result;
}
int esp_transport_write(esp_transport_handle_t t, const char* data, int len, int) {
  assert(t == stream);
  if (calls++ == fail_at) return -1;
  int count = std::min(len, max_write);
  wire.insert(wire.end(), data, data + count);
  now_us += write_delay_ms * 1000;
  return count;
}
extern "C" int __real_esp_transport_ws_send_raw(esp_transport_handle_t, int, const char*, int, int) { return 777; }

static void reset() {
  wire.clear(); timeouts.clear(); calls = 0; max_write = 100000; fail_at = -1;
  poll_result = 1; now_us = 0; write_delay_ms = 0; oom = false;
}

// 用独立接收端解析检查掩码、长度与内容，覆盖控制帧和延续帧。
static void check_frame(size_t len, uint8_t opcode) {
  reset();
  std::vector<char> payload(len);
  for (size_t i = 0; i < len; ++i) payload[i] = char(i % 251);
  const auto original = payload;
  int result = __wrap_esp_transport_ws_send_raw(ws, opcode, payload.data(), len, 1000);
  assert(result == int(len)); assert(calls == 1); assert(original == payload);
  assert(wire[0] == opcode && (wire[1] & 0x80));
  size_t offset = 2;
  uint64_t decoded_length = wire[1] & 127;
  if (decoded_length >= 126) {
    size_t width = decoded_length == 126 ? 2 : 8;
    decoded_length = 0;
    for (size_t i = 0; i < width; ++i) decoded_length = (decoded_length << 8) | wire[offset++];
  }
  assert(decoded_length == len && wire.size() == offset + 4 + len);
  for (size_t i = 0; i < len; ++i) assert((wire[offset + 4 + i] ^ wire[offset + i % 4]) == uint8_t(payload[i]));
}

int main() {
  ws_frame_transport_register(ws, stream);
  for (size_t len : {0, 1, 125, 126, 1030, 4096, 65535, 65536}) check_frame(len, 0x82);
  for (uint8_t opcode : {0x01, 0x00, 0x80, 0x88, 0x89, 0x8a}) check_frame(7, opcode);
  reset(); max_write = 3;
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "abcdef", 6, 1000) == 6);
  assert(calls == 4 && wire.size() == 12); // 部分写继续原帧，不重复帧头。
  reset(); max_write = 3; fail_at = 1;
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "abcdef", 6, 1000) == -1);
  assert(calls == 2 && wire.size() == 3);
  reset(); max_write = 3; write_delay_ms = 6;
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "abcdef", 6, 10) == -1);
  assert((timeouts == std::vector<int>{10, 4})); // 整帧共用截止时间。
  reset(); poll_result = 0;
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x89, nullptr, 0, 1000) == -1 && calls == 0);
  reset(); oom = true;
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "a", 1, 1000) == -1 && calls == 0);
  reset();
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, nullptr, 1, 1000) == -1);
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, nullptr, -1, 1000) == -1);
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "a", 65537, 1000) == -1);
  ws_frame_transport_unregister(ws);
  assert(__wrap_esp_transport_ws_send_raw(ws, 0x82, "a", 1, 1000) == 777);
  std::puts("WebSocket 完整帧、掩码、控制帧、部分写、失败、总超时与生命周期测试通过");
}
