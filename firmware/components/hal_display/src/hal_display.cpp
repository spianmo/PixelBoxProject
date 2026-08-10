/**
 * hal_display.cpp — SH8601 QSPI AMOLED 显示 HAL 实现
 *
 * 数据通路:
 *   gfx 绘图 → 逻辑帧缓冲 (PSRAM, 旋转后坐标系) → mark_dirty 记录脏矩形
 *   → flush(): 脏区(软件旋转)按行带打包进内部 DMA 中转缓冲
 *   → esp_lcd draw_bitmap → QSPI DMA → 面板, 每带等 trans_done 后复用。
 *
 * 中转缓冲必须是内部 (非 PSRAM) DMA 内存: S3 的 GPSPI 驱动对非
 * esp_ptr_dma_capable 缓冲会逐事务临时 malloc 内部副本 (失败静默
 * NO_MEM, 见 spi_master setup_priv_desc), PSRAM 整帧缓冲在内存压力下
 * 必然间歇丢帧。行带取 32 行 (480 宽 × 32 × 2B = 30KB), 恰低于单笔
 * SPI DMA 事务 32KB 上限, 每带一笔事务、零运行时分配。
 * 经中转缓冲的另两个理由: 旋转重排像素; 发送期间 JS 可继续绘制。
 */
#include "hal_display/hal_display.hpp"

#include <cstring>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "sdkconfig.h"
#if CONFIG_BOARD_WAVESHARE_AMOLED_216
#include "esp_lcd_co5300.h"
#else
#include "esp_lcd_sh8601.h"
#endif
#include "esp_log.h"
#include "hal_common/board.h"
#include "hal_common/px_alloc.h"

namespace hal_display {

namespace {

constexpr const char *TAG = "hal_display";

/* SH8601 QSPI 写命令前导操作码 (io 配置为 32bit cmd: 0x02 cmd 0x00) */
constexpr uint32_t kQspiCmd = 0x02;

struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
    bool empty() const { return w <= 0 || h <= 0; }
};

constexpr int kMaxDirty = 8;

/* 行带高度: 面板宽 × 32 行 × 2B ≤ 30KB, 低于 S3 单笔 SPI DMA 事务上限 (32KB) */
constexpr int kStripRows = 32;

struct State {
    bool ready = false;
    // 面板物理尺寸 (boards 提供)
    int panel_w = 0;
    int panel_h = 0;
    int rotation = 0;      // 0/90/180/270
    int brightness = 80;   // 0-100
    bool power = true;

    gfx::Surface fb;              // 逻辑帧缓冲 (PSRAM)
    uint16_t *staging = nullptr;  // 物理方向中转缓冲 (PSRAM, 64B 对齐)

    Rect dirty[kMaxDirty];
    int dirty_count = 0;

    esp_lcd_panel_io_handle_t io = nullptr;
    esp_lcd_panel_handle_t panel = nullptr;
    spi_host_device_t spi_host = SPI2_HOST;
    SemaphoreHandle_t trans_done = nullptr;
};

State s;

/* ------------------------------------------------------------
 * 脏矩形
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

/* ------------------------------------------------------------
 * 面板命令辅助
 * ------------------------------------------------------------ */

esp_err_t tx_cmd(uint8_t cmd, const uint8_t *param, size_t len)
{
    // QSPI 模式下命令为 32bit: 0x02 << 24 | cmd << 8
    return esp_lcd_panel_io_tx_param(s.io, (kQspiCmd << 24) | (static_cast<uint32_t>(cmd) << 8),
                                     param, len);
}

bool on_color_trans_done(esp_lcd_panel_io_handle_t /*io*/, esp_lcd_panel_io_event_data_t * /*ev*/,
                         void * /*ctx*/)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s.trans_done, &woken);
    return woken == pdTRUE;
}

