#!/usr/bin/env python3
"""真实 QuickJS 与 mic_binding.c 的类型、所有权和错误映射测试。"""
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
SOURCE = r'''
#include "quickjs.h"
#include "pixelbox_mic.h"
#include <assert.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
void px_install_mic(JSContext*,JSValue);
#include "mic_rms_cases.inc"
static JSValue detach(JSContext*c,JSValueConst self,int argc,JSValueConst*argv){
 (void)self;if(argc)JS_DetachArrayBuffer(c,argv[0]);return JS_UNDEFINED;
}
static bool available=true,active,busy,ready;
static int error,gain;
bool px_mic_available(void){return available;}
bool px_mic_active(void){return active;}
bool px_mic_busy(void){return busy;}
void px_mic_stop(void){active=false;}
int px_mic_start(unsigned r,unsigned f){if(error)return error;assert(r==16000&&f==10);active=busy=true;return 0;}
int px_mic_set_gain(int p){gain=p;return error;}
int px_mic_poll(struct px_mic_frame*f,unsigned maximum){
 assert(maximum==10);
 if(error)return error;if(!ready)return 0;ready=false;
 f->data=malloc(4);assert(f->data);memcpy(f->data,"\1\2\3\4",4);f->bytes=4;f->sample_rate=16000;return 1;
}
static void evaluate(JSContext*c,const char*s){
 JSValue v=JS_Eval(c,s,strlen(s),"mic-test",JS_EVAL_TYPE_GLOBAL);
 if(JS_IsException(v)){JSValue e=JS_GetException(c);const char*t=JS_ToCString(c,e);fprintf(stderr,"%s\n",t);JS_FreeCString(c,t);JS_FreeValue(c,e);assert(!"unexpected JS error");}
 JS_FreeValue(c,v);
}
int main(void){
 JSRuntime*r=JS_NewRuntime();assert(r);JSContext*c=JS_NewContext(r);assert(c);
 JSValue g=JS_GetGlobalObject(c),n=JS_NewObject(c);px_install_mic(c,n);JS_SetPropertyStr(c,n,"detach",JS_NewCFunction(c,detach,"detach",1));JS_SetPropertyStr(c,g,"n",n);JS_FreeValue(c,g);
 evaluate(c,"function ok(v){if(!v)throw Error('assertion');}function fails(fn,name){try{fn();}catch(e){ok(e.message===name);return;}throw Error('expected failure');}ok(n.micAvailable());ok(!n.micActive());n.micStart(16000,10);ok(n.micActive()&&n.micBusy());n.micStop();ok(!n.micActive()&&n.micBusy());");
 evaluate(c,"fails(()=>n.micStart(NaN,10),'EINVAL');fails(()=>n.micStart(16000,1),'EINVAL');fails(()=>n.micStart(16000.5,10),'EINVAL');fails(()=>n.micSetGain(Infinity),'EINVAL');n.micSetGain(999);");assert(gain==100);
 evaluate(c,"n.micSetGain(-10);");assert(gain==0);
 ready=true;evaluate(c,"var frame=n.micPoll();ok(frame.sampleRate===16000&&frame.data.byteLength===4);ok(new Uint8Array(frame.data)[2]===3);ok(n.micPoll()===null);");
 error=-EOVERFLOW;evaluate(c,"fails(()=>n.micPoll(),'EOVERFLOW');");
 error=-ETIMEDOUT;evaluate(c,"fails(()=>n.micPoll(),'ETIMEDOUT');");
 error=-EBUSY;evaluate(c,"fails(()=>n.micStart(16000,10),'EBUSY');");
 available=false;evaluate(c,"ok(!n.micAvailable());");
 evaluate(c,rms_cases);
 JS_FreeContext(c);JS_FreeRuntime(r);return 0;
}
'''

class MicBindingTests(unittest.TestCase):
    def test_real_quickjs_binding(self):
        library = LIBRARY.resolve()
        includes = library.parent / "generated/quickjs-ng"
        if not library.exists():
            self.skipTest("host QuickJS library required")
        with tempfile.TemporaryDirectory(prefix="pixelbox-mic-binding-") as temporary:
            root = Path(temporary)
            (root / "test.c").write_text(SOURCE)
            cases = (PROJECT / "tests/test_mic_rms.js").read_text()
            (root / "mic_rms_cases.inc").write_text('static const char *rms_cases = ' + json.dumps(cases) + ';\n')
            flags = ['-fsanitize=' + SANITIZER, '-fno-sanitize-recover=all'] if SANITIZER else []
            result = subprocess.run([*shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", *flags, "-I", str(includes), "-I", str(PROJECT / "include"), str(PROJECT / "src/mic_binding.c"), str(root / "test.c"), str(library), "-pthread", "-lm", "-o", str(root / "test")], text=True, capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(root / "test")], text=True, capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--quickjs-library', type=Path, default=LIBRARY)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args, remaining = parser.parse_known_args()
    LIBRARY, SANITIZER = args.quickjs_library, args.sanitize
    unittest.main(argv=[sys.argv[0], *remaining])
