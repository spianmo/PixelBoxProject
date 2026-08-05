/**
 * ble_hal.cpp — NimBLE 封装实现
 *
 * 结构:
 *   §1 协议栈启动          §2 UUID/地址转换
 *   §3 peripheral 动态 GATT §4 central 扫描
 *   §5 central 连接表       §6 服务发现状态机
 *   §7 GATT 客户端操作队列   §8 未启用时的桩
 */
#include "hal_periph/ble_hal.hpp"

#include "esp_log.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

static const char* TAG = "px.ble";

#if CONFIG_PX_ENABLE_BLE && CONFIG_BT_NIMBLE_ENABLED

#include <algorithm>
#include <atomic>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_adv.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#ifndef CONFIG_BT_NIMBLE_MAX_CONNECTIONS
#define CONFIG_BT_NIMBLE_MAX_CONNECTIONS 3
#endif

namespace hal_periph {
namespace ble {

// ================================================================
// §1 协议栈启动
// ================================================================

namespace {

std::atomic<bool> s_started{false};
SemaphoreHandle_t s_sync_sem = nullptr;
uint8_t s_own_addr_type = BLE_OWN_ADDR_PUBLIC;

void on_reset(int reason) { ESP_LOGW(TAG, "NimBLE host reset, reason=%d", reason); }

void on_sync() {
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (s_sync_sem) xSemaphoreGive(s_sync_sem);
}

void host_task_fn(void*) {
    nimble_port_run();  // 直到 nimble_port_stop
    nimble_port_freertos_deinit();
}

}  // namespace

bool available() { return board_caps()->ble; }

esp_err_t ensure_started() {
    if (!available()) return ESP_ERR_NOT_SUPPORTED;
    if (s_started.load()) return ESP_OK;

    s_sync_sem = xSemaphoreCreateBinary();
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %s", esp_err_to_name(err));
        return err;
    }
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("PixelBox");

    nimble_port_freertos_init(host_task_fn);
    if (xSemaphoreTake(s_sync_sem, pdMS_TO_TICKS(5000)) != pdTRUE) {
        ESP_LOGE(TAG, "等待 host sync 超时");
        return ESP_ERR_TIMEOUT;
    }
    s_started.store(true);
    return ESP_OK;
}

// ================================================================
// §2 UUID / 地址转换
// ================================================================

namespace {

void to_ble_uuid(const PxUuid& u, ble_uuid_any_t& out) {
    memset(&out, 0, sizeof(out));
    if (u.len == 2) {
        out.u16.u.type = BLE_UUID_TYPE_16;
        out.u16.value = u.u16;
    } else if (u.len == 4) {
        out.u32.u.type = BLE_UUID_TYPE_32;
        out.u32.value = u.u32;
    } else {
        out.u128.u.type = BLE_UUID_TYPE_128;
        memcpy(out.u128.value, u.b128, 16);
    }
}

PxUuid from_ble_uuid(const ble_uuid_t* u) {
    PxUuid out;
    switch (u->type) {
        case BLE_UUID_TYPE_16:
            out.len = 2;
            out.u16 = reinterpret_cast<const ble_uuid16_t*>(u)->value;
            break;
        case BLE_UUID_TYPE_32:
            out.len = 4;
            out.u32 = reinterpret_cast<const ble_uuid32_t*>(u)->value;
            break;
        case BLE_UUID_TYPE_128:
            out.len = 16;
            memcpy(out.b128, reinterpret_cast<const ble_uuid128_t*>(u)->value, 16);
            break;
        default:
            break;
    }
    return out;
}

std::string addr_to_string(const ble_addr_t& a) {
    char buf[18];
    snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
             a.val[5], a.val[4], a.val[3], a.val[2], a.val[1], a.val[0]);
    return buf;
}

bool string_to_addr(const std::string& s, ble_addr_t& out) {
    unsigned b[6];
    if (sscanf(s.c_str(), "%02x:%02x:%02x:%02x:%02x:%02x",
               &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6) {
        return false;
    }
    for (int i = 0; i < 6; i++) out.val[5 - i] = static_cast<uint8_t>(b[i]);
    return true;
}

std::vector<uint8_t> mbuf_to_vec(const os_mbuf* om) {
    uint16_t len = OS_MBUF_PKTLEN(om);
    std::vector<uint8_t> v(len);
    uint16_t out_len = 0;
    ble_hs_mbuf_to_flat(om, v.data(), len, &out_len);
    v.resize(out_len);
    return v;
}

// 扫描期间记录地址类型, connect 时查询
std::mutex s_addr_type_mtx;
std::map<std::string, uint8_t> s_addr_type_cache;

}  // namespace

// ================================================================
// §3 peripheral 动态 GATT
// ================================================================

namespace {

struct PeriphChar {
    CharDef def;
    ble_uuid_any_t uuid = {};
    uint16_t val_handle = 0;
};

struct PeriphSvc {
    PxUuid uuid_px;
    ble_uuid_any_t uuid = {};
    std::vector<PeriphChar> chars;
};

struct PeriphState {
    std::string name;
    PeripheralCallbacks cbs;
    std::vector<PeriphSvc> svcs;
    // NimBLE 注册用定义表(注册后 NimBLE 持有指针, 需与状态同生命周期)
    std::vector<ble_gatt_svc_def> svc_defs;
    std::vector<std::vector<ble_gatt_chr_def>> chr_defs;
    bool running = false;
};

PeriphState* s_periph = nullptr;      // 仅在 start/stop 时替换
std::mutex s_periph_mtx;              // 保护连接/订阅表
std::vector<uint16_t> s_periph_conns; // 已连接 central 的 conn handle
std::vector<std::pair<uint16_t, uint16_t>> s_periph_subs;  // (conn, attr) 订阅表

int periph_gap_event(struct ble_gap_event* event, void* arg);

void periph_advertise() {
    if (s_periph == nullptr || !s_periph->running) return;

    struct ble_hs_adv_fields fields = {};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = reinterpret_cast<const uint8_t*>(s_periph->name.c_str());
    uint8_t nlen = static_cast<uint8_t>(s_periph->name.size() > 29 ? 29 : s_periph->name.size());
    fields.name_len = nlen;
    fields.name_is_complete = s_periph->name.size() <= 29 ? 1 : 0;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) ESP_LOGW(TAG, "adv_set_fields rc=%d", rc);

