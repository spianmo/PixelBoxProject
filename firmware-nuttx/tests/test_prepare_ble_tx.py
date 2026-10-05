#!/usr/bin/env python3
"""编译RAW HCI补丁生成的真实发送函数，检查错误传播和IOB所有权。"""
from pathlib import Path
import importlib.util
import os
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare_ble_tx", ROOT / "tools/prepare_ble_tx.py")
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


SOURCE_FUNCTION = r'''static int  btnet_req_hci_data(FAR struct btnet_driver_s *priv,
                               FAR struct bluetooth_frame_meta_s *meta,
                               FAR struct iob_s *framelist)
{
  FAR struct iob_s *iob;
  FAR struct bt_buf_s *buf;

  for (iob = framelist; iob != NULL; iob = framelist)
    {
      NETDEV_TXPACKETS(&priv->bd_dev.r_dev);
      framelist     = iob->io_flink;
      iob->io_flink = NULL;
      switch (iob->io_data[iob->io_offset])
        {
          case HCI_ACLDATA_PKT:
            iob->io_offset += 1;
            buf = bt_buf_alloc(BT_ACL_OUT, iob, 0);
            break;
          case HCI_COMMAND_PKT:
            iob->io_offset += 1;
            buf = bt_buf_alloc(BT_CMD, iob, 0);
            break;
          case HCI_EVENT_PKT:
            iob->io_offset += 1;
            buf = bt_buf_alloc(BT_EVT, iob, 0);
            break;
          default:
            return -EOPNOTSUPP;
            break;
        }

      if (buf == NULL)
        {
          wlerr("ERROR:  Failed to allocate buffer container\n");
          return -ENOMEM;
        }

      bt_send(g_btdev.btdev, buf);
      bt_buf_release(buf);
      NETDEV_TXDONE(&priv->bd_dev.r_dev);
    }

  return OK;
}
'''


def patched_source(directory):
    source = directory / patch.RELATIVE
    source.parent.mkdir(parents=True)
    source.write_text(SOURCE_FUNCTION + '\n/****************************************************************************\n')
    assert patch.patch_hci_tx(directory)
    assert not patch.patch_hci_tx(directory)
    return source.read_text()


def function_body(source, signature):
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


class PrepareBleTxTests(unittest.TestCase):
    def test_drift_does_not_write_partial_patch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / patch.RELATIVE
            target.parent.mkdir(parents=True)
            target.write_text(SOURCE_FUNCTION.replace(
                'bt_send(g_btdev.btdev, buf);', 'bt_send_was_changed();')
                + '\n/****************************************************************************\n')
            original = target.read_bytes()
            with self.assertRaises(RuntimeError):
                patch.patch_hci_tx(root)
            self.assertEqual(target.read_bytes(), original)

    def test_compiled_patched_function_owns_every_iob_once(self):
        harness = r'''
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#define FAR
#define OK 0
#define HCI_ACLDATA_PKT 2
#define HCI_COMMAND_PKT 1
#define HCI_EVENT_PKT 4
#define BT_ACL_OUT 1
#define BT_CMD 2
#define BT_EVT 3
#define DEBUGASSERT(value) assert(value)
#define wlerr(...) ((void)0)
#define NETDEV_TXPACKETS(dev) ((dev)->tx_packets++)
#define NETDEV_TXDONE(dev) ((dev)->tx_done++)

struct iob_s {
  struct iob_s *io_flink;
  unsigned int io_offset;
  unsigned int io_len;
  uint8_t io_data[8];
  bool freed;
};
struct bt_buf_s { struct iob_s *frame; };
struct net_driver_s { unsigned int tx_packets, tx_done; };
struct btnet_driver_s { struct { struct net_driver_s r_dev; } bd_dev; };
struct bluetooth_frame_meta_s { int unused; };
struct bt_driver_s { int unused; };
static struct { struct bt_driver_s *btdev; } g_btdev;
static struct bt_driver_s btdev;
static int send_result;
static bool fail_alloc;
static unsigned int send_calls, buf_releases, iob_frees;

static struct bt_buf_s *bt_buf_alloc(int type, struct iob_s *iob, int reserve)
{
  (void)type; (void)reserve;
  if (fail_alloc) return NULL;
  struct bt_buf_s *buf = malloc(sizeof(*buf));
  assert(buf != NULL);
  buf->frame = iob;
  return buf;
}
static int bt_send(struct bt_driver_s *driver, struct bt_buf_s *buf)
{
  assert(driver == &btdev && buf && buf->frame && !buf->frame->freed);
  send_calls++;
  return send_result;
}
static void iob_free(struct iob_s *iob)
{
  assert(iob && !iob->freed);
  iob->freed = true;
  iob_frees++;
}
static void iob_free_chain(struct iob_s *iob)
{
  while (iob) {
    struct iob_s *next = iob->io_flink;
    iob_free(iob);
    iob = next;
  }
}
static void bt_buf_release(struct bt_buf_s *buf)
{
  assert(buf && buf->frame);
  iob_free(buf->frame);
  buf_releases++;
  free(buf);
}
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = patched_source(root)
            signature = 'static int  btnet_req_hci_data('
            c_source = harness + function_body(source, signature) + r'''
