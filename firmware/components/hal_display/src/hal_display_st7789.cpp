/**
 * hal_display_st7789.cpp — 通用 SPI 屏后端 (BOARD_GENERIC_SPI, ST7789)
 *
 * 与 QSPI 后端 (hal_display.cpp, 微雪 SH8601) 互斥编译, 公开接口一致
 * (hal_display.hpp), 由 CMakeLists 按 CONFIG_BOARD_* 选择源文件。
 *
 * 面向无 PSRAM 的小内存目标 (ESP32-C6, ~512KB HP SRAM) 的内存策略:
 *   - 逻辑帧缓冲 240x240x2 = 112.5KB, 经 px_alloc 分配 (无 PSRAM 落内部堆),
 *     绘图引擎 (gfx) 直接操作, 与 QSPI 后端一致;
 *   - 中转缓冲不再整帧 (QSPI 后端为全帧 322KB), 改为「行带 (strip)」:
 *     每次最多 CONFIG_PX_DISPLAY_STRIP_LINES 行 (默认 40 行 = 18.75KB,
 *     DMA 内部内存), 脏矩形按行带分段 gather → draw_bitmap → 等 DMA 完成,
 *     以 ~19KB 常驻换掉 112.5KB 的整帧中转;
 *   - 面板驱动用 IDF 内置 esp_lcd_new_panel_st7789 (无额外组件依赖);
 *   - 亮度: 背光 GPIO 走 LEDC PWM (ST7789 无亮度命令); 无背光脚时仅记值。
 *
 * 脏矩形/旋转逻辑与 QSPI 后端保持同构 (两后端互斥编译, 允许少量重复,
 * 修改时请两侧同步)。线程约定同 hal_display.hpp: 仅 JS 线程调用。
 */
#include "hal_display/hal_display.hpp"

#include <cstring>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

namespace hal_display {

namespace {

constexpr const char *TAG = "hal_display";

struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
    bool empty() const { return w <= 0 || h <= 0; }
};

constexpr int kMaxDirty = 8;

struct State {
    bool ready = false;
    int panel_w = 0;
    int panel_h = 0;
    int rotation = 0;      // 0/90/180/270
    int brightness = 80;   // 0-100
    bool power = true;
    bool has_backlight = false;

    gfx::Surface fb;              // 逻辑帧缓冲 (px_alloc: 无 PSRAM 落内部堆)
    uint16_t *staging = nullptr;  // 行带中转缓冲 (DMA 内部内存)
    int strip_lines = 0;          // 行带高度 (行)

    Rect dirty[kMaxDirty];
    int dirty_count = 0;

    esp_lcd_panel_io_handle_t io = nullptr;
    esp_lcd_panel_handle_t panel = nullptr;
    spi_host_device_t spi_host = SPI2_HOST;
    SemaphoreHandle_t trans_done = nullptr;
};

State s;

/* ------------------------------------------------------------
 * 脏矩形 (与 QSPI 后端同构)
 * ------------------------------------------------------------ */

Rect rect_union(const Rect &a, const Rect &b)
{
    const int x0 = a.x < b.x ? a.x : b.x;
    const int y0 = a.y < b.y ? a.y : b.y;
    const int x1 = (a.x + a.w > b.x + b.w) ? a.x + a.w : b.x + b.w;
    const int y1 = (a.y + a.h > b.y + b.h) ? a.y + a.h : b.y + b.h;
    return {x0, y0, x1 - x0, y1 - y0};
}

bool rect_overlap_or_touch(const Rect &a, const Rect &b)
{
    return !(a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h);
}

bool on_color_trans_done(esp_lcd_panel_io_handle_t /*io*/, esp_lcd_panel_io_event_data_t * /*ev*/,
                         void * /*ctx*/)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s.trans_done, &woken);
    return woken == pdTRUE;
}

/* ------------------------------------------------------------
 * 旋转坐标变换 (与 QSPI 后端同构, 见 hal_display.cpp 注释)
 * ------------------------------------------------------------ */

/** 逻辑脏矩形 → 物理包围矩形 */
Rect to_physical(const Rect &r)
{
    switch (s.rotation) {
    case 90:  return {s.panel_w - (r.y + r.h), r.x, r.h, r.w};
    case 180: return {s.panel_w - (r.x + r.w), s.panel_h - (r.y + r.h), r.w, r.h};
    case 270: return {r.y, s.panel_h - (r.x + r.w), r.h, r.w};
    default:  return r;
    }
}

