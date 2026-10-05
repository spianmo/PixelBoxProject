#!/usr/bin/env python3
"""临时副本验证BLE补丁幂等性，并编译实际NuttX发送函数做OOM/UAF/背压故障注入。"""
from pathlib import Path
import argparse
import importlib.util
import os
import shlex
import shutil
import subprocess
import tempfile

def function(text,name,occurrence=0):
    start=-1
    for _ in range(occurrence+1):start=text.index('static int\n'+name+'(',start+1)
    body=text.index('{',start);depth=1;end=body+1
    while depth:
        if text[end]=='{':depth+=1
        elif text[end]=='}':depth-=1
        end+=1
    return text[start:end]

def public_function(text, name):
    start=text.index('ble_npl_error_t\n'+name+'(');body=text.index('{',start);depth=1;end=body+1
    while depth:
        if text[end]=='{':depth+=1
        elif text[end]=='}':depth-=1
        end+=1
    return text[start:end]

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('nimble',type=Path);parser.add_argument('--nuttx',type=Path);args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];nuttx=args.nuttx or root.parent/'.deps/nuttx'
    spec=importlib.util.spec_from_file_location('prepare_ble',root/'tools/prepare_ble.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-patches-') as temporary:
        out=Path(temporary)
        platform_files=['arch/xtensa/src/esp32s3/esp32s3_ble.c','arch/xtensa/src/esp32s3/esp32s3_ble_adapter.c','boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c','net/bluetooth/bluetooth_sendmsg.c']
        for relative,source in [('nimble/transport/socket/src/ble_hci_socket.c',args.nimble),*[(name,nuttx) for name in platform_files]]:
            target=out/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/relative,target)
        assert module.patch_nimble(out) and not module.patch_nimble(out)
        assert module.patch_controller(out) and not module.patch_controller(out)
        assert module.patch_controller_lifecycle(out) and not module.patch_controller_lifecycle(out)
        assert module.patch_hci_network(out) and not module.patch_hci_network(out)
        assert module.patch_controller_memory(out) and not module.patch_controller_memory(out)
        assert module.patch_bringup(out) and not module.patch_bringup(out)
        bringup=(out/platform_files[2]).read_text()
        assert 'ret = esp32s3_ble_initialize();' not in bringup
        assert 'ret = board_wlan_init();' in bringup and 'ret = esp_wifi_bt_coexist_init();' in bringup
        npl='porting/npl/nuttx';shutil.copytree(args.nimble/npl,out/npl)
        assert module.patch_npl(out) and not module.patch_npl(out)
        assert (out/npl/'src/os_eventq.c').read_bytes()==(root/'port/ble_npl_eventq.c').read_bytes()
        assert (out/npl/'src/os_callout.c').read_bytes()==(root/'port/ble_npl_callout.c').read_bytes()
        drift=out/'drift';shutil.copytree(args.nimble/npl,drift/npl)
        sem=drift/npl/'src/os_sem.c';sem.write_text(sem.read_text().replace('        err = sem_wait(&sem->lock);','        source_has_drifted();'))
        before={path.relative_to(drift):path.read_bytes() for path in drift.rglob('*') if path.is_file()}
        try:module.patch_npl(drift)
        except RuntimeError:pass
        else:raise AssertionError('NPL源码漂移没有阻止写入')
        assert before=={path.relative_to(drift):path.read_bytes() for path in drift.rglob('*') if path.is_file()}
        patched=(out/'nimble/transport/socket/src/ble_hci_socket.c').read_text();controller=(out/'arch/xtensa/src/esp32s3/esp32s3_ble.c').read_text()
        # 使用真实修补后的函数体，不写另一个模拟发送实现代替被测逻辑。
        source=r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>
