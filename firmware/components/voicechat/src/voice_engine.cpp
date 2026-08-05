/**
 * PixelBox voicechat — 语音对话引擎实现
 */
#include "voice_engine.hpp"

#include <algorithm>
#include <cstring>
#include <vector>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_audio/hal_audio.hpp"
#include "sdkconfig.h"

namespace voicechat {

static const char* TAG = "px.voice";

const char* state_name(State s) {
    switch (s) {
        case State::Idle: return "idle";
        case State::Connecting: return "connecting";
        case State::Listening: return "listening";
        case State::Thinking: return "thinking";
        case State::Speaking: return "speaking";
    }
    return "idle";
}

namespace {
// VAD / barge-in 时序参数
constexpr int kSpeechStartFrames = 3;     // 60ms 连续语音 → speechStart
constexpr int kBargeFrames = 12;          // 240ms 连续强语音 → barge-in(无 AEC,保守)
constexpr float kBargeFactor = 6.0f;      // barge 阈值 = 噪声底 × 6
constexpr float kBargeMinRms = 500.0f;    // barge 绝对能量下限
constexpr uint32_t kMaxListenMs = 15000;  // 单轮无语音超时
constexpr size_t kPrerollSamples = 8000;  // barge 预滚 500ms @16k
constexpr uint32_t kUplinkRate = 16000;   // 协议上行采样率
constexpr uint64_t kSayTimeoutUs = 60ULL * 1000 * 1000;
}  // namespace

// ============================================================
// Impl
// ============================================================

struct VoiceEngine::Impl {
    std::mutex mtx;
    Events ev;
    Options opts;
    bool configured = false;

    State st = State::Idle;
    bool continuous = false;
    bool session_round = false;  // start()/startContinuous() 发起的对话轮

    // ---- WebSocket ----
    esp_websocket_client_handle_t ws = nullptr;
    std::string ws_uri;          // 当前 client 使用的 uri
    bool ws_started = false;
    std::atomic<bool> ws_connected{false};
    std::string rx_acc;          // 分片文本帧累积
    int rx_op = 0;               // 当前消息 op (1=text 2=binary)

    // ---- mic / VAD ----
    int mic_sink = -1;
    hal_audio::LinearResampler mic_rs;  // 设备率 → 16k
    std::vector<int16_t> vad_acc;
    EnergyVad vad;
    int speech_run = 0;
    uint32_t silence_ms = 0;
    bool speech_started = false;
    uint32_t listen_ms = 0;
    int barge_run = 0;
    int64_t last_level_us = 0;

    // barge 预滚缓冲(speaking 期间循环写入)
    int16_t* preroll = nullptr;
    size_t preroll_wr = 0;
    bool preroll_full = false;

    // ---- 上行环形缓冲 + 发送任务 ----
    uint8_t* up_buf = nullptr;
    size_t up_cap = 0, up_rd = 0, up_wr = 0, up_used = 0;
    std::mutex up_mtx;
    std::atomic<bool> end_round_pending{false};
    TaskHandle_t sender = nullptr;
    std::atomic<bool> sender_run{false};

    // ---- TTS 下行 ----
    std::shared_ptr<hal_audio::PcmRingSource> tts_ring;
    int64_t last_feed_warn_us = 0;

    // ---- 连接后待执行动作 ----
    enum class Pending : uint8_t { None, Round, Text, Say };
    Pending pending = Pending::None;
    std::string pending_text;

    // ---- say ----
    int say_seq = 1;
    int active_say = -1;
    esp_timer_handle_t say_timer = nullptr;

    // ---- wakeword ----
    WakewordDetector wake;
    bool wake_enabled = false;

    // ============================================================

    Impl() {
        up_cap = static_cast<size_t>(CONFIG_PX_VOICE_UPLINK_RING_KB) * 1024;
        up_buf = static_cast<uint8_t*>(hal_audio::big_alloc(up_cap));
        preroll = static_cast<int16_t*>(hal_audio::big_alloc(kPrerollSamples * 2));
        esp_timer_create_args_t targs = {};
        targs.callback = [](void* arg) { static_cast<Impl*>(arg)->on_say_timeout(); };
        targs.arg = this;
        targs.dispatch_method = ESP_TIMER_TASK;
        targs.name = "px_voice_say";
        esp_timer_create(&targs, &say_timer);
    }

