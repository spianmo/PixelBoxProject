# wifi_portal — 网页配网:SoftAP + httpd 表单页 + 原生屏幕显示
#
# 手机端表单页 portal.html 经 EMBED_TXTFILES 编入 flash
# (符号 _binary_portal_html_start), 完全自包含 —— 热点没有互联网出口,
# 任何外链资源都会加载失败。
#
# 多目标: 无片上 WiFi 的目标 (ESP32-P4) 只编 wifi_portal_stub.cpp,
# 接口一致地返回 ESP_ERR_NOT_SUPPORTED (连表单页也不必编进 flash)。
# P4 联网走 esp_hosted (esp_wifi_remote) 的 TODO 见 docs/hardware/multi-target.md。
#
# 注意: 仅 SRCS / EMBED_TXTFILES 允许依赖 CONFIG_* (IDF 构建系统约束 —
# REQUIRES/PRIV_REQUIRES 在配置加载前的 early expansion 阶段展开, 必须无条件)。
if(CONFIG_SOC_WIFI_SUPPORTED)
    set(srcs "src/wifi_portal.cpp")
    set(embed "src/portal.html")
else()
    set(srcs "src/wifi_portal_stub.cpp")
    set(embed "")
endif()

# 公开头只依赖 esp_err.h, 故所有组件依赖都是私有的
idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    EMBED_TXTFILES ${embed}
    PRIV_REQUIRES
        hal_net         # WifiManager: start_ap / connect / scan / reconnect_saved
        hal_display     # gfx + pxfonts: 屏幕显示热点名称与密码
        jsvm            # post(): 绘制必须回到持有帧缓冲的 js_task
        appmgr          # stop_app / restart_app: 配网期间独占屏幕
        esp_http_server
        json
        esp_wifi        # esp_wifi_ap_get_sta_list: 屏显已连接手机数
        esp_netif       # captive portal DHCP 选项
        esp_timer
        esp_hw_support  # esp_random / esp_read_mac
)
