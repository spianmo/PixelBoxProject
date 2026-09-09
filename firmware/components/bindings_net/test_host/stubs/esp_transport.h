#pragma once
using esp_transport_handle_t = void*;
int esp_transport_poll_write(esp_transport_handle_t, int);
int esp_transport_write(esp_transport_handle_t, const char*, int, int);
