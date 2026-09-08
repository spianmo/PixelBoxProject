#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "esp_log.h"
#include "hal_audio/audio_source.hpp"

using esp_err_t = int;
constexpr int ESP_OK = 0, ESP_FAIL = -1, ESP_ERR_TIMEOUT = 1, ESP_ERR_HTTP_EAGAIN = 2;
constexpr int HTTP_EVENT_ON_HEADER = 1, HTTP_EVENT_ON_DATA = 2, HTTP_METHOD_POST = 1;
#define pdMS_TO_TICKS(value) (value)
struct Client;
using esp_http_client_handle_t = Client*;
struct esp_http_client_event_t {
    int event_id = 0;
    void* user_data = nullptr;
    const char* header_key = nullptr;
    const char* header_value = nullptr;
    int data_len = 0;
    void* data = nullptr;
    Client* client = nullptr;
};
struct esp_http_client_config_t {
    const char* url = nullptr;
    int method = 0, timeout_ms = 0, buffer_size = 0;
    void (*crt_bundle_attach)() = nullptr;
    bool disable_auto_redirect = false, keep_alive_enable = false;
    esp_err_t (*event_handler)(esp_http_client_event_t*) = nullptr;
    void* user_data = nullptr;
};
struct Response {
    int status = 200;
    std::string header_pcm;
    std::deque<std::string> chunks;
    bool headers_fail = false, complete = true, retry_read = false, cancel = false, close = false;
    bool open_fail = false, stalled = false;
};
struct Client {
    esp_http_client_config_t config;
    Response response;
    bool drain_header = false;
};
static std::deque<Response> responses;
static int created = 0, destroyed = 0, read_events = 0;
static int64_t now_us = 1000000;
static bool active_job = true;
static std::shared_ptr<hal_audio::PcmRingSource> playing_ring;
static std::vector<int16_t> played;

int64_t esp_timer_get_time() { return now_us; }
void esp_crt_bundle_attach() {}
const char* esp_err_to_name(int) { return "test-error"; }
void vTaskDelay(unsigned ticks) {
    now_us += ticks * 1000;
    if (playing_ring) {
        int16_t output[160];
        const auto count = playing_ring->pull(output, 160);
        played.insert(played.end(), output, output + count);
        if (playing_ring->finished()) { playing_ring->fire_finished(); playing_ring.reset(); }
    }
}
Client* esp_http_client_init(const esp_http_client_config_t* config) {
    assert(config->crt_bundle_attach && config->disable_auto_redirect && config->keep_alive_enable);
    created++;
    return new Client{*config, {}, false};
}
void esp_http_client_cleanup(Client* client) { destroyed++; delete client; }
void esp_http_client_close(Client*) {}
void esp_http_client_set_timeout_ms(Client*, int) {}
int esp_http_client_set_header(Client*, const char*, const char*) { return ESP_OK; }
int esp_http_client_get_and_clear_last_tls_error(Client*, int*, int*) { return ESP_OK; }
int esp_http_client_open(Client* client, size_t) {
    assert(!responses.empty());
    client->response = std::move(responses.front());
    responses.pop_front();
    client->drain_header = !client->response.header_pcm.empty();
    return client->response.open_fail ? ESP_FAIL : ESP_OK;
}
int esp_http_client_write(Client*, const char*, size_t size) { return static_cast<int>(size); }
int esp_http_client_get_status_code(Client* client) { return client->response.status; }
void dispatch(Client* client, const std::string& bytes) {
    esp_http_client_event_t event;
    event.event_id = HTTP_EVENT_ON_DATA;
    event.user_data = client->config.user_data;
    event.data = const_cast<char*>(bytes.data());
    event.data_len = bytes.size();
    event.client = client;
    client->config.event_handler(&event);
}
int esp_http_client_fetch_headers(Client* client) {
    if (client->response.headers_fail) return ESP_FAIL;
    if (client->response.close) {
        esp_http_client_event_t event;
        event.event_id = HTTP_EVENT_ON_HEADER;
        event.user_data = client->config.user_data;
        event.header_key = "Connection";
        event.header_value = "close";
        client->config.event_handler(&event);
    }
    if (!client->response.header_pcm.empty()) dispatch(client, client->response.header_pcm);
    return 0;
}
int esp_http_client_read(Client* client, char*, size_t) {
    if (client->drain_header) { client->drain_header = false; return client->response.header_pcm.size(); }
    if (client->response.cancel) { active_job = false; return -ESP_ERR_HTTP_EAGAIN; }
    if (client->response.stalled) { now_us += 1000000; return -ESP_ERR_HTTP_EAGAIN; }
    if (client->response.retry_read) { client->response.retry_read = false; now_us += 100000; return -ESP_ERR_HTTP_EAGAIN; }
    if (client->response.chunks.empty()) return 0;
    auto bytes = std::move(client->response.chunks.front());
    client->response.chunks.pop_front();
    dispatch(client, bytes);
    // read 尚未返回，HTTP 数据事件已经启动播放，证明不依赖填满 read 缓冲。
    if (client->response.status == 200 && bytes.size() >= 2) assert(playing_ring);
    read_events++;
    return bytes.size();
}
bool esp_http_client_is_complete_data_received(Client* client) { return client->response.complete && client->response.chunks.empty(); }