    struct ble_gap_adv_params advp = {};
    advp.conn_mode = BLE_GAP_CONN_MODE_UND;
    advp.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_own_addr_type, nullptr, BLE_HS_FOREVER, &advp,
                           periph_gap_event, nullptr);
    if (rc != 0 && rc != BLE_HS_EALREADY) ESP_LOGW(TAG, "adv_start rc=%d", rc);
}

int chr_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                  struct ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn_handle;
    (void)attr_handle;
    auto* pc = static_cast<PeriphChar*>(arg);
    PeriphState* st = s_periph;
    if (pc == nullptr || st == nullptr) return BLE_ATT_ERR_UNLIKELY;

    switch (ctxt->op) {
        case BLE_GATT_ACCESS_OP_READ_CHR: {
            // onRead 同步读桥:阻塞等 JS 线程 ≤100ms, 失败退回缓存值
            if (pc->def.has_on_read && st->cbs.on_read_sync) {
                std::vector<uint8_t> fresh;
                if (st->cbs.on_read_sync(pc->def.user_tag, fresh)) {
                    pc->def.value = fresh;
                }
            }
            int rc = os_mbuf_append(ctxt->om, pc->def.value.data(), pc->def.value.size());
            return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        case BLE_GATT_ACCESS_OP_WRITE_CHR: {
            std::vector<uint8_t> data = mbuf_to_vec(ctxt->om);
            pc->def.value = data;
            if (st->cbs.on_write) st->cbs.on_write(pc->def.user_tag, std::move(data));
            return 0;
        }
        default:
            return BLE_ATT_ERR_UNLIKELY;
    }
}

int periph_gap_event(struct ble_gap_event* event, void* arg) {
    (void)arg;
    PeriphState* st = s_periph;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT: {
            if (event->connect.status == 0) {
                ble_gap_conn_desc desc = {};
                std::string id;
                if (ble_gap_conn_find(event->connect.conn_handle, &desc) == 0) {
                    id = addr_to_string(desc.peer_id_addr);
                }
                {
                    std::lock_guard<std::mutex> lk(s_periph_mtx);
                    s_periph_conns.push_back(event->connect.conn_handle);
                }
                if (st && st->cbs.on_connect) st->cbs.on_connect(id);
            }
            periph_advertise();  // 继续广播接受更多连接 / 连接失败重新广播
            return 0;
        }
        case BLE_GAP_EVENT_DISCONNECT: {
            uint16_t h = event->disconnect.conn.conn_handle;
            std::string id = addr_to_string(event->disconnect.conn.peer_id_addr);
            {
                std::lock_guard<std::mutex> lk(s_periph_mtx);
                for (auto it = s_periph_conns.begin(); it != s_periph_conns.end();) {
                    it = (*it == h) ? s_periph_conns.erase(it) : it + 1;
                }
                for (auto it = s_periph_subs.begin(); it != s_periph_subs.end();) {
                    it = (it->first == h) ? s_periph_subs.erase(it) : it + 1;
                }
            }
            if (st && st->cbs.on_disconnect) st->cbs.on_disconnect(id);
            periph_advertise();
            return 0;
        }
        case BLE_GAP_EVENT_SUBSCRIBE: {
            std::lock_guard<std::mutex> lk(s_periph_mtx);
            auto key = std::make_pair(event->subscribe.conn_handle, event->subscribe.attr_handle);
            bool want = event->subscribe.cur_notify || event->subscribe.cur_indicate;
            auto it = std::find(s_periph_subs.begin(), s_periph_subs.end(), key);
            if (want && it == s_periph_subs.end()) {
                s_periph_subs.push_back(key);
            } else if (!want && it != s_periph_subs.end()) {
                s_periph_subs.erase(it);
            }
            return 0;
        }
        default:
            return 0;
    }
}

}  // namespace