#if CONFIG_BOARD_WAVESHARE_AMOLED_216
/* Waveshare ESP32-S3-Touch-AMOLED-2.16 (CO5300, 480x480) 初始化序列,
 * 逐字对齐官方 BSP esp32_s3_touch_amoled_2_16.c 的 lcd_init_cmds:
 * 0x11 SLPOUT 后 600ms 长延时是官方实测值 (组件默认 60ms 不够);
 * 0xFE 页切换 (0x20 页写 0x19/0x1C, 回 0x00 页); 0x3A=0x55 RGB565;
 * 0x35 TEON; 0x53=0x20 亮度控制使能; 0x51/0x63 亮度与 HBM 上限;
 * 0x2A/0x2B 全屏窗口 (480-1=0x1DF); 0x36=0xA0 MADCTL 方向;
 * 0x29 DISPON + 600ms。0x3A/0x36 会覆盖驱动默认值并打 WARN, 属预期。
 * (C++ 不支持复合字面量, 参数数组单独定义) */
const uint8_t kCmd11[] = {0x00};
const uint8_t kCmdFE20[] = {0x20};
const uint8_t kCmd19[] = {0x10};
const uint8_t kCmd1C[] = {0xA0};
const uint8_t kCmdFE00[] = {0x00};
const uint8_t kCmdC4[] = {0x80};
const uint8_t kCmd3A[] = {0x55};
const uint8_t kCmd35[] = {0x00};
const uint8_t kCmd53[] = {0x20};
const uint8_t kCmd51[] = {0xFF};
const uint8_t kCmd63[] = {0xFF};
const uint8_t kCmd2A[] = {0x00, 0x00, 0x01, 0xDF};
const uint8_t kCmd2B[] = {0x00, 0x00, 0x01, 0xDF};
const uint8_t kCmd36[] = {0xA0};
const co5300_lcd_init_cmd_t kInitCmds[] = {
    {0x11, kCmd11, 0, 600},
    {0xFE, kCmdFE20, 1, 0},
    {0x19, kCmd19, 1, 0},
    {0x1C, kCmd1C, 1, 0},
    {0xFE, kCmdFE00, 1, 0},
    {0xC4, kCmdC4, 1, 0},
    {0x3A, kCmd3A, 1, 0},
    {0x35, kCmd35, 1, 0},
    {0x53, kCmd53, 1, 0},
    {0x51, kCmd51, 1, 0},
    {0x63, kCmd63, 1, 0},
    {0x2A, kCmd2A, 4, 0},
    {0x2B, kCmd2B, 4, 0},
    {0x36, kCmd36, 1, 0},
    {0x29, nullptr, 0, 600},
};
#else
/* Waveshare ESP32-S3-Touch-AMOLED-1.8 (SH8601, 368x448) 附加初始化序列:
 * 0x44+0x35 使能 TE; 0x53=0x20 打开亮度控制 (0x51 才生效);
 * 0x2A/0x2B 声明全屏窗口 (368-1=0x16F, 448-1=0x1BF)。
 * (C++ 不支持复合字面量, 参数数组单独定义) */
const uint8_t kCmd44[] = {0x01, 0xD1};
const uint8_t kCmd35[] = {0x00};
const uint8_t kCmd53[] = {0x20};
const uint8_t kCmd2A[] = {0x00, 0x00, 0x01, 0x6F};
const uint8_t kCmd2B[] = {0x00, 0x00, 0x01, 0xBF};
const sh8601_lcd_init_cmd_t kInitCmds[] = {
    {0x44, kCmd44, sizeof(kCmd44), 0},
    {0x35, kCmd35, sizeof(kCmd35), 0},
    {0x53, kCmd53, sizeof(kCmd53), 10},
    {0x2A, kCmd2A, sizeof(kCmd2A), 0},
    {0x2B, kCmd2B, sizeof(kCmd2B), 0},
};
#endif

