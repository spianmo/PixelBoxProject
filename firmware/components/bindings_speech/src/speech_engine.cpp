#include "speech_engine.hpp"
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

struct Recording {
    explicit Recording(size_t samples)
        : wav(44 + samples * sizeof(int16_t)),
          pcm(wav.data ? reinterpret_cast<int16_t*>(wav.data + 44) : nullptr, samples) {}
    Buffer wav;
    PcmCapture pcm;
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
    bool open(const Config& config, const std::string& url, const char* content_type, int body_size, int timeout_ms) {
        const int64_t start = esp_timer_get_time();
        esp_http_client_config_t options{};
        options.url = url.c_str();
        options.method = HTTP_METHOD_POST;
        options.timeout_ms = std::min(timeout_ms, 15000);
        options.crt_bundle_attach = esp_crt_bundle_attach;
        options.disable_auto_redirect = true;
        options.buffer_size = 4096;
        options.buffer_size_tx = 2048;
        handle = esp_http_client_init(&options);
        if (!handle) return failed("init", ESP_ERR_NO_MEM);
        esp_http_client_set_header(handle, "Ocp-Apim-Subscription-Key", config.key.c_str());
        esp_http_client_set_header(handle, "Content-Type", content_type);
        esp_http_client_set_header(handle, "User-Agent", "ObeingPixel/1.0");
        esp_http_client_set_header(handle, "Accept", "application/json");
        const esp_err_t err = esp_http_client_open(handle, body_size);
        ESP_LOGI(kTag, "Azure connect: %lld ms, result=%s", (long long)((esp_timer_get_time() - start) / 1000), esp_err_to_name(err));
        return err == ESP_OK || failed("connect", err);
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

struct Model {
    srmodel_list_t* models = nullptr;
    const esp_mn_iface_t* iface = nullptr;
    model_iface_data_t* data = nullptr;
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
        // ESP-SR MultiNet7 destroy() owns the global command table as well.
        if (data && iface) iface->destroy(data);
        if (models) esp_srmodel_deinit(models);
        log_memory("wake model released");
    }
};
// Retain weights and command table between speech turns. One detector is used
// at a time, guarded by model_mutex, and released after 60 seconds idle.
std::unique_ptr<Model> cached_model;
int64_t model_last_used = 0;

void release_idle_model(bool force = false) {
    std::unique_lock<std::mutex> lock(model_mutex, std::try_to_lock);
    if (lock.owns_lock() && cached_model &&
        (force || esp_timer_get_time() - model_last_used > 60000000)) cached_model.reset();
}
}  // namespace

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

std::shared_ptr<Engine> Engine::create() {
    auto engine = std::make_shared<Engine>();
    engine->queue_ = xQueueCreate(2, sizeof(std::shared_ptr<Job>*));
    if (!engine->queue_) {
        ESP_LOGE(kTag, "speech queue allocation failed; internal largest=%u",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return nullptr;
    }
    auto* owner = new std::shared_ptr<Engine>(engine);
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
    }, "px_speech", 16384, owner, 4, nullptr, core, stack_caps) != pdPASS) {
        ESP_LOGE(kTag, "speech worker allocation failed; internal largest=%u PSRAM largest=%u",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
        delete owner;
        return nullptr;
    }
    ESP_LOGI(kTag, "speech worker ready; stack=16384 caps=0x%x", (unsigned)stack_caps);
    return engine;
}

Engine::~Engine() { if (queue_) vQueueDelete(queue_); }

bool Engine::submit(const std::shared_ptr<Job>& job) {
    cancel();
    job->generation = generation_.load();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        current_ = job;
    }
    auto* queued = new std::shared_ptr<Job>(job);
    if (!alive_.load() || xQueueSend(queue_, &queued, 0) != pdTRUE) {
        delete queued;
        job->fail("语音任务忙，请稍后重试");
        return false;
    }
    return true;
}

bool Engine::active(const Job& job) const { return alive_.load() && generation_.load() == job.generation; }

void Engine::cancel(bool wake_only) {
    std::shared_ptr<Job> job;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (wake_only && current_ && current_->kind != Kind::Wake) return;
        generation_.fetch_add(1);
        job = current_;
        current_.reset();
    }
    // Reject immediately; the worker owns TLS until the next I/O boundary/timeout.
    if (job) job->fail("语音操作已取消");
    detach_audio();
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
        if (xQueueReceive(queue_, &queued, pdMS_TO_TICKS(100)) != pdTRUE) {
            release_idle_model();
            continue;
        }
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
    release_idle_model(true);
}