esp_err_t peripheral_start(const std::string& name, std::vector<SvcDef> svcs,
                           PeripheralCallbacks cbs) {
    esp_err_t err = ensure_started();
    if (err != ESP_OK) return err;

    peripheral_stop();

    auto* st = new PeriphState();
    st->name = name.empty() ? "PixelBox" : name;
    st->cbs = std::move(cbs);

    // 构建持久的 NimBLE 服务定义表
    st->svcs.reserve(svcs.size());
    for (auto& sd : svcs) {
        PeriphSvc ps;
        ps.uuid_px = sd.uuid;
        to_ble_uuid(sd.uuid, ps.uuid);
        ps.chars.reserve(sd.chars.size());
        for (auto& cd : sd.chars) {
            PeriphChar pc;
            pc.def = std::move(cd);
            to_ble_uuid(pc.def.uuid, pc.uuid);
            ps.chars.push_back(std::move(pc));
        }
        st->svcs.push_back(std::move(ps));
    }

    st->chr_defs.resize(st->svcs.size());
    st->svc_defs.reserve(st->svcs.size() + 1);
    for (size_t si = 0; si < st->svcs.size(); si++) {
        auto& ps = st->svcs[si];
        auto& cvec = st->chr_defs[si];
        cvec.reserve(ps.chars.size() + 1);
        for (auto& pc : ps.chars) {
            ble_gatt_chr_def cd = {};
            cd.uuid = &pc.uuid.u;
            cd.access_cb = chr_access_cb;
            cd.arg = &pc;
            cd.val_handle = &pc.val_handle;
            ble_gatt_chr_flags flags = 0;
            if (pc.def.readable) flags |= BLE_GATT_CHR_F_READ;
            if (pc.def.writable) flags |= BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP;
            if (pc.def.notifiable) flags |= BLE_GATT_CHR_F_NOTIFY;
            cd.flags = flags;
            cvec.push_back(cd);
        }
        cvec.push_back(ble_gatt_chr_def{});  // 终结符

        ble_gatt_svc_def sd = {};
        sd.type = BLE_GATT_SVC_TYPE_PRIMARY;
        sd.uuid = &ps.uuid.u;
        sd.characteristics = cvec.data();
        st->svc_defs.push_back(sd);
    }
    st->svc_defs.push_back(ble_gatt_svc_def{});  // 终结符

    // 重建 GATT 表:reset 会清掉 gap/gatt 内置服务, 需重新 init
    ble_gatts_reset();
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set(st->name.c_str());

    int rc = ble_gatts_count_cfg(st->svc_defs.data());
    if (rc == 0) rc = ble_gatts_add_svcs(st->svc_defs.data());
    if (rc == 0) rc = ble_gatts_start();
    if (rc != 0) {
        ESP_LOGE(TAG, "GATT 建表失败 rc=%d", rc);
        delete st;
        return ESP_FAIL;
    }

    st->running = true;
    PeriphState* old = s_periph;
    s_periph = st;
    delete old;

    periph_advertise();
    ESP_LOGI(TAG, "peripheral \"%s\" 开始广播, %d 个服务", st->name.c_str(), (int)st->svcs.size());
    return ESP_OK;
}

void peripheral_stop() {
    if (s_periph == nullptr) return;
    s_periph->running = false;
    ble_gap_adv_stop();
    std::vector<uint16_t> conns;
    {
        std::lock_guard<std::mutex> lk(s_periph_mtx);
        conns = s_periph_conns;
    }
    for (uint16_t h : conns) ble_gap_terminate(h, BLE_ERR_REM_USER_CONN_TERM);
}

bool peripheral_running() { return s_periph != nullptr && s_periph->running; }

esp_err_t peripheral_notify(const PxUuid& svc, const PxUuid& chr,
                            const uint8_t* data, size_t len) {
    PeriphState* st = s_periph;
    if (st == nullptr || !st->running) return ESP_ERR_INVALID_STATE;

    uint16_t val_handle = 0;
    for (auto& ps : st->svcs) {
        if (!(ps.uuid_px == svc)) continue;
        for (auto& pc : ps.chars) {
            if (pc.def.uuid == chr) {
                val_handle = pc.val_handle;
                pc.def.value.assign(data, data + len);
                break;
            }
        }
    }
    if (val_handle == 0) return ESP_ERR_NOT_FOUND;

    std::vector<uint16_t> targets;
    {
        std::lock_guard<std::mutex> lk(s_periph_mtx);
        for (auto& sub : s_periph_subs) {
            if (sub.second == val_handle) targets.push_back(sub.first);
        }
    }
    for (uint16_t h : targets) {
        os_mbuf* om = ble_hs_mbuf_from_flat(data, len);
        if (om == nullptr) return ESP_ERR_NO_MEM;
        ble_gatts_notify_custom(h, val_handle, om);
    }
    return ESP_OK;
}

esp_err_t peripheral_set_value(uint32_t user_tag, std::vector<uint8_t> value) {
    PeriphState* st = s_periph;
    if (st == nullptr) return ESP_ERR_INVALID_STATE;
    for (auto& ps : st->svcs) {
        for (auto& pc : ps.chars) {
            if (pc.def.user_tag == user_tag) {
                pc.def.value = std::move(value);
                return ESP_OK;
            }
        }
    }
    return ESP_ERR_NOT_FOUND;
}

// ================================================================
// §4 central 扫描
// ================================================================