    // ---------- 事件(可在持锁时调用;回调侧只做 jsvm::post) ----------
    void emit_state_locked() {
        if (ev.state_change) ev.state_change(st);
    }
    void set_state_locked(State ns) {
        if (st == ns) return;
        st = ns;
        ESP_LOGI(TAG, "状态 → %s", state_name(ns));
        emit_state_locked();
    }
    void emit_error_locked(const std::string& msg) {
        ESP_LOGW(TAG, "错误: %s", msg.c_str());
        if (ev.error) ev.error(msg);
    }

    // ---------- 上行环 ----------
    void up_clear() {
        std::lock_guard<std::mutex> lk(up_mtx);
        up_rd = up_wr = up_used = 0;
    }
    void up_push(const uint8_t* d, size_t n) {
        std::lock_guard<std::mutex> lk(up_mtx);
        if (!up_buf || n > up_cap) return;
        // 满则丢最旧
        if (up_used + n > up_cap) {
            const size_t drop = up_used + n - up_cap;
            up_rd = (up_rd + drop) % up_cap;
            up_used -= drop;
        }
        size_t c = 0;
        while (c < n) {
            const size_t chunk = std::min(n - c, up_cap - up_wr);
            memcpy(up_buf + up_wr, d + c, chunk);
            up_wr = (up_wr + chunk) % up_cap;
            c += chunk;
        }
        up_used += n;
    }
    size_t up_pop(uint8_t* d, size_t max) {
        std::lock_guard<std::mutex> lk(up_mtx);
        const size_t n = std::min(up_used, max);
        size_t c = 0;
        while (c < n) {
            const size_t chunk = std::min(n - c, up_cap - up_rd);
            memcpy(d + c, up_buf + up_rd, chunk);
            up_rd = (up_rd + chunk) % up_cap;
            c += chunk;
        }
        up_used -= n;
        return n;
    }

    // ---------- WS ----------
    static void ws_event_tramp(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
        static_cast<Impl*>(arg)->on_ws_event(event_id,
                                             static_cast<esp_websocket_event_data_t*>(event_data));
    }

    std::string build_uri() const {
        std::string uri = opts.server_url;
        if (!opts.token.empty()) {
            uri += (uri.find('?') == std::string::npos) ? "?token=" : "&token=";
            uri += opts.token;
        }
        return uri;
    }

    /** 需持 mtx */
    bool ensure_ws_locked() {
        const std::string uri = build_uri();
        if (ws && uri != ws_uri) {
            // 配置变更:仅在未连接时重建
            if (!ws_connected.load()) {
                destroy_ws_locked();
            }
        }
        if (!ws) {
            esp_websocket_client_config_t cfg = {};
            cfg.uri = uri.c_str();
            cfg.buffer_size = 4096;
            cfg.task_stack = 6144;
            cfg.network_timeout_ms = 10000;
            // 自动重连交给 esp_websocket_client(断线后 CONNECTED 事件会重发 session.start)
            cfg.reconnect_timeout_ms = 3000;
            cfg.crt_bundle_attach = esp_crt_bundle_attach;
            ws = esp_websocket_client_init(&cfg);
            if (!ws) {
                emit_error_locked("WebSocket 客户端创建失败");
                return false;
            }
            ws_uri = uri;
            esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, ws_event_tramp, this);
        }
        if (!ws_started) {
            if (esp_websocket_client_start(ws) != ESP_OK) {
                emit_error_locked("WebSocket 连接启动失败");
                return false;
            }
            ws_started = true;
        }
        return true;
    }

    void destroy_ws_locked() {
        if (!ws) return;
        esp_websocket_client_stop(ws);
        esp_websocket_client_destroy(ws);
        ws = nullptr;
        ws_started = false;
        ws_connected.store(false);
    }

    bool send_json(cJSON* obj) {
        char* txt = cJSON_PrintUnformatted(obj);
        cJSON_Delete(obj);
        if (!txt) return false;
        bool ok = false;
        if (ws && ws_connected.load()) {
            ok = esp_websocket_client_send_text(ws, txt, static_cast<int>(strlen(txt)),
                                                pdMS_TO_TICKS(2000)) >= 0;
        }
        if (!ok) ESP_LOGW(TAG, "文本消息发送失败");
        cJSON_free(txt);
        return ok;
    }

