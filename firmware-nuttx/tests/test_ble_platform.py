#!/usr/bin/env python3
"""编译真实BLE平台函数：双堆释放、受监督启动；不访问硬件。"""
from pathlib import Path
import argparse
import importlib.util
import os
import shlex
import shutil
import subprocess
import tempfile


def function(source, signature):
    start = source.index(signature)
    body = source.index('{', start)
    depth, end = 1, body + 1
    while depth:
        if source[end] == '{':
            depth += 1
        elif source[end] == '}':
            depth -= 1
        end += 1
    return source[start:end]


def run(directory, name, source, flags=()):
    path = directory / (name + '.c')
    path.write_text(source)
    binary = directory / name
    subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), '-std=c11', '-O1', '-g',
                    '-Wall', '-Wextra', '-Werror', '-fsanitize=undefined',
                    '-fno-sanitize-recover=all', *flags, str(path), '-lpthread',
                    '-o', str(binary)], check=True, timeout=60)
    subprocess.run([str(binary)], check=True, timeout=60)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nuttx', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    nuttx = args.nuttx or root.parent / '.deps/nuttx'
    spec = importlib.util.spec_from_file_location('prepare_ble', root / 'tools/prepare_ble.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-platform-') as temporary:
        out = Path(temporary)
        relative = Path('arch/xtensa/src/esp32s3/esp32s3_ble_adapter.c')
        target = out / relative
        target.parent.mkdir(parents=True)
        shutil.copy2(nuttx / relative, target)
        assert module.patch_controller_memory(out)
        assert not module.patch_controller_memory(out)
        adapter = target.read_text()
        assert '  ._free = free_wrapper,' in adapter
        source = r'''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
unsigned char internal[64],normal[64],external[64];
unsigned ordinary_allocs,internal_allocs,ordinary_frees,internal_frees;
bool fail_internal,fail_ordinary,use_external=true;
void *kmm_malloc(size_t size){assert(size==32);ordinary_allocs++;return fail_ordinary?NULL:use_external?external:normal;}
void kmm_free(void *pointer){assert(pointer==normal||pointer==external);ordinary_frees++;}
bool esp32s3_ptr_extram(void *pointer){return pointer==external;}
void *xtensa_imm_malloc(size_t size){assert(size==32);internal_allocs++;return fail_internal?NULL:internal;}
bool xtensa_imm_heapmember(void *pointer){return pointer==internal;}
void xtensa_imm_free(void *pointer){assert(pointer==internal);internal_frees++;}
''' + function(adapter, 'static void *malloc_internal_wrapper(size_t size)\n{') + '\n' + function(adapter, 'static void free_wrapper(void *pointer)\n{') + r'''
int main(void){
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
 assert(malloc_internal_wrapper(32)==internal&&ordinary_allocs==0&&internal_allocs==1);
 free_wrapper(internal);assert(internal_frees==1&&ordinary_frees==0);
 fail_internal=true;assert(!malloc_internal_wrapper(32)&&ordinary_allocs==0);
#else
 assert(!malloc_internal_wrapper(32)&&ordinary_frees==1);
 use_external=false;assert(malloc_internal_wrapper(32)==normal);free_wrapper(normal);
 fail_ordinary=true;assert(!malloc_internal_wrapper(32));
#endif
 unsigned before=ordinary_frees;free_wrapper(external);assert(ordinary_frees==before+1);
 free_wrapper(NULL);assert(ordinary_frees==before+1);
 puts("BLE控制器真实函数通过：内部SRAM分配、OOM不回退PSRAM、双堆正确释放、NULL释放");return 0;
}
'''
        run(out, 'memory_separate', source, ['-DCONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=1'])
        run(out, 'memory_common', source)
        # 所有锚点确认前不能落盘；源码漂移必须保留原文件。
        drift = (nuttx / relative).read_text().replace('  ._free = free,', '  ._free = changed_free,')
        target.write_text(drift)
        try:
            module.patch_controller_memory(out)
        except RuntimeError:
            pass
        else:
            raise AssertionError('内存补丁未拒绝源码漂移')
        assert target.read_text() == drift

        # P14曾有控制器但无RAW HCI路由；编译实际注册函数重现-ENOSYS并验证两条路由。
        driver = (nuttx / 'drivers/wireless/bluetooth/bt_driver.c').read_text()
        source = r'''
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#define FAR
struct bt_driver_s {int value;};
static unsigned netdev_calls,uart_calls;
int bt_netdev_register(struct bt_driver_s *driver){assert(driver);netdev_calls++;return 17;}
int uart_bth4_register(const char *name,struct bt_driver_s *driver){assert(driver&&!strcmp(name,"/dev/ttyHCI0"));uart_calls++;return 19;}
''' + function(driver, 'static int bt_driver_register_internal(') + r'''
int main(void){
 struct bt_driver_s driver={0};int result=bt_driver_register_internal(&driver,"/dev/ttyHCI%d",0);
#if defined(CONFIG_UART_BTH4)
 assert(result==19&&uart_calls==1&&!netdev_calls);
#elif defined(CONFIG_NET_BLUETOOTH)
 assert(result==17&&netdev_calls==1&&!uart_calls);
#else
 assert(result==-ENOSYS&&!netdev_calls&&!uart_calls);
#endif
 puts("BLE真实驱动注册路由通过：无NET_BLUETOOTH复现ENOSYS，RAW HCI进入netdev，UART优先于socket");return 0;
}
'''
        for name, flags in [('missing_hci', []), ('raw_hci', ['-DCONFIG_NET_BLUETOOTH=1']),
                            ('uart_hci', ['-DCONFIG_UART_BTH4=1', '-DCONFIG_NET_BLUETOOTH=1'])]:
            run(out, name, source, ['-Wno-unused-parameter', *flags])

        relative = Path('arch/xtensa/src/esp32s3/esp32s3_ble.c')
        target = out / relative
        shutil.copy2(nuttx / relative, target)
        assert module.patch_controller_lifecycle(out) and not module.patch_controller_lifecycle(out)
        controller = target.read_text()
        source = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <errno.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <syslog.h>
