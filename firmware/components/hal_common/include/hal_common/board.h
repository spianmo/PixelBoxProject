/**
 * hal_common/board.h — PixelBox 板级抽象接口
 *
 * 全部引脚/总线/能力配置收敛在 boards 组件的板型文件中,
 * 其他组件(hal_display / hal_audio / bindings_* 等)一律通过
 * 本头文件的 getter 获取硬件信息,禁止硬编码引脚。
 *
 * 实现方: components/boards (Kconfig 选择板型)。
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 前向声明 i2c_master 总线句柄 (与 driver/i2c_master.h 中的定义一致,
 * 这里避免让纯头文件组件依赖具体驱动组件) */
struct i2c_master_bus_t;
typedef struct i2c_master_bus_t *board_i2c_bus_handle_t;

/** 无效引脚统一用 -1 表示 */
#define BOARD_PIN_NC (-1)

/* ------------------------------------------------------------
 * 配置结构体
 * ------------------------------------------------------------ */

/** 显示配置 (SH8601 QSPI AMOLED / ST7789 单线 SPI 等; 无屏板全部置 -1/0)
 *
 * 多目标说明: 面板驱动与总线模式由板型 Kconfig 在编译期选定
 * (hal_display 按 CONFIG_BOARD_* 选择后端源文件), 本结构只承载引脚/时序。
 * 单线 SPI 板 (BOARD_GENERIC_SPI): MOSI 复用 pin_d0, pin_d1..d3 置 -1,
 * 并使用 pin_dc / pin_backlight; QSPI 板 (微雪 SH8601) 两字段置 -1。 */
typedef struct {
    int width;              /*!< 横向分辨率 (px) */
    int height;             /*!< 纵向分辨率 (px) */
    int qspi_host;          /*!< SPI 主机编号 (spi_host_device_t 值; QSPI/SPI 共用) */
    int pclk_hz;            /*!< 像素时钟 */
    int pin_cs;             /*!< 片选 */
    int pin_sclk;           /*!< 时钟 */
    int pin_d0;             /*!< QSPI 数据 0 / 单线 SPI 的 MOSI */
    int pin_d1;             /*!< QSPI 数据 1; 单线 SPI = -1 */
    int pin_d2;             /*!< QSPI 数据 2; 单线 SPI = -1 */
    int pin_d3;             /*!< QSPI 数据 3; 单线 SPI = -1 */
    int pin_reset;          /*!< 复位; -1 = 由 IO 扩展器控制 (board_init 已释放复位) */
    int pin_te;             /*!< TE 撕裂同步; -1 = 无 */
    int pin_dc;             /*!< 数据/命令 (单线 SPI 用); QSPI = -1 */
    int pin_backlight;      /*!< 背光 (单线 SPI TFT 用, LEDC PWM 调亮度); -1 = 无 */
} board_display_config_t;

/** 音频配置 (ES8311 codec + I2S) */
typedef struct {
    int i2s_port;           /*!< I2S 端口号 */
    int pin_mclk;           /*!< 主时钟 */
    int pin_bclk;           /*!< 位时钟 */
    int pin_ws;             /*!< 帧时钟 (LRCK) */
    int pin_dout;           /*!< ESP32 → codec (播放数据) */
    int pin_din;            /*!< codec → ESP32 (麦克风数据) */
    int pin_pa_enable;      /*!< 功放使能; -1 = 无 */
    uint8_t es8311_addr;    /*!< ES8311 I2C 7 位地址 */
    uint8_t es7210_addr;    /*!< ES7210 拾音 ADC 地址; 0 = 无 (录音走 ES8311 自带 ADC) */
} board_audio_config_t;

/** 共享 I2C 总线配置 (触摸/codec 控制/PMU/IMU/RTC 同一条总线) */
typedef struct {
    int port;               /*!< I2C 端口号 */
    int pin_sda;
    int pin_scl;
    uint32_t freq_hz;       /*!< 总线速率 */
} board_i2c_config_t;

/** 触摸配置 (FT3168 等) */
typedef struct {
    uint8_t i2c_addr;       /*!< 触摸控制器 I2C 7 位地址 */
    int pin_int;            /*!< 中断脚; -1 = 无 (轮询) */
    int pin_reset;          /*!< 复位; -1 = 由 IO 扩展器控制 (board_init 已释放复位) */
} board_touch_config_t;

/** IMU 配置 (QMI8658 等) */
typedef struct {
    uint8_t i2c_addr;       /*!< IMU I2C 7 位地址 */
    int pin_int1;           /*!< 中断 1; -1 = 无 */
    int pin_int2;           /*!< 中断 2; -1 = 无 */
} board_imu_config_t;

/** RTC 配置 (PCF85063 等) */
typedef struct {
    uint8_t i2c_addr;       /*!< RTC I2C 7 位地址 */
} board_rtc_config_t;

/** 按键配置 */
typedef struct {
    int pin_boot;           /*!< 板载 BOOT 键 (低有效); -1 = 无 */
    int pin_user;           /*!< 用户键 (低有效, 2.16 板 KEY3=GPIO18); -1 = 无 */
    int pin_pwr_sense;      /*!< 电源键状态感知脚 (2.16 板 SYS_OUT=GPIO16,
                                 极性上电自检); -1 = 无 */
} board_button_config_t;

/** 硬件能力开关 (与 px.system.info().capabilities 一一对应) */
typedef struct {
    bool camera;
    bool gps;
    bool ble;
    bool led;
    bool imu;
    bool touch;
    bool battery;
    bool mic;
    bool speaker;
} board_caps_t;

/** 电池状态 (px.system.battery()) */
typedef struct {
    int level;              /*!< 电量百分比 0-100; 无电池 = -1 */
    bool charging;          /*!< 是否充电中 */
    int voltage_mv;         /*!< 电池电压 mV; 无电池 = 0 */
} board_battery_info_t;

/* ------------------------------------------------------------
 * 板级接口 (boards 组件实现)
 * ------------------------------------------------------------ */

/**
 * 板级初始化: I2C 总线、IO 扩展器(释放屏幕/触摸复位)、PMU(电量计使能)等。
 * 必须在使用其余 board_* 接口前调用一次 (app_main 起始阶段)。
 */
esp_err_t board_init(void);

/** 设备型号字符串, 如 "pixelbox-s3-v1" */
const char *board_model(void);

/** 各配置 getter (返回指向静态配置的指针, 永不为 NULL) */
const board_display_config_t *board_display_config(void);
const board_audio_config_t *board_audio_config(void);
const board_i2c_config_t *board_i2c_config(void);
const board_touch_config_t *board_touch_config(void);
const board_imu_config_t *board_imu_config(void);
const board_rtc_config_t *board_rtc_config(void);
const board_button_config_t *board_button_config(void);
const board_caps_t *board_caps(void);

/** 读取电池状态 (内部走 PMU I2C, 已做总线加锁) */
esp_err_t board_battery(board_battery_info_t *out);

/**
 * 共享 I2C 总线句柄 (i2c_master_bus_handle_t)。
 * 多任务并发访问外设前必须 board_i2c_lock/unlock。
 */
board_i2c_bus_handle_t board_i2c_bus(void);

/** 共享 I2C 总线互斥锁; timeout_ms 超时返回 ESP_ERR_TIMEOUT */
esp_err_t board_i2c_lock(uint32_t timeout_ms);
void board_i2c_unlock(void);

#ifdef __cplusplus
}
#endif
