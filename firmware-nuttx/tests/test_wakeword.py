#!/usr/bin/env python3
"""真模型目录/端口+独立worker边界测试；替身候选不代表真实语音推理。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile
import sys
from wakeword_memory_fixture import build as build_allocator

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'))
    args=parser.parse_args()
    project=Path(__file__).resolve().parents[1]
    port_source=(project/'src/wakeword_port.c').read_text(encoding='utf-8')
    assert '__attribute__((section(".ext_ram.bss"), aligned(16), used))' in port_source
    assert 'return mn7_backing;' in port_source
    assert 'extern uint8_t _ext_ram_bss_start[];' in port_source
    assert 'extern uint8_t _ext_ram_bss_end[];' in port_source
    assert 'return memalign(16, PX_MN7_WORKSPACE_BYTES);' not in port_source
    assert '/* 静态 .ext_ram.bss backing 随镜像生命周期存在，不能交给通用堆释放。 */' in port_source
    cc=shlex.split(os.environ.get('CC','cc'))
    flags=['-std=gnu11','-D_GNU_SOURCE','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include')]
    if args.sanitize: flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    def run(command):subprocess.run(command,check=True,timeout=60)
    with tempfile.TemporaryDirectory(prefix='px-wakeword-tests-') as name:
        temp=Path(name)
        sys.path.insert(0,str(project/'tools'))
        from prepare_wakeword import prepare
        prepare(project,project.parent,temp/'generated')
        includes,allocator=build_allocator(temp,project,cc,flags)
        flags+=includes+['-DPX_MN7_MEMORY_TEST','-I'+str(temp/'generated/wakeword')]
        common=[str(project/'src/wakeword_port.c'),str(project/'tests/wakeword_memory_backend.c'),
                str(temp/'generated/wakeword/cJSON.c'),*allocator]
        run([*cc,*flags,*common,*[str(project/'src'/x) for x in ['wakeword_model.c','wakeword_commands.c','sha256.c']],
             str(project/'tests/test_wakeword_memory.c'),'-lpthread','-o',str(temp/'memory')])
        run([str(temp/'memory'),str(project.parent/'firmware/build/srmodels/srmodels.bin')])
        run([str(temp/'memory'),'quarantine'])
        run([*cc,*flags,*common,*[str(project/'src'/x) for x in ['wakeword_model.c','wakeword_commands.c','sha256.c']],
             str(project/'tests/test_wakeword_model.c'),'-lpthread','-o',str(temp/'model')])
        run([str(temp/'model'),str(project.parent/'firmware/build/srmodels/srmodels.bin')])
        run([*cc,*flags,*common,'-DPX_WAKEWORD_TEST','-DPX_AUDIO_WORKER_TEST','-DPX_WAKEWORD_AUDIO_TIMEOUT_MS=400',
             '-I'+str(project/'tests/wakeword_fixture'),str(project/'src/wakeword.c'),
             str(project/'src/wakeword_commands.c'),str(project/'src/wakeword_selector.c'),
             str(project/'tests/test_wakeword_worker.c'),'-lpthread','-o',str(temp/'worker')])
        for scenario in ['launch','watchdog','model','create','rate','chunk','command','threshold','cancel',
                         'timeout','candidate','blocked','backlog','preroll','stale',
                         'terminal_wake','terminal_error','terminal_cancel','oom_create','oom_detect']:
            run([str(temp/'worker'),scenario])
    run(['node',str(project/'tests/test_wakeword_contract.mjs')])
    print('MN7真实归档、20组原生生命周期和5组JS契约通过；未声称真机识别成功')

if __name__=='__main__':main()