#define OK 0
#define ESP_BT_MODE_BLE 1
#define NET_LL_BLUETOOTH 7
static bool g_px_ble_initialized,g_px_ble_enabled;
static atomic_bool g_px_ble_io_ready;
struct net_driver_s {int d_lltype;unsigned d_ifindex;char d_ifname[8];};
static struct net_driver_s radio={NET_LL_BLUETOOTH,5,"bnep0"};
struct bt_driver_s {void *bt_net;};
static struct {struct bt_driver_s drv;} g_ble_priv;
static int vhci_host_cb,fail_init,fail_enable,fail_callback,fail_driver,fail_disable,fail_deinit;
static int fail_up;
static unsigned inits,enables,callbacks,drivers,disables,deinits,up_calls,down_calls,netlocks;
static char last_log[160];
void fake_syslog(int priority,const char *format,...){assert(priority==LOG_ERR||priority==LOG_INFO);va_list args;va_start(args,format);vsnprintf(last_log,sizeof(last_log),format,args);va_end(args);}
#define syslog fake_syslog
int esp32s3_bt_controller_init(void){assert(!g_px_ble_initialized&&!g_px_ble_enabled);inits++;return fail_init;}
int esp32s3_bt_controller_enable(int mode){assert(mode==ESP_BT_MODE_BLE&&g_px_ble_initialized);enables++;return fail_enable;}
int esp32s3_vhci_register_callback(int *callback){assert(callback==&vhci_host_cb&&g_px_ble_enabled);callbacks++;return fail_callback;}
int bt_driver_register(struct bt_driver_s *driver){assert(driver==&g_ble_priv.drv&&g_px_ble_enabled&&!atomic_load(&g_px_ble_io_ready));drivers++;if(!fail_driver)driver->bt_net=&radio;return fail_driver;}
int esp32s3_bt_controller_disable(void){assert(g_px_ble_enabled&&!atomic_load(&g_px_ble_io_ready));disables++;return fail_disable;}
int esp32s3_bt_controller_deinit(void){assert(g_px_ble_initialized&&!g_px_ble_enabled);deinits++;return fail_deinit;}
void net_lock(void){assert(!netlocks);netlocks++;}
void net_unlock(void){assert(netlocks==1);netlocks--;}
int netdev_ifup(struct net_driver_s *device){assert(device==&radio&&netlocks);up_calls++;return fail_up;}
int netdev_ifdown(struct net_driver_s *device){assert(device==&radio&&netlocks&&!atomic_load(&g_px_ble_io_ready));down_calls++;return 0;}
''' + '\n'.join(function(controller, signature) for signature in [
            'int esp32s3_ble_shutdown(void)', 'int esp32s3_ble_hci_device(void)', 'int esp32s3_ble_initialize(void)']) + r'''
