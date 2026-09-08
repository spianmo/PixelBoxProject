#include <atomic>
#include <cassert>
#include <cstdio>
#include <mutex>
#include <string>
#include "speech_protocol.hpp"
#include "hal_net/ws_message.hpp"

#define ESP_LOGW(...) ((void)0)
using esp_event_base_t = const char*;
enum { WEBSOCKET_EVENT_CONNECTED, WEBSOCKET_EVENT_DISCONNECTED, WEBSOCKET_EVENT_CLOSED,
       WEBSOCKET_EVENT_ERROR, WEBSOCKET_EVENT_DATA };
enum { WEBSOCKET_ERROR_TYPE_NONE, WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT };
enum { ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME = 1, ESP_ERR_NO_MEM = 2 };
struct esp_websocket_event_data_t {
    const char* data_ptr = nullptr;
    int data_len = 0, op_code = 0, payload_offset = 0, payload_len = 0;
    bool fin = false;
    struct {
        int error_type = 0, esp_ws_handshake_status_code = 0, esp_tls_last_esp_err = 0;
        int esp_tls_stack_err = 0, esp_tls_cert_verify_flags = 0, esp_transport_sock_errno = 0;
    } error_handle;
};
struct SpeechSocket {
    std::atomic<bool> connected{false}, closed{false};
    std::mutex mutex;
    hal_net::WsMessage message{65536};
    speech::SpeechResponse response;
    std::string id;
#include "speech_socket_event.inc"
};

int main() {
    SpeechSocket socket;
    esp_websocket_event_data_t data;
    // ERROR 的 TLS 字段在库内尚未填充，不能误判内存或证书错误。
    data.error_handle.esp_tls_last_esp_err = ESP_ERR_NO_MEM;
    data.error_handle.esp_tls_cert_verify_flags = 123;
    SpeechSocket::event(&socket, nullptr, WEBSOCKET_EVENT_ERROR, &data);
    assert(socket.response.error.empty() && !socket.closed);
    data.error_handle.error_type = WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT;
    data.error_handle.esp_tls_last_esp_err = ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME;
    data.error_handle.esp_tls_cert_verify_flags = 0;
    SpeechSocket::event(&socket, nullptr, WEBSOCKET_EVENT_DISCONNECTED, &data);
    assert(socket.closed && socket.response.error.find("DNS") != std::string::npos);

    SpeechSocket auth;
    data = {};
    data.error_handle.esp_ws_handshake_status_code = 401;
    SpeechSocket::event(&auth, nullptr, WEBSOCKET_EVENT_ERROR, &data);
    const auto auth_error = auth.response.error;
    assert(!auth_error.empty());
    data.error_handle.error_type = WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT;
    SpeechSocket::event(&auth, nullptr, WEBSOCKET_EVENT_DISCONNECTED, &data);
    assert(auth.response.error == auth_error);

    SpeechSocket complete;
    SpeechSocket::event(&complete, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    assert(complete.connected);
    SpeechSocket::event(&complete, nullptr, WEBSOCKET_EVENT_CLOSED, nullptr);
    assert(complete.closed && complete.response.error.empty());
    std::puts("Azure WebSocket DNS errors, handshake errors and clean close passed");
}