    bool send_type_msg(const char* type) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "type", type);
        return send_json(o);
    }

    bool send_text_msg(const char* type, const std::string& text) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "type", type);
        cJSON_AddStringToObject(o, "text", text.c_str());
        return send_json(o);
    }

    void send_session_start() {
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        char dev[24];
        snprintf(dev, sizeof(dev), "px-%02x%02x%02x", mac[3], mac[4], mac[5]);
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "type", "session.start");
        cJSON_AddStringToObject(o, "device", dev);
        cJSON_AddNumberToObject(o, "sampleRate", kUplinkRate);
        send_json(o);
    }

    void on_ws_event(int32_t event_id, esp_websocket_event_data_t* data) {
        switch (event_id) {
            case WEBSOCKET_EVENT_CONNECTED: {
                std::lock_guard<std::mutex> lk(mtx);
                ws_connected.store(true);
                send_session_start();
                run_pending_locked();
                break;
            }
            case WEBSOCKET_EVENT_DISCONNECTED:
            case WEBSOCKET_EVENT_ERROR: {
                std::lock_guard<std::mutex> lk(mtx);
                ws_connected.store(false);
                // client 自动重连;进行中的会话立即失败回 idle
                if (st != State::Idle) {
                    emit_error_locked("与语音服务器连接断开");
                    fail_say_locked("connection lost");
                    to_idle_locked();
                }
                break;
            }
            case WEBSOCKET_EVENT_DATA:
                on_ws_data(data);
                break;
            default:
                break;
        }
    }

    void on_ws_data(esp_websocket_event_data_t* d) {
        if (!d) return;
        if (d->op_code == 0x08) return;  // close
        if (d->op_code == 0x09 || d->op_code == 0x0A) return;  // ping/pong
        if (d->payload_offset == 0 && (d->op_code == 0x01 || d->op_code == 0x02)) {
            rx_op = d->op_code;
            if (rx_op == 0x01) rx_acc.clear();
        }
        if (rx_op == 0x02) {
            // TTS 下行 PCM:直接喂播放环形缓冲(与 openPcmStream 同款)
            feed_tts(reinterpret_cast<const uint8_t*>(d->data_ptr),
                     static_cast<size_t>(d->data_len));
            return;
        }
        if (rx_op == 0x01) {
            rx_acc.append(d->data_ptr, static_cast<size_t>(d->data_len));
            if (d->payload_offset + d->data_len >= d->payload_len) {
                handle_text_message(rx_acc);
                rx_acc.clear();
            }
        }
    }

    void feed_tts(const uint8_t* buf, size_t len) {
        std::shared_ptr<hal_audio::PcmRingSource> ring;
        {
            std::lock_guard<std::mutex> lk(mtx);
            ring = tts_ring;
        }
        if (!ring || !buf || !len) return;
        const size_t n = ring->feed(buf, len);
        if (n < len) {
            const int64_t now = esp_timer_get_time();
            if (now - last_feed_warn_us > 1000000) {
                last_feed_warn_us = now;
                ESP_LOGW(TAG, "TTS 缓冲溢出,丢弃 %u 字节", static_cast<unsigned>(len - n));
            }
        }
    }

    void handle_text_message(const std::string& msg) {
        cJSON* root = cJSON_ParseWithLength(msg.c_str(), msg.size());
        if (!root) {
            ESP_LOGW(TAG, "无法解析下行消息: %.64s", msg.c_str());
            return;
        }
        const cJSON* jtype = cJSON_GetObjectItem(root, "type");
        const char* type = cJSON_IsString(jtype) ? jtype->valuestring : "";
        const cJSON* jtext = cJSON_GetObjectItem(root, "text");
        const char* text = cJSON_IsString(jtext) ? jtext->valuestring : "";

        std::lock_guard<std::mutex> lk(mtx);
        if (strcmp(type, "stt.final") == 0) {
            if (ev.user_text) ev.user_text(text);
        } else if (strcmp(type, "llm.delta") == 0) {
            if (ev.assistant_delta) ev.assistant_delta(text);
        } else if (strcmp(type, "llm.done") == 0) {
            if (ev.assistant_text) ev.assistant_text(text);
        } else if (strcmp(type, "tts.begin") == 0) {
            const cJSON* jsr = cJSON_GetObjectItem(root, "sampleRate");
            const uint32_t sr = cJSON_IsNumber(jsr) ? static_cast<uint32_t>(jsr->valuedouble)
                                                    : 16000;
            begin_tts_locked(sr);
        } else if (strcmp(type, "tts.end") == 0) {
            if (tts_ring) tts_ring->end();
        } else if (strcmp(type, "error") == 0) {
            const cJSON* jmsg = cJSON_GetObjectItem(root, "message");
            const std::string em = cJSON_IsString(jmsg) ? jmsg->valuestring : "服务器错误";
            emit_error_locked(em);
            fail_say_locked(em);
            if (session_round && continuous) {
                begin_round_locked();
            } else {
                to_idle_locked();
            }
        } else {
            ESP_LOGD(TAG, "忽略下行消息类型: %s", type);
        }
        cJSON_Delete(root);
    }

    // ---------- TTS 播放 ----------
    /** 需持 mtx */
    void begin_tts_locked(uint32_t sample_rate) {
        if (tts_ring) {
            tts_ring->stop();
            tts_ring = nullptr;
        }
        auto ring = hal_audio::PcmRingSource::create(
            sample_rate, 1, static_cast<size_t>(CONFIG_PX_VOICE_TTS_RING_KB) * 1024);
        if (!ring) {
            emit_error_locked("TTS 缓冲分配失败");
            return;
        }
        tts_ring = ring;
        Impl* self = this;
        std::weak_ptr<hal_audio::PcmRingSource> weak = ring;
        ring->on_finished([self, weak] { self->on_tts_drained(weak.lock()); });
        hal_audio::player_add(ring);
        barge_run = 0;
        preroll_wr = 0;
        preroll_full = false;
        set_state_locked(State::Speaking);
    }

    /** 播放任务上下文:TTS 排空/停止 */
    void on_tts_drained(const std::shared_ptr<hal_audio::PcmRingSource>& ring) {
        std::lock_guard<std::mutex> lk(mtx);
        if (!ring || ring != tts_ring) return;  // 已被 barge/stop 替换
        tts_ring = nullptr;
        finish_say_locked();
        if (st != State::Speaking) return;  // barge 已切走
        if (session_round && continuous) {
            begin_round_locked();
        } else {
            to_idle_locked();
        }
    }

    // ---------- say ----------
    void on_say_timeout() {
        std::lock_guard<std::mutex> lk(mtx);
        if (active_say < 0) return;
        const int id = active_say;
        active_say = -1;
        if (ev.say_done) ev.say_done(id, false, "timeout");
    }
    /** 需持 mtx:say 成功完成 */
    void finish_say_locked() {
        if (active_say < 0) return;
        esp_timer_stop(say_timer);
        const int id = active_say;
        active_say = -1;
        if (ev.say_done) ev.say_done(id, true, "");
    }
    /** 需持 mtx:say 失败 */
    void fail_say_locked(const std::string& why) {
        if (active_say < 0) return;
        esp_timer_stop(say_timer);
        const int id = active_say;
        active_say = -1;
        if (ev.say_done) ev.say_done(id, false, why);
    }

    // ---------- mic ----------
    /** 需持 mtx */
    bool ensure_mic_locked() {
        if (mic_sink >= 0) return true;
        mic_rs.reset(hal_audio::device_rate(), kUplinkRate);
        vad_acc.clear();
        Impl* self = this;
        mic_sink = hal_audio::mic_subscribe(
            [self](const int16_t* s, size_t n) { self->on_mic(s, n); });
        if (mic_sink < 0) {
            emit_error_locked("麦克风启动失败");
            return false;
        }
        return true;
    }
    /** 需持 mtx */
    void release_mic_if_unused_locked() {
        if (mic_sink >= 0 && st == State::Idle && !wake_enabled) {
            hal_audio::mic_unsubscribe(mic_sink);
            mic_sink = -1;
        }
    }

    /** 采集任务上下文 */
    void on_mic(const int16_t* samples, size_t count) {
        // 重采样到 16k
        size_t off = 0;
        auto pull = [&](int16_t* b, size_t m) {
            const size_t c = std::min(m, count - off);
            memcpy(b, samples + off, c * 2);
            off += c;
            return c;
        };
        int16_t tmp[256];
        for (;;) {
            const size_t got = mic_rs.produce(tmp, 256, pull);
            if (got == 0) break;
            vad_acc.insert(vad_acc.end(), tmp, tmp + got);
        }
        while (vad_acc.size() >= EnergyVad::kFrameSamples) {
            process_vad_frame(vad_acc.data());
            vad_acc.erase(vad_acc.begin(),
                          vad_acc.begin() + static_cast<long>(EnergyVad::kFrameSamples));
        }
    }

    /** 采集任务上下文:处理一个 20ms 帧 */
    void process_vad_frame(const int16_t* frame) {
        const bool sp = vad.process(frame, EnergyVad::kFrameSamples);
        const float rms = vad.last_rms();

        std::lock_guard<std::mutex> lk(mtx);

        // wakeword:idle 期喂 wakenet
        if (wake_enabled && st == State::Idle) {
            if (wake.feed(frame, EnergyVad::kFrameSamples)) {
                ESP_LOGI(TAG, "唤醒词触发");
                if (ev.wake) ev.wake();
                session_round = true;
                if (ws_connected.load()) {
                    begin_round_locked();
                } else {
                    pending = Pending::Round;
                    set_state_locked(State::Connecting);
                    ensure_ws_locked();
                }
            }
            return;
        }

        // level 事件(100ms 节流,仅会话期间)
        if (st == State::Listening || st == State::Thinking || st == State::Speaking) {
            const int64_t now = esp_timer_get_time();
            if (now - last_level_us >= 100000) {
                last_level_us = now;
                if (ev.level) ev.level(vad.level());
            }
        }

        switch (st) {
            case State::Listening: {
                // 上行推流(16k PCM16LE)
                up_push(reinterpret_cast<const uint8_t*>(frame), EnergyVad::kFrameSamples * 2);
                listen_ms += EnergyVad::kFrameMs;
                if (sp) {
                    speech_run++;
                    silence_ms = 0;
                } else {
                    speech_run = 0;
                    silence_ms += EnergyVad::kFrameMs;
                }
                if (!speech_started && speech_run >= kSpeechStartFrames) {
                    speech_started = true;
                    if (ev.speech_start) ev.speech_start();
                }
                if (speech_started &&
                    silence_ms >= static_cast<uint32_t>(opts.vad_silence_ms)) {
                    // 说完:排空上行后由发送任务补 speech.end
                    if (ev.speech_end) ev.speech_end();
                    end_round_pending.store(true);
                    set_state_locked(State::Thinking);
                } else if (!speech_started && listen_ms >= kMaxListenMs && !continuous) {
                    ESP_LOGI(TAG, "拾音超时,无语音输入");
                    to_idle_locked();
                }
                break;
            }
            case State::Speaking: {
                // 预滚缓冲(barge 后补发,弥补检测延迟)
                if (preroll) {
                    memcpy(preroll + preroll_wr, frame, EnergyVad::kFrameSamples * 2);
                    preroll_wr += EnergyVad::kFrameSamples;
                    if (preroll_wr >= kPrerollSamples) {
                        preroll_wr = 0;
                        preroll_full = true;
                    }
                }
                // barge-in:高倍率 + 持续帧数(无 AEC,防扬声器回灌误触发)
                const float th = std::max(vad.noise_floor() * kBargeFactor, kBargeMinRms);
                if (rms > th) barge_run++;
                else barge_run = 0;
                if (barge_run >= kBargeFrames) {
                    barge_locked();
                }
                break;
            }
            default:
                break;
        }
    }

    /** 需持 mtx:barge-in / 手动 interrupt */
    void barge_locked() {
        ESP_LOGI(TAG, "barge-in: 打断 TTS");
        send_type_msg("interrupt");
        fail_say_locked("interrupted");
        if (tts_ring) {
            tts_ring->stop();
            tts_ring = nullptr;
        }
        if (session_round) {
            // 回到 listening,预滚补发已说出的开头
            begin_round_locked();
            speech_started = true;
            speech_run = kSpeechStartFrames;
            if (ev.speech_start) ev.speech_start();
            flush_preroll_locked();
        } else {
            to_idle_locked();
        }
    }

    /** 需持 mtx */
    void flush_preroll_locked() {
        if (!preroll) return;
        if (preroll_full) {
            up_push(reinterpret_cast<const uint8_t*>(preroll + preroll_wr),
                    (kPrerollSamples - preroll_wr) * 2);
        }
        if (preroll_wr > 0) {
            up_push(reinterpret_cast<const uint8_t*>(preroll), preroll_wr * 2);
        }
        preroll_wr = 0;
        preroll_full = false;
    }

    // ---------- 轮次控制 ----------
    /** 需持 mtx:进入 listening */
    void begin_round_locked() {
        if (!ensure_mic_locked()) {
            to_idle_locked();
            return;
        }
        vad.reset_round();
        speech_run = 0;
        silence_ms = 0;
        speech_started = false;
        listen_ms = 0;
        barge_run = 0;
        up_clear();
        end_round_pending.store(false);
        ensure_sender_locked();
        set_state_locked(State::Listening);
    }

    /** 需持 mtx */
    void to_idle_locked() {
        end_round_pending.store(false);
        up_clear();
        if (tts_ring) {
            tts_ring->stop();
            tts_ring = nullptr;
        }
        session_round = false;
        pending = Pending::None;
        set_state_locked(State::Idle);
        release_mic_if_unused_locked();
    }

    /** 需持 mtx:连接建立后执行待定动作 */
    void run_pending_locked() {
        const Pending p = pending;
        pending = Pending::None;
        switch (p) {
            case Pending::Round:
                begin_round_locked();
                break;
            case Pending::Text:
                send_text_msg("text.input", pending_text);
                set_state_locked(State::Thinking);
                break;
            case Pending::Say:
                send_text_msg("tts.request", pending_text);
                esp_timer_stop(say_timer);
                esp_timer_start_once(say_timer, kSayTimeoutUs);
                set_state_locked(State::Thinking);
                break;
            case Pending::None:
                if (st == State::Connecting) set_state_locked(State::Idle);
                break;
        }
        pending_text.clear();
    }

    // ---------- 上行发送任务 ----------
    /** 需持 mtx */
    void ensure_sender_locked() {
        if (sender) return;
        sender_run.store(true);
        Impl* self = this;
        if (xTaskCreatePinnedToCore(
                [](void* arg) { static_cast<Impl*>(arg)->sender_main(); }, "px_voice_tx", 4096,
                self, 10, &sender, CONFIG_PX_AUDIO_TASK_CORE) != pdPASS) {
            sender = nullptr;
            sender_run.store(false);
            emit_error_locked("上行发送任务创建失败");
        }
    }

    void sender_main() {
        uint8_t buf[1920];  // 60ms @16k mono PCM16
        while (sender_run.load()) {
            const size_t n = up_pop(buf, sizeof(buf));
            if (n > 0) {
                if (ws && ws_connected.load()) {
                    if (esp_websocket_client_send_bin(ws, reinterpret_cast<const char*>(buf),
                                                      static_cast<int>(n),
                                                      pdMS_TO_TICKS(1000)) < 0) {
                        ESP_LOGW(TAG, "上行音频发送失败");
                    }
                }
                continue;
            }
            // 环已排空:若本轮拾音结束,补发 speech.end(保证音频先于控制消息)
            if (end_round_pending.exchange(false)) {
                std::lock_guard<std::mutex> lk(mtx);
                send_type_msg("speech.end");
            }
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        vTaskDelete(nullptr);
    }
};