struct sockaddr_hci {sa_family_t hci_family;unsigned short hci_dev,hci_channel;};
struct os_mbuf {struct os_mbuf *next;unsigned om_len;uint8_t *om_data;unsigned total;bool freed;};
static bool allocation_fail;static unsigned mbuf_frees,transport_frees,send_calls,busy_count;static bool always_busy;
static uint8_t sent[1024];static size_t sent_size;
static void *test_malloc(size_t size){return allocation_fail?NULL:malloc(size);}
static void os_mbuf_free_chain(struct os_mbuf *m){assert(!m->freed);m->freed=true;mbuf_frees++;}
static unsigned packet_length(struct os_mbuf *m){assert(!m->freed);return m->total;}
static void ble_transport_free(void *p){assert(p);transport_frees++;}
static int test_sendto(int fd,const void *data,size_t size,int flags,const struct sockaddr *address,socklen_t address_size)
{(void)fd;(void)flags;assert(address_size==sizeof(struct sockaddr_hci)&&((const struct sockaddr_hci*)address)->hci_dev==4);send_calls++;if(always_busy||busy_count){if(busy_count)busy_count--;errno=EAGAIN;return -1;}assert(size<sizeof(sent));memcpy(sent,data,size);sent_size=size;return (int)size;}
#define malloc test_malloc
#define sendto test_sendto
#define SLIST_NEXT(m,field) ((m)->next)
#define OS_MBUF_PKTLEN(m) packet_length(m)
#define STATS_INC(a,b) ((void)0)
#define STATS_INCN(a,b,c) ((void)(c))
#define BLE_ERR_MEM_CAPACITY 7
#define BLE_HCI_UART_H4_ACL 2
#define BLE_HCI_UART_H4_CMD 1
#define BLE_HCI_UART_H4_EVT 4
#define HCI_CHANNEL_RAW 0
#ifndef AF_BLUETOOTH
#define AF_BLUETOOTH 31
#endif
struct ble_hci_cmd {uint8_t opcode[2],length;};
struct ble_hci_ev {uint8_t event,length;};
static struct {int sock;} ble_hci_sock_state={.sock=9};
static int s_ble_hci_device=4;
'''+module.SEND_RETRY+'\n'+function(patched,'ble_hci_sock_acl_tx',1)+'\n'+function(patched,'ble_hci_sock_cmdevt_tx',1)+r'''
#undef malloc
#undef sendto
static bool controller_ready;static unsigned controller_sends;
static atomic_bool g_px_ble_io_ready=true;
struct bt_driver_s {unsigned head_reserve;};
enum bt_buf_type_e {BT_CMD,BT_ACL_OUT,BT_ISO_OUT,BT_EVT,BT_ACL_IN,BT_ISO_IN};
#define H4_HEADER_SIZE 1
#define BLE_BUF_SIZE 1024
#define H4_CMD 1
#define H4_ACL 2
#define H4_EVT 4
#define H4_ISO 5
#define ERROR -1
#define wlerr(...) ((void)0)
static unsigned received;
static struct esp32s3_ble_priv_s {struct bt_driver_s drv;} g_ble_priv;
static int bt_netdev_receive(struct bt_driver_s *driver,enum bt_buf_type_e type,void *data,size_t length){assert(driver==&g_ble_priv.drv&&type==BT_EVT&&data&&length==2&&atomic_load(&g_px_ble_io_ready));received++;return 0;}
static bool esp32s3_vhci_host_check_send_available(void){return controller_ready;}
static void esp32s3_vhci_host_send_packet(void *data,size_t length){assert(data&&length);controller_sends++;}
'''
        start=controller.index('static int esp32s3_ble_send(struct bt_driver_s *drv,',controller.index('static int esp32s3_ble_send(struct bt_driver_s *drv,')+1)
        body=controller.index('{',start);depth=1;end=body+1
        while depth:
            if controller[end]=='{':depth+=1
            elif controller[end]=='}':depth-=1
            end+=1
        source+=controller[start:end]+'\n'
        start=controller.index('static int esp32s3_ble_recv_cb(uint8_t *data, uint16_t len)\n{')
        body=controller.index('{',start);depth=1;end=body+1
        while depth:
            if controller[end]=='{':depth+=1
            elif controller[end]=='}':depth-=1
            end+=1
        source+=controller[start:end]+r'''