namespace hal_audio {
int player_add(const std::shared_ptr<PcmRingSource>& ring) { playing_ring = ring; return ESP_OK; }
}
namespace speech {
constexpr const char* kTag = "test";
constexpr uint32_t kRate = 16000;
struct AudioPriority { AudioPriority() {} };
void log_memory(const char*) {}
std::string xml_escape(const std::string& text) { return text; }
struct Config { std::string region = "region", key = "key", language = "zh-CN", voice = "voice"; };
struct Job {
    Config config;
    std::string text = "hello";
    int done_count = 0;
    std::string error;
    void done() { done_count++; }
    void fail(const std::string& reason) { error = reason; }
};
#include "tts_http.inc"
#include "tts_connection.inc"
class Engine {
public:
    std::shared_ptr<TtsConnection> tts_connection_;
    bool active(const Job&) const { return active_job; }
    bool set_player(const std::shared_ptr<hal_audio::PcmRingSource>&, const Job&) { return active_job; }
    void speak(const std::shared_ptr<Job>& job);
};
#include "tts_speak.inc"
}

static std::shared_ptr<speech::Job> speak(speech::Engine& engine, Response response) {
    auto job = std::make_shared<speech::Job>();
    responses.push_back(std::move(response));
    engine.speak(job);
    return job;
}

int main() {
    // 半帧跨满环边界时必须完整保留，重试后每个 PCM 样本仍按顺序输出。
    auto ring = hal_audio::PcmRingSource::create(16000, 1, 1024);
    std::vector<uint8_t> bytes(1025, 0);
    bytes.back() = 0x34;
    assert(ring->feed(bytes.data(), bytes.size()) == bytes.size());
    const uint8_t high = 0x12;
    assert(ring->feed(&high, 1) == 0);
    int16_t samples[512];
    assert(ring->pull(samples, 512) == 512);
    assert(ring->feed(&high, 1) == 1);
    assert(ring->pull(samples, 1) == 1 && samples[0] == 0x1234);

    speech::Engine engine;
    Response first;
    first.header_pcm = std::string(1, '\x34');
    first.chunks = {std::string(1, '\x12'), std::string(2, '\0')};
    first.retry_read = true;
    auto job = speak(engine, first);
    assert(job->done_count == 1 && job->error.empty());
    assert(played.size() == 2 && played[0] == 0x1234 && played[1] == 0);
    assert(engine.tts_connection_ && created == 1 && destroyed == 0);
    assert(!engine.tts_connection_->request.on_data);

    Response second;
    second.chunks = {std::string(70000, '\0')};
    job = speak(engine, second);
    assert(job->done_count == 1 && job->error.empty() && created == 1);
    assert(played.size() == 35002);

    Response stale;
    stale.headers_fail = true;
    responses.push_back(stale);
    job = speak(engine, first);
    assert(job->done_count == 1 && job->error.empty() && responses.empty());

    stale.headers_fail = false;
    stale.open_fail = true;
    responses.push_back(stale);
    job = speak(engine, first);
    assert(job->done_count == 1 && job->error.empty() && created == 2 && destroyed == 1);

    now_us += 15000000;
    job = speak(engine, first);
    assert(job->done_count == 1 && created == 3 && destroyed == 2);
    engine.tts_connection_->config.key = "different-key";
    job = speak(engine, first);
    assert(job->done_count == 1 && created == 4 && destroyed == 3);

    Response odd;
    odd.chunks = {std::string(3, '\0')};
    job = speak(engine, odd);
    assert(job->done_count == 0 && !job->error.empty() && !engine.tts_connection_);
    playing_ring.reset();

    Response forbidden;
    forbidden.status = 403;
    forbidden.header_pcm = "error";
    job = speak(engine, forbidden);
    assert(job->done_count == 0 && job->error.find("密钥") != std::string::npos && !playing_ring);

    Response truncated;
    truncated.chunks = {std::string(2, '\0')};
    truncated.complete = false;
    job = speak(engine, truncated);
    assert(job->done_count == 0 && !job->error.empty());
    playing_ring.reset();

    Response closed = first;
    closed.close = true;
    job = speak(engine, closed);
    assert(job->done_count == 1 && !engine.tts_connection_);

    Response stalled;
    stalled.stalled = true;
    const int64_t stall_start = now_us;
    job = speak(engine, stalled);
    assert(job->done_count == 0 && job->error.find("等待超时") != std::string::npos);
    assert(now_us - stall_start == 15000000 && !engine.tts_connection_);

    Response cancelled;
    cancelled.cancel = true;
    job = speak(engine, cancelled);
    assert(job->done_count == 0 && !engine.tts_connection_);
    assert(created == destroyed && read_events > 0);
    std::puts("TTS first-packet delivery, fragmented PCM/backpressure, TLS reuse/expiry, retry, errors and cancellation passed");
}