/* ------------------------------------------------------------
 * 旋转坐标变换
 *
 * 逻辑 (lx,ly) → 物理 (px,py), PW/PH 为面板物理宽高:
 *   0:   (lx, ly)
 *   90:  (PW-1-ly, lx)         — 内容顺时针转 90°
 *   180: (PW-1-lx, PH-1-ly)
 *   270: (ly, PH-1-lx)
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

/** 把物理矩形 p 的像素从逻辑帧缓冲收集进 staging (行优先紧凑排列) */
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

    // 1) QSPI 总线 (等价 SH8601_PANEL_BUS_QSPI_CONFIG; 宏的指定初始化器
    //    顺序与结构体声明序不符, C++ 下无法直接使用, 故逐字段填写)
    spi_bus_config_t buscfg = {};
    buscfg.data0_io_num = cfg->pin_d0;
    buscfg.data1_io_num = cfg->pin_d1;
    buscfg.sclk_io_num = cfg->pin_sclk;
    buscfg.data2_io_num = cfg->pin_d2;
    buscfg.data3_io_num = cfg->pin_d3;
    buscfg.max_transfer_sz = s.panel_w * s.panel_h * static_cast<int>(sizeof(uint16_t)) + 64;
    ESP_RETURN_ON_ERROR(spi_bus_initialize(s.spi_host, &buscfg, SPI_DMA_CH_AUTO), TAG,
                        "spi_bus_initialize 失败");

    // 2) 面板 IO (等价 SH8601_PANEL_IO_QSPI_CONFIG: QSPI 32bit cmd + 8bit param)
    esp_lcd_panel_io_spi_config_t io_cfg = {};
    io_cfg.cs_gpio_num = cfg->pin_cs;
    io_cfg.dc_gpio_num = -1;
    io_cfg.spi_mode = 0;
    io_cfg.pclk_hz = static_cast<unsigned int>(cfg->pclk_hz);
#if CONFIG_BOARD_WAVESHARE_AMOLED_216
    io_cfg.trans_queue_depth = 3;  // 官方 BSP 值 (整帧 450KB DMA, 深队列无意义)
#else
    io_cfg.trans_queue_depth = 10;
#endif
    io_cfg.on_color_trans_done = on_color_trans_done;
    io_cfg.user_ctx = nullptr;
    io_cfg.lcd_cmd_bits = 32;
    io_cfg.lcd_param_bits = 8;
    io_cfg.flags.quad_mode = true;
    // IDF 5.5 中 esp_lcd_spi_bus_handle_t 为 int, 枚举转换须用 static_cast
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi(
                            static_cast<esp_lcd_spi_bus_handle_t>(s.spi_host), &io_cfg, &s.io),
                        TAG, "new_panel_io_spi 失败");

#if CONFIG_BOARD_WAVESHARE_AMOLED_216
    // 3) CO5300 面板驱动 (组件注册表 espressif/esp_lcd_co5300)
    co5300_vendor_config_t vendor_cfg = {};
    vendor_cfg.init_cmds = kInitCmds;
    vendor_cfg.init_cmds_size = sizeof(kInitCmds) / sizeof(kInitCmds[0]);
    vendor_cfg.flags.use_qspi_interface = 1;

    esp_lcd_panel_dev_config_t panel_cfg = {};
    panel_cfg.reset_gpio_num = cfg->pin_reset;  // 2.16 板复位直连 GPIO39
    panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_cfg.bits_per_pixel = 16;
    panel_cfg.vendor_config = &vendor_cfg;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_co5300(s.io, &panel_cfg, &s.panel), TAG,
                        "new_panel_co5300 失败");
#else
    // 3) SH8601 面板驱动 (组件注册表 espressif/esp_lcd_sh8601)
    sh8601_vendor_config_t vendor_cfg = {};
    vendor_cfg.init_cmds = kInitCmds;
    vendor_cfg.init_cmds_size = sizeof(kInitCmds) / sizeof(kInitCmds[0]);
    vendor_cfg.flags.use_qspi_interface = 1;

    esp_lcd_panel_dev_config_t panel_cfg = {};
    panel_cfg.reset_gpio_num = cfg->pin_reset;  // -1 = 复位由 IO 扩展器完成 (board_init)
    panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_cfg.bits_per_pixel = 16;
    panel_cfg.vendor_config = &vendor_cfg;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_sh8601(s.io, &panel_cfg, &s.panel), TAG,
                        "new_panel_sh8601 失败");