static void reset(void)
{
  send_result = 0; fail_alloc = false;
  send_calls = buf_releases = iob_frees = 0;
}
static struct iob_s frame(uint8_t type)
{
  struct iob_s item = { .io_offset = 0, .io_len = 2 };
  item.io_data[0] = type; item.io_data[1] = 0x5a;
  return item;
}
int main(void)
{
  struct btnet_driver_s priv = {0};
  struct bluetooth_frame_meta_s meta = {0};
  g_btdev.btdev = &btdev;

  reset();
  struct iob_s first = frame(HCI_COMMAND_PKT), second = frame(HCI_EVENT_PKT);
  first.io_flink = &second;
  assert(btnet_req_hci_data(&priv, &meta, &first) == 0);
  assert(send_calls == 2 && buf_releases == 2 && iob_frees == 2);
  assert(priv.bd_dev.r_dev.tx_done == 2 && priv.bd_dev.r_dev.tx_packets == 2);

  reset(); priv = (struct btnet_driver_s){0};
  first = frame(HCI_COMMAND_PKT); second = frame(HCI_EVENT_PKT); first.io_flink = &second;
  send_result = -EAGAIN;
  assert(btnet_req_hci_data(&priv, &meta, &first) == -EAGAIN);
  assert(send_calls == 1 && buf_releases == 1 && iob_frees == 2);
  assert(priv.bd_dev.r_dev.tx_done == 0);

  reset(); priv = (struct btnet_driver_s){0};
  struct iob_s third = frame(HCI_ACLDATA_PKT);
  first = frame(HCI_COMMAND_PKT); second = frame(HCI_EVENT_PKT);
  first.io_flink = &second; second.io_flink = &third;
  priv.bd_dev.r_dev.tx_done = 0;
  send_result = 0;
  /* 第二次发送失败时，首帧成功，其余两帧各释放一次。 */
  send_calls = 0;
  send_result = -EIO;
  assert(btnet_req_hci_data(&priv, &meta, &first) == -EIO);
  assert(send_calls == 1 && buf_releases == 1 && iob_frees == 3);
  assert(priv.bd_dev.r_dev.tx_done == 0);

  reset(); priv = (struct btnet_driver_s){0};
  first = frame(0xff); second = frame(HCI_EVENT_PKT); first.io_flink = &second;
  assert(btnet_req_hci_data(&priv, &meta, &first) == -EOPNOTSUPP);
  assert(send_calls == 0 && buf_releases == 0 && iob_frees == 2);

  reset(); priv = (struct btnet_driver_s){0};
  first = frame(HCI_COMMAND_PKT); second = frame(HCI_EVENT_PKT); first.io_flink = &second;
  fail_alloc = true;
  assert(btnet_req_hci_data(&priv, &meta, &first) == -ENOMEM);
  assert(send_calls == 0 && buf_releases == 0 && iob_frees == 2);
  assert(priv.bd_dev.r_dev.tx_done == 0);
  return 0;
}
'''
            c_path = root / 'hci_tx_test.c'
            binary = root / 'hci_tx_test'
            c_path.write_text(c_source)
            subprocess.run([*shlex.split(os.environ.get('CC', 'cc')),
                            '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-Wno-unused-parameter',
                            '-fsanitize=undefined', '-fno-sanitize-recover=all',
                            str(c_path), '-o', str(binary)],
                           check=True, timeout=60)
            subprocess.run([str(binary)], check=True, timeout=60)


if __name__ == '__main__':
    unittest.main()