/** 把物理矩形 p (≤ 行带高度) 的像素从逻辑帧缓冲收集进 staging */
void gather_rect(const Rect &p)
{
    uint16_t *dst = s.staging;
    const gfx::Surface &fb = s.fb;
    switch (s.rotation) {
    case 0:
        for (int y = 0; y < p.h; ++y) {
            memcpy(dst + static_cast<size_t>(y) * p.w, fb.row(p.y + y) + p.x,
                   static_cast<size_t>(p.w) * sizeof(uint16_t));
        }
        break;
    case 90:
        // 逆变换: lx = py, ly = PW-1-px
        for (int y = 0; y < p.h; ++y) {
            const int py = p.y + y;
            uint16_t *drow = dst + static_cast<size_t>(y) * p.w;
            for (int x = 0; x < p.w; ++x) {
                const int px = p.x + x;
                drow[x] = fb.row(s.panel_w - 1 - px)[py];
            }
        }
        break;
    case 180:
        for (int y = 0; y < p.h; ++y) {
            const int py = p.y + y;
            const uint16_t *srow = fb.row(s.panel_h - 1 - py);
            uint16_t *drow = dst + static_cast<size_t>(y) * p.w;
            for (int x = 0; x < p.w; ++x) {
                drow[x] = srow[s.panel_w - 1 - (p.x + x)];
            }
        }
        break;
    case 270:
        // 逆变换: lx = PH-1-py, ly = px
        for (int y = 0; y < p.h; ++y) {
            const int py = p.y + y;
            const uint16_t *srow_base = fb.px;
            uint16_t *drow = dst + static_cast<size_t>(y) * p.w;
            const int lx = s.panel_h - 1 - py;
            for (int x = 0; x < p.w; ++x) {
                drow[x] = srow_base[static_cast<size_t>(p.x + x) * fb.stride + lx];
            }
        }
        break;
    default:
        break;
    }
}

/* ------------------------------------------------------------
 * 背光 (LEDC PWM)
 * ------------------------------------------------------------ */

constexpr ledc_mode_t kBlMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_channel_t kBlChannel = LEDC_CHANNEL_0;

esp_err_t backlight_init(int gpio)
{
    ledc_timer_config_t tcfg = {};
    tcfg.speed_mode = kBlMode;
    tcfg.duty_resolution = LEDC_TIMER_8_BIT;
    tcfg.timer_num = LEDC_TIMER_0;
    tcfg.freq_hz = 5000;
    tcfg.clk_cfg = LEDC_AUTO_CLK;
    ESP_RETURN_ON_ERROR(ledc_timer_config(&tcfg), TAG, "ledc_timer_config 失败");

    ledc_channel_config_t ccfg = {};
    ccfg.gpio_num = gpio;
    ccfg.speed_mode = kBlMode;
    ccfg.channel = kBlChannel;
    ccfg.timer_sel = LEDC_TIMER_0;
    ccfg.duty = 0;
    ccfg.hpoint = 0;
    ESP_RETURN_ON_ERROR(ledc_channel_config(&ccfg), TAG, "ledc_channel_config 失败");
    return ESP_OK;
}

void backlight_set(int percent)
{
    if (!s.has_backlight) return;
    const uint32_t duty = static_cast<uint32_t>(percent * 255 / 100);
    ledc_set_duty(kBlMode, kBlChannel, duty);
    ledc_update_duty(kBlMode, kBlChannel);
}

}  // namespace

/* ------------------------------------------------------------
 * 公开接口
 * ------------------------------------------------------------ */