namespace {

struct ScanState {
    bool active = false;
    std::map<std::string, ScanResult> results;
    std::function<void(const ScanResult&)> on_device;
    std::function<void(std::vector<ScanResult>)> on_done;
};

ScanState s_scan;
std::mutex s_scan_mtx;

void scan_finish() {
    std::function<void(std::vector<ScanResult>)> done;
    std::vector<ScanResult> all;
    {
        std::lock_guard<std::mutex> lk(s_scan_mtx);
        if (!s_scan.active) return;
        s_scan.active = false;
        done = std::move(s_scan.on_done);
        for (auto& kv : s_scan.results) all.push_back(kv.second);
        s_scan.results.clear();
        s_scan.on_device = nullptr;
        s_scan.on_done = nullptr;
    }
    if (done) done(std::move(all));
}

int scan_gap_event(struct ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_DISC: {
            struct ble_hs_adv_fields fields = {};
            ble_hs_adv_parse_fields(&fields, event->disc.data, event->disc.length_data);

            std::string id = addr_to_string(event->disc.addr);
            {
                std::lock_guard<std::mutex> lk(s_addr_type_mtx);
                s_addr_type_cache[id] = event->disc.addr.type;
            }

            ScanResult snapshot;
            bool is_new = false;
            std::function<void(const ScanResult&)> on_device;
            {
                std::lock_guard<std::mutex> lk(s_scan_mtx);
                if (!s_scan.active) return 0;
                auto it = s_scan.results.find(id);
                if (it == s_scan.results.end()) {
                    ScanResult r;
                    r.id = id;
                    r.rssi = event->disc.rssi;
                    if (fields.name != nullptr && fields.name_len > 0) {
                        r.name.assign(reinterpret_cast<const char*>(fields.name), fields.name_len);
                        r.has_name = true;
                    }
                    if (fields.mfg_data != nullptr && fields.mfg_data_len > 0) {
                        r.mfg.assign(fields.mfg_data, fields.mfg_data + fields.mfg_data_len);
                        r.has_mfg = true;
                    }
                    s_scan.results[id] = r;
                    snapshot = r;
                    is_new = true;
                    on_device = s_scan.on_device;
                } else {
                    // 已知设备:补充 scan response 里迟到的名字/厂商数据
                    it->second.rssi = event->disc.rssi;
                    if (!it->second.has_name && fields.name != nullptr && fields.name_len > 0) {
                        it->second.name.assign(reinterpret_cast<const char*>(fields.name),
                                               fields.name_len);
                        it->second.has_name = true;
                    }
                    if (!it->second.has_mfg && fields.mfg_data != nullptr && fields.mfg_data_len > 0) {
                        it->second.mfg.assign(fields.mfg_data,
                                              fields.mfg_data + fields.mfg_data_len);
                        it->second.has_mfg = true;
                    }
                }
            }
            if (is_new && on_device) on_device(snapshot);
            return 0;
        }
        case BLE_GAP_EVENT_DISC_COMPLETE:
            scan_finish();
            return 0;
        default:
            return 0;
    }
}

}  // namespace

esp_err_t scan_start(uint32_t timeout_ms,
                     std::function<void(const ScanResult&)> on_device,
                     std::function<void(std::vector<ScanResult>)> on_done) {
    esp_err_t err = ensure_started();
    if (err != ESP_OK) return err;

    // 已在扫描 → 先取消(旧 promise 会收到已收集的结果)
    if (ble_gap_disc_active()) {
        ble_gap_disc_cancel();
        scan_finish();
    }

    {
        std::lock_guard<std::mutex> lk(s_scan_mtx);
        s_scan.active = true;
        s_scan.results.clear();
        s_scan.on_device = std::move(on_device);
        s_scan.on_done = std::move(on_done);
    }

    struct ble_gap_disc_params params = {};
    params.passive = 0;             // 主动扫描以拿 scan response 中的名字
    params.filter_duplicates = 0;   // 自行去重, 以便合并迟到的 scan rsp

    int32_t duration = timeout_ms == 0 ? BLE_HS_FOREVER : static_cast<int32_t>(timeout_ms);
    int rc = ble_gap_disc(s_own_addr_type, duration, &params, scan_gap_event, nullptr);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gap_disc rc=%d", rc);
        std::lock_guard<std::mutex> lk(s_scan_mtx);
        s_scan.active = false;
        s_scan.on_device = nullptr;
        s_scan.on_done = nullptr;
        return ESP_FAIL;
    }
    return ESP_OK;
}

void scan_stop() {
    if (ble_gap_disc_active()) ble_gap_disc_cancel();
    scan_finish();
}

// ================================================================
// §5 central 连接表
// ================================================================

namespace {

struct ConnState {
    bool used = false;
    bool connected = false;
    uint16_t conn_handle = BLE_HS_CONN_HANDLE_NONE;
    uint32_t gen = 1;

    std::function<void(ConnToken, const char*)> on_result;  // 连接建立结果(一次性)
    std::function<void()> on_disconnect;

    // 服务发现缓存
    bool disc_done = false;
    std::vector<GattSvcInfo> svcs;
    std::vector<std::pair<uint16_t, uint16_t>> svc_ranges;      // 与 svcs 对齐
    std::vector<std::vector<uint16_t>> chr_def_handles;         // 与 svcs/chars 对齐
    std::vector<std::function<void(const std::vector<GattSvcInfo>*, const char*)>> disc_waiters;
    size_t disc_svc_idx = 0;   // 特征发现进度
    size_t dsc_svc_idx = 0;    // 描述符发现进度
    size_t dsc_chr_idx = 0;

    // notify 分发
    std::map<uint16_t, std::function<void(std::vector<uint8_t>)>> subs;

    // 串行操作队列(NimBLE 同连接同时只允许一个 GATT 过程)
    std::deque<std::function<void()>> ops;
    bool op_busy = false;
};

ConnState s_conns[CONFIG_BT_NIMBLE_MAX_CONNECTIONS];
std::mutex s_conn_mtx;  // 保护 used/gen/ops/subs 等结构性字段

constexpr uint32_t token_of(int idx, uint32_t gen) {
    return (static_cast<uint32_t>(idx + 1) & 0xFF) | (gen << 8);
}

/** token → 槽位;无效返回 -1 */
int slot_of(ConnToken t) {
    int idx = static_cast<int>(t & 0xFF) - 1;
    if (idx < 0 || idx >= CONFIG_BT_NIMBLE_MAX_CONNECTIONS) return -1;
    if (!s_conns[idx].used || s_conns[idx].gen != (t >> 8)) return -1;
    return idx;
}

void op_done(int idx) {
    std::function<void()> next;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        ConnState& cs = s_conns[idx];
        cs.op_busy = false;
        if (!cs.ops.empty()) {
            cs.op_busy = true;
            next = std::move(cs.ops.front());
            cs.ops.pop_front();
        }
    }
    if (next) next();
}

