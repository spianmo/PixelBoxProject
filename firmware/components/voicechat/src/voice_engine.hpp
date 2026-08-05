/**
 * PixelBox voicechat — 语音对话引擎(architecture.md §7 客户端)
 *
 * 状态机:idle → connecting → listening(VAD 收音) → thinking(等 LLM)
 *        → speaking(播 TTS) → idle / listening(持续模式)
 *
 * 协议(ws://<server>:8787/realtime?token=...):
 *   上行二进制:PCM16LE 16kHz 单声道麦克风帧(listening 期间持续)
 *   上行文本:session.start / speech.end / interrupt / text.input
 *   下行文本:stt.final / llm.delta / llm.done / tts.begin / tts.end / error
 *   下行二进制:TTS PCM16LE(采样率以 tts.begin 为准)→ 直接喂播放环形缓冲
 *
 * barge-in:speaking 期间 mic 持续采集,检测到持续人声(高倍率阈值,
 * 无 AEC 故较保守)→ 上行 interrupt → 停播 → 回 listening(预滚缓冲补发)。
 *
 * 线程:JS 线程(API 调用)/ WS 任务(下行)/ 采集任务(VAD+上行入环)/
 * 上行发送任务 / 播放任务(TTS 排空回调)。状态由互斥锁保护;
 * 事件通过 Events 回调抛出(由 bindings 层经 jsvm::post 转 JS 线程)。
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "hal_audio/audio_source.hpp"
#include "vad.hpp"
#include "wakeword.hpp"

namespace voicechat {

enum class State : uint8_t { Idle, Connecting, Listening, Thinking, Speaking };

const char* state_name(State s);

class VoiceEngine {
public:
    static VoiceEngine& instance();

    struct Options {
        std::string server_url;
        std::string token;
        bool wakeword = false;
        int vad_silence_ms = 800;
    };

    /** 事件回调集合(任意内部线程触发;bindings 层负责投递 JS) */
    struct Events {
        std::function<void(State)> state_change;
        std::function<void()> wake;
        std::function<void()> speech_start;
        std::function<void()> speech_end;
        std::function<void(const std::string&)> user_text;
        std::function<void(const std::string&)> assistant_delta;
        std::function<void(const std::string&)> assistant_text;
        std::function<void(int)> level;  // 已做 100ms 节流
        std::function<void(const std::string&)> error;
        /** say() 完成回调:say_id, ok, 错误消息 */
        std::function<void(int, bool, const std::string&)> say_done;
    };

    void set_events(Events ev);
    void configure(const Options& opts);
    bool configured() const;

    /** 单轮对话(听→想→说→idle);wakeword 模式下由唤醒自动触发 */
    void start();
    /** 持续对话:说完自动回到 listening */
    void start_continuous();
    void stop();
    /** 打断当前 TTS 播报(手动 barge-in) */
    void interrupt();
    /** 文本直达 LLM+TTS */
    void send_text(const std::string& text);
    /**
     * 服务器 TTS 播报;返回 say_id(<0 = 失败:未配置/忙)。
     * 完成经 events.say_done 通知。
     */
    int say(const std::string& text);

    State state() const;

private:
    VoiceEngine() = default;
    struct Impl;
    Impl* impl();  // 惰性创建
    Impl* impl_ = nullptr;
    std::mutex impl_mtx_;
};

}  // namespace voicechat
