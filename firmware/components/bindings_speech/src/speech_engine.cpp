#include "speech_engine.hpp"
#include "speech_core.hpp"
#include "speech_model_hashes.hpp"

#include <algorithm>
#include <cstring>
#include <vector>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "model_path.h"
#include "mbedtls/sha256.h"

namespace speech {
namespace {
constexpr const char* kTag = "px.speech";
constexpr size_t kMinModelPsram = 4 * 1024 * 1024;
std::mutex model_mutex;

struct AudioQueue {
    StreamBufferHandle_t stream = xStreamBufferCreate(16384, 1);
    std::atomic<bool> enabled{true};
    std::atomic<bool> overflow{false};
    ~AudioQueue() { if (stream) vStreamBufferDelete(stream); }
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

struct Http {
    esp_http_client_handle_t handle = nullptr;
    ~Http() { if (handle) esp_http_client_cleanup(handle); }
    bool open(const Config& config, const std::string& url, const char* content_type, int body_size, int timeout_ms) {
        esp_http_client_config_t options{};
        options.url = url.c_str();
        options.method = HTTP_METHOD_POST;
        options.timeout_ms = std::min(timeout_ms, 5000);
        options.crt_bundle_attach = esp_crt_bundle_attach;
        options.disable_auto_redirect = true;
        options.buffer_size = 4096;
        options.buffer_size_tx = 2048;
        handle = esp_http_client_init(&options);
        if (!handle) return false;
        esp_http_client_set_header(handle, "Ocp-Apim-Subscription-Key", config.key.c_str());
        esp_http_client_set_header(handle, "Content-Type", content_type);
        esp_http_client_set_header(handle, "User-Agent", "ObeingPixel/1.0");
        return esp_http_client_open(handle, body_size) == ESP_OK;
    }
    bool write(const uint8_t* bytes, size_t count, const std::function<bool()>& active) {
        size_t offset = 0;
        while (offset < count && active()) {
            const int n = esp_http_client_write(handle, reinterpret_cast<const char*>(bytes + offset), std::min<size_t>(2048, count - offset));
            if (n <= 0) return false;
            offset += static_cast<size_t>(n);
        }
        return offset == count;
    }
    int status() {
        if (esp_http_client_fetch_headers(handle) < 0) return -1;
        return esp_http_client_get_status_code(handle);
    }
};

struct Model {
    srmodel_list_t* models = nullptr;
    const esp_mn_iface_t* iface = nullptr;
    model_iface_data_t* data = nullptr;
    bool commands = false;
    esp_partition_mmap_handle_t mapping = 0;
    bool mapped = false;
    const char* load() {
        if (get_static_srmodels()) return "语音模型被其他任务占用";
        const auto* partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "model");
        if (!partition) return "未安装 speech 固件的 model 分区";
        const void* root = nullptr;
        // vendor esp_srmodel_init 内含 ESP_ERROR_CHECK；自己处理 mmap 失败，避免启动唤醒使整机重启。
        if (esp_partition_mmap(partition, 0, partition->size, ESP_PARTITION_MMAP_DATA, &root, &mapping) != ESP_OK)
            return "语音模型映射失败，请重启后重试";
        mapped = true;
        ModelPayloads payloads;
        if (!valid_model_archive(static_cast<const uint8_t*>(root), partition->size, &payloads))
            return "语音模型分区缺失或目录损坏，请重新安装 speech 固件";
        for (size_t i = 0; i < payloads.size(); i++) {
            uint8_t digest[32];
            if (mbedtls_sha256(payloads[i].data, payloads[i].size, digest, 0) != 0
                    || !digest_matches(digest, kModelHashes[i]))
                return "语音模型内容校验失败，请安装与固件配套的模型";
        }
        models = srmodel_load(root);
        return models ? nullptr : "语音模型目录分配失败";
    }
    ~Model() {
        if (commands) esp_mn_commands_free();
        if (data && iface) iface->destroy(data);
        if (models) esp_srmodel_deinit(models);
        if (mapped) esp_partition_munmap(mapping);
    }
};
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
    reject.invoke_with([error](JSContext* ctx, JSValue* args) {
        args[0] = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, args[0], "message", JS_NewString(ctx, error.c_str()));
        return 1;
    });
}

