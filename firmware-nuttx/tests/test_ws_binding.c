#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>
void px_install_net(JSContext *,JSValue);
void px_install_ws(JSContext *,JSValue);
static JSValue random_bytes(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;uint32_t count;if(!argc||JS_ToUint32(ctx,&count,argv[0]))return JS_EXCEPTION;
  if(count>65536)return JS_ThrowRangeError(ctx,"random length");
  uint8_t *bytes=malloc(count?count:1);if(!bytes)return JS_ThrowOutOfMemory(ctx);
  int fd=open("/dev/urandom",O_RDONLY);if(fd<0){free(bytes);return JS_ThrowInternalError(ctx,"urandom");}
  for(size_t offset=0;offset<count;){ssize_t n=read(fd,bytes+offset,count-offset);if(n<=0){close(fd);free(bytes);return JS_ThrowInternalError(ctx,"urandom read");}offset+=(size_t)n;}
  close(fd);JSValue result=JS_NewArrayBufferCopy(ctx,bytes,count);free(bytes);return result;
}
static int exception(JSContext *ctx,JSValue result)
{
  if(!JS_IsException(result)){JS_FreeValue(ctx,result);return 0;}
  JSValue error=JS_GetException(ctx),stack=JS_GetPropertyStr(ctx,error,"stack");
  const char *message=JS_ToCString(ctx,error),*trace=JS_ToCString(ctx,stack);
  fprintf(stderr,"%s\n%s\n",message?message:"JS error",trace?trace:"");JS_FreeCString(ctx,message);JS_FreeCString(ctx,trace);
  JS_FreeValue(ctx,stack);JS_FreeValue(ctx,error);return 1;
}
int main(int argc,char **argv)
{
  if(argc!=2)return 2;FILE *file=fopen(argv[1],"rb");if(!file||fseek(file,0,SEEK_END))return 2;
  long size=ftell(file);if(size<0||size>2*1024*1024||fseek(file,0,SEEK_SET))return 2;
  char *source=malloc((size_t)size+1);if(!source||fread(source,1,(size_t)size,file)!=(size_t)size)return 2;fclose(file);source[size]=0;
  JSRuntime *runtime=JS_NewRuntime();JS_SetMemoryLimit(runtime,32*1024*1024);JS_SetMaxStackSize(runtime,1024*1024);
  JSContext *ctx=JS_NewContext(runtime);JSValue global=JS_GetGlobalObject(ctx),native=JS_NewObject(ctx);
  px_install_net(ctx,native);px_install_ws(ctx,native);JS_SetPropertyStr(ctx,native,"randomBytes",JS_NewCFunction(ctx,random_bytes,"randomBytes",1));
  JS_SetPropertyStr(ctx,global,"native",native);
  int failed=exception(ctx,JS_Eval(ctx,source,(size_t)size,argv[1],JS_EVAL_TYPE_GLOBAL));free(source);
  for(unsigned iteration=0;!failed&&iteration<15000;++iteration){
    JSContext *job;while(JS_IsJobPending(runtime)){if(JS_ExecutePendingJob(runtime,&job)<0){failed=exception(job,JS_EXCEPTION);break;}}
    if(failed)break;
    JSValue complete=JS_GetPropertyStr(ctx,global,"testComplete");int done=JS_ToBool(ctx,complete);JS_FreeValue(ctx,complete);
    if(done)break;
    failed=exception(ctx,JS_Eval(ctx,"testTick()",10,"test:tick",JS_EVAL_TYPE_GLOBAL));
    struct timespec wait={0,1000000};nanosleep(&wait,NULL);
  }
  JSValue complete=JS_GetPropertyStr(ctx,global,"testComplete"),error=JS_GetPropertyStr(ctx,global,"testError");
  if(!JS_ToBool(ctx,complete)||!JS_IsUndefined(error)){const char *message=JS_ToCString(ctx,error);fprintf(stderr,"WS测试未完成或失败：%s\n",message?message:"timeout");JS_FreeCString(ctx,message);failed=1;}
  JS_FreeValue(ctx,error);JS_FreeValue(ctx,complete);JS_FreeValue(ctx,global);JS_FreeContext(ctx);JS_FreeRuntime(runtime);
  if(!failed)puts("WebSocket真实QuickJS回环通过：标准ws服务端互通、文本/二进制/分片/ping/关闭、16条64KiB背压、坏握手与VM退出");return failed;
}
