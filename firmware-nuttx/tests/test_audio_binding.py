#!/usr/bin/env python3
"""链接本地真实 QuickJS 静态库检验 audio_binding 的 FFI，不写共享构建。"""
from pathlib import Path
import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
LIBRARY = PROJECT / "build/libpixelbox_quickjs.a"
SANITIZER = None

HARNESS = r"""
#include "quickjs.h"
#include "pixelbox_audio.h"
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
void px_install_audio(JSContext*,JSValue);
#include "adpcm_cases.inc"
static JSValue detach(JSContext*c,JSValueConst self,int argc,JSValueConst*argv){
 (void)self;if(argc)JS_DetachArrayBuffer(c,argv[0]);return JS_UNDEFINED;
}
static int init_error, volume=70, shutdowns, stops;
static uint8_t copied[32];
static size_t copied_length;
static unsigned sample_rate,channel_count;
static uint32_t next_id;
static bool paused, event_ready;
int px_audio_init(void){return init_error;}
void px_audio_shutdown(void){++shutdowns;}
int px_audio_set_volume(int v){volume=v;return 0;}
int px_audio_get_volume(void){return volume;}
int px_audio_tone(float frequency,unsigned duration,int amplitude,uint32_t*id){
 assert(frequency==440&&duration==200&&amplitude==80);*id=++next_id;return 0;
}
int px_audio_play_pcm(const void*p,size_t n,unsigned rate,unsigned channels,uint32_t*id){
 assert(n<=sizeof(copied));memcpy(copied,p,n);copied_length=n;
 sample_rate=rate;channel_count=channels;*id=++next_id;return 0;
}
int px_audio_play_encoded(const void*p,size_t n,uint32_t*id){
 assert(n<=sizeof(copied));memcpy(copied,p,n);copied_length=n;*id=++next_id;return 0;
}
int px_audio_stream_open(unsigned rate,unsigned channels,uint32_t*id){sample_rate=rate;channel_count=channels;*id=++next_id;return 0;}
int px_audio_stream_feed(uint32_t id,const void*p,size_t n){assert(id==next_id);if(n>16)return -EAGAIN;memcpy(copied,p,n);copied_length=n;return 0;}
int px_audio_stream_end(uint32_t id){assert(id==next_id);return 0;}
int px_audio_buffered_ms(uint32_t id){assert(id==next_id);return 123;}
int px_audio_pause(uint32_t id,bool state){assert(id==next_id);paused=state;return 0;}
int px_audio_stop(uint32_t id){assert(id==next_id);++stops;event_ready=true;return 0;}
void px_audio_stop_all(void){++stops;}
bool px_audio_playing(uint32_t id){return !paused&&(id==0||id==next_id)&&!init_error;}
int px_audio_poll(struct px_audio_result*r){if(!event_ready)return 0;r->job_id=next_id;r->error=-ECANCELED;r->started=false;event_ready=false;return 1;}
static void evaluate(JSContext*ctx,const char*code){
 JSValue value=JS_Eval(ctx,code,strlen(code),"audio-binding-test",JS_EVAL_TYPE_GLOBAL);
 if(JS_IsException(value)){JSValue error=JS_GetException(ctx);const char*text=JS_ToCString(ctx,error);fprintf(stderr,"%s\n",text);JS_FreeCString(ctx,text);JS_FreeValue(ctx,error);assert(!"unexpected JavaScript exception");}
 JS_FreeValue(ctx,value);
}
int main(void){
 JSRuntime*rt=JS_NewRuntime();assert(rt);JSContext*ctx=JS_NewContext(rt);assert(ctx);
 JSValue n=JS_NewObject(ctx);px_install_audio(ctx,n);JS_SetPropertyStr(ctx,n,"detach",JS_NewCFunction(ctx,detach,"detach",1));
 JSValue global=JS_GetGlobalObject(ctx);JS_SetPropertyStr(ctx,global,"n",n);JS_FreeValue(ctx,global);
 evaluate(ctx,"function ok(value){if(!value)throw Error('assertion failed');} function fails(fn,message){try{fn();}catch(e){if(message)ok(e.message===message);return;}throw Error('expected error');}");
 evaluate(ctx,"ok(n.audioAvailable());n.audioSetVolume(123.4);ok(n.audioGetVolume()===100);n.audioSetVolume(-10);ok(n.audioGetVolume()===0);fails(()=>n.audioSetVolume(NaN),'EINVAL');");
 evaluate(ctx,"var id=n.audioPlayPcm(new Uint8Array([9,1,2,3,4,8]).subarray(1,5),48000,2);ok(id===1);");
 assert(copied_length==4&&!memcmp(copied,"\1\2\3\4",4)&&sample_rate==48000&&channel_count==2);
 evaluate(ctx,"fails(()=>n.audioPlayPcm(new DataView(new ArrayBuffer(4)),16000,1));fails(()=>n.audioPlayPcm(new Uint8Array(4),-1,1),'EINVAL');fails(()=>n.audioPlayPcm(new Uint8Array(4),Infinity,1),'EINVAL');fails(()=>n.audioPlayPcm(new Uint8Array(4),16000.5,1),'EINVAL');");
 evaluate(ctx,"id=n.audioTone(440,200,80);ok(id===2);fails(()=>n.audioTone(440,-1,80),'EINVAL');fails(()=>n.audioTone(440,0x100000000,80),'EINVAL');");
 evaluate(ctx,"id=n.audioStreamOpen(16000,1);n.audioStreamFeed(id,new Uint8Array([3,4,5,6]));fails(()=>n.audioStreamFeed(id,new Uint8Array(18)),'EAGAIN');ok(n.audioBuffered(id)===123);n.audioPause(id,true);ok(!n.audioPlaying(id));n.audioPause(id,false);ok(n.audioPlaying(id));n.audioStreamEnd(id);n.audioStop(id);var event=n.audioPoll();ok(event.jobId===id&&event.error<0&&event.code==='ECANCELED');ok(n.audioPoll()===null);");
 assert(copied_length==4&&!memcmp(copied,"\3\4\5\6",4));
 evaluate(ctx,"id=n.audioPlayEncoded(new Uint8Array([9,82,73,70,70,8]).subarray(1,5));ok(id>0);");
 assert(copied_length==4&&!memcmp(copied,"RIFF",4));
 init_error=-ENOTSUP;
 evaluate(ctx,"ok(!n.audioAvailable());fails(()=>n.audioGetVolume(),'ENOTSUP');fails(()=>n.audioTone(440,200,80),'ENOTSUP');ok(!n.audioPlaying(0));n.audioShutdown();");
 assert(shutdowns==1&&stops==1);
 evaluate(ctx,adpcm_cases);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);return 0;
}
"""


