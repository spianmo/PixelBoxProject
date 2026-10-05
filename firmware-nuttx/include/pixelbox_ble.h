#ifndef PIXELBOX_NUTTX_BLE_H
#define PIXELBOX_NUTTX_BLE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PX_BLE_SERVICES 8
#define PX_BLE_CHARACTERISTICS 32
#define PX_BLE_CONNECTIONS 3
#define PX_BLE_VALUE_BYTES 512
#define PX_BLE_SCAN_DEVICES 64
#define PX_BLE_EVENT_COUNT 32
#define PX_BLE_UUID_BYTES 37
enum { PX_BLE_READ=1, PX_BLE_WRITE=2, PX_BLE_WRITE_NR=4,
       PX_BLE_NOTIFY=8, PX_BLE_INDICATE=16 };
struct px_ble_characteristic {
  char uuid[PX_BLE_UUID_BYTES];
  unsigned service,properties,tag;
  bool on_read;
  size_t length;
  uint8_t value[PX_BLE_VALUE_BYTES];
};
struct px_ble_definition {
  char name[64];
  unsigned service_count,characteristic_count;
  char services[PX_BLE_SERVICES][PX_BLE_UUID_BYTES];
  struct px_ble_characteristic characteristics[PX_BLE_CHARACTERISTICS];
};
struct px_ble_service_info {
  char uuid[PX_BLE_UUID_BYTES];
  unsigned first,count;
};
struct px_ble_characteristic_info {
  char uuid[PX_BLE_UUID_BYTES];
  unsigned properties;
};
struct px_ble_services {
  unsigned service_count,characteristic_count;
  struct px_ble_service_info services[PX_BLE_SERVICES];
  struct px_ble_characteristic_info characteristics[PX_BLE_CHARACTERISTICS];
};
enum px_ble_event_type {
  PX_BLE_SCAN=1,PX_BLE_SCAN_DONE,PX_BLE_CONNECTED,PX_BLE_DISCONNECTED,
  PX_BLE_RESULT,PX_BLE_NOTIFICATION,PX_BLE_PERIPHERAL_CONNECT,
  PX_BLE_PERIPHERAL_DISCONNECT,PX_BLE_PERIPHERAL_WRITE,PX_BLE_PERIPHERAL_READ
};
struct px_ble_event {
  enum px_ble_event_type type;
  uint32_t connection,request,tag;
  int error,rssi;
  char id[18],name[64],service[PX_BLE_UUID_BYTES],characteristic[PX_BLE_UUID_BYTES];
  bool has_name,has_manufacturer;
  uint8_t *data;
  size_t length;
};
struct px_ble;
/* 协议栈设备级常驻，只有一个应用会话；任何后台回调只携带代次，不持有VM指针。 */
struct px_ble *px_ble_create(void);
void px_ble_destroy(struct px_ble *ble);
bool px_ble_available(struct px_ble *ble);
int px_ble_peripheral_start(struct px_ble *ble,const struct px_ble_definition *definition);
int px_ble_peripheral_stop(struct px_ble *ble);
int px_ble_notify(struct px_ble *ble,const char *service,const char *characteristic,const uint8_t *data,size_t length);
int px_ble_scan(struct px_ble *ble,unsigned timeout_ms);
int px_ble_stop_scan(struct px_ble *ble);
int px_ble_connect(struct px_ble *ble,const char *id,unsigned timeout_ms,uint32_t *connection);
int px_ble_disconnect(struct px_ble *ble,uint32_t connection);
enum px_ble_operation {PX_BLE_DISCOVER=1,PX_BLE_READ_VALUE,PX_BLE_WRITE_VALUE,PX_BLE_SUBSCRIBE};
int px_ble_operate(struct px_ble *ble,uint32_t connection,uint32_t request,enum px_ble_operation operation,
                   const char *service,const char *characteristic,const uint8_t *data,size_t length,bool flag);
int px_ble_read_reply(struct px_ble *ble,uint32_t request,const uint8_t *data,size_t length,bool ok);
int px_ble_poll(struct px_ble *ble,struct px_ble_event *event);
void px_ble_event_free(struct px_ble_event *event);
bool px_ble_uuid(const char *input,char output[PX_BLE_UUID_BYTES]);

/* NimBLE适配层与测试适配层共用的纯C接口；事件负载立即复制。 */
int px_ble_emit(uint32_t generation,const struct px_ble_event *event);
bool px_ble_session_alive(uint32_t generation);
bool px_ble_read_bridge(uint32_t generation,uint32_t tag,uint8_t *data,size_t *length);
/* 能力查询只读状态；实际BLE命令才通过ready按需启动硬件。 */
bool px_ble_backend_available(void);
int px_ble_backend_ready(void);
int px_ble_backend_peripheral(uint32_t generation,const struct px_ble_definition *definition);
int px_ble_backend_stop(uint32_t generation,bool all);
int px_ble_backend_notify(uint32_t generation,const char *service,const char *characteristic,const uint8_t *data,size_t length);
int px_ble_backend_scan(uint32_t generation,unsigned timeout_ms);
int px_ble_backend_connect(uint32_t generation,const char *id,unsigned timeout_ms,uint32_t *connection);
int px_ble_backend_disconnect(uint32_t generation,uint32_t connection);
int px_ble_backend_operate(uint32_t generation,uint32_t connection,uint32_t request,enum px_ble_operation operation,
                          const char *service,const char *characteristic,const uint8_t *data,size_t length,bool flag);
#endif
