#include "pixelbox_devd.h"
#include "quickjs.h"
#include <assert.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static volatile sig_atomic_t stopped;
static void stop_signal(int value){(void)value;stopped=1;}
static JSValue log_value(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;const char *message=argc?JS_ToCString(ctx,argv[0]):NULL;
  px_devd_log(JS_GetContextOpaque(ctx),"info","js",message?message:"");JS_FreeCString(ctx,message);return JS_UNDEFINED;
}
static JSContext *new_app(JSRuntime *runtime,struct px_devd *service,unsigned generation)
{
  JSContext *ctx=JS_NewContext(runtime);assert(ctx);JS_SetContextOpaque(ctx,service);
  JSValue global=JS_GetGlobalObject(ctx);JS_SetPropertyStr(ctx,global,"generation",JS_NewInt32(ctx,(int32_t)generation));
  JS_SetPropertyStr(ctx,global,"log",JS_NewCFunction(ctx,log_value,"log",1));JS_FreeValue(ctx,global);return ctx;
}
int main(int argc,char **argv)
{
  if(argc!=2)return 2;signal(SIGTERM,stop_signal);signal(SIGINT,stop_signal);
  struct px_devd_config config={.storage_root=argv[1],.name="fixture",.model="host",.firmware="1.0.0",.ip="127.0.0.1",.mac="00:11:22:33:44:55"};
  struct px_devd *service=NULL;int result=px_devd_start(&config,&service);if(result){fprintf(stderr,"devd start: %d\n",result);return 1;}
  printf("%u\n",px_devd_port(service));fflush(stdout);
  JSRuntime *runtime=JS_NewRuntime();assert(runtime);JS_SetMaxStackSize(runtime,512*1024);unsigned generation=1;
  JSContext *ctx=new_app(runtime,service,generation);px_devd_state(service,"running",NULL);px_devd_log(service,"info","boot","fixture ready");
  while(!stopped){
    struct px_devd_action action;
    while(px_devd_take_action(service,&action)==1){
      if(action.type==PX_DEVD_STOP){if(ctx)JS_FreeContext(ctx);ctx=NULL;px_devd_state(service,"stopped",NULL);}
      else if(action.type==PX_DEVD_PUSH_PREPARE){
        if(ctx)JS_FreeContext(ctx);ctx=NULL;
        assert(!px_devd_complete_push_pause(service,action.token,0));
      }
      else if(action.type==PX_DEVD_PUSH_COMMIT||action.type==PX_DEVD_PUSH_ABORT){
        if(ctx)JS_FreeContext(ctx);ctx=new_app(runtime,service,++generation);
        px_devd_release_push(service,action.token);px_devd_state(service,"running",NULL);
      }
      else if(action.type==PX_DEVD_RESTART){if(ctx)JS_FreeContext(ctx);ctx=new_app(runtime,service,++generation);px_devd_state(service,"running",NULL);}
      else if(action.type==PX_DEVD_EVAL){
        if(!ctx)assert(!px_devd_complete_eval(service,action.token,false,"application stopped"));
        else{JSValue value=JS_Eval(ctx,action.code,strlen(action.code),"devd:test",JS_EVAL_TYPE_GLOBAL);bool success=!JS_IsException(value);
          if(!success)value=JS_GetException(ctx);const char *text=JS_ToCString(ctx,value);
          result=px_devd_complete_eval(service,action.token,success,text?text:"");
          if(result)assert(!px_devd_complete_eval(service,action.token,false,"eval result too large"));
          JS_FreeCString(ctx,text);JS_FreeValue(ctx,value);}
      }
      px_devd_action_free(&action);
    }
    struct timespec pause={0,1000000};nanosleep(&pause,NULL);
  }
  if(ctx)JS_FreeContext(ctx);JS_FreeRuntime(runtime);px_devd_stop(service);return 0;
}