// ============================================================
// VoiceEngine 公开方法
// ============================================================

VoiceEngine& VoiceEngine::instance() {
    static VoiceEngine e;
    return e;
}

VoiceEngine::Impl* VoiceEngine::impl() {
    std::lock_guard<std::mutex> lk(impl_mtx_);
    if (!impl_) impl_ = new Impl();
    return impl_;
}

void VoiceEngine::set_events(Events ev) {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    p->ev = std::move(ev);
}

void VoiceEngine::configure(const Options& opts) {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    p->opts = opts;
    if (p->opts.vad_silence_ms <= 0) p->opts.vad_silence_ms = 800;
    p->configured = !opts.server_url.empty();
    if (opts.wakeword) {
#if CONFIG_PX_ENABLE_WAKEWORD
        p->wake_enabled = p->wake.init();
        if (p->wake_enabled) p->ensure_mic_locked();
#else
        ESP_LOGW(TAG, "wakeword 需开启 Kconfig PX_ENABLE_WAKEWORD 并添加 esp-sr 依赖,已忽略");
        p->wake_enabled = false;
#endif
    } else {
        p->wake_enabled = false;
        p->release_mic_if_unused_locked();
    }
}

bool VoiceEngine::configured() const {
    Impl* p = const_cast<VoiceEngine*>(this)->impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    return p->configured;
}