int main(void){
 uint8_t bytes[]={1,2,3},tail[]={4,5};struct os_mbuf second={.om_len=2,.om_data=tail,.total=2},first={.next=&second,.om_len=3,.om_data=bytes,.total=5};
 busy_count=2;assert(!ble_hci_sock_acl_tx(&first));assert(mbuf_frees==1&&send_calls==3&&sent_size==6&&sent[0]==2&&!memcmp(sent+1,bytes,3)&&!memcmp(sent+4,tail,2));
 first.freed=false;allocation_fail=true;assert(ble_hci_sock_acl_tx(&first)==BLE_ERR_MEM_CAPACITY&&mbuf_frees==2);allocation_fail=false;
 uint8_t command[]={3,4,2,5,6};busy_count=2;assert(!ble_hci_sock_cmdevt_tx(command,1));assert(transport_frees==1&&sent_size==6&&sent[0]==1&&!memcmp(sent+1,command,5));
 allocation_fail=true;assert(ble_hci_sock_cmdevt_tx(command,1)==BLE_ERR_MEM_CAPACITY&&transport_frees==2);allocation_fail=false;
 always_busy=true;struct timespec start,end;clock_gettime(CLOCK_MONOTONIC,&start);assert(ble_hci_sock_cmdevt_tx(command,1)==BLE_ERR_MEM_CAPACITY&&transport_frees==3);clock_gettime(CLOCK_MONOTONIC,&end);double elapsed=end.tv_sec-start.tv_sec+(end.tv_nsec-start.tv_nsec)/1e9;assert(elapsed>=0.99&&elapsed<1.5);always_busy=false;
 struct bt_driver_s driver={.head_reserve=1};uint8_t packet[8]={0};assert(esp32s3_ble_send(&driver,BT_CMD,packet+1,3)==-EAGAIN&&controller_sends==0);controller_ready=true;assert(esp32s3_ble_send(&driver,BT_CMD,packet+1,3)==3&&controller_sends==1&&packet[0]==1);
 atomic_store(&g_px_ble_io_ready,false);assert(esp32s3_ble_send(&driver,BT_CMD,packet+1,3)==-ENODEV&&controller_sends==1);
 uint8_t rx[]={H4_EVT,1,0};assert(esp32s3_ble_recv_cb(rx,sizeof(rx))==-ENODEV&&!received);
 assert(esp32s3_ble_recv_cb(NULL,0)==-EINVAL&&!received);atomic_store(&g_px_ble_io_ready,true);
 assert(!esp32s3_ble_recv_cb(rx,sizeof(rx))&&received==1);
 puts("BLE HCI补丁通过：固定源锚点/幂等、真实函数OOM和释放后访问检查、busy重试/1s上限、控制器不假报成功");return 0;
}
'''
        test=out/'test.c';test.write_text(source);binary=out/'test'
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),'-std=c11','-O1','-g','-Wall','-Wextra','-Wno-sign-compare','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all',str(test),'-o',str(binary)],check=True,timeout=60)
        subprocess.run([str(binary)],check=True,timeout=60)
        # 用实际修补后的sem/mutex函数验证纳秒进位、EINTR重试和独立deadline。
        source=r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdbool.h>
#include <errno.h>
#include <stdint.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdio.h>
#include <time.h>
typedef int ble_npl_error_t;
#define BLE_NPL_TIME_FOREVER UINT32_MAX
#define BLE_NPL_OK 0
#define BLE_NPL_ERROR 12
#define BLE_NPL_INVALID_PARAM 2
#define BLE_NPL_TIMEOUT 6
struct ble_npl_mutex {pthread_mutex_t lock;struct timespec wait;};
struct ble_npl_sem {sem_t lock;};
static struct timespec captured,mono={42,990000000};static unsigned interrupted,calls,sleeps,busy_count;static int wait_error;
static bool always_busy;
static int fake_clock(clockid_t clock,struct timespec *value){assert(clock==CLOCK_MONOTONIC);*value=mono;return 0;}
static int fake_sem_wait(sem_t *sem){(void)sem;calls++;if(interrupted){interrupted--;errno=EINTR;return -1;}if(wait_error){errno=wait_error;return -1;}return 0;}
static int fake_sem_clockwait(sem_t *sem,clockid_t clock,const struct timespec *deadline){assert(clock==CLOCK_MONOTONIC);captured=*deadline;return fake_sem_wait(sem);}
static int fake_mutex_lock(pthread_mutex_t *mutex){(void)mutex;calls++;return wait_error;}
static int fake_mutex_trylock(pthread_mutex_t *mutex){if(always_busy||busy_count){if(busy_count)busy_count--;calls++;return EBUSY;}return fake_mutex_lock(mutex);}
static int fake_nanosleep(const struct timespec *delay,struct timespec *remaining){(void)remaining;assert(delay->tv_sec==0&&delay->tv_nsec==1000000);sleeps++;mono.tv_nsec+=delay->tv_nsec;if(mono.tv_nsec>=1000000000){mono.tv_nsec-=1000000000;mono.tv_sec++;}return 0;}
#define clock_gettime fake_clock
#define sem_wait fake_sem_wait
#define sem_clockwait fake_sem_clockwait
#define pthread_mutex_lock fake_mutex_lock
#define pthread_mutex_trylock fake_mutex_trylock
#define nanosleep fake_nanosleep
'''+public_function((out/npl/'src/os_sem.c').read_text(),'ble_npl_sem_pend')+'\n'+public_function((out/npl/'src/os_mutex.c').read_text(),'ble_npl_mutex_pend')+r'''
int main(void){
 struct ble_npl_sem sem={0};struct ble_npl_mutex mutex={0};interrupted=2;
 assert(!ble_npl_sem_pend(&sem,500)&&calls==3&&captured.tv_sec==43&&captured.tv_nsec==490000000);
 calls=0;interrupted=2;assert(!ble_npl_sem_pend(&sem,BLE_NPL_TIME_FOREVER)&&calls==3);
 wait_error=ETIMEDOUT;assert(ble_npl_sem_pend(&sem,1)==BLE_NPL_TIMEOUT&&captured.tv_nsec==991000000);
 wait_error=0;always_busy=true;assert(ble_npl_mutex_pend(&mutex,1500)==BLE_NPL_TIMEOUT&&mono.tv_sec==44&&mono.tv_nsec==490000000&&sleeps==1500);
 assert(ble_npl_mutex_pend(&mutex,0)==BLE_NPL_TIMEOUT&&sleeps==1500);always_busy=false;
 busy_count=2;assert(!ble_npl_mutex_pend(&mutex,10)&&sleeps==1502);
 assert(!ble_npl_mutex_pend(&mutex,BLE_NPL_TIME_FOREVER));assert(!ble_npl_mutex_pend(&mutex,0));
 assert(mutex.wait.tv_sec==0&&mutex.wait.tv_nsec==0);
 wait_error=EIO;assert(ble_npl_mutex_pend(&mutex,10)==BLE_NPL_ERROR);
 assert(ble_npl_mutex_pend(NULL,1)==BLE_NPL_INVALID_PARAM&&ble_npl_sem_pend(NULL,1)==BLE_NPL_INVALID_PARAM);
 puts("BLE NPL补丁通过：固定锚点/幂等/漂移时零写入、单调sem EINTR重试、mutex实际1ms让出/1500ms边界/零超时/忙后成功/独立deadline");return 0;
}
'''
        test.write_text(source)
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),'-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all',str(test),'-o',str(binary)],check=True,timeout=60)
        subprocess.run([str(binary)],check=True,timeout=60)
        project=out/'project';kernel=project/'build/test/nuttx';apps=project/'build/test/apps';wrapper=apps/'wireless/bluetooth/nimble'
        wrapper.mkdir(parents=True);(wrapper/'Makefile.nimble').write_text('# test wrapper\n')
        for relative in platform_files:
            target=kernel/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(nuttx/relative,target)
        archive=project/'third_party'/('mynewt-nimble-'+module.NIMBLE_REF+'.tar.gz');archive.parent.mkdir();shutil.copy2(root/'third_party'/archive.name,archive)
        first=module.prepare(project,kernel,apps);assert first==module.prepare(project,kernel,apps)
        nimble=wrapper/'mynewt-nimble';assert nimble.stat().st_mtime_ns>=(wrapper/(module.NIMBLE_REF+'.tar.gz')).stat().st_mtime_ns
        assert (nimble/npl/'src/os_eventq.c').read_bytes()==(root/'port/ble_npl_eventq.c').read_bytes()
        assert module.MARKER in (nimble/'nimble/transport/socket/src/ble_hci_socket.c').read_text()
        assert 'PIXELBOX_BLE_CONTROLLER_BACKPRESSURE_V1' in (kernel/platform_files[0]).read_text()
        assert 'PIXELBOX_BLE_INTERNAL_HEAP_V1' in (kernel/platform_files[1]).read_text()
        assert 'PIXELBOX_BLE_DEFERRED_INIT_V1' in (kernel/platform_files[2]).read_text()
        for invalid in [out/'outside',project/'.deps/nuttx']:
            try:module.prepare(project,invalid,apps)
            except ValueError:pass
            else:raise AssertionError('configure hook写入私有树外部')
        archive.write_bytes(b'corrupt')
        try:module.prepare(project,kernel,apps)
        except ValueError:pass
        else:raise AssertionError('configure hook接受损坏归档')
        print('BLE离线configure hook通过：固定SHA256、完整解包/HCI/NPL/内部堆/延迟初始化、重复调用、越界拒绝、损坏归档拒绝')
if __name__=='__main__':main()
