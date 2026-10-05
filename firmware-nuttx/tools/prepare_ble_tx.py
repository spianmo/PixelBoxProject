#!/usr/bin/env python3
"""在私有NuttX树修复RAW HCI发送错误传播，不改变NimBLE快照指纹。"""
from pathlib import Path
import argparse

MARKER = 'PIXELBOX_RAW_HCI_TX_RESULT_V1'
RELATIVE = Path('wireless/bluetooth/bt_netdev.c')


def replace_exact(text: str, before: str, after: str) -> str:
    if text.count(before) != 1:
        raise RuntimeError('BLE TX patch source drift: ' + before[:100])
    return text.replace(before, after, 1)


def patch_hci_tx(nuttx_root: Path) -> bool:
    """驱动接收后拥有整个IOB列表；所有结果均恰好释放一次并保留负errno。"""
    path = Path(nuttx_root) / RELATIVE
    original = path.read_text()
    signature = ('static int  btnet_req_hci_data(FAR struct btnet_driver_s *priv,\n'
                 '                               FAR struct bluetooth_frame_meta_s *meta,\n'
                 '                               FAR struct iob_s *framelist)\n{')
    start = original.index(signature)
    end = original.index('\n/****************************************************************************', start)
    section = original[start:end]
    if MARKER in section:
        return False
    section = replace_exact(section, '  FAR struct bt_buf_s *buf;\n',
        '  FAR struct bt_buf_s *buf;\n  int ret;\n\n'
        '  /* PIXELBOX_RAW_HCI_TX_RESULT_V1: busy必须传回socket，不能丢包后报告成功。 */\n')
    section = replace_exact(section,
        '          default:\n            return -EOPNOTSUPP;\n            break;',
        '          default:\n'
        '            iob_free(iob);\n'
        '            iob_free_chain(framelist);\n'
        '            return -EOPNOTSUPP;')
    section = replace_exact(section,
        '          wlerr("ERROR:  Failed to allocate buffer container\\n");\n'
        '          return -ENOMEM;',
        '          wlerr("ERROR:  Failed to allocate buffer container\\n");\n'
        '          /* 分配失败未取得IOB所有权，当前帧和未提交帧均由此处释放。 */\n'
        '          iob_free(iob);\n'
        '          iob_free_chain(framelist);\n'
        '          return -ENOMEM;')
    section = replace_exact(section,
        '      bt_send(g_btdev.btdev, buf);\n      bt_buf_release(buf);',
        '      ret = bt_send(g_btdev.btdev, buf);\n'
        '      /* bt_buf_release拥有当前IOB；返回失败后socket用原始用户缓冲新建IOB。 */\n'
        '      bt_buf_release(buf);\n'
        '      if (ret < 0)\n'
        '        {\n'
        '          iob_free_chain(framelist);\n'
        '          return ret;\n'
        '        }')
    # 所有锚点匹配后只写一次，避免留下部分补丁。
    path.write_text(original[:start] + section + original[end:])
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('nuttx_root', type=Path)
    args = parser.parse_args()
    try:
        project = args.project.resolve(strict=True)
        build_path = project / 'build'
        if build_path.is_symlink():
            raise ValueError('BLE工程build目录不能是符号链接')
        build = build_path.resolve(strict=True)
        kernel = args.nuttx_root.resolve(strict=True)
        target = (kernel / RELATIVE).resolve(strict=True)
        if not kernel.is_relative_to(build) or not target.is_relative_to(kernel):
            raise ValueError('BLE TX补丁只允许写入工程私有build树')
        changed = patch_hci_tx(kernel)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')
    print('BLE RAW HCI TX补丁: ' + ('已应用' if changed else '已就绪'))


if __name__ == '__main__':
    main()
