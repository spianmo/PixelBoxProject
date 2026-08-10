/**
 * main.cpp — PixelBox 固件入口
 *
 * 启动顺序:
 *   1. NVS / 事件循环 / netif 基础设施
 *   2. board_init         — 板级硬件 (I2C / IO 扩展器 / PMU)
 *   3. appmgr_init        — littlefs 挂载 + 应用包管理 + jsvm 入口注册
 *   4. devd_start         — 开发服务 (WS 8765 + mDNS + 日志广播)
 *   5. jsvm::start        — JS 运行时 (加载当前应用或内置欢迎应用)
 *
 * 各 bindings_* 组件通过 JSVM_REGISTER_MODULE 静态自注册,
 * 无需在此逐个初始化 (main/CMakeLists.txt 中声明依赖保证被链接)。
 */
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"

#include "appmgr/appmgr.h"
#include "devd/devd.h"
#include "hal_common/board.h"
#include "jsvm/jsvm.hpp"
#include "system_keys.h"


static const char *TAG = "main";

extern "C" void app_main(void)
{
    /* 1. 基础设施 */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_netif_init());

    /* 2. 板级硬件 */
    ESP_ERROR_CHECK(board_init());

    /* 3. 应用包管理 (littlefs + manifest + jsvm 入口提供者) */
    ESP_ERROR_CHECK(appmgr_init());

    /* 4. 开发服务 (WiFi 未连接时照常监听, 联网后即可发现/推送) */
    err = devd_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "devd 启动失败: %s (继续启动 JS 运行时)", esp_err_to_name(err));
    }

    /* 5. 系统按键动作 (①设置页 ②应用页 ③息屏/关机) */
    system_keys_init();

    /* 6. JS 运行时 */
    ESP_ERROR_CHECK(jsvm::start());

    ESP_LOGI(TAG, "PixelBox 启动完成 (%s)", board_model());
}