void Engine::wake(const std::shared_ptr<Job>& job) {
    // MultiNet owns a global command table; serialize all detector use and cleanup.
    std::lock_guard<std::mutex> model_lock(model_mutex);
    if (!active(*job)) return;
    const int64_t started = esp_timer_get_time();
    const bool reused = bool(cached_model);
    log_memory("wake prepare");
    // MultiNet allocates multiple buffers, not a single 4 MiB block.
    if (!cached_model && heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) < kMinModelPsram) { job->fail("MultiNet7 需要至少 4 MiB 空闲 PSRAM 总量"); return; }
    std::unique_ptr<Model> fresh;
    if (!cached_model) fresh = std::make_unique<Model>();
    Model& model = cached_model ? *cached_model : *fresh;
    if (!reused) {
        AudioPriority initialization_priority;
        if (const char* error = model.load()) { job->fail(error); return; }
        if (!active(*job)) return;
        char* name = esp_srmodel_filter(model.models, ESP_MN_PREFIX, ESP_MN_CHINESE);
        if (!name || !std::strstr(name, "mn7")) { job->fail("model 分区缺少 mn7_cn 中文模型"); return; }
        model.iface = esp_mn_handle_from_name(name);
        if (!has_required_multinet_api(model.iface)) { job->fail("MultiNet7 接口不可用"); return; }
        model.data = model.iface->create(name, 3000);
        log_memory("wake model created");
        if (!model.data) { job->fail("MultiNet7 工作区分配失败"); return; }
        // ESP-SR 2.4.7 的 mn7 接口未实现 switch_loader_mode，使用该模型的默认加载方式。
        if (model.iface->get_samp_rate(model.data) != kRate) { job->fail("MultiNet7 采样率不兼容"); return; }
        if (esp_mn_commands_alloc(model.iface, model.data) != ESP_OK) { job->fail("本地语音命令注册被占用"); return; }
        if (!active(*job)) return;
        if (esp_mn_commands_add(1, kWakePinyin) != ESP_OK || esp_mn_commands_update() != nullptr) { job->fail("MultiNet7 无法解析你好小川拼音命令"); return; }
        log_memory("wake commands ready");
        cached_model = std::move(fresh);
    }
    model.iface->clean(model.data);
    model.iface->set_det_threshold(model.data, job->threshold);
    const int samples = model.iface->get_samp_chunksize(model.data);
    if (samples <= 0 || samples > 4096) { job->fail("MultiNet7 音频块异常"); return; }
    Buffer pcm(samples * 2);
    auto audio = std::make_shared<AudioQueue>();
    if (!pcm.data || !audio->stream) { job->fail("本地语音缓冲分配失败"); return; }
    log_memory("wake audio ready");
    if (!active(*job)) return;
    AudioPriority priority;
    const int sink = hal_audio::mic_subscribe([audio](const int16_t* data, size_t count) { audio->feed(data, count); });
    if (sink < 0) { job->fail("麦克风不可用"); return; }
    if (!set_mic(sink, *job)) return;
    job->done();
    ESP_LOGI(kTag, "wake ready in %lld ms; cached=%d", (long long)((esp_timer_get_time() - started) / 1000), reused);
    ESP_LOGI(kTag, "离线命令检测已启动: mn7_cn / ni hao xiao chuan, PSRAM free=%u", static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    size_t fill = 0;
    bool detected = false;
    int64_t last_audio = esp_timer_get_time();
    while (active(*job)) {
        const size_t received = xStreamBufferReceive(audio->stream, pcm.data + fill, samples * 2 - fill, pdMS_TO_TICKS(100));
        if (received) last_audio = esp_timer_get_time();
        if (esp_timer_get_time() - last_audio > 3000000) {
            if (job->error_callback) job->error_callback.invoke_with([](JSContext* ctx, JSValue* args) { args[0] = JS_NewString(ctx, "离线唤醒麦克风无数据"); return 1; });
            break;
        }
        fill += received;
        if (fill != static_cast<size_t>(samples * 2)) continue;
        fill = 0;
        if (audio->overflow.exchange(false)) model.iface->clean(model.data);
        const auto result = model.iface->detect(model.data, reinterpret_cast<int16_t*>(pcm.data));
        if (result == ESP_MN_STATE_DETECTED) {
            const auto* matches = model.iface->get_results(model.data);
            if (matches && matches->num > 0 && matches->command_id[0] == 1 && matches->prob[0] >= job->threshold) { detected = true; break; }
        }
        if (result != ESP_MN_STATE_DETECTING) model.iface->clean(model.data);
        // Give the UI and idle task time even if inference cannot keep up with input.
        vTaskDelay(1);
    }
    audio->enabled.store(false);
    detach_audio();
    model.iface->clean(model.data);
    model_last_used = esp_timer_get_time();
    // 命中后停止本地拾音，JS 下一步开始云识别；回调由绑定层的代数包装过滤过期事件。
    if (detected && active(*job)) job->callback.invoke();
}