void VoiceEngine::start() {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    if (!p->configured) {
        p->emit_error_locked("voice 未配置,请先调用 configure()");
        return;
    }
    if (p->st != State::Idle) {
        ESP_LOGW(TAG, "start(): 当前状态 %s,忽略", state_name(p->st));
        return;
    }
    p->continuous = false;
    p->session_round = true;
    if (!p->ensure_mic_locked()) return;
    if (p->ws_connected.load()) {
        p->begin_round_locked();
    } else {
        p->pending = Impl::Pending::Round;
        p->set_state_locked(State::Connecting);
        p->ensure_ws_locked();
    }
}

void VoiceEngine::start_continuous() {
    Impl* p = impl();
    {
        std::lock_guard<std::mutex> lk(p->mtx);
        if (!p->configured) {
            p->emit_error_locked("voice 未配置,请先调用 configure()");
            return;
        }
        if (p->st != State::Idle) {
            p->continuous = true;  // 已在会话中:仅切换模式
            return;
        }
        p->continuous = true;
        p->session_round = true;
        if (!p->ensure_mic_locked()) return;
        if (p->ws_connected.load()) {
            p->begin_round_locked();
        } else {
            p->pending = Impl::Pending::Round;
            p->set_state_locked(State::Connecting);
            p->ensure_ws_locked();
        }
    }
}

