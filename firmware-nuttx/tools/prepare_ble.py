"""离线预置固定NimBLE并修复HCI/NPL；由configure在工程私有build树调用。"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile

NIMBLE_REF = 'fb15c844542e812ceb49ab5ac8502dc93c167b90'
NIMBLE_SHA256 = '7be7b5205d345372460838808199d39e73703dbe082336e752607dce2c48f8bd'
MARKER = 'PIXELBOX_NIMBLE_TRANSPORT_V1'

def replace_exact(text: str, before: str, after: str, count: int = 1) -> str:
    actual = text.count(before)
    if actual != count:
        raise RuntimeError(f'BLE patch source drift: expected {count}, got {actual}: {before[:100]!r}')
    return text.replace(before, after)

SEND_RETRY = r'''
/* PIXELBOX_NIMBLE_TRANSPORT_V1: release net_lock between controller busy retries. */
static int px_hci_send_retry(int fd, const void *data, size_t length,
                             const struct sockaddr *address, socklen_t address_length)
{
    struct timespec begin, now;
    if (clock_gettime(CLOCK_MONOTONIC, &begin)) return -1;
    for (;;) {
        int result = sendto(fd, data, length, 0, address, address_length);
        if (result >= 0 || (errno != EAGAIN && errno != EINTR)) return result;
        if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
        int64_t elapsed = (int64_t)(now.tv_sec - begin.tv_sec) * 1000 +
                          (now.tv_nsec - begin.tv_nsec) / 1000000;
        if (elapsed >= 1000) { errno = ETIMEDOUT; return -1; }
        struct timespec pause = {0, 1000000};
        nanosleep(&pause, NULL);
    }
}
'''

def patch_nimble(nimble_root: Path) -> bool:
    path = Path(nimble_root) / 'nimble/transport/socket/src/ble_hci_socket.c'
    text = path.read_text()
    if MARKER in text:
        return False
    # 不修改共享依赖时可先对临时副本调用；全部锚点通过后才一次写入。
    text = replace_exact(text, '#include <netpacket/bluetooth.h>',
        '#include <time.h>\n#include <nuttx/wireless/bluetooth/bt_hci.h>\n#undef BT_ADDR_ANY\n#include <netpacket/bluetooth.h>\n'+SEND_RETRY)
    text = replace_exact(text, '    memcpy(&addr, &addr, sizeof(struct sockaddr_hci));\n', '', 2)
    # NuttX的hci_dev是全局网卡ifindex减一；Wi-Fi先注册时不能继续写死0。
    text = replace_exact(text, '    addr.hci_dev = 0;', '    addr.hci_dev = s_ble_hci_device;', 2)
    text = replace_exact(text, '    shci.hci_dev = 0;', '    shci.hci_dev = s_ble_hci_device;')
    text = replace_exact(text, '    buf = (uint8_t *)malloc(len);\n',
        '    buf = (uint8_t *)malloc(len);\n    if (!buf) { os_mbuf_free_chain(om); return BLE_ERR_MEM_CAPACITY; }\n')
    text = replace_exact(text, '    buf = (uint8_t *)malloc(len + 1);\n',
        '    buf = (uint8_t *)malloc(len + 1);\n    if (!buf) { ble_transport_free(hci_ev); return BLE_ERR_MEM_CAPACITY; }\n')
    text = replace_exact(text, '    i = sendto(ble_hci_sock_state.sock, buf, len, 0,',
        '    i = px_hci_send_retry(ble_hci_sock_state.sock, buf, len,')
    text = replace_exact(text, '    i = sendto(ble_hci_sock_state.sock, buf, len + 1, 0,',
        '    i = px_hci_send_retry(ble_hci_sock_state.sock, buf, len + 1,')
    # 两个分支均有释放后读取；NuttX已有len，Linux/TCP先保存expected。
    text = replace_exact(text, '    i = sendmsg(ble_hci_sock_state.sock, &msg, 0);\n    os_mbuf_free_chain(om);\n    if (i != OS_MBUF_PKTLEN(om) + 1) {',
        '    size_t expected = OS_MBUF_PKTLEN(om) + 1;\n    i = sendmsg(ble_hci_sock_state.sock, &msg, 0);\n    os_mbuf_free_chain(om);\n    if (i != (int)expected) {')
    text = replace_exact(text, '    os_mbuf_free_chain(om);\n    if (i != OS_MBUF_PKTLEN(om) + 1) {',
        '    os_mbuf_free_chain(om);\n    if (i != (int)len) {')
    # H4类型字节也占空间，访问长度字段前必须检查完整头；损坏帧不能卡满RX缓冲。
    for header, count in [('sizeof(struct ble_hci_cmd)', 1), ('sizeof(struct ble_hci_ev)', 1), ('BLE_HCI_DATA_HDR_SZ', 2)]:
        text = replace_exact(text, f'if (bhss->rx_off < {header})', f'if (bhss->rx_off < 1 + {header})', count)
    text = replace_exact(text, '            if (bhss->rx_off < len) {',
        '            if (len > (int)sizeof(bhss->rx_data)) { bhss->rx_off = 0; return -1; }\n            if (bhss->rx_off < len) {', 4)
    text = replace_exact(text, '            data = ble_transport_alloc_evt(0);',
        '            if (len - 1 > MYNEWT_VAL(BLE_TRANSPORT_EVT_SIZE)) { STATS_INC(hci_sock_stats, ierr); break; }\n            data = ble_transport_alloc_evt(0);')
    text = replace_exact(text, '        default:\n            STATS_INC(hci_sock_stats, ierr);\n            break;',
        '        default:\n            STATS_INC(hci_sock_stats, ierr);\n            bhss->rx_off = 0;\n            return -1;')
    path.write_text(text)
    return True

def patch_controller(nuttx_root: Path) -> bool:
    path = Path(nuttx_root) / 'arch/xtensa/src/esp32s3/esp32s3_ble.c'
    text = path.read_text()
    marker = 'PIXELBOX_BLE_CONTROLLER_BACKPRESSURE_V1'
    if marker in text:
        return False
    text = replace_exact(text, '  switch (data[0])',
        '  if (data == NULL || len < H4_HEADER_SIZE)\n    {\n      return -EINVAL;\n    }\n\n  switch (data[0])')
    needle = '''  if (esp32s3_vhci_host_check_send_available())
    {
      esp32s3_vhci_host_send_packet(hdr, len + drv->head_reserve);
    }
'''
    replacement = '''  /* PIXELBOX_BLE_CONTROLLER_BACKPRESSURE_V1: never acknowledge a dropped packet.
   * The socket transport retries after sendto releases the network lock.
   */
  if (!esp32s3_vhci_host_check_send_available())
    {
      return -EAGAIN;
    }

  esp32s3_vhci_host_send_packet(hdr, len + drv->head_reserve);
'''
    text = replace_exact(text, needle, replacement)
    path.write_text(text)
    return True


def patch_controller_lifecycle(nuttx_root: Path) -> bool:
    """失败必须关闭已启动控制器；RAW网络上下文保留到重启，避免在途回调悬空。"""
    path = Path(nuttx_root) / 'arch/xtensa/src/esp32s3/esp32s3_ble.c'
    text = path.read_text()
    marker = 'PIXELBOX_BLE_CONTROLLER_LIFECYCLE_V2'
    if marker in text:
        return False
    text = replace_exact(text, '#include <stdbool.h>',
        '#include <stdbool.h>\n#include <stdatomic.h>\n#include <syslog.h>')
    text = replace_exact(text, '#include <nuttx/net/bluetooth.h>',
        '#include <nuttx/net/bluetooth.h>\n#include <nuttx/net/netdev.h>')
    text = replace_exact(text, 'static struct esp32s3_ble_priv_s g_ble_priv =',
        '/* PIXELBOX_BLE_CONTROLLER_LIFECYCLE_V2: 初始化状态由唯一host任务管理。 */\n'
        'static bool g_px_ble_initialized;\nstatic bool g_px_ble_enabled;\n'
        'static atomic_bool g_px_ble_io_ready;\n\nstatic struct esp32s3_ble_priv_s g_ble_priv =')
    text = replace_exact(text, '  switch (data[0])',
        '  if (!atomic_load(&g_px_ble_io_ready))\n    {\n      return -ENODEV;\n    }\n\n  switch (data[0])')
    text = replace_exact(text, '  uint8_t *hdr = (uint8_t *)data - drv->head_reserve;',
        '  if (!atomic_load(&g_px_ble_io_ready))\n    {\n      return -ENODEV;\n    }\n\n'
        '  uint8_t *hdr = (uint8_t *)data - drv->head_reserve;')
    original = '''int esp32s3_ble_initialize(void)
{
  int ret;

  ret = esp32s3_bt_controller_init();
  if (ret)
    {
      wlerr("Failed to initialize BLE ret=%d\\n", ret);
      return ERROR;
    }

  ret = esp32s3_bt_controller_enable(ESP_BT_MODE_BLE);
  if (ret)
    {
      wlerr("Failed to Enable BLE ret=%d\\n", ret);
      return ERROR;
    }

  ret = esp32s3_vhci_register_callback(&vhci_host_cb);
  if (ret)
    {
      wlerr("Failed to register BLE callback ret=%d\\n", ret);
      return ERROR;
    }

  ret = bt_driver_register(&g_ble_priv.drv);
  if (ret < 0)
    {
      wlerr("bt_driver_register error: %d\\n", ret);
      return ret;
    }

  return OK;
}'''
    replacement = '''/* 禁止新I/O后先关闭射频，再释放控制器内部资源。RAW netdev不在此释放：
 * 上游RAW deinitialize未同步排空rx work，失败后本次开机不重新初始化。
 * 调用方必须在清理完成前保持watchdog票据，以覆盖controller disable等待。
 */
int esp32s3_ble_shutdown(void)
{
  int ret;
  atomic_store(&g_px_ble_io_ready, false);
  /* 保留网络对象，但关闭carrier并唤醒仍在等待的socket。 */
  if (g_ble_priv.drv.bt_net != NULL)
    {
      net_lock();
      (void)netdev_ifdown((struct net_driver_s *)g_ble_priv.drv.bt_net);
      net_unlock();
    }
  if (g_px_ble_enabled)
    {
      ret = esp32s3_bt_controller_disable();
      if (ret)
        {
          syslog(LOG_ERR, "pixelbox BLE rollback failed: stage=disable error=%d\\n", ret);
          return ret;
        }
      g_px_ble_enabled = false;
    }
  if (g_px_ble_initialized)
    {
      ret = esp32s3_bt_controller_deinit();
      if (ret)
        {
          syslog(LOG_ERR, "pixelbox BLE rollback failed: stage=deinit error=%d\\n", ret);
          return ret;
        }
      g_px_ble_initialized = false;
    }
  return OK;
}

int esp32s3_ble_hci_device(void)
{
  /* btnet_driver_s以radio_driver_s/net_driver_s开头；直接取本控制器的真实网卡。 */
  struct net_driver_s *netdev = (struct net_driver_s *)g_ble_priv.drv.bt_net;
  if (!atomic_load(&g_px_ble_io_ready) || netdev == NULL ||
      netdev->d_lltype != NET_LL_BLUETOOTH || netdev->d_ifindex == 0)
    {
      return -ENODEV;
    }
  net_lock();
  int ret = netdev_ifup(netdev);
  net_unlock();
  if (ret < 0)
    {
      return ret;
    }
  int device = netdev->d_ifindex - 1;
  syslog(LOG_INFO, "pixelbox BLE HCI route: netdev=%s ifindex=%u hci_dev=%d\\n",
         netdev->d_ifname, netdev->d_ifindex, device);
  return device;
}

int esp32s3_ble_initialize(void)
{
  int ret;
  const char *stage = "init";
  ret = esp32s3_bt_controller_init();
  if (ret)
    {
      goto failed;
    }
  g_px_ble_initialized = true;

  stage = "enable";
  ret = esp32s3_bt_controller_enable(ESP_BT_MODE_BLE);
  if (ret)
    {
      goto failed;
    }
  g_px_ble_enabled = true;

  stage = "vhci-callback";
  ret = esp32s3_vhci_register_callback(&vhci_host_cb);
  if (ret)
    {
      goto failed;
    }

  stage = "driver-register";
  ret = bt_driver_register(&g_ble_priv.drv);
  if (ret < 0)
    {
      goto failed;
    }
  atomic_store(&g_px_ble_io_ready, true);
  return OK;

failed:
  syslog(LOG_ERR, "pixelbox BLE controller failed: stage=%s error=%d\\n", stage, ret);
  (void)esp32s3_ble_shutdown();
  return ret;
}'''
    text = replace_exact(text, original, replacement)
    path.write_text(text)
    return True


def patch_hci_network(nuttx_root: Path) -> bool:
    """RAW HCI只能使用蓝牙网卡，单次TX调度等待必须有上限。"""
    path = Path(nuttx_root) / 'net/bluetooth/bluetooth_sendmsg.c'
    text = path.read_text()
    marker = 'PIXELBOX_HCI_NETWORK_V1'
    if marker in text:
        return False
    text = replace_exact(text, '''      DEBUGASSERT(radio->r_dev.d_lltype == NET_LL_BLUETOOTH);

      if (radio == NULL)''', '''      /* PIXELBOX_HCI_NETWORK_V1: 错误索引不能把WLAN当作radio驱动解引用。 */
      if (radio == NULL || radio->r_dev.d_lltype != NET_LL_BLUETOOTH)''')
    text = replace_exact(text, '          ret = net_sem_wait(&state.is_sem);',
        '          /* HCI轮询未完成时1秒退出，并在网络锁下撤销回调。 */\n'
        '          ret = psock->s_proto == BTPROTO_HCI ?\n'
        '            net_sem_timedwait(&state.is_sem, 1000) : net_sem_wait(&state.is_sem);')
    path.write_text(text)
    return True


def patch_controller_memory(nuttx_root: Path) -> bool:
    """控制器内部缓冲必须使用预留SRAM；统一释放回调必须识别两种堆。"""
    path = Path(nuttx_root) / 'arch/xtensa/src/esp32s3/esp32s3_ble_adapter.c'
    text = path.read_text()
    marker = 'PIXELBOX_BLE_INTERNAL_HEAP_V1'
    if marker in text:
        return False
    text = replace_exact(text, '#include <nuttx/kmalloc.h>', '#include <arch/arch.h>\n#include <nuttx/kmalloc.h>')
    text = replace_exact(text, 'static void *malloc_internal_wrapper(size_t size);',
        'static void *malloc_internal_wrapper(size_t size);\nstatic void free_wrapper(void *pointer);')
    text = replace_exact(text, '  ._free = free,', '  ._free = free_wrapper,')
    original = '''static void *malloc_internal_wrapper(size_t size)
{
  void * p = kmm_malloc(size);

  if (p != NULL)
    {
      if (esp32s3_ptr_extram(p))
        {
          kmm_free(p);
          return NULL;
        }
    }

  return p;
}'''
    replacement = '''/* PIXELBOX_BLE_INTERNAL_HEAP_V1: 使用真正的内部堆，不能从PSRAM堆取出后拒绝。 */
static void *malloc_internal_wrapper(size_t size)
{
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
  return xtensa_imm_malloc(size);
#else
  void *pointer = kmm_malloc(size);
  if (pointer != NULL && esp32s3_ptr_extram(pointer))
    {
      kmm_free(pointer);
      return NULL;
    }
  return pointer;
#endif
}

static void free_wrapper(void *pointer)
{
  if (pointer == NULL)
    {
      return;
    }
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
  if (xtensa_imm_heapmember(pointer))
    {
      xtensa_imm_free(pointer);
      return;
    }
#endif
  kmm_free(pointer);
}'''
    text = replace_exact(text, original, replacement)
    path.write_text(text)
    return True


def patch_bringup(nuttx_root: Path) -> bool:
    """只延迟本板BLE控制器；NSH/Wi-Fi先启动，再由BLE永久任务受看门狗监督初始化。"""
    path = Path(nuttx_root) / 'boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c'
    text = path.read_text()
    marker = 'PIXELBOX_BLE_DEFERRED_INIT_V1'
    if marker in text:
        return False
    original = '''#ifdef CONFIG_ESPRESSIF_BLE
  ret = esp32s3_ble_initialize();
  if (ret)
    {
      syslog(LOG_ERR, "ERROR: Failed to initialize BLE\\n");
    }
#endif'''
    text = replace_exact(text, original,
        '/* PIXELBOX_BLE_DEFERRED_INIT_V1: BLE控制器在受看门狗监督的host任务中初始化。 */')
    path.write_text(text)
    return True


def patch_npl(nimble_root: Path) -> bool:
    """修复固定NPL的事件队列、timer和等待时基；调用前必须解包完整NimBLE树。"""
    root = Path(nimble_root) / 'porting/npl/nuttx'
    types = root / 'include/nimble/os_types.h'
    text = types.read_text()
    marker = 'PIXELBOX_NIMBLE_NPL_V2'
    if marker in text:
        return False
    text = replace_exact(text, '    void                   *ev_arg;\n',
        '    void                   *ev_arg;\n    struct ble_npl_event   *ev_next;\n    struct ble_npl_eventq  *ev_owner;\n')
    text = replace_exact(text, '    mqd_t                  mq;\n',
        '    /* PIXELBOX_NIMBLE_NPL_V2: intrusive queue, monotonic bounded waits. */\n'
        '    pthread_cond_t         condition;\n    struct ble_npl_event   *head, *tail;\n    bool                   initialized;\n')
    text = replace_exact(text, '    bool                    c_active;\n',
        '    bool                    c_active;\n    bool                    c_inited;\n')
    pending = {types: text}
    for original, replacement, anchor in [
        ('os_eventq.c', 'ble_npl_eventq.c', '    ret = mq_send(evq->mq, (const char*)&ev, sizeof(ev), 0);'),
        ('os_callout.c', 'ble_npl_callout.c', '    pending_callout = c;')]:
        path = root / 'src' / original
        if anchor not in path.read_text():
            raise RuntimeError(f'BLE NPL source drift: {path}')
        pending[path] = (Path(__file__).resolve().parents[1] / 'port' / replacement).read_text()
    sem = root / 'src/os_sem.c'
    text = sem.read_text()
    text = replace_exact(text, 'clock_gettime(CLOCK_REALTIME, &wait)', 'clock_gettime(CLOCK_MONOTONIC, &wait)')
    text = replace_exact(text, '        err = sem_wait(&sem->lock);',
        '        do { err = sem_wait(&sem->lock); } while (err && errno == EINTR);')
    text = replace_exact(text, '        wait.tv_nsec += (timeout % 1000) * 1000000;',
        '        wait.tv_nsec += (timeout % 1000) * 1000000;\n        if (wait.tv_nsec >= 1000000000) { wait.tv_nsec -= 1000000000; wait.tv_sec++; }')
    text = replace_exact(text, '        err = sem_timedwait(&sem->lock, &wait);',
        '        do { err = sem_clockwait(&sem->lock, CLOCK_MONOTONIC, &wait); } while (err && errno == EINTR);')
    pending[sem] = text
    mutex = root / 'src/os_mutex.c'
    text = mutex.read_text()
    text = replace_exact(text, '    int err;\n', '    int err;\n    struct timespec deadline;\n')
    text = text.replace('mu->wait', 'deadline')
    text = replace_exact(text, 'clock_gettime(CLOCK_REALTIME, &deadline)', 'clock_gettime(CLOCK_MONOTONIC, &deadline)')
    text = replace_exact(text, '        deadline.tv_nsec += (timeout % 1000) * 1000000;',
        '        deadline.tv_nsec += (timeout % 1000) * 1000000;\n        if (deadline.tv_nsec >= 1000000000) { deadline.tv_nsec -= 1000000000; deadline.tv_sec++; }')
    # 当前NuttX没有pthread_mutex_clocklock；保留pthread递归/健壮语义，以单调时钟约束trylock。
    text = replace_exact(text, '        err = pthread_mutex_timedlock(&mu->lock, &deadline);', '''        for (;;) {
            err = pthread_mutex_trylock(&mu->lock);
            if (err != EBUSY) break;
            struct timespec now;
            if (clock_gettime(CLOCK_MONOTONIC, &now)) return BLE_NPL_ERROR;
            if (now.tv_sec > deadline.tv_sec ||
                (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) {
                err = ETIMEDOUT;
                break;
            }
            struct timespec pause = {0, 1000000};
            nanosleep(&pause, NULL);
        }''')
    pending[mutex] = text
    timing = root / 'src/os_time.c'
    text = replace_exact(timing.read_text(), '    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;',
        '    return (uint32_t)now.tv_sec * 1000u + (uint32_t)now.tv_nsec / 1000000u;')
    pending[timing] = text
    # 所有固定版本锚点确认后才修改；types标记最后写，失败时不伪装完整成功。
    for path, content in pending.items():
        if path != types:
            path.write_text(content)
    types.write_text(pending[types])
    return True


def _private_path(base: Path, path: Path) -> Path:
    """只允许真实位于build内的路径，不能通过目录链接写回共享SDK。"""
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_relative_to(base) or '.deps' in resolved.parts:
        raise ValueError(f'BLE目标必须位于工程私有build树: {path}')
    return resolved


def _unpack(archive: Path, destination: Path) -> None:
    expected = 'mynewt-nimble-' + NIMBLE_REF
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        # 先检查所有成员，不能在遇到越界路径前先写一半归档。
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != expected or '..' in parts:
                raise ValueError('NimBLE归档目录越界: ' + member.name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError('NimBLE归档包含不支持的节点: ' + member.name)
            if member.issym():
                target = (destination.joinpath(*parts[1:]).parent / member.linkname).resolve()
                if not target.is_relative_to(destination):
                    raise ValueError('NimBLE归档链接越界: ' + member.name)
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name).parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as stream, target.open('wb') as output:
                    shutil.copyfileobj(stream, output)


def prepare(project: Path, nuttx_root: Path, apps_root: Path) -> dict:
    """configure hook：在make context之前调用；不下载、不改共享依赖、不启用配置。"""
    project = Path(project).resolve(strict=True)
    build = (project / 'build').resolve(strict=True)
    if (project / 'build').is_symlink():
        raise ValueError('BLE工程build目录不能是符号链接')
    kernel = _private_path(build, Path(nuttx_root))
    apps = _private_path(build, Path(apps_root))
    wrapper = _private_path(apps, apps / 'wireless/bluetooth/nimble')
    if not (wrapper / 'Makefile.nimble').is_file():
        raise ValueError('缺少NuttX NimBLE构建包装: ' + str(wrapper))
    for name in ('esp32s3_ble.c', 'esp32s3_ble_adapter.c'):
        controller = _private_path(kernel, kernel / 'arch/xtensa/src/esp32s3' / name)
        if not controller.is_file():
            raise ValueError('缺少ESP32-S3 BLE控制器适配: ' + str(controller))
    bringup = _private_path(kernel, kernel / 'boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c')
    if not bringup.is_file():
        raise ValueError('缺少ESP32-S3开发板初始化源码: ' + str(bringup))
    network = _private_path(kernel, kernel / 'net/bluetooth/bluetooth_sendmsg.c')
    if not network.is_file():
        raise ValueError('缺少NuttX RAW HCI网络传输源码: ' + str(network))
    archive = project / 'third_party' / ('mynewt-nimble-' + NIMBLE_REF + '.tar.gz')
    if not archive.is_file() or archive.is_symlink() or hashlib.sha256(archive.read_bytes()).hexdigest() != NIMBLE_SHA256:
        raise ValueError('NimBLE离线归档缺失或SHA256不匹配: ' + str(archive))
    nimble = _private_path(wrapper, wrapper / 'mynewt-nimble')
    marker = nimble / '.pixelbox-ble-ready.json'
    port = Path(__file__).resolve().parents[1] / 'port'
    patch_hash = hashlib.sha256(Path(__file__).read_bytes() + (port/'ble_npl_eventq.c').read_bytes() + (port/'ble_npl_callout.c').read_bytes()).hexdigest()
    expected = {'ref': NIMBLE_REF, 'archiveSha256': NIMBLE_SHA256, 'patchSha256': patch_hash}
    if nimble.exists():
        if not marker.is_file() or json.loads(marker.read_text()) != expected:
            raise ValueError('NimBLE私有源码不是当前修复版本；请重建工程隔离快照: ' + str(nimble))
    else:
        # 新目录完整解包并修补成功后才rename，不把半成品视为已就绪的依赖。
        with tempfile.TemporaryDirectory(prefix='.pixelbox-nimble-', dir=wrapper) as temporary:
            stage = Path(temporary) / 'source';stage.mkdir()
            _unpack(archive, stage)
            patch_nimble(stage);patch_npl(stage)
            (stage / marker.name).write_text(json.dumps(expected, sort_keys=True) + '\n')
            stage.rename(nimble)
    patch_controller(kernel)
    patch_controller_lifecycle(kernel)
    patch_hci_network(kernel)
    patch_controller_memory(kernel)
    patch_bringup(kernel)
    # 上游context的目录依赖tar；两者均预置，且目录时间晚于tar，防止make再下载/解包。
    cached_archive = _private_path(wrapper, wrapper / (NIMBLE_REF + '.tar.gz'))
    if not cached_archive.is_file() or hashlib.sha256(cached_archive.read_bytes()).hexdigest() != NIMBLE_SHA256:
        shutil.copy2(archive, cached_archive)
    nimble.touch()
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('nuttx_root', type=Path)
    parser.add_argument('apps_root', type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args.project, args.nuttx_root, args.apps_root)
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        parser.exit(1, str(error) + '\n')
    print('BLE离线依赖就绪: ' + json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
