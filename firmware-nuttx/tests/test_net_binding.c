/* 独立QuickJS宿主：只使用回环socket，检查FFI与VM销毁，不接触共享构建和串口。 */
#include "quickjs.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

void px_install_net(JSContext *ctx,JSValue native);
static unsigned fd_count(void)
{
  unsigned count=0;
  for(int fd=0;fd<1024;++fd)if(fcntl(fd,F_GETFD)!=-1||errno!=EBADF)++count;
  return count;
}
static JSValue collect(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;JS_RunGC(JS_GetRuntime(ctx));
  return JS_NewUint32(ctx,fd_count());
}
static JSValue pause_ms(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)ctx;(void)self;(void)argc;(void)argv;
  struct timespec value={0,1000000};nanosleep(&value,NULL);return JS_UNDEFINED;
}
static JSValue make_network(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;
  JSValue native=JS_NewObject(ctx);px_install_net(ctx,native);
  JSValue net=JS_GetPropertyStr(ctx,native,"net");JS_FreeValue(ctx,native);return net;
}
static int run(const char *source,size_t length,const char *path)
{
  JSRuntime *runtime=JS_NewRuntime();if(!runtime)return 2;
  JS_SetMemoryLimit(runtime,32*1024*1024);JS_SetMaxStackSize(runtime,1024*1024);
  JSContext *ctx=JS_NewContext(runtime);if(!ctx){JS_FreeRuntime(runtime);return 2;}
  JSValue global=JS_GetGlobalObject(ctx),native=JS_NewObject(ctx);
  px_install_net(ctx,native);JS_SetPropertyStr(ctx,global,"native",native);
  JS_SetPropertyStr(ctx,global,"gc",JS_NewCFunction(ctx,collect,"gc",0));
  JS_SetPropertyStr(ctx,global,"pause",JS_NewCFunction(ctx,pause_ms,"pause",0));
  JS_SetPropertyStr(ctx,global,"makeNetwork",JS_NewCFunction(ctx,make_network,"makeNetwork",0));
  JS_FreeValue(ctx,global);
  JSValue result=JS_Eval(ctx,source,length,path,JS_EVAL_TYPE_GLOBAL);
  int failed=JS_IsException(result);
  if(failed){
    JSValue error=JS_GetException(ctx),stack=JS_GetPropertyStr(ctx,error,"stack");
    const char *message=JS_ToCString(ctx,error),*trace=JS_ToCString(ctx,stack);
    fprintf(stderr,"%s\n%s\n",message?message:"JS error",trace?trace:"");
    JS_FreeCString(ctx,message);JS_FreeCString(ctx,trace);JS_FreeValue(ctx,error);JS_FreeValue(ctx,stack);
  }
  JS_FreeValue(ctx,result);JS_FreeContext(ctx);JS_FreeRuntime(runtime);return failed;
}
int main(int argc,char **argv)
{
  if(argc!=2)return 2;
  FILE *file=fopen(argv[1],"rb");if(!file||fseek(file,0,SEEK_END))return 2;
  long size=ftell(file);if(size<0||size>1024*1024||fseek(file,0,SEEK_SET))return 2;
  char *source=malloc((size_t)size+1);if(!source||fread(source,1,(size_t)size,file)!=(size_t)size)return 2;
  fclose(file);source[size]=0;unsigned baseline=fd_count();
  /* 连续创建/销毁runtime，防止静态class id或迟到worker混入下一VM。 */
  for(int iteration=0;iteration<3;++iteration){
    if(run(source,(size_t)size,argv[1])){free(source);return 1;}
    if(fd_count()!=baseline){fprintf(stderr,"VM销毁后fd泄漏：%u -> %u\n",baseline,fd_count());free(source);return 1;}
  }
  free(source);puts("网络原生绑定通过：真实QuickJS TCP/UDP回环、视图偏移/UTF-8、输入快照、错误参数、call隔离、GC及跨VM fd回收");return 0;
}