void op_push(int idx, std::function<void()> op) {
    bool run_now = false;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        ConnState& cs = s_conns[idx];
        if (cs.op_busy) {
            cs.ops.push_back(std::move(op));
        } else {
            cs.op_busy = true;
            run_now = true;
        }
    }
    if (run_now) op();
}

void conn_cleanup(int idx, bool was_pending, const char* err) {
    std::function<void(ConnToken, const char*)> on_result;
    std::function<void()> on_disc;
    std::vector<std::function<void(const std::vector<GattSvcInfo>*, const char*)>> waiters;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        ConnState& cs = s_conns[idx];
        on_result = std::move(cs.on_result);
        on_disc = std::move(cs.on_disconnect);
        waiters = std::move(cs.disc_waiters);
        cs.used = false;
        cs.connected = false;
        cs.conn_handle = BLE_HS_CONN_HANDLE_NONE;
        cs.gen++;
        cs.disc_done = false;
        cs.svcs.clear();
        cs.svc_ranges.clear();
        cs.chr_def_handles.clear();
        cs.subs.clear();
        cs.ops.clear();
        cs.op_busy = false;
    }
    for (auto& w : waiters) w(nullptr, err ? err : "连接已断开");
    if (was_pending) {
        if (on_result) on_result(INVALID_CONN, err ? err : "连接失败");
    } else {
        if (on_disc) on_disc();
    }
}

int central_gap_event(struct ble_gap_event* event, void* arg) {
    int idx = static_cast<int>(reinterpret_cast<uintptr_t>(arg)) - 1;
    if (idx < 0 || idx >= CONFIG_BT_NIMBLE_MAX_CONNECTIONS) return 0;
    ConnState& cs = s_conns[idx];

    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT: {
            if (event->connect.status == 0) {
                std::function<void(ConnToken, const char*)> cb;
                ConnToken tok;
                {
                    std::lock_guard<std::mutex> lk(s_conn_mtx);
                    cs.connected = true;
                    cs.conn_handle = event->connect.conn_handle;
                    tok = token_of(idx, cs.gen);
                    cb = std::move(cs.on_result);
                }
                if (cb) cb(tok, nullptr);
            } else {
                conn_cleanup(idx, true, "连接失败");
            }
            return 0;
        }
        case BLE_GAP_EVENT_DISCONNECT: {
            bool was_pending;
            {
                std::lock_guard<std::mutex> lk(s_conn_mtx);
                was_pending = !cs.connected;
            }
            conn_cleanup(idx, was_pending, nullptr);
            return 0;
        }
        case BLE_GAP_EVENT_NOTIFY_RX: {
            std::function<void(std::vector<uint8_t>)> cb;
            {
                std::lock_guard<std::mutex> lk(s_conn_mtx);
                auto it = cs.subs.find(event->notify_rx.attr_handle);
                if (it != cs.subs.end()) cb = it->second;
            }
            if (cb) cb(mbuf_to_vec(event->notify_rx.om));
            return 0;
        }
        default:
            return 0;
    }
}

}  // namespace

esp_err_t connect(const std::string& device_id, uint32_t timeout_ms,
                  std::function<void(ConnToken, const char*)> on_result,
                  std::function<void()> on_disconnect) {
    esp_err_t err = ensure_started();
    if (err != ESP_OK) return err;

    // NimBLE 要求发起连接前停止扫描
    if (ble_gap_disc_active()) {
        ble_gap_disc_cancel();
        scan_finish();
    }

    ble_addr_t addr = {};
    if (!string_to_addr(device_id, addr)) return ESP_ERR_INVALID_ARG;
    {
        std::lock_guard<std::mutex> lk(s_addr_type_mtx);
        auto it = s_addr_type_cache.find(device_id);
        addr.type = it != s_addr_type_cache.end() ? it->second : BLE_ADDR_PUBLIC;
    }

    int idx = -1;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        for (int i = 0; i < CONFIG_BT_NIMBLE_MAX_CONNECTIONS; i++) {
            if (!s_conns[i].used) {
                idx = i;
                s_conns[i].used = true;
                s_conns[i].connected = false;
                s_conns[i].on_result = std::move(on_result);
                s_conns[i].on_disconnect = std::move(on_disconnect);
                break;
            }
        }
    }
    if (idx < 0) return ESP_ERR_NO_MEM;

    int rc = ble_gap_connect(s_own_addr_type, &addr,
                             timeout_ms == 0 ? 10000 : static_cast<int32_t>(timeout_ms),
                             nullptr, central_gap_event,
                             reinterpret_cast<void*>(static_cast<uintptr_t>(idx + 1)));
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gap_connect rc=%d", rc);
        conn_cleanup(idx, true, "发起连接失败");
        return ESP_FAIL;
    }
    return ESP_OK;
}

// ================================================================
// §6 服务发现状态机(全部在 host 任务回调中推进)
// ================================================================

namespace {

void disc_fail(int idx, const char* err) {
    std::vector<std::function<void(const std::vector<GattSvcInfo>*, const char*)>> waiters;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        waiters = std::move(s_conns[idx].disc_waiters);
        s_conns[idx].disc_waiters.clear();
    }
    for (auto& w : waiters) w(nullptr, err);
    op_done(idx);
}

void disc_finish(int idx) {
    std::vector<std::function<void(const std::vector<GattSvcInfo>*, const char*)>> waiters;
    const std::vector<GattSvcInfo>* svcs;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        s_conns[idx].disc_done = true;
        waiters = std::move(s_conns[idx].disc_waiters);
        s_conns[idx].disc_waiters.clear();
        svcs = &s_conns[idx].svcs;
    }
    for (auto& w : waiters) w(svcs, nullptr);
    op_done(idx);
}

void disc_next_cccd(int idx);

