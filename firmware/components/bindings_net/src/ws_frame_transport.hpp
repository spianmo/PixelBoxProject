#pragma once
#include "esp_transport.h"

// 仅登记本模块拥有的传输；客户端销毁后解除登记，发送期间父传输始终有效。
void ws_frame_transport_register(esp_transport_handle_t ws, esp_transport_handle_t stream);
void ws_frame_transport_unregister(esp_transport_handle_t ws);
