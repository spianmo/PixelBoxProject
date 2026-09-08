#include "speech_engine.hpp"
#include "speech_protocol.hpp"
#include "hal_net/ws_message.hpp"

#include <ctime>
#include "esp_random.h"
#include "esp_websocket_client.h"
#include "speech_core.hpp"
#include "speech_model_hashes.hpp"

#include <algorithm>
#include <cstring>
#include <cstdio>
#include <vector>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_memory_utils.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "model_path.h"
#include "mbedtls/sha256.h"

namespace speech {
namespace {
constexpr const char* kTag = "px.speech";
constexpr size_t kMinModelPsram = 4 * 1024 * 1024;
std::mutex model_mutex;
// One read-only mapping per boot. Keep it alive across jobs and VM hot reloads;
// mapping and unmapping can freeze caches and must never run on a PSRAM stack.
const void* model_root = nullptr;
size_t model_size = 0;
esp_partition_mmap_handle_t model_mapping = 0;
bool model_verified = false;

void log_memory(const char* stage) {
    ESP_LOGI(kTag, "%s; internal free=%u largest=%u, PSRAM free=%u largest=%u", stage,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
}

struct AudioQueue {
    // Dynamic FreeRTOS stream buffers use internal RAM even with SPIRAM_USE_MALLOC.
    // Static buffers need one extra byte to distinguish full from empty.
    static constexpr size_t kCapacity = 16384;
    uint8_t* storage = static_cast<uint8_t*>(heap_caps_malloc(kCapacity + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    StaticStreamBuffer_t control{};
    StreamBufferHandle_t stream = storage ? xStreamBufferCreateStatic(kCapacity + 1, 1, storage, &control) : nullptr;
    std::atomic<bool> enabled{true};
    std::atomic<bool> overflow{false};
    AudioQueue() = default;
    AudioQueue(const AudioQueue&) = delete;
    AudioQueue& operator=(const AudioQueue&) = delete;
    ~AudioQueue() {
        if (stream) vStreamBufferDelete(stream);
        heap_caps_free(storage);
    }
    void feed(const int16_t* samples, size_t count) {
        if (!enabled.load() || !stream) return;
        const size_t bytes = count * sizeof(int16_t);
        // 单生产者先检查整帧空间，避免StreamBuffer部分写入造成PCM16字节错位。
        if (xStreamBufferSpacesAvailable(stream) < bytes) { overflow.store(true); return; }
        if (xStreamBufferSend(stream, samples, bytes, 0) != bytes) overflow.store(true);
    }
};

struct Buffer {
    explicit Buffer(size_t size) : data(static_cast<uint8_t*>(heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT))) {}
    ~Buffer() { if (data) heap_caps_free(data); }
    uint8_t* data;
};

struct LevelUpdate {
    std::atomic<int> latest{0};
    std::atomic<bool> pending{false};
};

struct AudioPriority {
    UBaseType_t previous = uxTaskPriorityGet(nullptr);
    AudioPriority() {
        // Live audio must preempt expensive JS frames on the same core.
        vTaskPrioritySet(nullptr, std::max(previous,
            std::min<UBaseType_t>(CONFIG_JSVM_TASK_PRIORITY + 1, configMAX_PRIORITIES - 1)));
    }
    ~AudioPriority() { vTaskPrioritySet(nullptr, previous); }
};

struct Http {
    esp_http_client_handle_t handle = nullptr;
    std::string error;
    ~Http() { if (handle) esp_http_client_cleanup(handle); }
    bool failed(const char* stage, esp_err_t code = ESP_FAIL) {
        int tls = 0, flags = 0;
        const esp_err_t tls_status = handle ? esp_http_client_get_and_clear_last_tls_error(handle, &tls, &flags) : ESP_OK;
        char details[192];
        snprintf(details, sizeof(details), "Azure %s: %s; tls=%s/%d; verify=0x%x", stage,
                 esp_err_to_name(code), esp_err_to_name(tls_status), tls, unsigned(flags));
        error = details;
        ESP_LOGW(kTag, "%s", details);
        return false;
    }
    bool write(const uint8_t* bytes, size_t count, const std::function<bool()>& active) {
        const int64_t start = esp_timer_get_time();
        size_t offset = 0;
        while (offset < count && active()) {
            const int n = esp_http_client_write(handle, reinterpret_cast<const char*>(bytes + offset), std::min<size_t>(4096, count - offset));
            if (n <= 0) return failed("upload");
            offset += static_cast<size_t>(n);
        }
        ESP_LOGI(kTag, "Azure upload: %u bytes in %lld ms", unsigned(offset), (long long)((esp_timer_get_time() - start) / 1000));
        return offset == count || failed("upload timeout", ESP_ERR_TIMEOUT);
    }
    int status() {
        const int64_t start = esp_timer_get_time();
        if (esp_http_client_fetch_headers(handle) < 0) { failed("response headers"); return -1; }
        const int code = esp_http_client_get_status_code(handle);
        ESP_LOGI(kTag, "Azure response: HTTP %d in %lld ms", code, (long long)((esp_timer_get_time() - start) / 1000));
        return code;
    }
};

std::string speech_timestamp() {
    const time_t now = time(nullptr);
    struct tm utc{};
    gmtime_r(&now, &utc);
    char text[32];
    strftime(text, sizeof(text), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return text;
}

struct SpeechSocket {
    esp_websocket_client_handle_t handle = nullptr;
    std::atomic<bool> connected{false}, closed{false};
    std::mutex mutex;
    hal_net::WsMessage message{65536};
    SpeechResponse response;
    std::string id;
    SpeechSocket() {
        char value[33];
        snprintf(value, sizeof(value), "%08lx%08lx%08lx%08lx", (unsigned long)esp_random(),
                 (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
        id = value;
    }
    void release() {
        // 仅语音 worker 销毁；库等待事件任务退出后才允许回收回调上下文。
        if (handle) esp_websocket_client_destroy(handle);
        handle = nullptr;
    }
    ~SpeechSocket() { release(); }
    static void event(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
        auto& self = *static_cast<SpeechSocket*>(arg);
        const auto* data = static_cast<esp_websocket_event_data_t*>(event_data);
        if (event_id == WEBSOCKET_EVENT_CONNECTED) { self.connected.store(true); return; }
        std::lock_guard<std::mutex> lock(self.mutex);
        if (event_id == WEBSOCKET_EVENT_DISCONNECTED || event_id == WEBSOCKET_EVENT_CLOSED) {
            // esp_websocket_client 1.8 在 DISCONNECTED 才填充 TCP 错误；
            // 先前 ERROR 事件的 TLS 字段未初始化，不能读取或据此判断故障。
            if (data && data->error_handle.error_type == WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT) {
                const auto& error = data->error_handle;
                if (error.esp_tls_last_esp_err == ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME)
                    self.response.error = "Azure 域名解析失败，请检查 Wi-Fi DNS";
                else if (error.esp_tls_last_esp_err == ESP_ERR_NO_MEM)
                    self.response.error = "Azure 连接内存不足，请重启设备";
                else if (error.esp_tls_cert_verify_flags)
                    self.response.error = "Azure 证书校验失败，请检查设备时间";
                else if (self.response.error.empty()) self.response.error = "Azure 语音连接失败";
                ESP_LOGW(kTag, "Azure WSS transport: error=%s tls=%d verify=%d errno=%d",
                    esp_err_to_name(error.esp_tls_last_esp_err), error.esp_tls_stack_err,
                    error.esp_tls_cert_verify_flags, error.esp_transport_sock_errno);
            }
            self.closed.store(true);
            return;
        }
        if (event_id == WEBSOCKET_EVENT_ERROR) {
            const int status = data ? data->error_handle.esp_ws_handshake_status_code : 0;
            if (status == 401 || status == 403) self.response.error = "Azure 语音密钥或区域无效";
            ESP_LOGW(kTag, "Azure WSS error: HTTP=%d", status);
        } else if (event_id == WEBSOCKET_EVENT_DATA && data && data->op_code < 8 && self.response.error.empty()) {
            const auto result = self.message.feed(data->op_code, data->fin, data->payload_offset,
                data->payload_len, data->data_ptr, data->data_len);
            if (result == hal_net::WsMessage::Result::Invalid) self.response.error = "Azure 语音消息分片无效或过大";
            else if (result == hal_net::WsMessage::Result::Complete && self.message.type == 1)
                self.response.feed(std::string(self.message.bytes.begin(), self.message.bytes.end()), self.id);
        }
    }
    bool start(const Job& job) {
        const std::string url = "wss://" + job.config.region
            + ".stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language="
            + job.config.language + "&format=simple&endSilenceTimeoutMs=" + std::to_string(job.silence_ms)
            + "&initialSilenceTimeoutMs=" + std::to_string(job.max_ms);
        esp_websocket_client_config_t config{};
        config.uri = url.c_str();
        config.crt_bundle_attach = esp_crt_bundle_attach;
        config.disable_auto_reconnect = true;
        config.buffer_size = 4096;
        config.task_stack = 6144;
        config.task_prio = std::min(CONFIG_JSVM_TASK_PRIORITY + 1, configMAX_PRIORITIES - 1);
        config.network_timeout_ms = std::min(job.timeout_ms, 15000);
        handle = esp_websocket_client_init(&config);
        return handle
            && esp_websocket_client_append_header(handle, "Ocp-Apim-Subscription-Key", job.config.key.c_str()) == ESP_OK
            && esp_websocket_client_append_header(handle, "X-ConnectionId", id.c_str()) == ESP_OK
            && esp_websocket_register_events(handle, WEBSOCKET_EVENT_ANY, event, this) == ESP_OK
            && esp_websocket_client_start(handle) == ESP_OK;
    }
    bool configure() {
        const auto frame = speech_headers("speech.config", id, speech_timestamp()) + "Content-Type: application/json\r\n\r\n"
            + R"({"context":{"system":{"name":"PixelBox","version":"1.0"},"os":{"platform":"ESP-IDF"}}})";
        return esp_websocket_client_send_text(handle, frame.data(), frame.size(), pdMS_TO_TICKS(2000)) == int(frame.size());
    }
    bool audio(const uint8_t* data, size_t size) {
        const auto frame = speech_audio(id, speech_timestamp(), data, size);
        return esp_websocket_client_send_bin(handle, reinterpret_cast<const char*>(frame.data()), frame.size(), pdMS_TO_TICKS(2000)) == int(frame.size());
    }
    SpeechResponse snapshot() { std::lock_guard<std::mutex> lock(mutex); return response; }
};

struct Model {
    srmodel_list_t* models = nullptr;
    const esp_mn_iface_t* iface = nullptr;
    model_iface_data_t* data = nullptr;
    std::string registered_pinyin;
    const char* configure_wake(const WakeConfig& config) {
        if (const char* error = validate_wake_config(config)) return error;
        iface->clean(data);
        // 缓存只复用模型；业务换词时完整替换命令表，失败后下次必须重新注册。
        if (registered_pinyin != config.pinyin) {
            registered_pinyin.clear();
            const int64_t started = esp_timer_get_time();
            if (esp_mn_commands_clear() != ESP_OK || esp_mn_commands_add(1, config.pinyin.c_str()) != ESP_OK
                    || esp_mn_commands_update() != nullptr)
                return "MultiNet5 唤醒词注册失败，请检查 pinyin 是否为模型支持的拼音";
            registered_pinyin = config.pinyin;
            ESP_LOGI(kTag, "wake commands: %lld ms", (long long)((esp_timer_get_time() - started) / 1000));
        }
        const int result = iface->set_det_threshold(data, static_cast<float>(config.threshold));
        ESP_LOGI(kTag, "wake threshold: %.4f, model result=%d", config.threshold, result);
        return nullptr;
    }
    const char* load() {
        const int64_t started = esp_timer_get_time();
        if (get_static_srmodels()) return "语音模型被其他任务占用";
        if (!model_root) return "语音模型尚未映射";
        ModelPayloads payloads;
        if (!valid_model_archive(static_cast<const uint8_t*>(model_root), model_size, &payloads))
            return "语音模型分区缺失或目录损坏，请重新安装 speech 固件";
        for (size_t i = 0; !model_verified && i < payloads.size(); i++) {
            uint8_t digest[32];
            if (mbedtls_sha256(payloads[i].data, payloads[i].size, digest, 0) != 0
                    || !digest_matches(digest, kModelHashes[i]))
                return "语音模型内容校验失败，请安装与固件配套的模型";
        }
        model_verified = true;
        ESP_LOGI(kTag, "wake archive verified in %lld ms", (long long)((esp_timer_get_time() - started) / 1000));
        models = srmodel_load(model_root);
        return models ? nullptr : "语音模型目录分配失败";
    }
    ~Model() {
        // ESP-SR MultiNet5 的 destroy 同时释放命令表，不能在此之前重复释放。
        if (data && iface) iface->destroy(data);
        if (models) esp_srmodel_deinit(models);
        log_memory("wake model released");
    }
};
// 模型随语音 worker 保留，长回答或设置页停留不会让下次唤醒重新加载；退出 worker 时释放。
std::unique_ptr<Model> cached_model;

void release_model() {
    // 热更新时新 worker 已开始监听则由它继续持有；旧 worker 退出不能等待整段监听结束。
    std::unique_lock<std::mutex> lock(model_mutex, std::try_to_lock);
    if (lock.owns_lock()) cached_model.reset();
}
}  // namespace

struct Recording {
    explicit Recording(size_t samples)
        : wav(44 + samples * sizeof(int16_t)),
          pcm(wav.data ? reinterpret_cast<int16_t*>(wav.data + 44) : nullptr, samples) {}
    void stop() {
        pcm.stop();
        const int id = mic_id.exchange(-1);
        if (id >= 0) hal_audio::mic_unsubscribe(id);
    }
    ~Recording() { stop(); }
    Buffer wav;
    PcmCapture pcm;
    std::atomic<int> mic_id{-1};
    int64_t started = 0;
};

void Job::done(const std::string& result, bool text_result) {
    if (settled.exchange(true)) return;
    resolve.invoke_with([result, text_result](JSContext* ctx, JSValue* args) {
        if (!text_result) return 0;
        args[0] = JS_NewStringLen(ctx, result.data(), result.size());
        return 1;
    });
}

void Job::fail(const std::string& error) {
    if (settled.exchange(true)) return;
    if (error != "语音操作已取消") ESP_LOGW(kTag, "job kind=%d failed: %s", int(kind), error.c_str());
    reject.invoke_with([error](JSContext* ctx, JSValue* args) {
        args[0] = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, args[0], "message", JS_NewString(ctx, error.c_str()));
        return 1;
    });
}

const char* Engine::prepare_model_mapping() {
    if (model_root) return nullptr;
    int stack_probe;
    if (!esp_ptr_internal(&stack_probe)) return "语音模型映射需要内部线程栈，请更新固件";
    const auto* partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "model");
    if (!partition) return "未安装 speech 固件的 model 分区";
    const void* root = nullptr;
    if (esp_partition_mmap(partition, 0, partition->size, ESP_PARTITION_MMAP_DATA, &root, &model_mapping) != ESP_OK)
        return "语音模型映射失败，请重启后重试";
    model_size = partition->size;
    model_root = root;
    ESP_LOGI(kTag, "model mapped on internal stack; size=%u", (unsigned)model_size);
    return nullptr;
}

std::shared_ptr<Engine> Engine::create(Role role) {
    auto engine = std::make_shared<Engine>();
    engine->role_ = role;
    engine->queue_ = xQueueCreate(2, sizeof(std::shared_ptr<Job>*));
    if (!engine->queue_) {
        ESP_LOGE(kTag, "speech queue allocation failed; internal largest=%u",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return nullptr;
    }
    auto* owner = new std::shared_ptr<Engine>(engine);
    const char* task_name = role == Role::Wake ? "px_speech_wake" : "px_speech_op";
#if CONFIG_FREERTOS_UNICORE
    constexpr BaseType_t core = 0;
#else
    constexpr BaseType_t core = 1 - CONFIG_PX_AUDIO_TASK_CORE;
#endif
    // The worker uses mapped model data and network/audio I/O, never Flash writes.
    // Keep the 16 KiB stack in PSRAM; FreeRTOS still places its TCB in internal RAM.
#if CONFIG_SPIRAM && CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM
    constexpr uint32_t stack_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
#else
    constexpr uint32_t stack_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
#endif
    if (xTaskCreatePinnedToCoreWithCaps([](void* arg) {
        auto owned = *static_cast<std::shared_ptr<Engine>*>(arg);
        delete static_cast<std::shared_ptr<Engine>*>(arg);
        owned->run();
        owned.reset();
        vTaskDeleteWithCaps(nullptr);
    }, task_name, 16384, owner, 4, nullptr, core, stack_caps) != pdPASS) {
        ESP_LOGE(kTag, "speech worker allocation failed; internal largest=%u PSRAM largest=%u",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
        delete owner;
        return nullptr;
    }
    ESP_LOGI(kTag, "speech worker ready: %s; stack=16384 caps=0x%x", task_name, (unsigned)stack_caps);
    return engine;
}

Engine::~Engine() { if (queue_) vQueueDelete(queue_); }

bool Engine::submit(const std::shared_ptr<Job>& job) {
    if ((role_ == Role::Wake) != (job->kind == Kind::Wake)) {
        job->fail("内部语音任务路由错误");
        return false;
    }
    cancel();
    job->generation = generation_.load();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        current_ = job;
    }
    if (job->kind == Kind::Recognize) {
        // 新轮先采入自己的 PSRAM 缓冲；旧 TLS 仍在退出时也不会漏掉用户开口。
        auto recording = std::make_shared<Recording>(static_cast<size_t>(job->max_ms) * kRate / 1000);
        job->recording = recording;
        if (!recording->wav.data) { job->fail("录音缓冲分配失败"); return false; }
        recording->started = esp_timer_get_time();
        const int sink = hal_audio::mic_subscribe([recording](const int16_t* data, size_t count) { recording->pcm.feed(data, count); });
        if (sink < 0) { job->fail("麦克风不可用"); return false; }
        recording->mic_id.store(sink);
    }
    auto* queued = new std::shared_ptr<Job>(job);
    if (!alive_.load() || xQueueSend(queue_, &queued, 0) != pdTRUE) {
        delete queued;
        if (job->recording) job->recording->stop();
        job->fail("语音任务忙，请稍后重试");
        return false;
    }
    return true;
}

bool Engine::active(const Job& job) const { return alive_.load() && generation_.load() == job.generation; }

void Engine::cancel() {
    std::shared_ptr<Job> job;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        generation_.fetch_add(1);
        job = current_;
        current_.reset();
    }
    // 每轮独立持有录音订阅，旧 worker 清理时不能停止新轮已经开始的采音。
    if (job && job->recording) job->recording->stop();
    // Reject immediately; the worker owns TLS until the next I/O boundary/timeout.
    if (job) job->fail("语音操作已取消");
    detach_audio();
    std::shared_ptr<Job>* queued = nullptr;
    while (xQueueReceive(queue_, &queued, 0) == pdTRUE) { (*queued)->fail("语音操作已取消"); delete queued; }
}

void Engine::shutdown() {
    alive_.store(false);
    cancel();
    std::fill(config.key.begin(), config.key.end(), '\0');
    config.key.clear();
}

bool Engine::set_mic(int id, const Job& job) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (active(job)) { mic_id_ = id; return true; }
    }
    if (id >= 0) hal_audio::mic_unsubscribe(id);
    return false;
}
bool Engine::set_player(const std::shared_ptr<hal_audio::PcmRingSource>& player, const Job& job) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (active(job)) { player_ = player; return true; }
    }
    player->stop();
    return false;
}
void Engine::detach_audio() {
    int mic;
    std::shared_ptr<hal_audio::PcmRingSource> player;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        mic = mic_id_; mic_id_ = -1;
        player = std::move(player_);
    }
    if (mic >= 0) hal_audio::mic_unsubscribe(mic);
    if (player) player->stop();
}

