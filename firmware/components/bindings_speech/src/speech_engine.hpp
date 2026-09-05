#pragma once

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "hal_audio/hal_audio.hpp"
#include "jsvm/jsvm.hpp"

namespace speech {

struct Config {
    std::string region, key, language = "zh-CN", voice = "zh-CN-XiaoxiaoNeural";
    ~Config() { std::fill(key.begin(), key.end(), '\0'); }
};

enum class Kind { Wake, Recognize, Speak };
struct Job {
    Kind kind;
    uint32_t generation = 0;
    int max_ms = 15000, silence_ms = 800, timeout_ms = 20000;
    float threshold = 0.8f;
    std::string text;
    Config config;
    jsvm::Callback resolve, reject, callback, error_callback;
    std::atomic<bool> settled{false};
    void done(const std::string& result = "", bool text_result = false);
    void fail(const std::string& error);
};

class Engine : public std::enable_shared_from_this<Engine> {
public:
    static std::shared_ptr<Engine> create();
    ~Engine();
    bool submit(const std::shared_ptr<Job>& job);
    void cancel(bool wake_only = false);
    void shutdown();
    bool active(const Job& job) const;
    Config config;

private:
    void run();
    void wake(const std::shared_ptr<Job>& job);
    void recognize(const std::shared_ptr<Job>& job);
    void speak(const std::shared_ptr<Job>& job);
    void detach_audio();
    bool set_mic(int id, const Job& job);
    bool set_player(const std::shared_ptr<hal_audio::PcmRingSource>& player, const Job& job);
    QueueHandle_t queue_ = nullptr;
    std::atomic<bool> alive_{true};
    std::atomic<uint32_t> generation_{0};
    std::mutex mutex_;
    std::shared_ptr<Job> current_;
    int mic_id_ = -1;
    std::shared_ptr<hal_audio::PcmRingSource> player_;
};

}  // namespace speech
