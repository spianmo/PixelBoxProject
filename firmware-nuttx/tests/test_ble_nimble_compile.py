#!/usr/bin/env python3
"""独立临时目录、真实NuttX配置+固定NimBLE头文件交叉编译，不修改共享构建树。"""
from pathlib import Path
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import shutil
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('nuttx',type=Path);parser.add_argument('nimble',type=Path);parser.add_argument('--cc',type=Path);parser.add_argument('--full',action='store_true',help='编译Makefile.nimble实际列出的所有非mesh依赖');args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];nuttx=args.nuttx.resolve();nimble=args.nimble.resolve()
    cc=args.cc or next((Path.home()/'.espressif/tools/xtensa-esp-elf').glob('*/xtensa-esp-elf/bin/xtensa-esp32s3-elf-gcc'))
    config={'WIRELESS':1,'NIMBLE':1,'NET_BLUETOOTH':1,'WIRELESS_BLUETOOTH':1,'NIMBLE_ROLE_BROADCASTER':1,'NIMBLE_ROLE_CENTRAL':1,'NIMBLE_ROLE_OBSERVER':1,'NIMBLE_ROLE_PERIPHERAL':1,'NIMBLE_MSYS_1_BLOCK_COUNT':12,'NIMBLE_MSYS_1_BLOCK_SIZE':292,'NIMBLE_MSYS_2_BLOCK_COUNT':0,'NIMBLE_MSYS_2_BLOCK_SIZE':0,'NIMBLE_BLE_MAX_CONN':3,'NIMBLE_BLE_VERSION':50,'NIMBLE_BLE_ATT_PREFFERED_MTU':256,'NIMBLE_L2CAP_COC_MAX_NUM':0,'NIMBLE_BLE_MAX_PERIODIC_SYNCS':1,'NIMBLE_BLE_MULTI_ADV_INSTANCES':0,'NIMBLE_BLE_RPA_TIMEOUT':300,'NIMBLE_CALLOUT_THREAD_STACKSIZE':4096,'NIMBLE_TINYCRYPT':1,'NIMBLE_BLE_SM_BONDING':1,'NIMBLE_BLE_SM_LEGACY':1,'NIMBLE_BLE_SM_SC':1,'SIG_EVTHREAD':1}
    with tempfile.TemporaryDirectory(prefix='pixelbox-ble-cross-') as temporary:
        out=Path(temporary);(out/'nuttx').mkdir();(out/'nuttx/config.h').write_text('#include "'+str(nuttx/'include/nuttx/config.h')+'"\n'+''.join('#undef CONFIG_'+key+'\n#define CONFIG_'+key+' '+str(value)+'\n' for key,value in config.items()))
        # 只在临时副本修补；所有调用方和NPL实现必须使用同一份已修复的事件布局。
        for relative in ['porting/npl/nuttx','nimble/transport/socket']:
            shutil.copytree(nimble/relative,out/relative)
        spec=importlib.util.spec_from_file_location('prepare_ble',root/'tools/prepare_ble.py');patch=importlib.util.module_from_spec(spec);spec.loader.exec_module(patch)
        patch.patch_nimble(out);patch.patch_npl(out)
        apps=root.parent/'.deps/apps';wrapper=apps/'wireless/bluetooth/nimble'
        includes=[out,nuttx/'include',root/'include',wrapper/'include',root/'build/generated/quickjs-ng',out/'porting/npl/nuttx/include']
        includes += [nimble/p for p in ['porting/nimble/include','nimble/include','nimble/host/include','nimble/host/util/include','nimble/transport/include','nimble/transport/socket/include','nimble/host/store/ram/include','ext/tinycrypt/include']]
        includes += sorted((nimble/'nimble/host/services').glob('*/include'))
        command=[str(cc),'-D__NuttX__','-D__KERNEL__','-std=c11','-Os',*['-I'+str(path) for path in includes]]
        # 必须真实编译拒绝被Kconfig丢弃的socket依赖和会抢走控制器的路由。
        config_header=out/'nuttx/config.h';enabled_config=config_header.read_text()
        for suffix, message in [
            ('\n#undef CONFIG_WIRELESS\n','PixelBox NimBLE requires'),
            ('\n#undef CONFIG_NET_BLUETOOTH\n','PixelBox NimBLE requires'),
            ('\n#define CONFIG_WIRELESS_BLUETOOTH_HOST 1\n','PixelBox NimBLE owns RAW HCI'),
            ('\n#define CONFIG_UART_BTH4 1\n','PixelBox NimBLE owns RAW HCI'),
            ('\n#undef CONFIG_NETDEV_IFINDEX\n','PixelBox NimBLE requires CONFIG_NETDEV_IFINDEX'),
            ('\n#undef CONFIG_NETDEV_IOCTL\n','PixelBox NimBLE requires CONFIG_NETDEV_IFINDEX')]:
            config_header.write_text(enabled_config+suffix)
            result=subprocess.run([*command,'-c',str(root/'src/ble_nimble.c'),'-o',str(out/'rejected.o')],capture_output=True,text=True,timeout=60)
            assert result.returncode and message in result.stderr,result.stderr
        config_header.write_text(enabled_config)
        print('BLE真实交叉编译守卫通过：拒绝WIRELESS/NET_BLUETOOTH/IFINDEX/IOCTL缺失及原生HOST/UART路由冲突')
        for source in ['ble.c','ble_nimble.c','ble_binding.c']:
            subprocess.run([*command,'-Wall','-Wextra','-Werror','-Wno-missing-field-initializers','-Wno-unused-parameter','-c',str(root/'src'/source),'-o',str(out/(source+'.o'))],check=True,timeout=60)
        if args.full:
            # 读取真实Makefile源列表，避免只验证手工挑选的宿主头文件路径。
            makefile=out/'sources.mk';makefile.write_text('include '+str(wrapper/'Makefile.nimble')+'\nall:\n\t@printf \'%s\\n\' $(CSRCS)\n')
            listing=subprocess.run(['make','-s','-f',str(makefile),'all','APPDIR='+str(apps),'NIMBLE_ROOT='+str(nimble),'CONFIG_NIMBLE_TINYCRYPT=y'],check=True,capture_output=True,text=True,timeout=60)
            sources=[Path(line) for line in listing.stdout.splitlines() if line.endswith('.c')];assert len(sources)>70
            def compile_source(item):
                index,source=item;replacement=out/source.relative_to(nimble);source=replacement if replacement.is_file() else source
                subprocess.run([*command,'-c',str(source),'-o',str(out/(str(index)+'.o'))],check=True,timeout=60)
            with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(compile_source,enumerate(sources)))
            print(f'NimBLE/修复NPL/Tinycrypt完整Make源列表：{len(sources)}个真实ESP32-S3交叉对象通过')
        print('BLE 三个模块使用修复NPL结构交叉对象编译通过；未链接、未验证射频')
if __name__=='__main__':main()