static void reset(void){
 assert(!g_px_ble_initialized&&!g_px_ble_enabled&&!atomic_load(&g_px_ble_io_ready));
 fail_init=fail_enable=fail_callback=fail_driver=fail_disable=fail_deinit=fail_up=0;
 inits=enables=callbacks=drivers=disables=deinits=up_calls=down_calls=0;last_log[0]=0;g_ble_priv.drv.bt_net=NULL;
 radio.d_lltype=NET_LL_BLUETOOTH;radio.d_ifindex=5;
}
int main(void){
 reset();fail_init=-ENOMEM;assert(esp32s3_ble_initialize()==-ENOMEM&&!enables&&!disables&&!deinits);assert(strstr(last_log,"stage=init"));
 reset();fail_enable=-EIO;assert(esp32s3_ble_initialize()==-EIO&&!callbacks&&!disables&&deinits==1);assert(strstr(last_log,"stage=enable"));
 reset();fail_callback=-EINVAL;assert(esp32s3_ble_initialize()==-EINVAL&&!drivers&&disables==1&&deinits==1);assert(strstr(last_log,"stage=vhci-callback"));
 reset();fail_driver=-ENOSYS;assert(esp32s3_ble_initialize()==-ENOSYS&&disables==1&&deinits==1);assert(strstr(last_log,"stage=driver-register"));
 assert(!esp32s3_ble_shutdown()&&disables==1&&deinits==1);
 reset();assert(!esp32s3_ble_initialize()&&atomic_load(&g_px_ble_io_ready)&&!disables&&!deinits);
 assert(esp32s3_ble_hci_device()==4&&up_calls==1&&!netlocks);assert(strstr(last_log,"ifindex=5 hci_dev=4"));
 fail_up=-ENETDOWN;assert(esp32s3_ble_hci_device()==-ENETDOWN&&up_calls==2);fail_up=0;
 radio.d_lltype=1;assert(esp32s3_ble_hci_device()==-ENODEV&&up_calls==2);radio.d_lltype=NET_LL_BLUETOOTH;
 radio.d_ifindex=0;assert(esp32s3_ble_hci_device()==-ENODEV&&up_calls==2);radio.d_ifindex=5;
 assert(!esp32s3_ble_shutdown()&&disables==1&&deinits==1&&!atomic_load(&g_px_ble_io_ready)&&down_calls==1);
 assert(esp32s3_ble_hci_device()==-ENODEV&&up_calls==2);
 reset();fail_driver=-ENOSYS;fail_disable=-EBUSY;assert(esp32s3_ble_initialize()==-ENOSYS&&g_px_ble_enabled&&!deinits);assert(strstr(last_log,"stage=disable"));
 fail_disable=0;assert(!esp32s3_ble_shutdown()&&disables==2&&deinits==1);
 reset();fail_enable=-EIO;fail_deinit=-EBUSY;assert(esp32s3_ble_initialize()==-EIO&&g_px_ble_initialized&&!g_px_ble_enabled);assert(strstr(last_log,"stage=deinit"));
 fail_deinit=0;assert(!esp32s3_ble_shutdown()&&deinits==2);
 puts("BLE真实控制器生命周期通过：分阶段回滚、保留原errno、disable先于deinit、回滚失败保留状态、幂等关闭");return 0;
}
'''
        run(out, 'controller_lifecycle', source)

        backend = (root / 'src/ble_nimble.c').read_text()
        source = r'''
