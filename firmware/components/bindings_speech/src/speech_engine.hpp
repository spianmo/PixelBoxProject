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
#include "speech_core.hpp"

namespace speech {

struct Config {
    std::string region, key, language = "zh-CN", voice = "zh-CN-XiaoxiaoNeural";
    ~Config() { std::fill(key.begin(), key.end(), '\0'); }
};

enum class Kind { Wake, Recognize, Speak };
enum class Role { Operation, Wake };
struct Recording;
struct TtsConnection;
struct Job {
    Kind kind;
    uint32_t generation = 0;
    int max_ms = 15000, silence_ms = 800, timeout_ms = 20000;
    WakeConfig wake_config;
    std::string text;
    Config config;
    std::shared_ptr<Recording> recording;
    jsvm::Callback resolve, reject, callback, error_callback, partial_callback;
    std::atomic<bool> settled{false};
    void done(const std::string& result = "", bool text_result = false);
    void fail(const std::string& error);
};

class Engine : public std::enable_shared_from_this<Engine> {
public:
    // Called on the JS thread's internal stack before posting a wake job.
    static const char* prepare_model_mapping();
    static std::shared_ptr<Engine> create(Role role);
    ~Engine();
    bool submit(const std::shared_ptr<Job>& job);
    void cancel();
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
    // 仅 operation worker 访问；相邻分句复用 TLS，空闲或转入录音时释放。
    std::shared_ptr<TtsConnection> tts_connection_;
    Role role_ = Role::Operation;
};

}  // namespace speech
