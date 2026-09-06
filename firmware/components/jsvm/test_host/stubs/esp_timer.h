#pragma once
#include <atomic>
#include <cstdint>
namespace host {
inline std::atomic<int64_t> now_us{1000000};
inline std::atomic<int64_t> clock_step_us{0};
}
inline int64_t esp_timer_get_time() { return host::now_us.fetch_add(host::clock_step_us.load()); }