int disc_dsc_cb(uint16_t conn_handle, const struct ble_gatt_error* error,
                uint16_t chr_val_handle, const struct ble_gatt_dsc* dsc, void* arg) {
    (void)conn_handle;
    (void)chr_val_handle;
    int idx = static_cast<int>(reinterpret_cast<uintptr_t>(arg)) - 1;
    ConnState& cs = s_conns[idx];
    if (error->status == 0 && dsc != nullptr) {
        if (dsc->uuid.u.type == BLE_UUID_TYPE_16 && dsc->uuid.u16.value == 0x2902) {
            auto& chr = cs.svcs[cs.dsc_svc_idx].chars[cs.dsc_chr_idx];
            chr.cccd_handle = dsc->handle;
        }
        return 0;
    }
    if (error->status == BLE_HS_EDONE) {
        cs.dsc_chr_idx++;
        disc_next_cccd(idx);
        return 0;
    }
    disc_fail(idx, "描述符发现失败");
    return 0;
}

/** 找到下一个需要 CCCD 的特征并发现其描述符;全部完成则收尾 */
void disc_next_cccd(int idx) {
    ConnState& cs = s_conns[idx];
    while (cs.dsc_svc_idx < cs.svcs.size()) {
        auto& svc = cs.svcs[cs.dsc_svc_idx];
        while (cs.dsc_chr_idx < svc.chars.size()) {
            auto& chr = svc.chars[cs.dsc_chr_idx];
            bool wants = (chr.properties & 0x18) != 0;  // notify | indicate
            if (wants) {
                // 描述符范围:val_handle+1 .. (下一特征 def_handle-1 或服务 end)
                uint16_t end = cs.svc_ranges[cs.dsc_svc_idx].second;
                auto& defs = cs.chr_def_handles[cs.dsc_svc_idx];
                if (cs.dsc_chr_idx + 1 < defs.size()) {
                    end = static_cast<uint16_t>(defs[cs.dsc_chr_idx + 1] - 1);
                }
                if (chr.val_handle < end) {
                    int rc = ble_gattc_disc_all_dscs(
                        cs.conn_handle, chr.val_handle, end, disc_dsc_cb,
                        reinterpret_cast<void*>(static_cast<uintptr_t>(idx + 1)));
                    if (rc == 0) return;  // 等回调推进
                }
            }
            cs.dsc_chr_idx++;
        }
        cs.dsc_svc_idx++;
        cs.dsc_chr_idx = 0;
    }
    disc_finish(idx);
}

void disc_next_svc_chars(int idx);

int disc_chr_cb(uint16_t conn_handle, const struct ble_gatt_error* error,
                const struct ble_gatt_chr* chr, void* arg) {
    (void)conn_handle;
    int idx = static_cast<int>(reinterpret_cast<uintptr_t>(arg)) - 1;
    ConnState& cs = s_conns[idx];
    if (error->status == 0 && chr != nullptr) {
        GattCharInfo ci;
        ci.uuid = from_ble_uuid(&chr->uuid.u);
        uint8_t p = 0;
        if (chr->properties & BLE_GATT_CHR_PROP_READ) p |= 0x01;
        if (chr->properties & BLE_GATT_CHR_PROP_WRITE) p |= 0x02;
        if (chr->properties & BLE_GATT_CHR_PROP_WRITE_NO_RSP) p |= 0x04;
        if (chr->properties & BLE_GATT_CHR_PROP_NOTIFY) p |= 0x08;
        if (chr->properties & BLE_GATT_CHR_PROP_INDICATE) p |= 0x10;
        ci.properties = p;
        ci.val_handle = chr->val_handle;
        cs.svcs[cs.disc_svc_idx].chars.push_back(ci);
        cs.chr_def_handles[cs.disc_svc_idx].push_back(chr->def_handle);
        return 0;
    }
    if (error->status == BLE_HS_EDONE) {
        cs.disc_svc_idx++;
        disc_next_svc_chars(idx);
        return 0;
    }
    disc_fail(idx, "特征发现失败");
    return 0;
}

void disc_next_svc_chars(int idx) {
    ConnState& cs = s_conns[idx];
    if (cs.disc_svc_idx >= cs.svcs.size()) {
        cs.dsc_svc_idx = 0;
        cs.dsc_chr_idx = 0;
        disc_next_cccd(idx);
        return;
    }
    auto range = cs.svc_ranges[cs.disc_svc_idx];
    int rc = ble_gattc_disc_all_chrs(cs.conn_handle, range.first, range.second, disc_chr_cb,
                                     reinterpret_cast<void*>(static_cast<uintptr_t>(idx + 1)));
    if (rc != 0) disc_fail(idx, "特征发现启动失败");
}

int disc_svc_cb(uint16_t conn_handle, const struct ble_gatt_error* error,
                const struct ble_gatt_svc* service, void* arg) {
    (void)conn_handle;
    int idx = static_cast<int>(reinterpret_cast<uintptr_t>(arg)) - 1;
    ConnState& cs = s_conns[idx];
    if (error->status == 0 && service != nullptr) {
        GattSvcInfo si;
        si.uuid = from_ble_uuid(&service->uuid.u);
        cs.svcs.push_back(std::move(si));
        cs.svc_ranges.emplace_back(service->start_handle, service->end_handle);
        cs.chr_def_handles.emplace_back();
        return 0;
    }
    if (error->status == BLE_HS_EDONE) {
        cs.disc_svc_idx = 0;
        disc_next_svc_chars(idx);
        return 0;
    }
    disc_fail(idx, "服务发现失败");
    return 0;
}