std::shared_ptr<Engine> Engine::create() {
    auto engine = std::make_shared<Engine>();
    engine->queue_ = xQueueCreate(2, sizeof(std::shared_ptr<Job>*));
    if (!engine->queue_) return nullptr;
    auto* owner = new std::shared_ptr<Engine>(engine);
#if CONFIG_FREERTOS_UNICORE
    constexpr BaseType_t core = 0;
#else
    constexpr BaseType_t core = 1 - CONFIG_PX_AUDIO_TASK_CORE;
#endif
    if (xTaskCreatePinnedToCore([](void* arg) {
        auto owned = *static_cast<std::shared_ptr<Engine>*>(arg);
        delete static_cast<std::shared_ptr<Engine>*>(arg);
        owned->run();
        owned.reset();
        vTaskDelete(nullptr);
    }, "px_speech", 16384, owner, 4, nullptr, core) != pdPASS) {
        delete owner;
        return nullptr;
    }
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
    // Promise 立即失败；网络 worker 自行在下一读块/5秒 socket 超时后收尾，不跨线程销毁 TLS。
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
}

void Engine::wake(const std::shared_ptr<Job>& job) {
    // MultiNet命令表是库内全局单例；跨VM重启的新worker须等旧模型完全销毁。
    std::lock_guard<std::mutex> model_lock(model_mutex);
    if (!active(*job)) return;
    if (heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) < kMinModelPsram) { job->fail("MultiNet7 需要至少 4 MiB 连续空闲 PSRAM"); return; }
    Model model;
    if (const char* error = model.load()) { job->fail(error); return; }
    char* name = esp_srmodel_filter(model.models, ESP_MN_PREFIX, ESP_MN_CHINESE);
    if (!name || !std::strstr(name, "mn7")) { job->fail("model 分区缺少 mn7_cn 中文模型"); return; }
    model.iface = esp_mn_handle_from_name(name);
    if (!has_required_multinet_api(model.iface)) { job->fail("MultiNet7 接口不可用"); return; }
    model.data = model.iface->create(name, 3000);
    if (!model.data) { job->fail("MultiNet7 工作区分配失败"); return; }
    // ESP-SR 2.4.7 的 mn7 接口未实现 switch_loader_mode，使用该模型的默认加载方式。
    if (model.iface->get_samp_rate(model.data) != kRate) { job->fail("MultiNet7 采样率不兼容"); return; }
    if (esp_mn_commands_alloc(model.iface, model.data) != ESP_OK) { job->fail("本地语音命令注册被占用"); return; }
    model.commands = true;
    if (esp_mn_commands_add(1, kWakePinyin) != ESP_OK || esp_mn_commands_update() != nullptr) { job->fail("MultiNet7 无法解析你好小川拼音命令"); return; }
    model.iface->set_det_threshold(model.data, job->threshold);
    const int samples = model.iface->get_samp_chunksize(model.data);
    if (samples <= 0 || samples > 4096) { job->fail("MultiNet7 音频块异常"); return; }
    Buffer pcm(samples * 2);
    auto audio = std::make_shared<AudioQueue>();
    if (!pcm.data || !audio->stream) { job->fail("本地语音缓冲分配失败"); return; }
    if (!active(*job)) return;
    const int sink = hal_audio::mic_subscribe([audio](const int16_t* data, size_t count) { audio->feed(data, count); });
    if (sink < 0) { job->fail("麦克风不可用"); return; }
    if (!set_mic(sink, *job)) return;
    job->done();
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
    }
    audio->enabled.store(false);
    detach_audio();
    // 命中后停止本地拾音，JS 下一步开始云识别；回调由绑定层的代数包装过滤过期事件。
    if (detected && active(*job)) job->callback.invoke();
}