void Engine::run() {
    while (alive_.load()) {
        std::shared_ptr<Job>* queued = nullptr;
        if (xQueueReceive(queue_, &queued, pdMS_TO_TICKS(100)) != pdTRUE) continue;
        auto job = *queued;
        delete queued;
        if (!active(*job)) { job->fail("语音操作已取消"); continue; }
        if (job->kind == Kind::Wake) wake(job);
        else if (job->kind == Kind::Recognize) recognize(job);
        else speak(job);
        detach_audio();
        if (!active(*job)) job->fail("语音操作已取消");
        std::lock_guard<std::mutex> lock(mutex_);
        if (current_ == job) current_.reset();
    }
    std::shared_ptr<Job>* queued = nullptr;
    while (xQueueReceive(queue_, &queued, 0) == pdTRUE) { (*queued)->fail("语音操作已取消"); delete queued; }
    if (role_ == Role::Wake) release_model();
}

void Engine::wake(const std::shared_ptr<Job>& job) {
    // MultiNet owns a global command table; serialize all detector use and cleanup.
    std::lock_guard<std::mutex> model_lock(model_mutex);
    if (!active(*job)) return;
    const int64_t started = esp_timer_get_time();
    const bool reused = bool(cached_model);
    log_memory("wake prepare");
    // MultiNet allocates multiple buffers, not a single 4 MiB block.
    if (!cached_model && heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) < kMinModelPsram) { job->fail("MultiNet5 需要至少 4 MiB 空闲 PSRAM 总量"); return; }
    std::unique_ptr<Model> fresh;
    if (!cached_model) fresh = std::make_unique<Model>();
    Model& model = cached_model ? *cached_model : *fresh;
    if (!reused) {
        AudioPriority initialization_priority;
        if (const char* error = model.load()) { job->fail(error); return; }
        if (!active(*job)) return;
        char* name = esp_srmodel_filter(model.models, ESP_MN_PREFIX, ESP_MN_CHINESE);
        if (!name || std::strcmp(name, kWakeModelName) != 0) { job->fail("model 分区缺少 mn5q8_cn 拼音模型，请同时更新固件和模型分区"); return; }
        model.iface = esp_mn_handle_from_name(name);
        if (!has_required_multinet_api(model.iface)) { job->fail("MultiNet5 接口不可用"); return; }
        const int64_t create_started = esp_timer_get_time();
        // MultiNet 按输入帧数超时；给完整短语留足窗口，待机静音在下方提前刷新。
        model.data = model.iface->create(name, 6000);
        ESP_LOGI(kTag, "wake model create: %lld ms", (long long)((esp_timer_get_time() - create_started) / 1000));
        log_memory("wake model created");
        if (!model.data) { job->fail("MultiNet5 工作区分配失败"); return; }
        // MN5Q8 使用 S3 优化的量化内核，权重由模型加载到 PSRAM；该接口没有 loader mode。
        if (model.iface->get_samp_rate(model.data) != kRate) { job->fail("MultiNet5 采样率不兼容"); return; }
        if (esp_mn_commands_alloc(model.iface, model.data) != ESP_OK) { job->fail("本地语音命令注册被占用"); return; }
        if (!active(*job)) return;
        cached_model = std::move(fresh);
    }
    AudioPriority priority;
    if (const char* error = model.configure_wake(job->wake_config)) { job->fail(error); return; }
    log_memory("wake commands ready");
    const int samples = model.iface->get_samp_chunksize(model.data);
    if (samples <= 0 || samples > 4096) { job->fail("MultiNet5 音频块异常"); return; }
    Buffer pcm(samples * 2), history(samples * sizeof(int16_t) * WakePreroll::frame_capacity(samples));
    auto audio = std::make_shared<AudioQueue>();
    if (!pcm.data || !history.data || !audio->stream) { job->fail("本地语音缓冲分配失败"); return; }
    log_memory("wake audio ready");
    if (!active(*job)) return;
    const int sink = hal_audio::mic_subscribe([audio](const int16_t* data, size_t count) { audio->feed(data, count); });
    if (sink < 0) { job->fail("麦克风不可用"); return; }
    if (!set_mic(sink, *job)) return;
    job->done();
    ESP_LOGI(kTag, "wake ready in %lld ms; cached=%d", (long long)((esp_timer_get_time() - started) / 1000), reused);
    ESP_LOGI(kTag, "离线命令检测已启动: %s / %s / %s, chunk=%d samples, PSRAM free=%u",
             kWakeModelName, job->wake_config.phrase.c_str(), job->wake_config.pinyin.c_str(),
             samples, static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    size_t fill = 0;
    bool detected = false;
    WakeSpeechBoundary speech_boundary;
    WakePreroll preroll(reinterpret_cast<int16_t*>(history.data), samples);
    WakeAudioStats audio_stats;
    const char* window_reset = "start";
    int64_t last_audio = esp_timer_get_time();
    int64_t last_report = last_audio, inference_us = 0, max_inference_us = 0;
    unsigned frames = 0, dropped_samples = 0, resets = 0, idle_resets = 0, timeouts = 0;
    const auto accept_candidate = [&](int64_t elapsed, bool replayed) {
        const auto* matches = model.iface->get_results(model.data);
        if (!matches || matches->num <= 0) return false;
        const bool accepted = wake_match(matches->command_id[0], matches->prob[0], job->wake_config.threshold);
        ESP_LOGI(kTag, "wake candidate: inference=%lld us, pending=%u ms, command=%d probability=%.3f threshold=%.4f accepted=%d replay=%d window=%u ms reset=%s rms=%.0f peak=%d clipped=%u",
                 (long long)elapsed, unsigned(xStreamBufferBytesAvailable(audio->stream) * 1000 / (kRate * 2)),
                 matches->command_id[0], double(matches->prob[0]), job->wake_config.threshold, accepted, replayed,
                 unsigned(audio_stats.samples * 1000 / kRate), window_reset, audio_stats.rms(), audio_stats.peak, unsigned(audio_stats.clipped));
        return accepted;
    };
    while (active(*job)) {
        // 只有消费者丢弃旧前缀，保持 StreamBuffer 单生产者/单消费者约束。
        // 溢出意味着中间有缺口，必须清空当时的旧音频并重置模型，不能反复识别半秒前的内容。
        const bool overflow = audio->overflow.exchange(false);
        size_t discard = wake_backlog_drop_samples(xStreamBufferBytesAvailable(audio->stream) / 2, overflow) * 2;
        if (overflow || discard) {
            dropped_samples += static_cast<unsigned>(fill / 2);
            fill = 0;
            model.iface->clean(model.data);
            audio_stats = {};
            window_reset = "backlog";
            speech_boundary = WakeSpeechBoundary{};
            preroll.clear();
            resets++;
            while (discard) {
                const size_t skipped = xStreamBufferReceive(audio->stream, pcm.data,
                    std::min(discard, static_cast<size_t>(samples * 2)), 0);
                if (!skipped) break;
                discard -= skipped;
                dropped_samples += static_cast<unsigned>(skipped / 2);
            }
        }
        const size_t received = xStreamBufferReceive(audio->stream, pcm.data + fill, samples * 2 - fill, pdMS_TO_TICKS(100));
        if (received) last_audio = esp_timer_get_time();
        if (esp_timer_get_time() - last_audio > 3000000) {
            if (job->error_callback) job->error_callback.invoke_with([](JSContext* ctx, JSValue* args) { args[0] = JS_NewString(ctx, "离线唤醒麦克风无数据"); return 1; });
            break;
        }
        fill += received;
        if (fill != static_cast<size_t>(samples * 2)) continue;
        fill = 0;
        auto* frame = reinterpret_cast<int16_t*>(pcm.data);
        const int64_t detect_started = esp_timer_get_time();
        if (speech_boundary.feed(frame, samples)) {
            // 从本次发声刷新窗口，并保留约 200 ms 轻声词首，避免只有一帧时截断唤醒词。
            model.iface->clean(model.data);
            audio_stats = {};
            window_reset = "idle";
            // 回放也是有效推理：立即处理候选，命中后停止，不能让后续帧覆盖结果。
            detected = preroll.replay([&](int16_t* prefix) {
                audio_stats.feed(prefix, samples);
                const auto result = model.iface->detect(model.data, prefix);
                if (result == ESP_MN_STATE_DETECTED && accept_candidate(esp_timer_get_time() - detect_started, true)) return true;
                if (result != ESP_MN_STATE_DETECTING) {
                    if (result == ESP_MN_STATE_TIMEOUT) timeouts++;
                    model.iface->clean(model.data);
                    audio_stats = {};
                    window_reset = result == ESP_MN_STATE_TIMEOUT ? "timeout" : "candidate";
                }
                return false;
            });
            idle_resets++;
            if (detected) break;
        }
        audio_stats.feed(frame, samples);
        const auto result = model.iface->detect(model.data, frame);
        const int64_t elapsed = esp_timer_get_time() - detect_started;
        inference_us += elapsed;
        max_inference_us = std::max(max_inference_us, elapsed);
        frames++;
        if (result == ESP_MN_STATE_DETECTED && accept_candidate(elapsed, false)) { detected = true; break; }
        if (result != ESP_MN_STATE_DETECTING) {
            if (result == ESP_MN_STATE_TIMEOUT) timeouts++;
            model.iface->clean(model.data);
            audio_stats = {};
            window_reset = result == ESP_MN_STATE_TIMEOUT ? "timeout" : "candidate";
            speech_boundary = WakeSpeechBoundary{};
            preroll.clear();
        }
        preroll.append(frame);
        if (esp_timer_get_time() - last_report >= 5000000) {
            ESP_LOGI(kTag, "wake inference: avg=%lld us max=%lld us chunk=%u us pending=%u ms dropped=%u ms resets=%u idle_resets=%u timeouts=%u",
                     (long long)(inference_us / frames), (long long)max_inference_us,
                     unsigned(samples * 1000000LL / kRate),
                     unsigned(xStreamBufferBytesAvailable(audio->stream) * 1000 / (kRate * 2)),
                     dropped_samples * 1000 / kRate, resets, idle_resets, timeouts);
            last_report = esp_timer_get_time();
            frames = dropped_samples = resets = idle_resets = timeouts = 0;
            inference_us = max_inference_us = 0;
        }
        // Give the UI and idle task time even if inference cannot keep up with input.
        vTaskDelay(1);
    }
    audio->enabled.store(false);
    detach_audio();
    model.iface->clean(model.data);
    // 命中后停止本地拾音，JS 下一步开始云识别；回调由绑定层的代数包装过滤过期事件。
    if (detected && active(*job)) job->callback.invoke();
}