/** 作为串行队列中的操作启动发现 */
void disc_op_start(int idx) {
    ConnState& cs = s_conns[idx];
    bool cached = false;
    std::vector<std::function<void(const std::vector<GattSvcInfo>*, const char*)>> waiters;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        if (cs.disc_done) {
            // 另一个排队者已完成发现 → 锁外回调, 避免 op_done 重入死锁
            cached = true;
            waiters = std::move(cs.disc_waiters);
            cs.disc_waiters.clear();
        } else {
            cs.svcs.clear();
            cs.svc_ranges.clear();
            cs.chr_def_handles.clear();
            cs.disc_svc_idx = 0;
        }
    }
    if (cached) {
        for (auto& w : waiters) w(&cs.svcs, nullptr);
        op_done(idx);
        return;
    }
    int rc = ble_gattc_disc_all_svcs(cs.conn_handle, disc_svc_cb,
                                     reinterpret_cast<void*>(static_cast<uintptr_t>(idx + 1)));
    if (rc != 0) disc_fail(idx, "服务发现启动失败");
}

/** 在缓存中定位特征;返回 nullptr = 未找到 */
const GattCharInfo* find_char(ConnState& cs, const PxUuid& svc, const PxUuid& chr) {
    for (auto& s : cs.svcs) {
        if (!(s.uuid == svc)) continue;
        for (auto& c : s.chars) {
            if (c.uuid == chr) return &c;
        }
    }
    return nullptr;
}

}  // namespace

esp_err_t discover(ConnToken token,
                   std::function<void(const std::vector<GattSvcInfo>*, const char*)> cb) {
    int idx;
    bool cached;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        idx = slot_of(token);
        if (idx < 0) return ESP_ERR_INVALID_STATE;
        cached = s_conns[idx].disc_done;
        if (!cached) s_conns[idx].disc_waiters.push_back(std::move(cb));
    }
    if (cached) {
        cb(&s_conns[idx].svcs, nullptr);
        return ESP_OK;
    }
    op_push(idx, [idx]() { disc_op_start(idx); });
    return ESP_OK;
}

// ================================================================
// §7 GATT 客户端操作(read / write / subscribe)
// ================================================================

namespace {

struct ReadCtx {
    int idx;
    std::function<void(std::vector<uint8_t>*, const char*)> cb;
};

int gatt_read_cb(uint16_t conn_handle, const struct ble_gatt_error* error,
                 struct ble_gatt_attr* attr, void* arg) {
    (void)conn_handle;
    auto* ctx = static_cast<ReadCtx*>(arg);
    if (error->status == 0 && attr != nullptr) {
        std::vector<uint8_t> data = mbuf_to_vec(attr->om);
        ctx->cb(&data, nullptr);
    } else {
        ctx->cb(nullptr, "读取失败");
    }
    int idx = ctx->idx;
    delete ctx;
    op_done(idx);
    return 0;
}

struct WriteCtx {
    int idx;
    std::function<void(const char*)> cb;
};

int gatt_write_cb(uint16_t conn_handle, const struct ble_gatt_error* error,
                  struct ble_gatt_attr* attr, void* arg) {
    (void)conn_handle;
    (void)attr;
    auto* ctx = static_cast<WriteCtx*>(arg);
    ctx->cb(error->status == 0 ? nullptr : "写入失败");
    int idx = ctx->idx;
    delete ctx;
    op_done(idx);
    return 0;
}

/** 需要先完成发现的操作的公共封装 */
void with_char(int idx, const PxUuid& svc, const PxUuid& chr,
               std::function<void(const GattCharInfo*, const char*)> fn) {
    ConnState& cs = s_conns[idx];
    if (cs.disc_done) {
        fn(find_char(cs, svc, chr), nullptr);
        return;
    }
    // 排一个发现 waiter, 完成后再找特征
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        cs.disc_waiters.push_back(
            [idx, svc, chr, fn](const std::vector<GattSvcInfo>* svcs, const char* err) {
                if (err != nullptr || svcs == nullptr) {
                    fn(nullptr, err ? err : "发现失败");
                    return;
                }
                fn(find_char(s_conns[idx], svc, chr), nullptr);
            });
    }
    op_push(idx, [idx]() { disc_op_start(idx); });
}

}  // namespace

esp_err_t gatt_read(ConnToken token, const PxUuid& svc, const PxUuid& chr,
                    std::function<void(std::vector<uint8_t>*, const char*)> cb) {
    int idx;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        idx = slot_of(token);
    }
    if (idx < 0) return ESP_ERR_INVALID_STATE;

    with_char(idx, svc, chr, [idx, cb](const GattCharInfo* ci, const char* err) {
        if (err != nullptr || ci == nullptr) {
            cb(nullptr, err ? err : "特征不存在");
            return;
        }
        uint16_t handle = ci->val_handle;
        op_push(idx, [idx, handle, cb]() {
            auto* ctx = new ReadCtx{idx, cb};
            int rc = ble_gattc_read(s_conns[idx].conn_handle, handle, gatt_read_cb, ctx);
            if (rc != 0) {
                cb(nullptr, "读取启动失败");
                delete ctx;
                op_done(idx);
            }
        });
    });
    return ESP_OK;
}