#include <assert.h>
#include <stdbool.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
static pthread_mutex_t boot_lock=PTHREAD_MUTEX_INITIALIZER;
static bool initialized,host_ready,synchronized;
static int boot_error;
''' + function(backend, 'bool px_ble_backend_available(void)\n{') + r'''
int main(void){
 /* 不提供task_create或控制器替身：查询引入硬件依赖会直接编译失败。 */
 for(unsigned i=0;i<100;i++)assert(px_ble_backend_available());
 assert(!initialized&&!host_ready&&!synchronized&&!boot_error);
 initialized=true;assert(!px_ble_backend_available());
 host_ready=true;assert(!px_ble_backend_available());
 synchronized=true;assert(px_ble_backend_available());
 synchronized=false;assert(!px_ble_backend_available());
 synchronized=true;boot_error=-EIO;assert(!px_ble_backend_available());
 host_ready=synchronized=false;assert(!px_ble_backend_available());
 initialized=false;assert(!px_ble_backend_available());
 boot_error=0;assert(px_ble_backend_available());
 puts("BLE能力查询真实函数通过：未启动无副作用、启动中不可用、同步可用、reset和失败不可用");return 0;
}
'''
        run(out, 'availability', source)
        source = r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <syslog.h>
#include <time.h>
#include <sys/socket.h>
static pthread_mutex_t boot_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t boot_condition=PTHREAD_COND_INITIALIZER;
static uint32_t startup_watchdog;
static bool startup_busy,synchronized,host_ready;
static int boot_error,fail_register,fail_begin,fail_controller,fail_socket,fail_bind,fail_hci,fail_end,fail_address,fail_shutdown,fail_interface;
static int hci_device;
static unsigned registered,begun,controller_calls,ended,unregistered,closed,synced,shutdowns;
static uint8_t own_address;
static bool perform_sync;
static char last_log[160];
static struct {void (*reset_cb)(int);void (*sync_cb)(void);} ble_hs_cfg;
void fake_syslog(int priority,const char *format,...){assert(priority==LOG_ERR||priority==LOG_INFO);va_list arguments;va_start(arguments,format);vsnprintf(last_log,sizeof(last_log),format,arguments);va_end(arguments);}
#define syslog fake_syslog
int px_watchdog_register(uint32_t *handle){registered++;*handle=fail_register?0:41;return fail_register;}
int px_watchdog_begin(uint32_t handle){assert(handle==41);begun++;return fail_begin;}
int px_watchdog_end(uint32_t handle){assert(handle==41&&startup_busy);ended++;return fail_end;}
int px_watchdog_unregister(uint32_t handle){assert(handle==41);unregistered++;return 0;}
int esp32s3_ble_initialize(void){assert(startup_watchdog==41&&startup_busy&&begun==1);controller_calls++;return fail_controller;}
int esp32s3_ble_shutdown(void){assert(startup_watchdog==41&&startup_busy);shutdowns++;return fail_shutdown;}
int esp32s3_ble_hci_device(void){assert(controller_calls&&startup_busy);return fail_interface?fail_interface:4;}
void ble_hci_sock_set_device(int device){assert(device==4);}
#define PF_BLUETOOTH 31
#define AF_BLUETOOTH 31
#define BTPROTO_HCI 1
#define HCI_CHANNEL_RAW 0
struct sockaddr_hci {sa_family_t hci_family;unsigned short hci_dev,hci_channel;};
int fake_socket(int domain,int type,int protocol){assert(domain==31&&type==SOCK_RAW&&protocol==1);errno=EIO;return fail_socket?-1:9;}
int fake_bind(int fd,const struct sockaddr *address,socklen_t length){assert(fd==9&&address&&length==sizeof(struct sockaddr_hci)&&((const struct sockaddr_hci *)address)->hci_dev==4);errno=ENODEV;return fail_bind?-1:0;}
int fake_close(int fd){assert(fd==9);closed++;return 0;}
#define socket fake_socket
#define bind fake_bind
#define close fake_close
void nimble_port_init(void){assert(startup_busy);}
void ble_svc_gap_init(void){}
void ble_svc_gatt_init(void){}
void ble_store_ram_init(void){}
int start_hci_thread(void){return fail_hci;}
int ble_hs_util_ensure_addr(int privacy){assert(privacy==0);return fail_address;}
int ble_hs_id_infer_auto(int privacy,uint8_t *address){assert(privacy==0);*address=1;return 0;}
int status(int code){return code?-EIO:0;}
struct ble_npl_event {int unused;};struct ble_npl_eventq {int unused;};
static struct ble_npl_event event;static struct ble_npl_eventq queue;static unsigned dispatched;
#define BLE_NPL_TIME_FOREVER UINT32_MAX
struct ble_npl_eventq *nimble_port_get_dflt_eventq(void){return &queue;}
struct ble_npl_event *ble_npl_eventq_get(struct ble_npl_eventq *target,uint32_t timeout){assert(target==&queue&&timeout==BLE_NPL_TIME_FOREVER);return dispatched++?NULL:&event;}
void ble_npl_event_run(struct ble_npl_event *value){assert(value==&event&&host_ready&&startup_busy);if(perform_sync){ble_hs_cfg.sync_cb();assert((startup_watchdog!=0)==(fail_address!=0));assert(synchronized==(!fail_address&&!fail_end));synced++;}}
''' + '\n'.join(function(backend, signature) for signature in [
            'static int start_startup_watchdog(void)', 'static int finish_startup_watchdog(void)',
            'static void on_reset(int reason)',
            'static void on_sync(void)', 'static int run_host(void)', 'static int host_task(int argc,char **argv)']) + r'''
static void reset(void){
 assert(!startup_watchdog&&!startup_busy);synchronized=host_ready=false;boot_error=0;
 fail_register=fail_begin=fail_controller=fail_socket=fail_bind=fail_hci=fail_end=fail_address=fail_shutdown=fail_interface=0;
 registered=begun=controller_calls=ended=unregistered=closed=synced=shutdowns=dispatched=0;perform_sync=false;
}
int main(void){
 reset();fail_register=-EAGAIN;assert(host_task(0,NULL)==1&&boot_error==-EAGAIN&&!controller_calls&&!ended&&!unregistered);assert(strstr(last_log,"stage=watchdog-supervision"));
 reset();fail_begin=-EBUSY;host_task(0,NULL);assert(boot_error==-EBUSY&&!controller_calls&&!ended&&unregistered==1);assert(strstr(last_log,"stage=watchdog-supervision"));
 reset();fail_controller=-ENOMEM;host_task(0,NULL);assert(boot_error==-ENOMEM&&ended==1&&unregistered==1&&!closed);assert(strstr(last_log,"stage=controller"));
 reset();fail_controller=-ENOSYS;host_task(0,NULL);assert(boot_error==-ENOSYS&&ended==1&&unregistered==1&&!closed);assert(strstr(last_log,"stage=controller"));
 reset();fail_interface=-ENODEV;host_task(0,NULL);assert(boot_error==-ENODEV&&ended==1&&unregistered==1&&shutdowns==1&&!closed);assert(strstr(last_log,"stage=hci-interface"));
 reset();fail_socket=1;host_task(0,NULL);assert(boot_error==-EIO&&ended==1&&unregistered==1);assert(strstr(last_log,"stage=hci-socket"));
 reset();fail_bind=1;host_task(0,NULL);assert(boot_error==-ENODEV&&closed==1&&ended==1&&unregistered==1);assert(strstr(last_log,"stage=hci-bind"));
 reset();fail_hci=-EAGAIN;host_task(0,NULL);assert(boot_error==-EAGAIN&&ended==1&&unregistered==1);assert(strstr(last_log,"stage=hci-thread"));
 reset();host_task(0,NULL);assert(!synchronized&&ended==1&&unregistered==1);
 reset();perform_sync=true;host_task(0,NULL);assert(!synchronized&&!host_ready&&boot_error==-EIO&&synced==1&&ended==2&&unregistered==2&&shutdowns==1);synchronized=true;on_reset(1);assert(!synchronized&&startup_watchdog==41&&startup_busy);assert(!finish_startup_watchdog());
 reset();perform_sync=true;fail_address=1;host_task(0,NULL);assert(!synchronized&&ended==1&&unregistered==1);
 reset();perform_sync=true;fail_end=-ETIMEDOUT;host_task(0,NULL);assert(!synchronized&&ended==2&&unregistered==2);
 reset();fail_socket=1;fail_shutdown=-EBUSY;host_task(0,NULL);assert(boot_error==-EIO&&shutdowns==1&&startup_busy&&startup_watchdog==41&&!ended&&!unregistered);startup_busy=false;startup_watchdog=0;
 /* 首次同步完成后，reset必须重新建立监督票据；连续reset沿用原busy期限。 */
 reset();assert(!start_startup_watchdog()&&startup_watchdog==41&&startup_busy&&registered==1&&begun==1);
 on_sync();assert(synchronized&&boot_error==0&&!startup_watchdog&&!startup_busy&&ended==1&&unregistered==1);
 unsigned registered_after_sync=registered,begun_after_sync=begun;
 on_reset(1);assert(!synchronized&&boot_error==0&&startup_watchdog==41&&startup_busy&&registered==registered_after_sync+1&&begun==begun_after_sync+1);
 registered_after_sync=registered;begun_after_sync=begun;on_reset(2);
 assert(!synchronized&&boot_error==0&&startup_watchdog==41&&startup_busy&&registered==registered_after_sync&&begun==begun_after_sync);
 on_sync();assert(synchronized&&boot_error==0&&!startup_watchdog&&!startup_busy&&ended==2&&unregistered==2);
 /* reset阶段register失败必须阻止ready，且不会伪造begin。 */
 reset();fail_register=-EAGAIN;on_reset(3);
 assert(!synchronized&&boot_error==-EAGAIN&&!startup_watchdog&&!startup_busy&&registered==1&&begun==0&&ended==0&&unregistered==0);
 /* begin失败保留注册票据但不标记busy；统一清理负责释放它。 */
 reset();fail_begin=-EBUSY;on_reset(4);
 assert(!synchronized&&boot_error==-EBUSY&&startup_watchdog==41&&!startup_busy&&registered==1&&begun==1&&ended==0&&unregistered==0);
 assert(!finish_startup_watchdog()&&!startup_watchdog&&!startup_busy&&unregistered==1);
 /* 启动阶段已有busy票据时，reset不得重复register或刷新begin期限。 */
 reset();assert(!start_startup_watchdog()&&startup_watchdog==41&&startup_busy);
 registered_after_sync=registered;begun_after_sync=begun;on_reset(5);
 assert(!synchronized&&boot_error==0&&startup_watchdog==41&&startup_busy&&registered==registered_after_sync&&begun==begun_after_sync);
 assert(!finish_startup_watchdog()&&!startup_watchdog&&!startup_busy);
 puts("BLE受监督启动真实函数通过：先注册/开始再初始化、到同步前持续busy、启动失败回收、超时不报告可用");return 0;
}
'''
        run(out, 'startup', source)
        print('BLE平台回归全部通过；硬件控制器/射频为显式替身，未访问设备')


if __name__ == '__main__':
    main()