void Engine::recognize(const std::shared_ptr<Job>& job) {
    const size_t max_samples = static_cast<size_t>(job->max_ms) * kRate / 1000;
    Buffer wav(44 + max_samples * 2);
    auto audio = std::make_shared<AudioQueue>();
    if (!wav.data || !audio->stream) { job->fail("录音缓冲分配失败"); return; }
    const int sink = hal_audio::mic_subscribe([audio](const int16_t* data, size_t count) { audio->feed(data, count); });
    if (sink < 0) { job->fail("麦克风不可用"); return; }
    if (!set_mic(sink, *job)) return;
    Vad vad(job->silence_ms);
    size_t used = 0;
    int64_t last_level = 0;
    const int64_t capture_deadline = esp_timer_get_time() + static_cast<int64_t>(job->max_ms + 1000) * 1000;
    while (active(*job) && used < max_samples * 2 && esp_timer_get_time() < capture_deadline) {
        const size_t got = xStreamBufferReceive(audio->stream, wav.data + 44 + used, std::min<size_t>(640, max_samples * 2 - used), pdMS_TO_TICKS(100));
        if (got == 0) continue;
        const bool finished = vad.feed(reinterpret_cast<int16_t*>(wav.data + 44 + used), got / 2);
        used += got;
        const int64_t now = esp_timer_get_time();
        if (now - last_level > 100000 && job->callback) {
            last_level = now;
            const int level = vad.level;
            job->callback.invoke_with([level](JSContext* ctx, JSValue* args) { args[0] = JS_NewInt32(ctx, level); return 1; });
        }
        if (finished) break;
    }
    audio->enabled.store(false);
    detach_audio();
    if (!active(*job)) return;
    if (audio->overflow.load()) { job->fail("录音处理积压，请重试"); return; }
    if (!vad.heard) { job->fail("未检测到语音，请重试"); return; }
    wav_header(wav.data, static_cast<uint32_t>(used));
    const std::string url = "https://" + job->config.region + ".stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=" + job->config.language + "&format=simple";
    Http request;
    const int64_t deadline = esp_timer_get_time() + static_cast<int64_t>(job->timeout_ms) * 1000;
    const auto valid = [&] { return active(*job) && esp_timer_get_time() < deadline; };
    if (!request.open(job->config, url, "audio/wav; codecs=audio/pcm; samplerate=16000", static_cast<int>(used + 44), job->timeout_ms)
            || !request.write(wav.data, used + 44, valid)) { job->fail("Azure 语音连接失败或已超时"); return; }
    const int status = request.status();
    if (status != 200) { job->fail(status == 401 || status == 403 ? "Azure 语音密钥或区域无效" : "Azure 语音识别请求失败"); return; }
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
    else job->fail("Azure 未识别到有效文字");
    if (json) cJSON_Delete(json);
}

void Engine::speak(const std::shared_ptr<Job>& job) {
    const std::string ssml = "<speak version='1.0' xml:lang='" + job->config.language + "'><voice name='" + job->config.voice + "'>" + xml_escape(job->text) + "</voice></speak>";
    const std::string url = "https://" + job->config.region + ".tts.speech.microsoft.com/cognitiveservices/v1";
    Http request;
    const int64_t deadline = esp_timer_get_time() + 120000000;
    const auto valid = [&] { return active(*job) && esp_timer_get_time() < deadline; };
    // 输出格式头必须在 HTTP open 前设置；统一使用原始16k单声道PCM以避免容器误解码。
    esp_http_client_config_t options{};
    options.url = url.c_str(); options.method = HTTP_METHOD_POST; options.timeout_ms = 5000;
    options.crt_bundle_attach = esp_crt_bundle_attach; options.disable_auto_redirect = true;
    options.buffer_size = 4096;
    request.handle = esp_http_client_init(&options);
    if (!request.handle) { job->fail("TLS 请求创建失败"); return; }
    esp_http_client_set_header(request.handle, "Ocp-Apim-Subscription-Key", job->config.key.c_str());
    esp_http_client_set_header(request.handle, "Content-Type", "application/ssml+xml");
    esp_http_client_set_header(request.handle, "X-Microsoft-OutputFormat", "raw-16khz-16bit-mono-pcm");
    esp_http_client_set_header(request.handle, "User-Agent", "ObeingPixel/1.0");
    if (esp_http_client_open(request.handle, ssml.size()) != ESP_OK || !request.write(reinterpret_cast<const uint8_t*>(ssml.data()), ssml.size(), valid)) { job->fail("Azure 语音合成连接失败"); return; }
    const int status = request.status();
    if (status != 200) { job->fail(status == 401 || status == 403 ? "Azure 语音密钥或区域无效" : "Azure 语音合成请求失败"); return; }
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