esp_err_t gatt_write(ConnToken token, const PxUuid& svc, const PxUuid& chr,
                     std::vector<uint8_t> data, bool with_response,
                     std::function<void(const char*)> cb) {
    int idx;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        idx = slot_of(token);
    }
    if (idx < 0) return ESP_ERR_INVALID_STATE;

    auto shared_data = std::make_shared<std::vector<uint8_t>>(std::move(data));
    with_char(idx, svc, chr,
              [idx, cb, shared_data, with_response](const GattCharInfo* ci, const char* err) {
        if (err != nullptr || ci == nullptr) {
            cb(err ? err : "特征不存在");
            return;
        }
        uint16_t handle = ci->val_handle;
        op_push(idx, [idx, handle, cb, shared_data, with_response]() {
            int rc;
            if (with_response) {
                auto* ctx = new WriteCtx{idx, cb};
                rc = ble_gattc_write_flat(s_conns[idx].conn_handle, handle,
                                          shared_data->data(), shared_data->size(),
                                          gatt_write_cb, ctx);
                if (rc != 0) {
                    cb("写入启动失败");
                    delete ctx;
                    op_done(idx);
                }
            } else {
                rc = ble_gattc_write_no_rsp_flat(s_conns[idx].conn_handle, handle,
                                                 shared_data->data(), shared_data->size());
                cb(rc == 0 ? nullptr : "写入失败");
                op_done(idx);
            }
        });
    });
    return ESP_OK;
}

esp_err_t gatt_subscribe(ConnToken token, const PxUuid& svc, const PxUuid& chr, bool enable,
                         std::function<void(std::vector<uint8_t>)> on_notify,
                         std::function<void(const char*)> done) {
    int idx;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        idx = slot_of(token);
    }
    if (idx < 0) return ESP_ERR_INVALID_STATE;

    with_char(idx, svc, chr,
              [idx, enable, on_notify, done](const GattCharInfo* ci, const char* err) {
        if (err != nullptr || ci == nullptr) {
            done(err ? err : "特征不存在");
            return;
        }
        if (ci->cccd_handle == 0) {
            done("特征不支持订阅 (无 CCCD)");
            return;
        }
        uint16_t cccd = ci->cccd_handle;
        uint16_t val_handle = ci->val_handle;
        // CCCD 值:bit0 notify, bit1 indicate
        uint8_t v[2] = {0, 0};
        if (enable) v[0] = (ci->properties & 0x08) ? 0x01 : 0x02;

        {
            std::lock_guard<std::mutex> lk(s_conn_mtx);
            if (enable && on_notify) {
                s_conns[idx].subs[val_handle] = on_notify;
            } else if (!enable) {
                s_conns[idx].subs.erase(val_handle);
            }
        }

        auto v0 = v[0];
        op_push(idx, [idx, cccd, v0, done, val_handle, enable]() {
            uint8_t val[2] = {v0, 0};
            auto* ctx = new WriteCtx{idx, [done, idx, val_handle, enable](const char* err) {
                if (err != nullptr && enable) {
                    // 写 CCCD 失败 → 回滚订阅表
                    std::lock_guard<std::mutex> lk(s_conn_mtx);
                    s_conns[idx].subs.erase(val_handle);
                }
                done(err);
            }};
            int rc = ble_gattc_write_flat(s_conns[idx].conn_handle, cccd, val, sizeof(val),
                                          gatt_write_cb, ctx);
            if (rc != 0) {
                ctx->cb("订阅写 CCCD 失败");
                delete ctx;
                op_done(idx);
            }
        });
    });
    return ESP_OK;
}

void disconnect(ConnToken token) {
    int idx;
    uint16_t handle = BLE_HS_CONN_HANDLE_NONE;
    {
        std::lock_guard<std::mutex> lk(s_conn_mtx);
        idx = slot_of(token);
        if (idx >= 0) handle = s_conns[idx].conn_handle;
    }
    if (idx < 0 || handle == BLE_HS_CONN_HANDLE_NONE) return;
    ble_gap_terminate(handle, BLE_ERR_REM_USER_CONN_TERM);
}

}  // namespace ble
}  // namespace hal_periph

#else  // 未启用 BLE —— 桩实现

namespace hal_periph {
namespace ble {

bool available() { return false; }
esp_err_t ensure_started() { return ESP_ERR_NOT_SUPPORTED; }

esp_err_t peripheral_start(const std::string&, std::vector<SvcDef>, PeripheralCallbacks) {
    ESP_LOGW(TAG, "BLE 未启用 (PX_ENABLE_BLE=n 或 NimBLE 未编入)");
    return ESP_ERR_NOT_SUPPORTED;
}
void peripheral_stop() {}
bool peripheral_running() { return false; }
esp_err_t peripheral_notify(const PxUuid&, const PxUuid&, const uint8_t*, size_t) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t peripheral_set_value(uint32_t, std::vector<uint8_t>) { return ESP_ERR_NOT_SUPPORTED; }

esp_err_t scan_start(uint32_t, std::function<void(const ScanResult&)>,
                     std::function<void(std::vector<ScanResult>)>) {
    return ESP_ERR_NOT_SUPPORTED;
}
void scan_stop() {}

esp_err_t connect(const std::string&, uint32_t, std::function<void(ConnToken, const char*)>,
                  std::function<void()>) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t discover(ConnToken, std::function<void(const std::vector<GattSvcInfo>*, const char*)>) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t gatt_read(ConnToken, const PxUuid&, const PxUuid&,
                    std::function<void(std::vector<uint8_t>*, const char*)>) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t gatt_write(ConnToken, const PxUuid&, const PxUuid&, std::vector<uint8_t>, bool,
                     std::function<void(const char*)>) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t gatt_subscribe(ConnToken, const PxUuid&, const PxUuid&, bool,
                         std::function<void(std::vector<uint8_t>)>,
                         std::function<void(const char*)>) {
    return ESP_ERR_NOT_SUPPORTED;
}
void disconnect(ConnToken) {}

}  // namespace ble
}  // namespace hal_periph

#endif  // CONFIG_PX_ENABLE_BLE && CONFIG_BT_NIMBLE_ENABLED