class AudioBindingTests(unittest.TestCase):
    def test_real_quickjs_ffi(self):
        library = LIBRARY.resolve()
        includes = library.parent / "generated/quickjs-ng"
        if not library.exists():
            self.skipTest("build host QuickJS library before running binding regression")
        with tempfile.TemporaryDirectory(prefix="pixelbox-audio-binding-") as temporary:
            path = Path(temporary)
            (path / "test.c").write_text(HARNESS)
            code = (PROJECT / 'tests/ima_adpcm_reference.js').read_text() + (PROJECT / 'tests/test_adpcm.js').read_text()
            (path / 'adpcm_cases.inc').write_text('static const char *adpcm_cases = ' + json.dumps(code) + ';\n')
            flags = ['-fsanitize=' + SANITIZER, '-fno-sanitize-recover=all'] if SANITIZER else []
            command = [*shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", *flags,
                       f"-I{includes}", f"-I{PROJECT / 'include'}",
                       str(PROJECT / "src/audio_binding.c"), str(path / "test.c"),
                       str(library), "-pthread", "-lm", "-o", str(path / "test")]
            compiled = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            ran = subprocess.run([str(path / "test")], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--quickjs-library', type=Path, default=LIBRARY)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args, remaining = parser.parse_known_args()
    LIBRARY, SANITIZER = args.quickjs_library, args.sanitize
    unittest.main(argv=[sys.argv[0], *remaining])