void Engine::recognize(const std::shared_ptr<Job>& job) {
    const size_t max_samples = static_cast<size_t>(job->max_ms) * kRate / 1000;
    auto recording = job->recording;
    if (!recording) { job->fail("录音未启动"); return; }
    auto& wav = recording->wav;
    if (!active(*job)) return;
    AudioPriority priority;
    // 建连与麦克风采集重叠；已缓存的开口音频在连接就绪后按原顺序追发。
    SpeechSocket socket;
    if (!socket.start(*job)) { recording->stop(); job->fail("Azure 语音连接创建失败"); return; }
    const int64_t connect_start = esp_timer_get_time();
    const int64_t connect_deadline = connect_start + std::min(job->timeout_ms, 15000) * 1000LL;
    while (active(*job) && !socket.connected.load() && !socket.closed.load()
            && socket.snapshot().error.empty() && esp_timer_get_time() < connect_deadline) vTaskDelay(pdMS_TO_TICKS(10));
    if (!active(*job)) return;
    if (!socket.connected.load()) {
        recording->stop();
        const auto result = socket.snapshot();
        job->fail(result.error.empty() ? "Azure 语音连接超时" : result.error);
        return;
    }
    ESP_LOGI(kTag, "Azure WSS connected in %lld ms", (long long)((esp_timer_get_time() - connect_start) / 1000));
    uint8_t header[44];
    wav_header(header, 0);
    // 流式 WAV 与 Speech SDK 一致，RIFF/data 长度均为 0，由空 audio 消息结束输入。
    std::memset(header + 4, 0, 4);
    if (!socket.configure() || !socket.audio(header, sizeof(header))) {
        recording->stop(); job->fail("Azure 语音配置发送失败"); return;
    }
    Vad vad(job->silence_ms);
    size_t used = 0, sent = 0;
    int64_t last_level = 0;
    auto level_update = std::make_shared<LevelUpdate>();
    const int64_t capture_deadline = recording->started + static_cast<int64_t>(job->max_ms + 1000) * 1000;
    const int64_t total_deadline = std::max(capture_deadline, connect_deadline) + job->timeout_ms * 1000LL;
    int64_t response_deadline = 0;
    std::string last_partial;
    bool input_ended = false, first_partial = false;
    while (active(*job)) {
        const int64_t now = esp_timer_get_time();
        if (now >= total_deadline) { recording->stop(); job->fail("Azure 语音识别超时"); return; }
        const auto response = socket.snapshot();
        if (!response.error.empty()) { recording->stop(); job->fail(response.error); return; }
        if (!response.partial.empty() && response.partial != last_partial) {
            if (!first_partial) {
                first_partial = true;
                ESP_LOGI(kTag, "Azure first partial: %lld ms from capture", (long long)((now - recording->started) / 1000));
            }
            if (!job->partial_callback || job->partial_callback.try_invoke_with([text = response.partial](JSContext* ctx, JSValue* args) {
                args[0] = JS_NewStringLen(ctx, text.data(), text.size()); return 1;
            })) last_partial = response.partial;
        }
        if (response.ended) {
            recording->stop();
            ESP_LOGI(kTag, "Azure final: %lld ms from capture, %lld ms after input, sent=%u bytes",
                (long long)((now - recording->started) / 1000),
                (long long)(input_ended ? (now - (response_deadline - job->timeout_ms * 1000LL)) / 1000 : 0), unsigned(sent));
            // Promise 唤醒 JS 后会立刻建立 AI TLS；先释放 ASR，避免两次握手争用内部 DMA 内存。
            socket.release();
            log_memory("Azure WSS released before final callback");
            if (response.text.empty()) job->fail("未识别到有效文字，请重试");
            else job->done(response.text, true);
            return;
        }
        if (socket.closed.load()) { recording->stop(); job->fail("Azure 语音连接已中断"); return; }
        if (input_ended) {
            if (now >= response_deadline) { job->fail("Azure 语音识别超时"); return; }
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (now >= capture_deadline) recording->stop();
        size_t available = recording->pcm.size() * sizeof(int16_t) - used;
        // 到达采音时限只停止生产；慢建连积压的音频仍须处理完，不能直接发送空输入。
        bool finished = used >= max_samples * 2 || (now >= capture_deadline && !available);
        while (available && !finished) {
            const size_t got = std::min<size_t>(640, available);
            finished = vad.feed(reinterpret_cast<int16_t*>(wav.data + 44 + used), got / sizeof(int16_t));
            used += got;
            available -= got;
            level_update->latest.store(vad.level);
            if (now - last_level > 100000 && job->callback) {
                last_level = now;
                if (!level_update->pending.exchange(true)) {
                    const bool queued = job->callback.try_invoke_with([level_update](JSContext* ctx, JSValue* args) {
                        args[0] = JS_NewInt32(ctx, level_update->latest.load());
                        level_update->pending.store(false);
                        return 1;
                    });
                    if (!queued) level_update->pending.store(false);
                }
            }
            // 100 ms 一包；追发握手期间的积压时每包最多 4096 字节，采音线程从不等待网络。
            if (used - sent >= 3200) break;
        }
        finished = finished || used >= max_samples * 2;
        if (used > sent && (used - sent >= 3200 || finished)) {
            const size_t count = std::min<size_t>(4096, used - sent);
            if (!socket.audio(wav.data + 44 + sent, count)) { recording->stop(); job->fail("Azure 语音发送失败"); return; }
            sent += count;
        }
        if (finished && sent == used) {
            recording->stop();
            if (!socket.audio(nullptr, 0)) { job->fail("Azure 语音结束发送失败"); return; }
            input_ended = true;
            response_deadline = esp_timer_get_time() + job->timeout_ms * 1000LL;
            ESP_LOGI(kTag, "Azure input ended: captured=%u sent=%u samples", unsigned(recording->pcm.size()), unsigned(sent / 2));
        }
        if (!available) vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void Engine::speak(const std::shared_ptr<Job>& job) {
    AudioPriority network_priority;
    const int64_t started = esp_timer_get_time();
    log_memory("Azure TTS starting");
    const std::string ssml = "<speak version='1.0' xml:lang='" + job->config.language + "'><voice name='" + job->config.voice + "'>" + xml_escape(job->text) + "</voice></speak>";
    const std::string url = "https://" + job->config.region + ".tts.speech.microsoft.com/cognitiveservices/v1";
    Http request;
    const int64_t deadline = esp_timer_get_time() + 120000000;
    const auto valid = [&] { return active(*job) && esp_timer_get_time() < deadline; };
    // 输出格式头必须在 HTTP open 前设置；统一使用原始16k单声道PCM以避免容器误解码。
    esp_http_client_config_t options{};
    options.url = url.c_str(); options.method = HTTP_METHOD_POST; options.timeout_ms = 15000;
    options.crt_bundle_attach = esp_crt_bundle_attach; options.disable_auto_redirect = true;
    options.buffer_size = 4096;
    request.handle = esp_http_client_init(&options);
    if (!request.handle) { job->fail("TLS 请求创建失败"); return; }
    esp_http_client_set_header(request.handle, "Ocp-Apim-Subscription-Key", job->config.key.c_str());
    esp_http_client_set_header(request.handle, "Content-Type", "application/ssml+xml");
    esp_http_client_set_header(request.handle, "X-Microsoft-OutputFormat", "raw-16khz-16bit-mono-pcm");
    esp_http_client_set_header(request.handle, "User-Agent", "ObeingPixel/1.0");
    const esp_err_t open_error = esp_http_client_open(request.handle, ssml.size());
    if (open_error != ESP_OK) { request.failed("TTS connect", open_error); job->fail(request.error); return; }
    if (!request.write(reinterpret_cast<const uint8_t*>(ssml.data()), ssml.size(), valid)) { job->fail(request.error); return; }
    const int status = request.status();
    if (status != 200) { job->fail(status < 0 ? request.error : status == 401 || status == 403 ? "Azure 语音密钥或区域无效" : "Azure 语音合成 HTTP " + std::to_string(status)); return; }
    auto ring = hal_audio::PcmRingSource::create(kRate, 1, 65536);
    if (!ring) { job->fail("播报缓冲分配失败"); return; }
    auto completed = std::make_shared<std::atomic<bool>>(false);
    ring->on_finished([completed] { completed->store(true); });
    if (hal_audio::player_add(ring) != ESP_OK) { job->fail("扬声器不可用"); return; }
    if (!set_player(ring, *job)) return;
    uint8_t chunk[2049];
    size_t carry = 0;
    size_t total = 0;
    while (valid()) {
        const int n = esp_http_client_read(request.handle, reinterpret_cast<char*>(chunk + carry), sizeof(chunk) - carry);
        if (n < 0) { job->fail("Azure 语音数据读取失败"); return; }
        if (n == 0) break;
        if (!total) ESP_LOGI(kTag, "Azure TTS first audio: %lld ms", (long long)((esp_timer_get_time() - started) / 1000));
        total += n;
        if (total > 4 * 1024 * 1024) { job->fail("语音播报超出时长限制"); return; }
        const size_t aligned = (static_cast<size_t>(n) + carry) & ~size_t(1);
        const size_t next_carry = static_cast<size_t>(n) + carry - aligned;
        size_t offset = 0;
        while (offset < aligned && valid()) {
            // 按环缓冲实际空闲量反压TLS读取，禁止把长回答整段载入PSRAM。
            offset += ring->feed(chunk + offset, aligned - offset);
            if (offset < aligned) vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (next_carry) chunk[0] = chunk[aligned];
        carry = next_carry;
    }
    if (!active(*job)) return;
    if (!total || carry || !valid() || !esp_http_client_is_complete_data_received(request.handle)) { job->fail("语音响应不完整或超时"); return; }
    ring->end();
    while (valid() && !completed->load()) vTaskDelay(pdMS_TO_TICKS(20));
    if (valid()) {
        ESP_LOGI(kTag, "Azure TTS playback done: %u bytes, %lld ms", unsigned(total), (long long)((esp_timer_get_time() - started) / 1000));
        job->done();
    }
    else if (active(*job)) job->fail("扬声器播放超时");
}

}  // namespace speech
