/* NuttX NimBLE适配：所有GAP/GATT状态仅在host线程修改，调用线程通过有界同步命令桥提交。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_ble.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if defined(__NuttX__) && defined(CONFIG_NIMBLE)
#if !defined(CONFIG_WIRELESS) || !defined(CONFIG_WIRELESS_BLUETOOTH) || !defined(CONFIG_NET_BLUETOOTH)
#error "PixelBox NimBLE requires CONFIG_WIRELESS, CONFIG_WIRELESS_BLUETOOTH and CONFIG_NET_BLUETOOTH"
#endif
#if defined(CONFIG_WIRELESS_BLUETOOTH_HOST) || defined(CONFIG_UART_BTH4)
#error "PixelBox NimBLE owns RAW HCI: disable CONFIG_WIRELESS_BLUETOOTH_HOST and CONFIG_UART_BTH4"
#endif
#if !defined(CONFIG_NETDEV_IFINDEX) || !defined(CONFIG_NETDEV_IOCTL)
#error "PixelBox NimBLE requires CONFIG_NETDEV_IFINDEX and CONFIG_NETDEV_IOCTL"
#endif
#include "pixelbox_watchdog.h"
#include <pthread.h>
#include <stdio.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <nuttx/wireless/bluetooth/bt_hci.h>
#undef BT_ADDR_ANY
#include <netpacket/bluetooth.h>
#include <sched.h>
#include "nimble/nimble_port.h"
#include "nimble/nimble_npl.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs_mbuf.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

void ble_hci_sock_ack_handler(void *argument);
void ble_hci_sock_set_device(int device);
void ble_store_ram_init(void);
int esp32s3_ble_initialize(void);
int esp32s3_ble_shutdown(void);
int esp32s3_ble_hci_device(void);
static pthread_mutex_t boot_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t boot_condition=PTHREAD_COND_INITIALIZER;
static bool initialized,host_ready,synchronized;
static int boot_error;
static uint32_t startup_watchdog;
static bool startup_busy;
static int hci_device;
static uint8_t own_address;
static uint32_t token_counter;
struct peer {
  uint32_t generation,token,request;
  uint16_t handle;
  bool connecting,connected,discovered;
  char id[18];
  struct px_ble_services info;
  uint16_t service_start[PX_BLE_SERVICES],service_end[PX_BLE_SERVICES];
  uint16_t declaration[PX_BLE_CHARACTERISTICS],value[PX_BLE_CHARACTERISTICS],cccd[PX_BLE_CHARACTERISTICS];
  unsigned service,characteristic;
  enum px_ble_operation operation;
  size_t length;
  uint8_t data[PX_BLE_VALUE_BYTES];
};
static struct peer peers[PX_BLE_CONNECTIONS];
struct peripheral {
  uint32_t generation;
  bool running;
  struct px_ble_definition definition;
  struct ble_gatt_svc_def services[PX_BLE_SERVICES+1];
  struct ble_gatt_chr_def characteristics[PX_BLE_CHARACTERISTICS+PX_BLE_SERVICES];
  ble_uuid_any_t uuids[PX_BLE_SERVICES+PX_BLE_CHARACTERISTICS];
  uint16_t handles[PX_BLE_CHARACTERISTICS];
  struct {uint16_t handle;bool used;char id[18];} connections[PX_BLE_CONNECTIONS];
};
static struct peripheral *peripheral;
static struct {uint32_t generation;unsigned count;bool active;ble_addr_t addresses[PX_BLE_SCAN_DEVICES];} scan;
enum command_type {CMD_PERIPHERAL,CMD_STOP,CMD_NOTIFY,CMD_SCAN,CMD_CONNECT,CMD_DISCONNECT,CMD_OPERATE};
struct command {
  struct ble_npl_event event;
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  unsigned references;
  bool done,flag,cancelled;
  int result;
  enum command_type type;
  enum px_ble_operation operation;
  uint32_t generation,connection,request;
  unsigned timeout;
  char service[37],characteristic[37],id[18];
  size_t length;
  uint8_t data[PX_BLE_VALUE_BYTES];
  struct px_ble_definition *definition;
};
static unsigned pending_commands;
static pthread_mutex_t command_lock=PTHREAD_MUTEX_INITIALIZER;
static int gap_event(struct ble_gap_event *event,void *argument);
/* NTP可修改墙上时间；启动和命令等待只依据单调时钟，不能拖过stall watchdog。 */
static void deadline_ms(struct timespec *deadline,unsigned milliseconds)
{clock_gettime(CLOCK_MONOTONIC,deadline);deadline->tv_sec+=milliseconds/1000;deadline->tv_nsec+=(long)(milliseconds%1000)*1000000;if(deadline->tv_nsec>=1000000000){deadline->tv_nsec-=1000000000;deadline->tv_sec++;}}
static int status(int code){return code==0?0:code==BLE_HS_ENOMEM?-ENOMEM:code==BLE_HS_EBUSY?-EBUSY:code==BLE_HS_EALREADY?-EALREADY:code==BLE_HS_ENOTCONN?-ENOTCONN:code==BLE_HS_ETIMEOUT?-ETIMEDOUT:-EIO;}
static void address_string(const ble_addr_t *address,char output[18])
{snprintf(output,18,"%02x:%02x:%02x:%02x:%02x:%02x",address->val[5],address->val[4],address->val[3],address->val[2],address->val[1],address->val[0]);}
static void uuid_string(const ble_uuid_t *uuid,char output[37])
{char raw[BLE_UUID_STR_LEN];ble_uuid_to_str(uuid,raw);(void)px_ble_uuid(raw[0]=='0'&&raw[1]=='x'?raw+2:raw,output);}
static struct peer *peer_token(uint32_t token)
{for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(peers[i].token==token)return &peers[i];return NULL;}
static struct peer *peer_callback(void *argument,uint16_t handle)
{struct peer *peer=peer_token((uint32_t)(uintptr_t)argument);return peer&&peer->connected&&peer->handle==handle?peer:NULL;}
static void complete(struct peer *peer,int error,const void *data,size_t length)
{
  struct px_ble_event event={.type=PX_BLE_RESULT,.connection=peer->token,.request=peer->request,.tag=peer->operation,.error=error,.data=(uint8_t *)data,.length=length};
  peer->request=0;px_ble_emit(peer->generation,&event);
}
static unsigned properties(uint8_t flags)
{return ((flags&BLE_GATT_CHR_PROP_READ)?PX_BLE_READ:0)|((flags&BLE_GATT_CHR_PROP_WRITE)?PX_BLE_WRITE:0)|((flags&BLE_GATT_CHR_PROP_WRITE_NO_RSP)?PX_BLE_WRITE_NR:0)|((flags&BLE_GATT_CHR_PROP_NOTIFY)?PX_BLE_NOTIFY:0)|((flags&BLE_GATT_CHR_PROP_INDICATE)?PX_BLE_INDICATE:0);}
static int characteristic_index(struct peer *peer,const char *service,const char *characteristic)
{for(unsigned s=0;s<peer->info.service_count;s++)if(!strcmp(service,peer->info.services[s].uuid))for(unsigned j=0;j<peer->info.services[s].count;j++){unsigned c=peer->info.services[s].first+j;if(!strcmp(characteristic,peer->info.characteristics[c].uuid))return (int)c;}return -1;}
static int next_descriptors(struct peer *peer);
static int descriptor_callback(uint16_t handle,const struct ble_gatt_error *error,uint16_t chr_handle,const struct ble_gatt_dsc *descriptor,void *argument)
{
  (void)chr_handle;struct peer *peer=peer_callback(argument,handle);if(!peer||!peer->request)return 0;
  if(!error->status){if(ble_uuid_u16(&descriptor->uuid.u)==BLE_GATT_DSC_CLT_CFG_UUID16)peer->cccd[peer->characteristic]=descriptor->handle;return 0;}
  if(error->status!=BLE_HS_EDONE){complete(peer,status(error->status),NULL,0);return 0;}
  peer->characteristic++;int rc=next_descriptors(peer);if(rc)complete(peer,status(rc),NULL,0);return 0;
}
static int next_descriptors(struct peer *peer)
{
  while(peer->characteristic<peer->info.characteristic_count){unsigned c=peer->characteristic;unsigned s=0;while(s+1<peer->info.service_count&&peer->info.services[s+1].first<=c)s++;
    uint16_t end=c+1<peer->info.services[s].first+peer->info.services[s].count?peer->declaration[c+1]-1:peer->service_end[s];
    if((peer->info.characteristics[c].properties&(PX_BLE_NOTIFY|PX_BLE_INDICATE))&&peer->value[c]<end)
      return ble_gattc_disc_all_dscs(peer->handle,peer->value[c],end,descriptor_callback,(void *)(uintptr_t)peer->token);
    peer->characteristic++;
  }
  peer->discovered=true;complete(peer,0,&peer->info,sizeof(peer->info));return 0;
}
static int next_characteristics(struct peer *peer);
static int characteristic_callback(uint16_t handle,const struct ble_gatt_error *error,const struct ble_gatt_chr *chr,void *argument)
{
  struct peer *peer=peer_callback(argument,handle);if(!peer||!peer->request)return 0;
  if(!error->status){unsigned c=peer->info.characteristic_count;if(c==PX_BLE_CHARACTERISTICS){complete(peer,-ENOSPC,NULL,0);return BLE_HS_ENOMEM;}
    uuid_string(&chr->uuid.u,peer->info.characteristics[c].uuid);peer->info.characteristics[c].properties=properties(chr->properties);
    peer->declaration[c]=chr->def_handle;peer->value[c]=chr->val_handle;peer->info.characteristic_count++;peer->info.services[peer->service].count++;return 0;}
  if(error->status!=BLE_HS_EDONE){complete(peer,status(error->status),NULL,0);return 0;}
  peer->service++;int rc=next_characteristics(peer);if(rc)complete(peer,status(rc),NULL,0);return 0;
}
static int next_characteristics(struct peer *peer)
{
  if(peer->service<peer->info.service_count){unsigned s=peer->service;peer->info.services[s].first=peer->info.characteristic_count;
    return ble_gattc_disc_all_chrs(peer->handle,peer->service_start[s],peer->service_end[s],characteristic_callback,(void *)(uintptr_t)peer->token);}
  peer->characteristic=0;return next_descriptors(peer);
}
static int service_callback(uint16_t handle,const struct ble_gatt_error *error,const struct ble_gatt_svc *service,void *argument)
{
  struct peer *peer=peer_callback(argument,handle);if(!peer||!peer->request)return 0;
  if(!error->status){unsigned s=peer->info.service_count;if(s==PX_BLE_SERVICES){complete(peer,-ENOSPC,NULL,0);return BLE_HS_ENOMEM;}
    uuid_string(&service->uuid.u,peer->info.services[s].uuid);peer->service_start[s]=service->start_handle;peer->service_end[s]=service->end_handle;peer->info.service_count++;return 0;}
  if(error->status!=BLE_HS_EDONE){complete(peer,status(error->status),NULL,0);return 0;}
  peer->service=0;int rc=next_characteristics(peer);if(rc)complete(peer,status(rc),NULL,0);return 0;
}
static int attribute_callback(uint16_t handle,const struct ble_gatt_error *error,struct ble_gatt_attr *attribute,void *argument)
{
  struct peer *peer=peer_callback(argument,handle);if(!peer||!peer->request)return 0;
  if(peer->operation==PX_BLE_READ_VALUE){
    if(!error->status&&attribute&&attribute->om){size_t length=OS_MBUF_PKTLEN(attribute->om);
      if(length>PX_BLE_VALUE_BYTES-peer->length){complete(peer,-EMSGSIZE,NULL,0);return BLE_HS_ENOMEM;}
      if(os_mbuf_copydata(attribute->om,0,length,peer->data+peer->length)){complete(peer,-EIO,NULL,0);return BLE_HS_EAPP;}
      peer->length+=length;return 0;
    }
    complete(peer,error->status==BLE_HS_EDONE?0:status(error->status),peer->data,peer->length);
  }else complete(peer,status(error->status),NULL,0);
  return 0;
}
static int advertise(void)
{
  if(!peripheral||!peripheral->running||!px_ble_session_alive(peripheral->generation))return 0;
  struct ble_hs_adv_fields fields={0};fields.flags=BLE_HS_ADV_F_DISC_GEN|BLE_HS_ADV_F_BREDR_UNSUP;
  fields.name=(uint8_t *)peripheral->definition.name;size_t length=strlen(peripheral->definition.name);fields.name_len=length>26?26:length;fields.name_is_complete=length<=26;
  int rc=ble_gap_adv_set_fields(&fields);if(rc)return rc;
  struct ble_gap_adv_params parameters={0};parameters.conn_mode=BLE_GAP_CONN_MODE_UND;parameters.disc_mode=BLE_GAP_DISC_MODE_GEN;
  return ble_gap_adv_start(own_address,NULL,BLE_HS_FOREVER,&parameters,gap_event,NULL);
}
static int peripheral_access(uint16_t connection,uint16_t handle,struct ble_gatt_access_ctxt *context,void *argument)
{
  (void)connection;(void)handle;struct px_ble_characteristic *chr=argument;
  if(!peripheral||!peripheral->running||!px_ble_session_alive(peripheral->generation))return BLE_ATT_ERR_UNLIKELY;
  if(context->op==BLE_GATT_ACCESS_OP_READ_CHR){
    if(chr->on_read){size_t length=0;uint8_t data[PX_BLE_VALUE_BYTES];if(px_ble_read_bridge(peripheral->generation,chr->tag,data,&length)){memcpy(chr->value,data,length);chr->length=length;}}
    return os_mbuf_append(context->om,chr->value,chr->length)?BLE_ATT_ERR_INSUFFICIENT_RES:0;
  }
  if(context->op==BLE_GATT_ACCESS_OP_WRITE_CHR){size_t length=OS_MBUF_PKTLEN(context->om);if(length>PX_BLE_VALUE_BYTES)return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    if(os_mbuf_copydata(context->om,0,length,chr->value))return BLE_ATT_ERR_UNLIKELY;
    chr->length=length;
    struct px_ble_event event={.type=PX_BLE_PERIPHERAL_WRITE,.tag=chr->tag,.data=chr->value,.length=length};return px_ble_emit(peripheral->generation,&event)?BLE_ATT_ERR_INSUFFICIENT_RES:0;
  }
  return BLE_ATT_ERR_UNLIKELY;
}
static int start_peripheral(uint32_t generation,const struct px_ble_definition *definition)
{
  /* GATT表重建要求没有任何连接或扫描；保留旧表直到reset成功，避免host仍引用已释放内存。 */
  for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(peers[i].token||(peripheral&&peripheral->connections[i].used))return -EBUSY;
  if(scan.active)return -EBUSY;
  struct peripheral *replacement=calloc(1,sizeof(*replacement));if(!replacement)return -ENOMEM;
  replacement->generation=generation;replacement->definition=*definition;unsigned cursor=0;
  for(unsigned s=0;s<definition->service_count;s++){
    if(ble_uuid_from_str(&replacement->uuids[s],definition->services[s])){free(replacement);return -EINVAL;}
    replacement->services[s].type=BLE_GATT_SVC_TYPE_PRIMARY;replacement->services[s].uuid=&replacement->uuids[s].u;replacement->services[s].characteristics=&replacement->characteristics[cursor];
    for(unsigned c=0;c<definition->characteristic_count;c++)if(definition->characteristics[c].service==s){struct px_ble_characteristic *source=&replacement->definition.characteristics[c];struct ble_gatt_chr_def *target=&replacement->characteristics[cursor++];
      ble_uuid_from_str(&replacement->uuids[PX_BLE_SERVICES+c],source->uuid);target->uuid=&replacement->uuids[PX_BLE_SERVICES+c].u;target->access_cb=peripheral_access;target->arg=source;target->val_handle=&replacement->handles[c];
      target->flags=((source->properties&PX_BLE_READ)?BLE_GATT_CHR_F_READ:0)|((source->properties&PX_BLE_WRITE)?BLE_GATT_CHR_F_WRITE|BLE_GATT_CHR_F_WRITE_NO_RSP:0)|((source->properties&PX_BLE_NOTIFY)?BLE_GATT_CHR_F_NOTIFY:0);
    }cursor++;
  }
  ble_gap_adv_stop();int rc=ble_gatts_reset();if(rc){free(replacement);return status(rc);}free(peripheral);peripheral=replacement;
  ble_svc_gap_init();ble_svc_gatt_init();rc=ble_gatts_count_cfg(peripheral->services);if(!rc)rc=ble_gatts_add_svcs(peripheral->services);if(!rc)rc=ble_gatts_start();if(!rc)rc=ble_svc_gap_device_name_set(definition->name);
  if(!rc){peripheral->running=true;rc=advertise();if(rc)peripheral->running=false;}return status(rc);
}
static int gap_event(struct ble_gap_event *event,void *argument)
{
  uint32_t token=(uint32_t)(uintptr_t)argument;struct peer *peer=token?peer_token(token):NULL;
  if(event->type==BLE_GAP_EVENT_DISC){
    if(!scan.active)return 0;
    const struct ble_gap_disc_desc *result=&event->disc;unsigned index=0;
    while(index<scan.count&&memcmp(&scan.addresses[index],&result->addr,sizeof(result->addr)))index++;
    if(index==scan.count){if(scan.count==PX_BLE_SCAN_DEVICES)return 0;scan.addresses[scan.count++]=result->addr;}
    struct ble_hs_adv_fields fields={0};if(ble_hs_adv_parse_fields(&fields,result->data,result->length_data))return 0;
    struct px_ble_event out={.type=PX_BLE_SCAN,.rssi=result->rssi,.has_name=fields.name!=NULL,.has_manufacturer=fields.mfg_data!=NULL,.data=(uint8_t *)fields.mfg_data,.length=fields.mfg_data_len};
    address_string(&result->addr,out.id);if(fields.name){size_t length=fields.name_len;if(length>63)length=63;memcpy(out.name,fields.name,length);}px_ble_emit(scan.generation,&out);return 0;
  }
  if(event->type==BLE_GAP_EVENT_DISC_COMPLETE){if(scan.active){scan.active=false;struct px_ble_event out={.type=PX_BLE_SCAN_DONE};px_ble_emit(scan.generation,&out);}return 0;}
  if(event->type==BLE_GAP_EVENT_CONNECT){
    if(token){if(!peer){if(!event->connect.status)ble_gap_terminate(event->connect.conn_handle,BLE_ERR_REM_USER_CONN_TERM);return 0;}
      peer->connecting=false;struct px_ble_event out={.type=PX_BLE_CONNECTED,.connection=token,.error=status(event->connect.status)};
      if(!event->connect.status){peer->handle=event->connect.conn_handle;peer->connected=true;if(!px_ble_session_alive(peer->generation)){ble_gap_terminate(peer->handle,BLE_ERR_REM_USER_CONN_TERM);return 0;}}
      px_ble_emit(peer->generation,&out);if(event->connect.status)memset(peer,0,sizeof(*peer));return 0;
    }
    if(!event->connect.status){struct ble_gap_conn_desc descriptor;ble_gap_conn_find(event->connect.conn_handle,&descriptor);if(!peripheral||!peripheral->running){ble_gap_terminate(event->connect.conn_handle,BLE_ERR_REM_USER_CONN_TERM);return 0;}
      for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(!peripheral->connections[i].used){peripheral->connections[i].used=true;peripheral->connections[i].handle=event->connect.conn_handle;address_string(&descriptor.peer_id_addr,peripheral->connections[i].id);struct px_ble_event out={.type=PX_BLE_PERIPHERAL_CONNECT};memcpy(out.id,peripheral->connections[i].id,18);px_ble_emit(peripheral->generation,&out);break;}}
    (void)advertise();return 0;
  }
  if(event->type==BLE_GAP_EVENT_DISCONNECT){
    if(peer){struct px_ble_event out={.type=PX_BLE_DISCONNECTED,.connection=peer->token,.error=event->disconnect.reason};px_ble_emit(peer->generation,&out);memset(peer,0,sizeof(*peer));}
    else if(peripheral)for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(peripheral->connections[i].used&&peripheral->connections[i].handle==event->disconnect.conn.conn_handle){struct px_ble_event out={.type=PX_BLE_PERIPHERAL_DISCONNECT};memcpy(out.id,peripheral->connections[i].id,18);peripheral->connections[i].used=false;px_ble_emit(peripheral->generation,&out);break;}
    (void)advertise();return 0;
  }
  if(event->type==BLE_GAP_EVENT_NOTIFY_RX&&peer){for(unsigned c=0;c<peer->info.characteristic_count;c++)if(peer->value[c]==event->notify_rx.attr_handle){size_t length=OS_MBUF_PKTLEN(event->notify_rx.om);if(length>PX_BLE_VALUE_BYTES)return 0;uint8_t data[PX_BLE_VALUE_BYTES];if(os_mbuf_copydata(event->notify_rx.om,0,length,data))return 0;
      struct px_ble_event out={.type=PX_BLE_NOTIFICATION,.connection=peer->token,.data=data,.length=length};memcpy(out.characteristic,peer->info.characteristics[c].uuid,37);
      for(unsigned s=0;s<peer->info.service_count;s++)if(c>=peer->info.services[s].first&&c<peer->info.services[s].first+peer->info.services[s].count){memcpy(out.service,peer->info.services[s].uuid,37);break;}
      px_ble_emit(peer->generation,&out);break;}}
  return 0;
}
static int do_command(struct command *command)
{
  uint32_t generation=command->generation;if(command->type!=CMD_STOP&&!px_ble_session_alive(generation))return -ECANCELED;
  if(command->type==CMD_PERIPHERAL)return start_peripheral(generation,command->definition);
  if(command->type==CMD_STOP){
    if(peripheral&&peripheral->generation==generation){peripheral->running=false;ble_gap_adv_stop();for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(peripheral->connections[i].used)ble_gap_terminate(peripheral->connections[i].handle,BLE_ERR_REM_USER_CONN_TERM);}
    if(command->flag){if(scan.generation==generation&&scan.active){ble_gap_disc_cancel();scan.active=false;}
      for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++)if(peers[i].generation==generation&&peers[i].token){if(peers[i].connecting)ble_gap_conn_cancel();else if(peers[i].connected)ble_gap_terminate(peers[i].handle,BLE_ERR_REM_USER_CONN_TERM);}}
    return 0;
  }
  if(command->type==CMD_NOTIFY){if(!peripheral||!peripheral->running||peripheral->generation!=generation)return -ENOTCONN;
    for(unsigned c=0;c<peripheral->definition.characteristic_count;c++){struct px_ble_characteristic *chr=&peripheral->definition.characteristics[c];
      if(strcmp(command->service,peripheral->definition.services[chr->service])||strcmp(command->characteristic,chr->uuid))continue;
      if(!(chr->properties&PX_BLE_NOTIFY))return -ENOTSUP;
      memcpy(chr->value,command->data,command->length);chr->length=command->length;ble_gatts_chr_updated(peripheral->handles[c]);return 0;}return -ENOENT;
  }
  if(command->type==CMD_SCAN){if(!command->timeout){if(scan.active&&scan.generation==generation){int rc=ble_gap_disc_cancel();if(rc&&rc!=BLE_HS_EALREADY)return status(rc);scan.active=false;struct px_ble_event out={.type=PX_BLE_SCAN_DONE};px_ble_emit(generation,&out);}return 0;}
    if(scan.active)return -EBUSY;
    memset(&scan,0,sizeof(scan));scan.generation=generation;struct ble_gap_disc_params parameters={0};parameters.passive=0;parameters.filter_duplicates=1;
    int rc=ble_gap_disc(own_address,command->timeout,&parameters,gap_event,NULL);if(!rc)scan.active=true;return status(rc);
  }
  if(command->type==CMD_CONNECT){struct peer *peer=NULL;for(unsigned i=0;i<PX_BLE_CONNECTIONS;i++){if(peers[i].connecting)return -EBUSY;if(!peers[i].token&&!peer)peer=&peers[i];}if(!peer)return -EMFILE;
    ble_addr_t address={.type=BLE_ADDR_PUBLIC};unsigned parts[6];if(sscanf(command->id,"%x:%x:%x:%x:%x:%x",&parts[5],&parts[4],&parts[3],&parts[2],&parts[1],&parts[0])!=6)return -EINVAL;for(unsigned i=0;i<6;i++)address.val[i]=(uint8_t)parts[i];
    for(unsigned i=0;i<scan.count;i++)if(!memcmp(address.val,scan.addresses[i].val,6)){address.type=scan.addresses[i].type;break;}
    if(!++token_counter)++token_counter;
    memset(peer,0,sizeof(*peer));peer->token=token_counter;peer->generation=generation;peer->connecting=true;memcpy(peer->id,command->id,18);
    int rc=ble_gap_connect(own_address,&address,command->timeout,NULL,gap_event,(void *)(uintptr_t)peer->token);if(rc){memset(peer,0,sizeof(*peer));return status(rc);}command->connection=peer->token;return 0;
  }
  struct peer *peer=peer_token(command->connection);if(!peer||peer->generation!=generation)return -ENOTCONN;
  if(command->type==CMD_DISCONNECT)return status(peer->connecting?ble_gap_conn_cancel():ble_gap_terminate(peer->handle,BLE_ERR_REM_USER_CONN_TERM));
  if(!peer->connected)return -ENOTCONN;
  if(peer->request)return -EBUSY;
  peer->request=command->request;peer->operation=command->operation;peer->length=0;int rc=0;
  if(command->operation==PX_BLE_DISCOVER){if(peer->discovered){complete(peer,0,&peer->info,sizeof(peer->info));return 0;}
    memset(&peer->info,0,sizeof(peer->info));memset(peer->cccd,0,sizeof(peer->cccd));rc=ble_gattc_disc_all_svcs(peer->handle,service_callback,(void *)(uintptr_t)peer->token);
  }else {int index=peer->discovered?characteristic_index(peer,command->service,command->characteristic):-1;if(index<0){peer->request=0;return -ENOENT;}unsigned c=(unsigned)index;
    if(command->operation==PX_BLE_READ_VALUE)rc=ble_gattc_read_long(peer->handle,peer->value[c],0,attribute_callback,(void *)(uintptr_t)peer->token);
    else if(command->operation==PX_BLE_SUBSCRIBE){if(!peer->cccd[c]){peer->request=0;return -ENOTSUP;}uint8_t value[2]={command->flag?((peer->info.characteristics[c].properties&PX_BLE_NOTIFY)?1:2):0,0};rc=ble_gattc_write_flat(peer->handle,peer->cccd[c],value,2,attribute_callback,(void *)(uintptr_t)peer->token);}
    else if(!command->flag){if(command->length>(size_t)(ble_att_mtu(peer->handle)-3)){peer->request=0;return -EMSGSIZE;}rc=ble_gattc_write_no_rsp_flat(peer->handle,peer->value[c],command->data,command->length);if(!rc)complete(peer,0,NULL,0);}
    else if(command->length>(size_t)(ble_att_mtu(peer->handle)-3)){struct os_mbuf *buffer=ble_hs_mbuf_from_flat(command->data,command->length);if(!buffer)rc=BLE_HS_ENOMEM;else rc=ble_gattc_write_long(peer->handle,peer->value[c],0,buffer,attribute_callback,(void *)(uintptr_t)peer->token);}
    else rc=ble_gattc_write_flat(peer->handle,peer->value[c],command->data,command->length,attribute_callback,(void *)(uintptr_t)peer->token);
  }
  if(rc)peer->request=0;
  return status(rc);
}
static void release_command(struct command *command)
{
  pthread_mutex_lock(&command->mutex);bool last=!--command->references;pthread_mutex_unlock(&command->mutex);
  if(last){pthread_mutex_destroy(&command->mutex);pthread_cond_destroy(&command->condition);free(command->definition);free(command);}
}
static void execute_command(struct ble_npl_event *event)
{
  struct command *command=ble_npl_event_get_arg(event);
  pthread_mutex_lock(&command->mutex);bool cancelled=command->cancelled;pthread_mutex_unlock(&command->mutex);
  int result=cancelled?-ECANCELED:do_command(command);
  pthread_mutex_lock(&command->mutex);bool cleanup=command->cancelled&&!cancelled;command->result=result;command->done=true;pthread_cond_broadcast(&command->condition);pthread_mutex_unlock(&command->mutex);
  /* 调用者已超时：不能让迟到的start/connect留下一项无人持有的无线资源。 */
  if(cleanup){struct command stop={.type=CMD_STOP,.generation=command->generation,.flag=true};(void)do_command(&stop);}
  pthread_mutex_lock(&command_lock);pending_commands--;pthread_mutex_unlock(&command_lock);release_command(command);
}
static struct command *new_command(uint32_t generation,enum command_type type)
{struct command *command=calloc(1,sizeof(*command));if(command){command->generation=generation;command->type=type;}return command;}
static int submit(struct command *command,uint32_t *connection)
{
  if(!command)return -ENOMEM;
  pthread_mutex_lock(&boot_lock);bool running=host_ready&&!boot_error;pthread_mutex_unlock(&boot_lock);
  if(!running){free(command->definition);free(command);return -ENOTSUP;}
  pthread_mutex_lock(&command_lock);if(pending_commands==8){pthread_mutex_unlock(&command_lock);free(command->definition);free(command);return -ENOBUFS;}pending_commands++;pthread_mutex_unlock(&command_lock);
  int error=pthread_mutex_init(&command->mutex,NULL);
  if(!error){error=pthread_cond_init(&command->condition,NULL);if(error)pthread_mutex_destroy(&command->mutex);}
  if(error){pthread_mutex_lock(&command_lock);pending_commands--;pthread_mutex_unlock(&command_lock);free(command->definition);free(command);return -error;}
  command->references=2;
  ble_npl_event_init(&command->event,execute_command,command);ble_npl_eventq_put(nimble_port_get_dflt_eventq(),&command->event);
  struct timespec deadline;deadline_ms(&deadline,2000);pthread_mutex_lock(&command->mutex);int result=0;
  while(!command->done&&!result)result=pthread_cond_clockwait(&command->condition,&command->mutex,CLOCK_MONOTONIC,&deadline);
  if(command->done){result=command->result;if(!result&&connection)*connection=command->connection;}else{command->cancelled=true;result=-ETIMEDOUT;}
  pthread_mutex_unlock(&command->mutex);release_command(command);return result;
}
/* 控制器初始化和首次host同步共享一张票据；卡住时监督线程停止喂硬件狗。 */
static int start_startup_watchdog(void)
{
  int result=0;
  if(!startup_watchdog){result=px_watchdog_register(&startup_watchdog);if(result)return result;}
  /* 连续reset沿用同一busy期限，不能用反复begin掩盖始终无法同步。 */
  if(!startup_busy){result=px_watchdog_begin(startup_watchdog);if(!result)startup_busy=true;}
  return result;
}
static int finish_startup_watchdog(void)
{
  if(!startup_watchdog)return 0;
  int result=startup_busy?px_watchdog_end(startup_watchdog):0;
  int released=px_watchdog_unregister(startup_watchdog);if(!result)result=released;
  startup_watchdog=0;startup_busy=false;return result;
}
static void on_reset(int reason)
{
  /* 首次同步后的失联也纳入硬件恢复；监督失败由host事件循环统一停控制器。 */
  int result=start_startup_watchdog();
  if(result)syslog(LOG_ERR,"pixelbox BLE reset supervision failed: reason=%d error=%d\n",reason,result);
  pthread_mutex_lock(&boot_lock);synchronized=false;if(result)boot_error=result;pthread_cond_broadcast(&boot_condition);pthread_mutex_unlock(&boot_lock);
}
static void on_sync(void)
{
  int rc=ble_hs_util_ensure_addr(0);if(!rc)rc=ble_hs_id_infer_auto(0,&own_address);
  /* 同步失败时由host退出路径在关闭控制器后释放启动票据。 */
  int result=status(rc);if(!result)result=finish_startup_watchdog();
  if(result)syslog(LOG_ERR,"pixelbox BLE sync failed: error=%d\n",result);
  else syslog(LOG_INFO,"pixelbox BLE ready: hci%d host synchronized\n",hci_device);
  pthread_mutex_lock(&boot_lock);synchronized=!result;boot_error=result;pthread_cond_broadcast(&boot_condition);pthread_mutex_unlock(&boot_lock);
}
static void *hci_thread(void *argument){ble_hci_sock_ack_handler(argument);return NULL;}
static int start_hci_thread(void)
{
  pthread_attr_t attributes;int rc=pthread_attr_init(&attributes);if(rc)return -rc;
  rc=pthread_attr_setstacksize(&attributes,8192);if(!rc)rc=pthread_attr_setdetachstate(&attributes,PTHREAD_CREATE_DETACHED);
  pthread_t thread;if(!rc)rc=pthread_create(&thread,&attributes,hci_thread,NULL);pthread_attr_destroy(&attributes);return -rc;
}
static int run_host(void)
{
  /* 使用NimBLE默认事件队列；同步回调失败后立即回到统一清理路径。 */
  for(;;){
    struct ble_npl_event *event=ble_npl_eventq_get(nimble_port_get_dflt_eventq(),BLE_NPL_TIME_FOREVER);
    if(!event)return -EIO;
    ble_npl_event_run(event);
    pthread_mutex_lock(&boot_lock);int result=boot_error;pthread_mutex_unlock(&boot_lock);
    if(result)return result;
  }
}
static int host_task(int argc,char **argv)
{
  (void)argc;(void)argv;int result=0,rollback=0;bool controller_attempted=false;const char *stage="watchdog-register";
    stage="watchdog-supervision";
    result=start_startup_watchdog();if(result)goto failed;
    /* 启动NSH/Wi-Fi后才按需初始化BLE；不得在未受监督的board bringup里调用。 */
    stage="controller";
    controller_attempted=true;result=esp32s3_ble_initialize();if(result)goto failed;
    stage="hci-interface";
    hci_device=esp32s3_ble_hci_device();if(hci_device<0){result=hci_device;goto failed;}
    ble_hci_sock_set_device(hci_device);
    /* 上游socket init使用panic断言；先探测真实HCI接口，未注册时直接不可用。 */
    stage="hci-socket";
    int socket_fd=socket(PF_BLUETOOTH,SOCK_RAW,BTPROTO_HCI);if(socket_fd<0){result=-errno;goto failed;}
    struct sockaddr_hci address={0};address.hci_family=AF_BLUETOOTH;address.hci_dev=hci_device;address.hci_channel=HCI_CHANNEL_RAW;
    stage="hci-bind";
    int rc=bind(socket_fd,(struct sockaddr *)&address,sizeof(address));int error=errno;close(socket_fd);if(rc){result=-error;goto failed;}
    /* 独立task拥有NPL的callout pthread和HCI socket；应用VM退出不销毁这些资源。 */
    stage="nimble-init";
    nimble_port_init();ble_hs_cfg.reset_cb=on_reset;ble_hs_cfg.sync_cb=on_sync;ble_svc_gap_init();ble_svc_gatt_init();ble_store_ram_init();
    /* HCI和callout pthread共用永久host task的fd表，不能由应用task拥有。 */
    stage="hci-thread";
    result=start_hci_thread();if(result)goto failed;
    stage="host-run";
    pthread_mutex_lock(&boot_lock);host_ready=true;pthread_mutex_unlock(&boot_lock);result=run_host();
failed:
  /* 固定阶段名与负errno直接写系统日志，不依赖可关闭的无线调试宏。 */
  syslog(LOG_ERR,"pixelbox BLE startup failed: stage=%s error=%d\n",stage,result);
  pthread_mutex_lock(&boot_lock);host_ready=synchronized=false;boot_error=result;pthread_cond_broadcast(&boot_condition);pthread_mutex_unlock(&boot_lock);
  if(controller_attempted){
    /* 首次同步后票据已释放；意外退出的清理也必须重新纳入硬件狗监督。 */
    if(!startup_watchdog) (void)start_startup_watchdog();
    rollback=esp32s3_ble_shutdown();
  }
  /* 回滚失败不能假报健康；保留busy票据，让监督线程触发硬件恢复。 */
  if(!rollback)(void)finish_startup_watchdog();
  pthread_mutex_lock(&boot_lock);host_ready=synchronized=false;boot_error=result;pthread_cond_broadcast(&boot_condition);pthread_mutex_unlock(&boot_lock);return 1;
}
bool px_ble_backend_available(void)
{
  /* 未启动时报告编译能力；启动中、失联或启动失败时不等待、不触发控制器。 */
  pthread_mutex_lock(&boot_lock);
  bool available=!boot_error&&(!initialized||(host_ready&&synchronized));
  pthread_mutex_unlock(&boot_lock);return available;
}
int px_ble_backend_ready(void)
{
  pthread_mutex_lock(&boot_lock);
  /* 必须用独立task组；kthread共享内核组，退出时不会回收自己的HCI/callout pthread。 */
  if(!initialized){initialized=true;int pid=task_create("pixelbox-ble",110,8192,host_task,NULL);if(pid<0)boot_error=-errno;}
  struct timespec deadline;deadline_ms(&deadline,2000);int waited=0;
  while(!synchronized&&!boot_error&&!waited)waited=pthread_cond_clockwait(&boot_condition,&boot_lock,CLOCK_MONOTONIC,&deadline);
  int result=synchronized?0:boot_error?boot_error:-ETIMEDOUT;pthread_mutex_unlock(&boot_lock);return result;
}
int px_ble_backend_peripheral(uint32_t generation,const struct px_ble_definition *definition)
{
  struct command *command=new_command(generation,CMD_PERIPHERAL);if(!command)return -ENOMEM;
  command->definition=malloc(sizeof(*definition));if(!command->definition){free(command);return -ENOMEM;}*command->definition=*definition;
  /* C调用方也可传短UUID，后台保存规范形式才能与notify的规范UUID匹配。 */
  for(unsigned i=0;i<definition->service_count;i++)px_ble_uuid(definition->services[i],command->definition->services[i]);
  for(unsigned i=0;i<definition->characteristic_count;i++)px_ble_uuid(definition->characteristics[i].uuid,command->definition->characteristics[i].uuid);
  return submit(command,NULL);
}
int px_ble_backend_stop(uint32_t generation,bool all)
{struct command *command=new_command(generation,CMD_STOP);if(command)command->flag=all;return submit(command,NULL);}
int px_ble_backend_notify(uint32_t generation,const char *service,const char *characteristic,const uint8_t *data,size_t length)
{struct command *command=new_command(generation,CMD_NOTIFY);if(command){memcpy(command->service,service,37);memcpy(command->characteristic,characteristic,37);command->length=length;if(length)memcpy(command->data,data,length);}return submit(command,NULL);}
int px_ble_backend_scan(uint32_t generation,unsigned timeout)
{struct command *command=new_command(generation,CMD_SCAN);if(command)command->timeout=timeout;return submit(command,NULL);}
int px_ble_backend_connect(uint32_t generation,const char *id,unsigned timeout,uint32_t *connection)
{struct command *command=new_command(generation,CMD_CONNECT);if(command){memcpy(command->id,id,18);command->timeout=timeout;}return submit(command,connection);}
int px_ble_backend_disconnect(uint32_t generation,uint32_t connection)
{struct command *command=new_command(generation,CMD_DISCONNECT);if(command)command->connection=connection;return submit(command,NULL);}
int px_ble_backend_operate(uint32_t generation,uint32_t connection,uint32_t request,enum px_ble_operation operation,const char *service,const char *characteristic,const uint8_t *data,size_t length,bool flag)
{struct command *command=new_command(generation,CMD_OPERATE);if(command){command->connection=connection;command->request=request;command->operation=operation;memcpy(command->service,service,37);memcpy(command->characteristic,characteristic,37);command->length=length;if(length)memcpy(command->data,data,length);command->flag=flag;}return submit(command,NULL);}
#else
bool px_ble_backend_available(void){return false;}
int px_ble_backend_ready(void){return -ENOTSUP;}
int px_ble_backend_peripheral(uint32_t g,const struct px_ble_definition *d){(void)g;(void)d;return -ENOTSUP;}
int px_ble_backend_stop(uint32_t g,bool all){(void)g;(void)all;return 0;}
int px_ble_backend_notify(uint32_t g,const char *s,const char *c,const uint8_t *d,size_t n){(void)g;(void)s;(void)c;(void)d;(void)n;return -ENOTSUP;}
int px_ble_backend_scan(uint32_t g,unsigned t){(void)g;(void)t;return -ENOTSUP;}
int px_ble_backend_connect(uint32_t g,const char *id,unsigned t,uint32_t *c){(void)g;(void)id;(void)t;(void)c;return -ENOTSUP;}
int px_ble_backend_disconnect(uint32_t g,uint32_t c){(void)g;(void)c;return -ENOTSUP;}
int px_ble_backend_operate(uint32_t g,uint32_t c,uint32_t r,enum px_ble_operation o,const char *s,const char *h,const uint8_t *d,size_t n,bool f){(void)g;(void)c;(void)r;(void)o;(void)s;(void)h;(void)d;(void)n;(void)f;return -ENOTSUP;}
#endif
