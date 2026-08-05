/**
 * ble_hal.hpp — NimBLE 封装(peripheral 动态 GATT + central 扫描/连接/GATT 客户端)
 *
 * 线程模型:
 *   - 本层所有回调都在 NimBLE host 任务上下文触发, bindings 负责投递到 JS 线程
 *   - 本层 API 可从任意任务调用(NimBLE host API 自带锁)
 *
 * 依赖 sdkconfig:CONFIG_BT_ENABLED + CONFIG_BT_NIMBLE_ENABLED;
 * 未开启时全部 API 返回 ESP_ERR_NOT_SUPPORTED, available() = false。
 */
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "esp_err.h"
#include "hal_periph/px_uuid.hpp"

namespace hal_periph {
namespace ble {

// ---------------------------------------------------------------
// 通用
// ---------------------------------------------------------------

/** BLE 是否可用(Kconfig PX_ENABLE_BLE 且 NimBLE 已编入) */
bool available();

/** 启动 NimBLE 协议栈(幂等, 同步等待 host sync) */
esp_err_t ensure_started();

// ---------------------------------------------------------------
// peripheral(外设/服务端)
// ---------------------------------------------------------------

struct CharDef {
    PxUuid uuid;
    bool readable = false;
    bool writable = false;
    bool notifiable = false;
    std::vector<uint8_t> value;   ///< 初始值/缓存值
    bool has_on_read = false;     ///< JS 侧提供了 onRead → 走同步读桥
    uint32_t user_tag = 0;        ///< bindings 侧特征索引
};

struct SvcDef {
    PxUuid uuid;
    std::vector<CharDef> chars;
};

struct PeripheralCallbacks {
    std::function<void(const std::string& central_id)> on_connect;
    std::function<void(const std::string& central_id)> on_disconnect;
    /** 特征被写(user_tag 定位特征;data 为新值, 缓存已同步更新) */
    std::function<void(uint32_t user_tag, std::vector<uint8_t> data)> on_write;
    /**
     * 同步读桥:在 NimBLE host 任务调用, 内部可阻塞等待 JS 线程 ≤100ms;
     * 返回 true 表示用 out 作为读结果, false 用缓存值。
     */
    std::function<bool(uint32_t user_tag, std::vector<uint8_t>& out)> on_read_sync;
};

/** 以外设身份建 GATT 表并开始广播(重复调用会先 stop) */
esp_err_t peripheral_start(const std::string& name, std::vector<SvcDef> svcs,
                           PeripheralCallbacks cbs);

/** 停止广播并断开连接(GATT 表保留至下次 start 重建) */
void peripheral_stop();

/** 是否处于外设运行状态 */
bool peripheral_running();

/** 向所有已订阅的连接发 notify */
esp_err_t peripheral_notify(const PxUuid& svc, const PxUuid& chr,
                            const uint8_t* data, size_t len);

/** 更新特征缓存值(不通知) */
esp_err_t peripheral_set_value(uint32_t user_tag, std::vector<uint8_t> value);

// ---------------------------------------------------------------
// central(中心/客户端)
// ---------------------------------------------------------------

struct ScanResult {
    std::string id;               ///< "aa:bb:cc:dd:ee:ff" 形式
    std::string name;             ///< 空串 = 无名
    bool has_name = false;
    int rssi = 0;
    std::vector<uint8_t> mfg;     ///< 厂商数据
    bool has_mfg = false;
};

/**
 * 开始扫描;on_device 每发现一个新设备回调一次(按地址去重),
 * on_done 在超时/取消时回调全量汇总。
 */
esp_err_t scan_start(uint32_t timeout_ms,
                     std::function<void(const ScanResult&)> on_device,
                     std::function<void(std::vector<ScanResult>)> on_done);

/** 取消扫描(会触发 on_done) */
void scan_stop();

/** 连接句柄(内部代次校验, 断开后失效) */
using ConnToken = uint32_t;
constexpr ConnToken INVALID_CONN = 0;

struct GattCharInfo {
    PxUuid uuid;
    uint8_t properties = 0;  ///< bit0 read, bit1 write, bit2 write_no_rsp, bit3 notify, bit4 indicate
    uint16_t val_handle = 0;
    uint16_t cccd_handle = 0;  ///< 0 = 无
};

struct GattSvcInfo {
    PxUuid uuid;
    std::vector<GattCharInfo> chars;
};

/**
 * 连接设备(device_id 为扫描返回的地址串)。
 * on_result(token, err):err 非空表示失败(token=INVALID_CONN)。
 */
esp_err_t connect(const std::string& device_id, uint32_t timeout_ms,
                  std::function<void(ConnToken, const char* err)> on_result,
                  std::function<void()> on_disconnect);

/** 服务发现(带缓存;cb 的 svcs 指针仅回调期间有效) */
esp_err_t discover(ConnToken token,
                   std::function<void(const std::vector<GattSvcInfo>* svcs, const char* err)> cb);

esp_err_t gatt_read(ConnToken token, const PxUuid& svc, const PxUuid& chr,
                    std::function<void(std::vector<uint8_t>* data, const char* err)> cb);

esp_err_t gatt_write(ConnToken token, const PxUuid& svc, const PxUuid& chr,
                     std::vector<uint8_t> data, bool with_response,
                     std::function<void(const char* err)> cb);

/** 订阅 notify/indicate;on_notify 持续回调直到退订/断开 */
esp_err_t gatt_subscribe(ConnToken token, const PxUuid& svc, const PxUuid& chr, bool enable,
                         std::function<void(std::vector<uint8_t>)> on_notify,
                         std::function<void(const char* err)> done);

/** 主动断开(on_disconnect 仍会触发) */
void disconnect(ConnToken token);

}  // namespace ble
}  // namespace hal_periph
