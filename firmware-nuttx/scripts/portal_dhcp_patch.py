#!/usr/bin/env python3
"""修复锁定 NuttX DHCPD 的启动确认、失败唤醒、退出 fd 与停止错误传播。"""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import re

ORIGINAL = {
    'dhcpd_run': '0fce9ff0b931b2a4304062473a4d627ed2e9450aa0811f112239d888f8052046',
    'dhcpd_start': '0320146185fabd2bd7e93694a00bb71902062738ed22f3b4ea0dbe51fb249036',
    'dhcpd_stop': 'ae82af4c5c3fc42577b43b3878a21edb1b4a19aff4ab8b48d771f44d0b064d2a',
}
PATCHED = {
    'dhcpd_run': 'c793ceca1551c8e55f527ef67e51286a61f7b66a670efd62e78d9f485aecdf83',
    'dhcpd_start': 'e0226591b8354c7ff761e7eea9ff64183d300e2de0d2b6ea7ac0b25f5ce9588e',
    'dhcpd_stop': 'ba8ebe97d19348a876e8f0d5e31dec94f654f23ad563bcdb24566deff2fa0fa2',
}
MARKER = '/* PIXELBOX_DHCPD_LIFECYCLE_V1 */'
HELPER = r'''/* PIXELBOX_DHCPD_LIFECYCLE_V1 */
/* 使用 NuttX 32 位原子；Xtensa 不依赖未提供的字节原子符号。 */
int pixelbox_dhcpd_safe(void);
int pixelbox_dhcpd_safe(void)
{
  return 1;
}

int pixelbox_dhcpd_status(void);
int pixelbox_dhcpd_status(void)
{
  int state = atomic_read_acquire(&g_dhcpd_daemon.ds_state);
  return state == DHCPD_RUNNING ? 1 :
    (state == DHCPD_NOT_RUNNING || state == DHCPD_STOPPED) ? 0 : -EINPROGRESS;
}
'''


def function(source: str, name: str) -> tuple[int, int, str]:
    matches = list(re.finditer(r'^int ' + name + r'\([^\n]*\)\n\{', source, re.M))
    if len(matches) != 1:
        raise ValueError(f'{name}: 需要唯一原函数')
    start = matches[0].start(); end = source.index('{', start) + 1; depth = 1
    while depth and end < len(source):
        depth += (source[end] == '{') - (source[end] == '}'); end += 1
    if depth:
        raise ValueError(f'{name}: 函数不完整')
    return start, end, source[start:end]


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError('DHCPD 补丁锚点漂移')
    return source.replace(old, new, 1)


def rewrite(name: str, text: str) -> str:
    if name == 'dhcpd_run':
        text = replace_once(text, '      return -ENOMEM;', '''      g_dhcpd_daemon.ds_pid = -1;
      g_dhcpd_daemon.ds_state = DHCPD_STOPPED;
      sem_post(&g_dhcpd_daemon.ds_sync);
      return -ENOMEM;''')
        text = replace_once(text, '  /* Indicate that we have started */', '''  /* 只有监听口绑定成功后才能通知 start 成功。失败也必须唤醒等待者。 */

  sockfd = dhcpd_openlistener(interface);
  if (sockfd < 0)
    {
      int error = errno ? errno : EIO;
      free(g_dhcpd_daemon.ds_data);
      g_dhcpd_daemon.ds_data = NULL;
      g_dhcpd_daemon.ds_pid = -1;
      g_dhcpd_daemon.ds_state = DHCPD_STOPPED;
      sem_post(&g_dhcpd_daemon.ds_sync);
      return -error;
    }

  /* Indicate that we have started */''')
        text = replace_once(text, '  sockfd = -1;\n  while (', '  while (')
        text = replace_once(text, '  free(g_dhcpd_daemon.ds_data);\n  g_dhcpd_daemon.ds_data = NULL;', '''  if (sockfd >= 0)
    {
      close(sockfd);
    }

  free(g_dhcpd_daemon.ds_data);
  g_dhcpd_daemon.ds_data = NULL;''')
    elif name == 'dhcpd_start':
        text = replace_once(text, '  int pid;', '  int pid;\n  int result;')
        text = replace_once(text, '  sem_post(&g_dhcpd_daemon.ds_lock);\n  return OK;', '''  else
    {
      sem_post(&g_dhcpd_daemon.ds_lock);
      return -EBUSY;
    }

  result = g_dhcpd_daemon.ds_state == DHCPD_RUNNING ? OK : -EIO;
  sem_post(&g_dhcpd_daemon.ds_lock);
  return result;''')
    else:
        text = replace_once(text, '  int ret;', '  int ret;\n  int result = OK;')
        text = replace_once(text, '      g_dhcpd_daemon.ds_state == DHCPD_RUNNING)',
                            '      g_dhcpd_daemon.ds_state == DHCPD_RUNNING ||\n      g_dhcpd_daemon.ds_state == DHCPD_STOP_REQUESTED)')
        text = replace_once(text, '              break;', '              result = -errno;\n              break;')
        text = replace_once(text, '  return OK;', '  return result;')
    # start/stop 等待被信号打断时仍等待真正的 daemon 状态改变。
    text = re.sub(r'(?m)^( +)sem_wait\(([^\n]+)\);$',
                  r'\1while (sem_wait(\2) < 0 && errno == EINTR)\n\1  {\n\1  }', text)
    # 整个上游文件的 ds_state 访问都在这三个锁定函数中。
    text = re.sub(r'g_dhcpd_daemon\.ds_state = (DHCPD_[A-Z_]+);',
                  r'atomic_set_release(&g_dhcpd_daemon.ds_state, \1);', text)
    text = re.sub(r'(?<!&)g_dhcpd_daemon\.ds_state',
                  'atomic_read_acquire(&g_dhcpd_daemon.ds_state)', text)
    return text


def patch_source(source: str) -> str:
    existing = MARKER in source
    if existing and (source.count(HELPER) != 1 or source.count(MARKER) != 1):
        raise ValueError('DHCPD 补丁不完整或已漂移')
    edits = []
    for name, digest in (PATCHED if existing else ORIGINAL).items():
        start, end, text = function(source, name)
        if hashlib.sha256(text.encode()).hexdigest() != digest:
            raise ValueError(f'{name}: 源码版本或补丁已漂移')
        if not existing:
            edits.append((start, end, rewrite(name, text)))
    if existing:
        if set(PATCHED) != set(ORIGINAL):
            raise ValueError('缺少补丁校验值')
        if '#include <nuttx/atomic.h>' not in source or 'atomic_t                  ds_state;' not in source:
            raise ValueError('DHCPD atomic 状态补丁不完整')
        return source
    for start, end, replacement in sorted(edits, reverse=True):
        source = source[:start] + replacement + source[end:]
    source = replace_once(source, '#include <stdint.h>', '#include <stdint.h>\n#include <nuttx/atomic.h>')
    source = replace_once(source, 'uint8_t                   ds_state;', 'atomic_t                  ds_state;')
    return source + '\n' + HELPER


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    if args.source.is_symlink() or not args.source.is_file():
        raise SystemExit('仅允许普通 SDK 快照文件，拒绝符号链接')
    source = args.source.read_text()
    try:
        result = patch_source(source)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if result != source:
        args.source.write_text(result)


if __name__ == '__main__':
    main()
