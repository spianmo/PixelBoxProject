#!/usr/bin/env python3
"""执行真实RAW HCI发送函数，验证Wi-Fi共存索引、错误设备拒绝和TX等待回收。"""
from pathlib import Path
import argparse
import importlib.util
import shutil
import tempfile

from test_ble_platform import function, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nuttx', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    nuttx = args.nuttx or root.parent / '.deps/nuttx'
    spec = importlib.util.spec_from_file_location('prepare_ble', root / 'tools/prepare_ble.py')
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-hci-route-') as temporary:
        out = Path(temporary)
        relative = Path('net/bluetooth/bluetooth_sendmsg.c')
        target = out / relative
        target.parent.mkdir(parents=True)
        shutil.copy2(nuttx / relative, target)
        assert patch.patch_hci_network(out) and not patch.patch_hci_network(out)
        real = target.read_text()
        source = r'''
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <sys/socket.h>
#define FAR
#define OK 0
#define NET_LL_BLUETOOTH 7
#define BTPROTO_HCI 1
#define BTPROTO_L2CAP 2
#define PKT_POLL 4
#define DEBUGASSERT assert
#define nerr(...) ((void)0)
typedef int sem_t;
typedef struct {uint8_t val[6];} bt_addr_t;
struct sockaddr_hci {sa_family_t hci_family;unsigned short hci_dev,hci_channel;};
struct sockaddr_l2 {sa_family_t l2_family;bt_addr_t l2_bdaddr;};
struct socket {int s_type,s_proto;void *s_conn;};
struct bluetooth_conn_s {bt_addr_t bc_laddr;unsigned bc_ldev;};
struct net_driver_s {int d_lltype,index;};
struct radio_driver_s {struct net_driver_s r_dev;};
struct devif_callback_s {unsigned flags;void *priv;uint16_t (*event)(struct net_driver_s*,void*,uint16_t);};
static struct radio_driver_s radio={{NET_LL_BLUETOOTH,5}};
static struct net_driver_s wifi={1,1};
static struct devif_callback_s callback;
static unsigned locks,lookups,notify_count,timed_waits,callback_frees,sem_frees;
static int wait_error;
struct net_driver_s *netdev_findbyindex(unsigned index){lookups++;return index==1?&wifi:index==5?&radio.r_dev:NULL;}
struct radio_driver_s *bluetooth_find_device(struct bluetooth_conn_s *conn,const bt_addr_t *address){assert(conn&&address);return &radio;}
void net_lock(void){assert(!locks);locks++;}
void net_unlock(void){assert(locks==1);locks--;}
void nxsem_init(sem_t *sem,int shared,unsigned value){assert(locks==1&&!shared&&!value);*sem=0;}
void nxsem_destroy(sem_t *sem){assert(locks==1&&sem);sem_frees++;}
struct devif_callback_s *bluetooth_callback_alloc(struct net_driver_s *device,struct bluetooth_conn_s *conn){assert(device==&radio.r_dev&&conn&&locks);return &callback;}
void bluetooth_callback_free(struct net_driver_s *device,struct bluetooth_conn_s *conn,struct devif_callback_s *cb){assert(device==&radio.r_dev&&conn&&locks&&cb==&callback);callback_frees++;callback.priv=NULL;callback.event=NULL;}
void netdev_txnotify_dev(struct net_driver_s *device){assert(device==&radio.r_dev&&locks);notify_count++;}
int net_sem_wait(sem_t *sem){(void)sem;assert(!"RAW HCI禁止无界TX等待");return -EIO;}
static uint16_t bluetooth_sendto_eventhandler(struct net_driver_s *device,void *state,uint16_t flags){(void)device;(void)state;return flags;}
''' + function(real, 'struct bluetooth_sendto_s\n{') + r''';
int net_sem_timedwait(sem_t *sem,unsigned timeout){
 assert(sem&&locks==1&&timeout==1000&&callback.priv);timed_waits++;
 if(wait_error)return wait_error;
 struct bluetooth_sendto_s *state=callback.priv;state->is_sent=state->is_buflen;return 0;
}
''' + function(real, 'static ssize_t bluetooth_sendto(') + r'''
int main(void){
 struct bluetooth_conn_s conn={0};struct socket socket={SOCK_RAW,BTPROTO_HCI,&conn};
 struct sockaddr_hci address={0};unsigned char data[]={1,3,12,0};
 /* Wi-Fi先注册，占据全局index1；写死hci0必须被拒绝，不能访问WLAN的radio回调。 */
 assert(bluetooth_sendto(&socket,data,sizeof(data),0,(struct sockaddr*)&address,sizeof(address))==-ENODEV);
 assert(!notify_count&&!timed_waits&&!locks&&lookups==1);
 conn.bc_ldev=4;
 assert(bluetooth_sendto(&socket,data,sizeof(data),0,(struct sockaddr*)&address,sizeof(address))==4);
 assert(notify_count==1&&timed_waits==1&&callback_frees==1&&sem_frees==1&&!locks&&!callback.priv);
 wait_error=-ETIMEDOUT;
 assert(bluetooth_sendto(&socket,data,sizeof(data),0,(struct sockaddr*)&address,sizeof(address))==-ETIMEDOUT);
 assert(timed_waits==2&&callback_frees==2&&sem_frees==2&&!locks&&!callback.priv);
 conn.bc_ldev=99;
 assert(bluetooth_sendto(&socket,data,sizeof(data),0,(struct sockaddr*)&address,sizeof(address))==-ENODEV);
 assert(notify_count==2&&timed_waits==2&&!locks);
 puts("BLE真实RAW HCI发送通过：Wi-Fi在前时按真实ifindex路由、拒绝WLAN/空网卡、TX限1000ms且超时回收回调");return 0;
}
'''
        run(out, 'route', source, ['-Wno-unused-parameter'])


if __name__ == '__main__':
    main()
