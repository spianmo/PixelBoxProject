/**
 * hal_display_none.cpp — 无屏后端 (BOARD_HEADLESS)
 *
 * 与 QSPI/SPI 后端互斥编译。init() 返回 ESP_ERR_NOT_SUPPORTED,
 * ready() 恒为 false, bindings_screen 据此让 px.screen 的全部绘图/
 * 控制调用抛 Error("ENOTSUP") (d.ts 契约), width/height 为 0。
 * 不分配帧缓冲, 不占用任何外设 —— 供 P4/C6 裸板跑通非可视链路。
 */
#include "hal_display/hal_display.hpp"

#include "esp_log.h"

namespace hal_display {

namespace {
constexpr const char *TAG = "hal_display";
gfx::Surface s_empty;  // 空表面 (px = nullptr), 仅为满足接口签名
}  // namespace

esp_err_t init()
{
    ESP_LOGI(TAG, "无屏板型 (BOARD_HEADLESS): px.screen 不可用 (ENOTSUP)");
    return ESP_ERR_NOT_SUPPORTED;
}

bool ready() { return false; }

gfx::Surface &framebuffer() { return s_empty; }

int width() { return 0; }
int height() { return 0; }

void mark_dirty(int, int, int, int) {}

esp_err_t flush() { return ESP_ERR_INVALID_STATE; }

esp_err_t set_brightness(int) { return ESP_ERR_INVALID_STATE; }
int get_brightness() { return 0; }

esp_err_t set_power(bool) { return ESP_ERR_INVALID_STATE; }
bool get_power() { return false; }

esp_err_t set_rotation(int) { return ESP_ERR_INVALID_STATE; }
int get_rotation() { return 0; }

}  // namespace hal_display