void Engine::recognize(const std::shared_ptr<Job>& job) {
    const size_t max_samples = static_cast<size_t>(job->max_ms) * kRate / 1000;
    auto recording = std::make_shared<Recording>(max_samples);
    auto& wav = recording->wav;
    if (!wav.data) { job->fail("录音缓冲分配失败"); return; }
    if (!active(*job)) return;
    const int sink = hal_audio::mic_subscribe([recording](const int16_t* data, size_t count) { recording->pcm.feed(data, count); });
    if (sink < 0) { job->fail("麦克风不可用"); return; }
    if (!set_mic(sink, *job)) return;
    Vad vad(job->silence_ms);
    size_t used = 0;
    int64_t last_level = 0;
    auto level_update = std::make_shared<LevelUpdate>();
    const int64_t capture_deadline = esp_timer_get_time() + static_cast<int64_t>(job->max_ms + 1000) * 1000;
    {
        AudioPriority priority;
        while (active(*job) && used < max_samples * 2) {
            const int64_t now = esp_timer_get_time();
            if (now >= capture_deadline) recording->pcm.stop();
            const size_t available = recording->pcm.size() * sizeof(int16_t) - used;
            if (!available) {
                if (now >= capture_deadline) break;
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
            const size_t got = std::min<size_t>(640, available);
            const bool finished = vad.feed(reinterpret_cast<int16_t*>(wav.data + 44 + used), got / sizeof(int16_t));
            used += got;
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
            if (finished) break;
        }
    }
    recording->pcm.stop();
    detach_audio();
    if (!active(*job)) return;
    ESP_LOGI(kTag, "recording captured=%u processed=%u samples, speech=%d", (unsigned)recording->pcm.size(), (unsigned)(used / sizeof(int16_t)), vad.heard);
    if (!vad.heard) { job->fail("未检测到语音，请重试"); return; }
    // Preserve 200 ms pre-roll, omit the long silence while waiting for speech.
    const size_t preroll = kRate / 5;
    const size_t trim = (vad.speech_start() > preroll ? vad.speech_start() - preroll : 0) * sizeof(int16_t);
    if (trim && trim < used) {
        std::memmove(wav.data + 44, wav.data + 44 + trim, used - trim);
        used -= trim;
    }
    AudioPriority network_priority;
    wav_header(wav.data, static_cast<uint32_t>(used));
    const std::string url = "https://" + job->config.region + ".stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=" + job->config.language + "&format=simple";
    Http request;
    const int64_t deadline = esp_timer_get_time() + static_cast<int64_t>(job->timeout_ms) * 1000;
    const auto valid = [&] { return active(*job) && esp_timer_get_time() < deadline; };
    if (!request.open(job->config, url, "audio/wav; codecs=audio/pcm; samplerate=16000", static_cast<int>(used + 44), job->timeout_ms)
            || !request.write(wav.data, used + 44, valid)) { job->fail(request.error); return; }
    if (!valid()) { job->fail("Azure 语音识别超时"); return; }
    esp_http_client_set_timeout_ms(request.handle, std::max(1, int((deadline - esp_timer_get_time()) / 1000)));
    const int status = request.status();
    if (status != 200) {
        job->fail(status < 0 ? request.error : status == 401 || status == 403 ? "Azure 语音密钥或区域无效" :
            "Azure 语音识别 HTTP " + std::to_string(status));
        return;
    }
    std::string response;
    char chunk[1024];
    while (valid()) {
        const int n = esp_http_client_read(request.handle, chunk, sizeof(chunk));
        if (n < 0) { job->fail("Azure 语音响应读取失败"); return; }
        if (n == 0) break;
        if (response.size() + n > 32768) { job->fail("Azure 识别响应超出限制"); return; }
        response.append(chunk, n);
    }
    if (!active(*job)) return;
    if (!valid()) { job->fail("Azure 语音识别超时"); return; }
    if (!esp_http_client_is_complete_data_received(request.handle)) { job->fail("Azure 识别响应不完整"); return; }
    cJSON* json = cJSON_ParseWithLength(response.data(), response.size());
    const cJSON* status_json = json ? cJSON_GetObjectItemCaseSensitive(json, "RecognitionStatus") : nullptr;
    const cJSON* display = json ? cJSON_GetObjectItemCaseSensitive(json, "DisplayText") : nullptr;
    if (cJSON_IsString(status_json) && std::strcmp(status_json->valuestring, "Success") == 0 && cJSON_IsString(display) && display->valuestring[0]) job->done(display->valuestring, true);
    else {
        const char* reason = cJSON_IsString(status_json) ? status_json->valuestring : "InvalidResponse";
        ESP_LOGI(kTag, "Azure recognition status: %s", reason);
        job->fail(std::string("Azure 未识别到有效文字: ") + reason);
    }
    if (json) cJSON_Delete(json);
}

void Engine::speak(const std::shared_ptr<Job>& job) {
    AudioPriority network_priority;
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
    if (valid()) job->done();
    else if (active(*job)) job->fail("扬声器播放超时");
}

}  // namespace speech