esp_err_t init()
{
    if (s.ready) return ESP_OK;
    const board_display_config_t *cfg = board_display_config();
    s.panel_w = cfg->width;
    s.panel_h = cfg->height;
    s.spi_host = static_cast<spi_host_device_t>(cfg->qspi_host);

    s.trans_done = xSemaphoreCreateBinary();
    if (!s.trans_done) return ESP_ERR_NO_MEM;

    // 行带高度: Kconfig 指定, 裁剪到面板高
    s.strip_lines = CONFIG_PX_DISPLAY_STRIP_LINES;
    if (s.strip_lines > s.panel_h) s.strip_lines = s.panel_h;
    if (s.strip_lines < 1) s.strip_lines = 1;
    const size_t strip_bytes =
        static_cast<size_t>(s.panel_w) * s.strip_lines * sizeof(uint16_t);

    // 1) 单线 SPI 总线 (MOSI 复用板配置的 d0)
    spi_bus_config_t buscfg = {};
    buscfg.mosi_io_num = cfg->pin_d0;
    buscfg.miso_io_num = -1;
    buscfg.sclk_io_num = cfg->pin_sclk;
    buscfg.quadwp_io_num = -1;
    buscfg.quadhd_io_num = -1;
    buscfg.max_transfer_sz = static_cast<int>(strip_bytes) + 64;
    ESP_RETURN_ON_ERROR(spi_bus_initialize(s.spi_host, &buscfg, SPI_DMA_CH_AUTO), TAG,
                        "spi_bus_initialize 失败");

    // 2) 面板 IO (8bit cmd / 8bit param, DC 线区分数据命令)
    esp_lcd_panel_io_spi_config_t io_cfg = {};
    io_cfg.cs_gpio_num = cfg->pin_cs;
    io_cfg.dc_gpio_num = cfg->pin_dc;
    io_cfg.spi_mode = 0;
    io_cfg.pclk_hz = static_cast<unsigned int>(cfg->pclk_hz);
    io_cfg.trans_queue_depth = 10;
    io_cfg.on_color_trans_done = on_color_trans_done;
    io_cfg.user_ctx = nullptr;
    io_cfg.lcd_cmd_bits = 8;
    io_cfg.lcd_param_bits = 8;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi(
                            static_cast<esp_lcd_spi_bus_handle_t>(s.spi_host), &io_cfg, &s.io),
                        TAG, "new_panel_io_spi 失败");

    // 3) ST7789 面板 (IDF esp_lcd 内置驱动, 无外部组件依赖)
    esp_lcd_panel_dev_config_t panel_cfg = {};
    panel_cfg.reset_gpio_num = cfg->pin_reset;
#if CONFIG_BOARD_GSPI_LCD_BGR
    panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR;
#else
    panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
#endif
    panel_cfg.bits_per_pixel = 16;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(s.io, &panel_cfg, &s.panel), TAG,
                        "new_panel_st7789 失败");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s.panel), TAG, "panel_reset 失败");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s.panel), TAG, "panel_init 失败");
#if CONFIG_BOARD_GSPI_LCD_INVERT_COLOR
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(s.panel, true), TAG, "invert_color 失败");
#endif
    ESP_RETURN_ON_ERROR(esp_lcd_panel_set_gap(s.panel, CONFIG_BOARD_GSPI_LCD_X_OFFSET,
                                              CONFIG_BOARD_GSPI_LCD_Y_OFFSET),
                        TAG, "set_gap 失败");

    // 4) 帧缓冲 (px_alloc: 无 PSRAM 落内部堆) + 行带中转缓冲 (DMA 内部内存)
    if (!gfx::create_surface(&s.fb, s.panel_w, s.panel_h)) {
        ESP_LOGE(TAG, "帧缓冲分配失败 (%dx%d)", s.panel_w, s.panel_h);
        return ESP_ERR_NO_MEM;
    }
    s.staging = static_cast<uint16_t *>(
        heap_caps_aligned_alloc(64, strip_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
    if (!s.staging) {
        gfx::destroy_surface(&s.fb);
        ESP_LOGE(TAG, "行带缓冲分配失败 (%u B)", static_cast<unsigned>(strip_bytes));
        return ESP_ERR_NO_MEM;
    }

    // 5) 背光 + 点亮
    if (cfg->pin_backlight >= 0) {
        s.has_backlight = (backlight_init(cfg->pin_backlight) == ESP_OK);
        if (!s.has_backlight) ESP_LOGW(TAG, "背光 LEDC 初始化失败, 亮度调节不可用");
    }
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s.panel, true), TAG, "disp_on 失败");
    s.ready = true;
    s.power = true;
    set_brightness(s.brightness);

    // 首帧推全屏 (黑)
    mark_dirty(0, 0, width(), height());
    ESP_LOGI(TAG, "初始化完成: %dx%d ST7789 SPI @%d Hz, 行带 %d 行 (%u B)", s.panel_w,
             s.panel_h, cfg->pclk_hz, s.strip_lines, static_cast<unsigned>(strip_bytes));
    return ESP_OK;
}

bool ready() { return s.ready; }

gfx::Surface &framebuffer() { return s.fb; }

