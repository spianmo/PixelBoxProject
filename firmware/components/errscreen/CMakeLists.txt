# errscreen — 应用异常的屏幕提示 (全屏卡片 / 顶部横幅)
#
# 分两层: error_card.cpp 是纯 gfx 绘制 (可在宿主机编译出图, 见 test_host/),
# errscreen.cpp 负责编排 (覆盖层 / 定时器 / 刷屏升级)。
#
# 不依赖 appmgr: 由 appmgr 反向调用本组件 (它才知道应用名与版本), 避免环。
idf_component_register(
    SRCS
        "src/error_card.cpp"
        "src/errscreen.cpp"
    INCLUDE_DIRS include
    PRIV_REQUIRES
        hal_display  # gfx + pxfonts + 帧缓冲/覆盖层
        jsvm         # post(): 绘制必须回到持有帧缓冲的 js_task; request_stop/vm_running
        esp_timer    # 横幅自动消失 / 升级后等停机
)