void VoiceEngine::stop() {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    p->continuous = false;
    p->fail_say_locked("stopped");
    if (p->st == State::Speaking) p->send_type_msg("interrupt");
    p->to_idle_locked();
}

void VoiceEngine::interrupt() {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    if (p->st != State::Speaking) return;
    p->barge_locked();
}

void VoiceEngine::send_text(const std::string& text) {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    if (!p->configured) {
        p->emit_error_locked("voice 未配置,请先调用 configure()");
        return;
    }
    p->ensure_mic_locked();  // 响应期支持 barge-in
    if (p->ws_connected.load()) {
        p->send_text_msg("text.input", text);
        if (p->st == State::Idle) p->set_state_locked(State::Thinking);
    } else {
        p->pending = Impl::Pending::Text;
        p->pending_text = text;
        if (p->st == State::Idle) p->set_state_locked(State::Connecting);
        p->ensure_ws_locked();
    }
}

int VoiceEngine::say(const std::string& text) {
    Impl* p = impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    if (!p->configured) return -1;
    if (p->active_say >= 0 || p->pending == Impl::Pending::Say) return -2;  // busy
    const int id = p->say_seq++;
    p->active_say = id;
    if (p->ws_connected.load()) {
        p->send_text_msg("tts.request", text);
        esp_timer_stop(p->say_timer);
        esp_timer_start_once(p->say_timer, kSayTimeoutUs);
        if (p->st == State::Idle) p->set_state_locked(State::Thinking);
    } else {
        p->pending = Impl::Pending::Say;
        p->pending_text = text;
        if (p->st == State::Idle) p->set_state_locked(State::Connecting);
        p->ensure_ws_locked();
    }
    return id;
}

State VoiceEngine::state() const {
    Impl* p = const_cast<VoiceEngine*>(this)->impl();
    std::lock_guard<std::mutex> lk(p->mtx);
    return p->st;
}

}  // namespace voicechat
