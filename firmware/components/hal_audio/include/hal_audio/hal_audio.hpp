/**
 * PixelBox hal_audio — 音频硬件抽象层公开接口
 *
 * 硬件:ES8311 codec(esp_codec_dev 驱动,I2S std 双工 + I2C 控制),默认 16kHz/单声道/16bit。
 *
 * 结构:
 *   - mic:采集任务按 10ms 块从 codec 读取,fan-out 给多个订阅者(JS mic / voicechat / record)
 *   - player:播放任务把多个 Source 重采样到设备输出率后混音写入 codec
 *
 * 引脚不在本组件硬编码:由板级(boards/main)构造 Config 后调用 init()。
 *
 * 线程约定:mic 订阅回调运行在采集任务上下文(禁止阻塞、禁止直接调 JS);
 * Source::on_finished 运行在播放任务上下文。投递 JS 一律经 jsvm::post。
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>

#include "esp_err.h"
#include "hal_audio/audio_source.hpp"

namespace hal_audio {

/** 板级音频配置(引脚由 boards 组件提供,禁止在其他组件硬编码) */
struct Config {
    int i2s_port = 0;          ///< I2S 端口号
    int pin_mclk = -1;
    int pin_bclk = -1;
    int pin_ws = -1;
    int pin_dout = -1;         ///< codec DAC 数据(播放)
    int pin_din = -1;          ///< codec ADC 数据(录音)
    int pin_pa = -1;           ///< 功放使能脚,-1 表示无
    uint8_t i2c_addr = 0x18;   ///< ES8311 7bit I2C 地址
    uint8_t es7210_addr = 0;   ///< ES7210 拾音 ADC 地址; 0 = 无(录音走 ES8311)
    /** i2c_master 总线句柄(IDF v5.5 新驱动,由板级初始化共享总线后传入) */
    void* i2c_bus_handle = nullptr;
    int i2c_port = 0;          ///< 兼容字段:bus_handle 为空时使用端口号
    uint32_t sample_rate = 16000;  ///< 双工设备采样率(mic 与 speaker 共时钟)
    bool use_mclk = true;
};

/** 初始化 codec + I2S + 播放任务;重复调用返回 ESP_ERR_INVALID_STATE */
esp_err_t init(const Config& cfg);
/**
 * 便捷初始化:从 hal_common/board.h 读取板级音频配置与共享 I2C 总线。
 * 需先完成 board_init();板级 caps 不含 mic/speaker 时返回 ESP_ERR_NOT_SUPPORTED。
 */
esp_err_t init_from_board();
esp_err_t deinit();
/** 音频硬件是否就绪(未就绪时绑定层应抛 ENOTSUP) */
bool ready();

/** 当前设备双工采样率 */
uint32_t device_rate();
/** 空闲(无采集订阅且无播放源)时重设设备采样率 */
esp_err_t set_device_rate(uint32_t rate);

// ---------------- 音量 / 增益(走 codec) ----------------

/** 扬声器音量 0-100 */
void set_volume(int percent);
int get_volume();
/** 麦克风增益 0-100(内部映射为 codec ADC dB) */
void set_mic_gain(int percent);
int get_mic_gain();

// ---------------- 麦克风采集(多订阅 fan-out) ----------------

/**
 * 采集回调:samples 为设备采样率下的单声道 PCM16(约 10ms/次)。
 * 运行在采集任务上下文;回调内允许调用 mic_unsubscribe(延迟生效)。
 */
using MicSink = std::function<void(const int16_t* samples, size_t count)>;

/** 订阅麦克风数据;第一个订阅者触发采集任务启动。返回订阅 id(<0 失败) */
int mic_subscribe(MicSink sink);
void mic_unsubscribe(int id);
/** 采集任务是否在运行 */
bool mic_running();

// ---------------- 播放(混音器) ----------------

/** 把源挂到混音器(立即开始播放);同一 source 重复添加返回 INVALID_STATE */
esp_err_t player_add(const std::shared_ptr<Source>& src);
/** 停止全部播放源 */
void player_stop_all();
/** 是否存在活跃播放源 */
bool player_active();

}  // namespace hal_audio