int width() { return (s.rotation == 90 || s.rotation == 270) ? s.panel_h : s.panel_w; }
int height() { return (s.rotation == 90 || s.rotation == 270) ? s.panel_w : s.panel_h; }

void mark_dirty(int x, int y, int w, int h)
{
    if (!s.ready || w <= 0 || h <= 0) return;
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + w, y1 = y + h;
    if (x1 > width()) x1 = width();
    if (y1 > height()) y1 = height();
    if (x0 >= x1 || y0 >= y1) return;
    Rect r{x0, y0, x1 - x0, y1 - y0};

    // 与已有矩形相交/相邻则合并 (策略与 QSPI 后端一致)
    for (int i = 0; i < s.dirty_count; ++i) {
        if (rect_overlap_or_touch(s.dirty[i], r)) {
            s.dirty[i] = rect_union(s.dirty[i], r);
            return;
        }
    }
    if (s.dirty_count < kMaxDirty) {
        s.dirty[s.dirty_count++] = r;
        return;
    }
    // 槽满: 并入面积增长最小的矩形
    int best = 0;
    long best_grow = -1;
    for (int i = 0; i < kMaxDirty; ++i) {
        const Rect u = rect_union(s.dirty[i], r);
        const long grow =
            static_cast<long>(u.w) * u.h - static_cast<long>(s.dirty[i].w) * s.dirty[i].h;
        if (best_grow < 0 || grow < best_grow) {
            best_grow = grow;
            best = i;
        }
    }
    s.dirty[best] = rect_union(s.dirty[best], r);
}

esp_err_t flush()
{
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (s.dirty_count == 0) return ESP_OK;
    if (!s.power) {  // 熄屏时丢弃推送, 保留脏区待亮屏
        return ESP_OK;
    }
    esp_err_t err = ESP_OK;
    for (int i = 0; i < s.dirty_count && err == ESP_OK; ++i) {
        const Rect p = to_physical(s.dirty[i]);
        if (p.empty()) continue;
        // 行带分段: 每段 ≤ strip_lines 行, gather → draw_bitmap → 等 DMA
        for (int y = p.y; y < p.y + p.h && err == ESP_OK; y += s.strip_lines) {
            int hh = p.y + p.h - y;
            if (hh > s.strip_lines) hh = s.strip_lines;
            const Rect strip{p.x, y, p.w, hh};
            gather_rect(strip);
            err = esp_lcd_panel_draw_bitmap(s.panel, strip.x, strip.y, strip.x + strip.w,
                                            strip.y + strip.h, s.staging);
            if (err == ESP_OK) {
                xSemaphoreTake(s.trans_done, portMAX_DELAY);
            }
        }
    }
    s.dirty_count = 0;
    return err;
}

esp_err_t set_brightness(int percent)
{
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s.brightness = percent;
    // ST7789 无亮度命令, 亮度 = 背光 PWM; 无背光脚时仅记值 (如实降级)
    backlight_set(s.power ? percent : 0);
    return ESP_OK;
}

int get_brightness() { return s.brightness; }

esp_err_t set_power(bool on)
{
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (on == s.power) return ESP_OK;
    esp_err_t err;
    if (on) {
        err = esp_lcd_panel_disp_sleep(s.panel, false);  // sleep out
        if (err == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(120));  // ST7789 sleep out 后需 >120ms
            err = esp_lcd_panel_disp_on_off(s.panel, true);
        }
        if (err == ESP_OK) {
            s.power = true;
            backlight_set(s.brightness);
            mark_dirty(0, 0, width(), height());  // 亮屏后整屏重推
            err = flush();
        }
    } else {
        backlight_set(0);
        err = esp_lcd_panel_disp_on_off(s.panel, false);
        if (err == ESP_OK) err = esp_lcd_panel_disp_sleep(s.panel, true);  // sleep in
        if (err == ESP_OK) s.power = false;
    }
    return err;
}

bool get_power() { return s.power; }

esp_err_t set_rotation(int deg)
{
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (deg != 0 && deg != 90 && deg != 180 && deg != 270) return ESP_ERR_INVALID_ARG;
    if (deg == s.rotation) return ESP_OK;
    s.rotation = deg;
    s.fb.w = width();
    s.fb.h = height();
    s.fb.stride = s.fb.w;
    gfx::clear(s.fb, 0);
    s.dirty_count = 0;
    mark_dirty(0, 0, width(), height());
    return ESP_OK;
}

int get_rotation() { return s.rotation; }

}  // namespace hal_display