#endif
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s.panel), TAG, "panel_reset 失败");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s.panel), TAG, "panel_init 失败");

    // 4) 帧缓冲 (PSRAM) + 行带中转缓冲 (内部 DMA 内存, 见文件头注释)
    if (!gfx::create_surface(&s.fb, s.panel_w, s.panel_h)) {
        ESP_LOGE(TAG, "帧缓冲分配失败 (%dx%d)", s.panel_w, s.panel_h);
        return ESP_ERR_NO_MEM;
    }
    const size_t strip_bytes = static_cast<size_t>(s.panel_w) * kStripRows * sizeof(uint16_t);
    s.staging = static_cast<uint16_t *>(
        heap_caps_aligned_alloc(64, strip_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
    if (!s.staging) {
        gfx::destroy_surface(&s.fb);
        ESP_LOGE(TAG, "行带中转缓冲分配失败 (%zu B 内部 DMA)", strip_bytes);
        return ESP_ERR_NO_MEM;
    }

    // 5) 点亮: display on + 默认亮度
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s.panel, true), TAG, "disp_on 失败");
    s.ready = true;
    s.power = true;
    set_brightness(s.brightness);

    // 首帧推全屏 (黑)
    mark_dirty(0, 0, width(), height());
    ESP_LOGI(TAG, "初始化完成: %dx%d QSPI @%d Hz", s.panel_w, s.panel_h, cfg->pclk_hz);
    return ESP_OK;
}

bool ready() { return s.ready; }

gfx::Surface &framebuffer() { return s.fb; }

int width() { return (s.rotation == 90 || s.rotation == 270) ? s.panel_h : s.panel_w; }
int height() { return (s.rotation == 90 || s.rotation == 270) ? s.panel_w : s.panel_h; }

void mark_dirty(int x, int y, int w, int h)
{
    if (!s.ready || w <= 0 || h <= 0) return;
    // 裁剪到逻辑屏幕
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + w, y1 = y + h;
    if (x1 > width()) x1 = width();
    if (y1 > height()) y1 = height();
    if (x0 >= x1 || y0 >= y1) return;
    Rect r{x0, y0, x1 - x0, y1 - y0};

    // 与已有矩形相交/相邻则合并
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
        const long grow = static_cast<long>(u.w) * u.h - static_cast<long>(s.dirty[i].w) * s.dirty[i].h;
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
        Rect p = to_physical(s.dirty[i]);
        if (p.empty()) continue;

        // SH8601/CO5300 QSPI 硬约束: 刷新窗口坐标须 2 像素对齐
        // (起点向下取偶, 终点向上取偶, 越界裁剪)
        const int x1 = (p.x + p.w + 1) & ~1;
        const int y1 = (p.y + p.h + 1) & ~1;
        p.x &= ~1;
        p.y &= ~1;
        p.w = ((x1 > s.panel_w) ? s.panel_w : x1) - p.x;
        p.h = ((y1 > s.panel_h) ? s.panel_h : y1) - p.y;

        // 按行带推送: staging 仅容 kStripRows 行, 每带一笔 DMA、等完成后复用
        for (int row = 0; row < p.h && err == ESP_OK; row += kStripRows) {
            const int band_h = (p.h - row < kStripRows) ? (p.h - row) : kStripRows;
            const Rect band{p.x, p.y + row, p.w, band_h};
            gather_rect(band);
            err = esp_lcd_panel_draw_bitmap(s.panel, band.x, band.y, band.x + band.w,
                                            band.y + band.h, s.staging);
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
    const uint8_t dbv = static_cast<uint8_t>((percent * 255) / 100);
    return tx_cmd(0x51, &dbv, 1);  // SH8601 亮度命令 0x51 (WRDISBV)
}

int get_brightness() { return s.brightness; }

esp_err_t set_power(bool on)
{
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (on == s.power) return ESP_OK;
    esp_err_t err;
    if (on) {
        err = tx_cmd(0x11, nullptr, 0);  // sleep out
        if (err == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(120));
            err = esp_lcd_panel_disp_on_off(s.panel, true);
        }
        if (err == ESP_OK) {
            s.power = true;
            set_brightness(s.brightness);
            mark_dirty(0, 0, width(), height());  // 亮屏后整屏重推
            err = flush();
        }
    } else {
        err = esp_lcd_panel_disp_on_off(s.panel, false);
        if (err == ESP_OK) err = tx_cmd(0x10, nullptr, 0);  // sleep in (AMOLED 深度省电)
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
    // 逻辑尺寸变化: 重排帧缓冲 (宽高互换时 stride 变), 内容清空
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
