/* 真实QuickJS/像素转换/脏区状态；仅替换NuttX framebuffer设备及板级设置。 */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <syslog.h>
#include <unistd.h>
#include "quickjs.h"
#include <nuttx/video/fb.h>

static int test_open(const char *,int,...);
static int test_close(int);
static int test_ioctl(int,unsigned long,...);
static void *test_mmap(void *,size_t,int,int,int,off_t);
static int test_munmap(void *,size_t);
static void test_syslog(int,const char *,...);
#define open test_open
#define close test_close
#define ioctl test_ioctl
#define mmap test_mmap
#define munmap test_munmap
#define syslog test_syslog
#include "../src/framebuffer.c"
#undef open
#undef close
#undef ioctl
#undef mmap
#undef munmap
#undef syslog

#define CHECK(x) do {if(!(x)){fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#x);exit(1);}}while(0)
static struct fb_videoinfo_s mock_video;
static struct fb_planeinfo_s mock_plane;
static uint8_t memory[1024*1024],displayed[1024*1024];
static struct fb_area_s updates[128];
static unsigned update_count,power_calls;
static unsigned fail_update_at;
static int power=1,rotation,brightness=80,fail_update,fail_power;
static bool opened,mapped;

static int test_open(const char *name,int flags,...)
{CHECK(!strcmp(name,"/dev/test-fb")&&flags==O_RDWR&&!opened);opened=true;return 42;}
static int test_close(int fd) {CHECK(fd==42&&opened);opened=false;return 0;}
static void *test_mmap(void *at,size_t size,int prot,int flags,int fd,off_t offset)
{CHECK(!at&&size==mock_plane.fblen&&prot==(PROT_READ|PROT_WRITE)&&flags==MAP_SHARED&&fd==42&&!offset&&!mapped);mapped=true;return memory;}
static int test_munmap(void *at,size_t size)
{CHECK(at==memory&&size==mock_plane.fblen&&mapped);mapped=false;return 0;}
static void test_syslog(int level,const char *format,...) {(void)level;(void)format;}
static int test_ioctl(int fd,unsigned long command,...)
{
  CHECK(fd==42&&opened);va_list args;va_start(args,command);int result=0;
  switch(command){
    case FBIOGET_VIDEOINFO:*(struct fb_videoinfo_s *)va_arg(args,unsigned long)=mock_video;break;
    case FBIOGET_PLANEINFO:*(struct fb_planeinfo_s *)va_arg(args,unsigned long)=mock_plane;break;
    case FBIOGET_POWER:*(int *)va_arg(args,unsigned long)=power;break;
    case FBIOSET_POWER:
      power=va_arg(args,int);++power_calls;
      if(fail_power){--fail_power;errno=EIO;result=-1;}break;
    case FBIO_UPDATE:
      CHECK(update_count<128);updates[update_count++]=*(struct fb_area_s *)va_arg(args,unsigned long);
      if(fail_update||update_count==fail_update_at) {
        if(fail_update)--fail_update;
        errno=ETIMEDOUT;result=-1;
      } else {
        const struct fb_area_s *area=&updates[update_count-1];
        CHECK((unsigned)area->x+area->w<=mock_video.xres);
        CHECK((unsigned)area->y+area->h<=mock_video.yres);
        /* 显示替身只接收成功事务，重试后逐字节确认屏幕没有遗漏任何段。 */
        for(unsigned y=area->y;y<(unsigned)area->y+area->h;++y) {
          size_t offset=y*mock_plane.stride+area->x*(mock_plane.bpp/8);
          memcpy(displayed+offset,memory+offset,area->w*(mock_plane.bpp/8));
        }
      }
      break;
    default:CHECK(false);
  }
  va_end(args);return result;
}
int pixelbox_board_display_get_rotation(void) {return rotation;}
int pixelbox_board_display_set_rotation(int value)
{
  if(value!=0&&value!=90&&value!=180&&value!=270)return -EINVAL;
  if(value!=rotation){rotation=value;for(unsigned y=0;y<mock_video.yres;++y)memset(memory+y*mock_plane.stride,0,mock_video.xres*(mock_plane.bpp/8));}
  return 0;
}
int pixelbox_board_display_get_brightness(void) {return brightness;}
int pixelbox_board_display_set_brightness(int value) {brightness=value;return 0;}

static void evaluate(JSContext *ctx,const char *source,bool expected_error)
{
  JSValue value=JS_Eval(ctx,source,strlen(source),"framebuffer-test",JS_EVAL_TYPE_GLOBAL);
  bool failed=JS_IsException(value);
  if(failed){JSValue error=JS_GetException(ctx);if(!expected_error){const char *text=JS_ToCString(ctx,error);fprintf(stderr,"%s\n",text?text:"JS error");JS_FreeCString(ctx,text);}JS_FreeValue(ctx,error);}
  JS_FreeValue(ctx,value);CHECK(failed==expected_error);
}
static void check_area(unsigned index,unsigned x,unsigned y,unsigned width,unsigned height,unsigned line)
{
  CHECK(index<update_count);
  if(updates[index].x!=x||updates[index].y!=y||updates[index].w!=width||updates[index].h!=height) {
    fprintf(stderr,"area line %u: got [%u,%u,%u,%u], expected [%u,%u,%u,%u]\n",line,
      updates[index].x,updates[index].y,updates[index].w,updates[index].h,x,y,width,height);
    CHECK(false);
  }
}
#define area(i,x,y,w,h) check_area(i,x,y,w,h,__LINE__)
static void padding(void)
{for(unsigned y=0;y<mock_video.yres;++y)for(size_t x=mock_video.xres*(mock_plane.bpp/8);x<mock_plane.stride;++x)CHECK(memory[y*mock_plane.stride+x]==0xa5);}
static JSValue detach(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{(void)self;if(argc)JS_DetachArrayBuffer(ctx,argv[0]);return JS_UNDEFINED;}
static void install(JSContext *ctx)
{
  JSValue native=JS_NewObject(ctx);px_install_framebuffer(ctx,native);
  JSValue global=JS_GetGlobalObject(ctx);CHECK(JS_SetPropertyStr(ctx,global,"native",native)>=0);
  CHECK(JS_SetPropertyStr(ctx,global,"detach",JS_NewCFunction(ctx,detach,"detach",1))>=0);
  JS_FreeValue(ctx,global);
}
static void run(int format,unsigned bpp,unsigned row_padding)
{
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=6,.yres=4};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=6*(bpp/8)+row_padding};mock_plane.fblen=mock_plane.stride*4;
  memset(memory,0xa5,sizeof(memory));for(unsigned y=0;y<4;++y)memset(memory+y*mock_plane.stride,0,6*(bpp/8));
  update_count=power_calls=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  evaluate(ctx,"globalThis.pixels=new Uint32Array(new ArrayBuffer(100),4,24);native.flush(pixels)",false);
  CHECK(update_count==1);area(0,0,0,6,4);
  CHECK(framebuffer_stats.planning_ns==0); /* 强制整帧无需规划。 */
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==1);
  CHECK(framebuffer_stats.planning_ns==0); /* 无真实变化也无需规划。 */
  evaluate(ctx,"pixels[15]=0xff0000;native.flush(pixels)",false);CHECK(update_count==2);area(1,3,2,1,1);
  evaluate(ctx,"(()=>{const s=native.frameStats();if(s.frames!==3||s.updates!==2||s.errors!==0||s.convertedPixels!==72||s.changedPixels!==1||s.lastArea.width!==1||s.lastArea.height!==1||!(s.elapsedMs>=0)||!(s.conversionMs>=0)||!(s.planningMs>=0)||!(s.updateMs>=0)||Math.abs(s.elapsedMs-s.conversionMs-s.planningMs-s.updateMs)>1e-6)throw new Error('frame stats '+JSON.stringify(s));})()",false);
  uint64_t planned=framebuffer_stats.planning_ns;
  evaluate(ctx,"native.flush(pixels,0,0,6,4,true)",false);
  CHECK(update_count==2&&framebuffer_stats.planning_ns==planned);
  size_t at=2*mock_plane.stride+3*(bpp/8);
  if(format==FB_FMT_RGB16_565){uint16_t v;memcpy(&v,memory+at,2);CHECK(v==0xf800);}
  else if(format==FB_FMT_RGB24){CHECK(memory[at]==0&&memory[at+1]==0&&memory[at+2]==0xff);}
  else {uint32_t v;memcpy(&v,memory+at,4);CHECK(v==0xff0000);}
  padding();evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==2);
  if(format==FB_FMT_RGB16_565){evaluate(ctx,"pixels[15]=0xf90001;native.flush(pixels)",false);CHECK(update_count==2);}

  // 同一画面重试必须继续发送；mmap已改色不能作为已传输成功的依据。
  fail_update=1;evaluate(ctx,"pixels[1]=0x00ff00;native.flush(pixels)",true);CHECK(update_count==3);area(2,1,0,1,1);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==4);area(3,1,0,1,1);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==4);
  fail_update=1;evaluate(ctx,"pixels[0]=0xffffff;native.flush(pixels)",true);area(4,0,0,1,1);
  evaluate(ctx,"pixels[23]=0x0000ff;native.flush(pixels)",false);CHECK(update_count==6);area(5,0,0,6,4);

  // 参数错误不会修改映射/脏状态。
  evaluate(ctx,"native.flush(new Uint32Array(23))",true);
  evaluate(ctx,"native.flush(new Uint8Array(96))",true);CHECK(update_count==6);
  for(unsigned field=1;field<5;++field) {
    char code[384];snprintf(code,sizeof(code),
      "(()=>{const p=new Uint32Array(24),a=[p,0,0,6,4],v=a[%u];a[%u]={valueOf(){detach(p.buffer);return v;}};native.flush(...a);})()",field,field);
    evaluate(ctx,code,true);CHECK(update_count==6);
  }
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==6);
  // 四个方向转换后板级映射已清零；新黑画布必须仍提交整屏。
  const int turns[]={90,180,270,0};
  for(unsigned i=0;i<4;++i){char code[128];snprintf(code,sizeof(code),"native.setRotation(%d);pixels.fill(0);native.flush(pixels)",turns[i]);
    evaluate(ctx,code,false);area(6+i,0,0,6,4);
    snprintf(code,sizeof(code),"native.setRotation(%d);native.flush(pixels)",turns[i]);evaluate(ctx,code,false);CHECK(update_count==7+i);}
  evaluate(ctx,"native.setRotation(45)",true);evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==10);

  evaluate(ctx,"native.setPower(false);native.setPower(true);native.flush(pixels)",false);area(10,0,0,6,4);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==11);
  // 电源设置部分成功但驱动补帧失败，后续flush仍强制整帧。
  fail_power=1;evaluate(ctx,"native.setPower(true)",true);
  fail_update=1;evaluate(ctx,"native.flush(pixels)",true);area(11,0,0,6,4);
  evaluate(ctx,"native.flush(pixels)",false);area(12,0,0,6,4);
  CHECK(!px_toggle_framebuffer_power()&&power==0);
  fail_power=1;CHECK(px_toggle_framebuffer_power()==-EIO&&power==1);
  evaluate(ctx,"native.flush(pixels)",false);area(13,0,0,6,4);padding();

  px_close_framebuffer();CHECK(!opened&&!mapped);install(ctx);
  fail_update=1;evaluate(ctx,"native.flush(pixels)",true);area(14,0,0,6,4);
  evaluate(ctx,"native.flush(pixels)",false);area(15,0,0,6,4);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==16);
  px_close_framebuffer();CHECK(!opened&&!mapped);JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void run565_pairs(unsigned row_padding)
{
  mock_video=(struct fb_videoinfo_s){.fmt=FB_FMT_RGB16_565,.xres=17,.yres=7};
  mock_plane=(struct fb_planeinfo_s){.bpp=16,.stride=34+row_padding};
  mock_plane.fblen=mock_plane.stride*7;
  memset(memory,0xa5,sizeof(memory));
  for(unsigned y=0;y<7;++y)memset(memory+y*mock_plane.stride,0,34);
  update_count=power_calls=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  evaluate(ctx,"globalThis.pixels=new Uint32Array(119);native.flush(pixels)",false);
  JSValue global=JS_GetGlobalObject(ctx),array=JS_GetPropertyStr(ctx,global,"pixels");
  size_t offset,size,element,capacity;
  JSValue owner=JS_GetTypedArrayBuffer(ctx,array,&offset,&size,&element);
  uint32_t *source=(uint32_t *)(void *)(JS_GetArrayBuffer(ctx,&capacity,owner)+offset);
  uint16_t expected[119]={0};uint32_t random=0x943759a1;
  /* 覆盖奇偶首尾和三种stride；重复像素对命中缓存也必须精确统计脏区。 */
  for(unsigned frame=0;frame<256;++frame) {
    unsigned x0=frame%17,y0=(frame/17)%7,w=1+(frame*7)%20,h=1+(frame*3)%9;
    unsigned x1=x0+w<17?x0+w:17,y1=y0+h<7?y0+h:7;
    unsigned changed=0,bx0=17,by0=7,bx1=0,by1=0;
    for(unsigned y=0;y<7;++y)for(unsigned x=0;x<17;++x) {
      random=random*1664525+1013904223;
      switch(frame%8) {
        case 0: source[y*17+x]=0xffffff;break;
        case 1: source[y*17+x]=0;break; /* 初始黑色缓存仍须覆盖旧白色映射。 */
        case 2: source[y*17+x]=x&1?0xf9a630:0x123456;break;
        case 3: source[y*17+x]=(x/4+y)%2?0x17f5f5:0x0d1210;break;
        case 4: source[y*17+x]^=0x010101;break; /* 原RGB变动但565可能不变。 */
        case 5: source[y*17+x]=(random&0xff000000)|0x112233;break;
        default: source[y*17+x]=random&0xffffff;break;
      }
      if(x<x0||x>=x1||y<y0||y>=y1)continue;
      uint32_t rgb=source[y*17+x];
      uint16_t value=(uint16_t)((((rgb>>16)&255)>>3)*2048+
        (((rgb>>8)&255)>>2)*32+((rgb&255)>>3));
      if(expected[y*17+x]!=value) {
        ++changed;expected[y*17+x]=value;
        if(x<bx0)bx0=x;if(y<by0)by0=y;
        if(x+1>bx1)bx1=x+1;if(y+1>by1)by1=y+1;
      }
    }
    uint64_t previous_changed=framebuffer_stats.changed_pixels;
    uint64_t previous_converted=framebuffer_stats.converted_pixels;
    update_count=0;char code[128];
    snprintf(code,sizeof(code),"native.flush(pixels,%u,%u,%u,%u)",x0,y0,w,h);
    evaluate(ctx,code,false);
    CHECK(framebuffer_stats.changed_pixels-previous_changed==changed);
    CHECK(framebuffer_stats.converted_pixels-previous_converted==(x1-x0)*(y1-y0));
    CHECK(update_count==(changed?1u:0u));
    if(changed)area(0,bx0,by0,bx1-bx0,by1-by0);
    for(unsigned y=0;y<7;++y)for(unsigned x=0;x<17;++x) {
      uint16_t actual;memcpy(&actual,memory+y*mock_plane.stride+x*2,2);
      CHECK(actual==expected[y*17+x]);
    }
    padding();
  }
  JS_FreeValue(ctx,owner);JS_FreeValue(ctx,array);JS_FreeValue(ctx,global);
  px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void run_known_clean(void)
{
  mock_video=(struct fb_videoinfo_s){.fmt=FB_FMT_RGB16_565,.xres=6,.yres=4};
  mock_plane=(struct fb_planeinfo_s){.bpp=16,.stride=12,.fblen=48};
  memset(memory,0,sizeof(memory));update_count=power_calls=0;
  rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  /* 即使调用者标记未绘图，初始全屏与亮屏/旋转保护仍优先。 */
  evaluate(ctx,"globalThis.pixels=new Uint32Array(24);native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==1&&framebuffer_stats.converted_pixels==24);area(0,0,0,6,4);
  uint64_t conversion_ns=framebuffer_stats.conversion_ns;
  uint64_t planning_ns=framebuffer_stats.planning_ns;
  uint64_t update_ns=framebuffer_stats.update_ns;
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==1&&framebuffer_stats.frames==2&&framebuffer_stats.converted_pixels==24);
  CHECK(framebuffer_stats.conversion_ns==conversion_ns&&
        framebuffer_stats.planning_ns==planning_ns&&framebuffer_stats.update_ns==update_ns);
  /* 脏映射在传输失败后必须重试，无新像素也不能吞掉pending区域。 */
  fail_update=1;evaluate(ctx,"pixels[8]=0xff0000;native.flush(pixels,2,1,1,1)",true);
  CHECK(update_count==2&&framebuffer_stats.converted_pixels==25);area(1,2,1,1,1);
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==3&&framebuffer_stats.converted_pixels==25);area(2,2,1,1,1);
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",false);CHECK(update_count==3);
  evaluate(ctx,"native.setPower(true);native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==4&&framebuffer_stats.converted_pixels==49);area(3,0,0,6,4);
  evaluate(ctx,"native.setRotation(90);native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==5&&framebuffer_stats.converted_pixels==73);area(4,0,0,6,4);
  /* 标志不会跳过buffer验证；显式单参数flush继续发现直接改写的像素。 */
  evaluate(ctx,"native.flush(new Uint32Array(23),0,0,0,0,true)",true);
  evaluate(ctx,"(()=>{const p=new Uint32Array(24);detach(p.buffer);native.flush(p,0,0,0,0,true);})()",true);
  CHECK(update_count==5&&framebuffer_stats.converted_pixels==73);
  evaluate(ctx,"pixels[23]=0x00ff00;native.flush(pixels)",false);
  CHECK(update_count==6&&framebuffer_stats.converted_pixels==97);area(5,5,3,1,1);
  px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void display_matches_mapping(void);

static void run_solid_change(void)
{
  mock_video=(struct fb_videoinfo_s){.fmt=FB_FMT_RGB16_565,.xres=64,.yres=64};
  mock_plane=(struct fb_planeinfo_s){.bpp=16,.stride=128,.fblen=8192};
  memset(memory,0,sizeof(memory));memset(displayed,0,sizeof(displayed));
  update_count=power_calls=fail_update_at=0;
  rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  evaluate(ctx,"globalThis.pixels=new Uint32Array(4096);native.flush(pixels)",false);
  CHECK(update_count==1);area(0,0,0,64,64);
  uint64_t planning_ns=framebuffer_stats.planning_ns;
  uint64_t changed=framebuffer_stats.changed_pixels;
  uint64_t transmitted=framebuffer_stats.transmitted_pixels;
  /* 整块每个像素都变化时，二维拆分不可能降低传输面积。 */
  evaluate(ctx,"pixels.fill(0xffffff);native.flush(pixels)",false);
  CHECK(update_count==2&&framebuffer_stats.changed_pixels-changed==4096);
  CHECK(framebuffer_stats.planning_ns==planning_ns);
  CHECK(framebuffer_stats.transmitted_pixels-transmitted==4096);
  area(1,0,0,64,64);display_matches_mapping();
  px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void display_matches_mapping(void)
{
  for(unsigned y=0;y<mock_video.yres;++y)
    CHECK(!memcmp(displayed+y*mock_plane.stride,memory+y*mock_plane.stride,
                  mock_video.xres*(mock_plane.bpp/8)));
}

static void run_bands(int format,unsigned bpp,unsigned row_padding)
{
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=12,.yres=96};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=12*(bpp/8)+row_padding};
  mock_plane.fblen=mock_plane.stride*96;CHECK(mock_plane.fblen<=sizeof(memory));
  memset(memory,0xa5,sizeof(memory));memset(displayed,0x5a,sizeof(displayed));
  for(unsigned y=0;y<96;++y)memset(memory+y*mock_plane.stride,0,12*(bpp/8));
  update_count=power_calls=fail_update_at=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  evaluate(ctx,"globalThis.pixels=new Uint32Array(1152);native.flush(pixels)",false);
  CHECK(update_count==1);area(0,0,0,12,96);display_matches_mapping();

  /* 小而精确的行带不能因网格对齐而增大发送面积。 */
  evaluate(ctx,"pixels[2*12+5]=pixels[10*12+9]=0xff0000;native.flush(pixels)",false);
  CHECK(update_count==2);area(1,5,2,5,9);
  evaluate(ctx,"pixels[20*12+8]=pixels[29*12+3]=pixels[30*12+10]=0x00ff00;native.flush(pixels)",false);
  CHECK(update_count==4);area(2,8,20,1,1);area(3,3,29,8,2);display_matches_mapping();
  evaluate(ctx,"(()=>{const s=native.frameStats();if(s.frames!==3||s.updates!==3||s.errors!==0||s.transactions!==4||s.transmittedPixels!==1214||s.changedPixels!==5||s.lastArea.x!==3||s.lastArea.y!==20||s.lastArea.width!==8||s.lastArea.height!==11)throw new Error('band stats '+JSON.stringify(s));})()",false);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==4);

  evaluate(ctx,"for(let i=0;i<8;i++)pixels[(4+10*i)*12+i+1]=0x0000ff;native.flush(pixels)",false);
  CHECK(update_count==12);
  for(unsigned i=0;i<8;++i)area(4+i,i+1,4+10*i,1,1);
  uint64_t transmitted=framebuffer_stats.transmitted_pixels;
  evaluate(ctx,"for(let i=0;i<9;i++)pixels[(6+10*i)*12+i+2]=0xffffff;native.flush(pixels)",false);
  /* 超过八条行带不再必然发送整块并集，所有碎片仍须完整上屏。 */
  CHECK(update_count>12&&update_count<=12+FRAMEBUFFER_MAX_RECTS);
  CHECK(framebuffer_stats.transmitted_pixels-transmitted<9*81);display_matches_mapping();
  CHECK(framebuffer_stats.frames==6&&framebuffer_stats.updates==5&&framebuffer_stats.changed_pixels==22);

  unsigned at=update_count;
  evaluate(ctx,"native.setPower(true);pixels[13]=pixels[90*12+10]=0xffffff;native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==at+1);area(at,0,0,12,96);
  evaluate(ctx,"native.setRotation(90);pixels.fill(0);native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==at+2);area(at+1,0,0,12,96);display_matches_mapping();

  /* 第二段失败：第一段已发送、第三段未发送；零扫描必须完整补发并集。 */
  at=update_count;fail_update_at=at+2;
  uint64_t transactions=framebuffer_stats.transactions;
  evaluate(ctx,"pixels[3*12+2]=pixels[20*12+8]=pixels[80*12+5]=0xffffff;native.flush(pixels)",true);
  CHECK(update_count==at+2);area(at,2,3,1,1);area(at+1,8,20,1,1);
  CHECK(framebuffer_stats.errors==1&&framebuffer_stats.transactions==transactions+1);
  uint64_t converted=framebuffer_stats.converted_pixels;
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",false);
  CHECK(update_count==at+3&&framebuffer_stats.converted_pixels==converted);
  area(at+2,2,3,7,78);display_matches_mapping();
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==at+3);

  /* 重试同时发现新像素时，旧成功段/失败段/未发送段均不能丢失。 */
  at=update_count;fail_update_at=at+2;
  evaluate(ctx,"pixels[3*12+2]=pixels[20*12+8]=pixels[80*12+5]=0x00ff00;native.flush(pixels)",true);
  CHECK(update_count==at+2);area(at,2,3,1,1);area(at+1,8,20,1,1);
  evaluate(ctx,"pixels[12]=pixels[94*12+11]=0xff0000;native.flush(pixels)",false);
  CHECK(update_count==at+3);area(at+2,0,1,12,94);display_matches_mapping();
  CHECK(framebuffer_stats.frames==13&&framebuffer_stats.updates==9&&framebuffer_stats.errors==2);

  /* 最后一段及其第一次重试失败，pending必须保留到成功。 */
  at=update_count;fail_update_at=at+3;
  evaluate(ctx,"pixels[4*12+2]=pixels[30*12+3]=pixels[70*12+4]=0xffffff;native.flush(pixels)",true);
  CHECK(update_count==at+3);area(at,2,4,1,1);area(at+1,3,30,1,1);area(at+2,4,70,1,1);
  fail_update=1;evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",true);
  CHECK(update_count==at+4);area(at+3,2,4,3,67);
  evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==at+5);area(at+4,2,4,3,67);
  display_matches_mapping();padding();
  evaluate(ctx,"native.flush(pixels);(()=>{const s=native.frameStats();if(s.frames!==17||s.updates!==10||s.errors!==4||s.updates>s.frames||s.lastArea.x!==2||s.lastArea.y!==4||s.lastArea.width!==3||s.lastArea.height!==67)throw new Error('final band stats '+JSON.stringify(s));})()",false);
  CHECK(update_count==at+5);
  fail_update_at=0;px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void rejected_without_write(JSContext *ctx,const char *source)
{
  uint8_t before[sizeof(memory)],stats[sizeof(framebuffer_stats)];
  memcpy(before,memory,sizeof(before));memcpy(stats,&framebuffer_stats,sizeof(stats));
  unsigned count=update_count,x0=dirty_x0,y0=dirty_y0,x1=dirty_x1,y1=dirty_y1;
  bool dirty=framebuffer_dirty,force=framebuffer_force_full;
  evaluate(ctx,source,true);
  CHECK(!memcmp(before,memory,sizeof(before))&&!memcmp(stats,&framebuffer_stats,sizeof(stats)));
  CHECK(update_count==count&&framebuffer_dirty==dirty&&framebuffer_force_full==force);
  CHECK(dirty_x0==x0&&dirty_y0==y0&&dirty_x1==x1&&dirty_y1==y1);
}

static void expect_pixel(unsigned x,unsigned y,uint32_t rgb)
{
  const uint8_t *at=memory+y*mock_plane.stride+x*(mock_plane.bpp/8);
  if(mock_video.fmt==FB_FMT_RGB16_565) {
    uint16_t actual;memcpy(&actual,at,2);
    uint16_t expected=(uint16_t)((((rgb>>16)&255)>>3)*2048+
      (((rgb>>8)&255)>>2)*32+((rgb&255)>>3));
    CHECK(actual==expected);
  } else if(mock_video.fmt==FB_FMT_RGB24) {
    CHECK(at[0]==(uint8_t)rgb&&at[1]==(uint8_t)(rgb>>8)&&at[2]==(uint8_t)(rgb>>16));
  } else {uint32_t actual;memcpy(&actual,at,4);CHECK(actual==rgb);}
}

static void run_rows(int format,unsigned bpp,unsigned row_padding)
{
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=12,.yres=96};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=12*(bpp/8)+row_padding};
  mock_plane.fblen=mock_plane.stride*96;CHECK(mock_plane.fblen<=sizeof(memory));
  memset(memory,0xa5,sizeof(memory));memset(displayed,0x5a,sizeof(displayed));
  for(unsigned y=0;y<96;++y)memset(memory+y*mock_plane.stride,0,12*(bpp/8));
  update_count=power_calls=fail_update_at=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  /* 两个非零offset视图；tracker只保证2字节对齐，不依赖JS的可覆盖属性。 */
  evaluate(ctx,"globalThis.pixels=new Uint32Array(new ArrayBuffer(4616),4,1152);"
    "globalThis.rows=new Uint16Array(new ArrayBuffer(388),2,192);"
    "native.flush(pixels,0,0,12,96,false,rows)",false);
  CHECK(update_count==1&&framebuffer_stats.converted_pixels==1152);area(0,0,0,12,96);
  evaluate(ctx,"Object.defineProperty(rows,'length',{get(){throw new Error('length getter');}});"
    "Object.defineProperty(rows,'byteLength',{get(){throw new Error('byteLength getter');}});"
    "pixels.fill(0xffffff);rows[4]=2;rows[5]=4;rows[8]=1;rows[9]=1;"
    "rows[40]=8;rows[41]=11;rows[190]=12;rows[191]=12;"
    "native.flush(pixels,2,1,8,40,false,rows)",false);
  CHECK(framebuffer_stats.converted_pixels==1157&&framebuffer_stats.changed_pixels==5);
  CHECK(update_count==3);area(1,2,2,2,1);area(2,7,20,3,1);
  for(unsigned y=0;y<96;++y)for(unsigned x=0;x<12;++x)
    expect_pixel(x,y,(y==2&&x>=2&&x<4)||(y==20&&x>=7&&x<10)?0xffffff:0);
  display_matches_mapping();padding();
  evaluate(ctx,"if(rows[4]!==2||rows[41]!==11||rows[191]!==12)throw new Error('C cleared tracker');"
    "rows.fill(0);native.flush(pixels,0,0,12,96,false,rows)",false);
  CHECK(update_count==3&&framebuffer_stats.converted_pixels==1157);

  /* 验证整份tracker，包括bbox之外的末行，错误不能留下半帧映射或统计变化。 */
  const char *bad_types[]={"new Uint32Array(192)","new Uint8Array(384)",
    "new DataView(new ArrayBuffer(384))","null","new Uint16Array(191)","new Uint16Array(193)"};
  for(unsigned i=0;i<sizeof(bad_types)/sizeof(bad_types[0]);++i) {
    char code[256];snprintf(code,sizeof(code),"native.flush(pixels,0,0,12,1,false,%s)",bad_types[i]);
    rejected_without_write(ctx,code);
  }
  const unsigned invalid[][2]={{0,1},{1,0},{5,4},{1,13},{13,13}};
  for(unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);++i) {
    char code[320];snprintf(code,sizeof(code),
      "(()=>{const r=new Uint16Array(192);r[0]=1;r[1]=12;r[190]=%u;r[191]=%u;"
      "native.flush(pixels,0,0,12,1,false,r);})()",invalid[i][0],invalid[i][1]);
    rejected_without_write(ctx,code);
  }
  for(unsigned victim=0;victim<2;++victim) {
    char code[512];snprintf(code,sizeof(code),
      "(()=>{const p=new Uint32Array(1152),r=new Uint16Array(192);detach(%s.buffer);"
      "native.flush(p,0,0,12,96,false,r);})()",victim?"r":"p");
    rejected_without_write(ctx,code);
    for(unsigned field=1;field<5;++field) {
      snprintf(code,sizeof(code),
        "(()=>{const p=new Uint32Array(1152),r=new Uint16Array(192),a=[p,0,0,12,96,false,r],v=a[%u];"
        "a[%u]={valueOf(){detach(%s.buffer);return v;}};native.flush(...a);})()",
        field,field,victim?"r":"p");
      rejected_without_write(ctx,code);
    }
  }
  /* 即使视图互不重叠也拒绝共享owner，避免输入像素被范围写入别名污染。 */
  rejected_without_write(ctx,"(()=>{const b=new ArrayBuffer(4992),p=new Uint32Array(b,0,1152),"
    "r=new Uint16Array(b,4608,192);native.flush(p,0,0,12,96,false,r);})()");
  rejected_without_write(ctx,"(()=>{const b=new ArrayBuffer(4608),p=new Uint32Array(b),"
    "r=new Uint16Array(b,0,192);native.flush(p,0,0,12,96,false,r);})()");
  /* valueOf中改坏末行，必须在转换结束后整体校验，不能提前信任tracker。 */
  rejected_without_write(ctx,"(()=>{const r=new Uint16Array(192);native.flush(pixels,"
    "{valueOf(){r[191]=1;return 0;}},0,12,1,false,r);})()");

  /* getter内重入flush再亮屏，外层必须重新观察force状态并扫描全屏。 */
  uint64_t converted=framebuffer_stats.converted_pixels;
  evaluate(ctx,"pixels.fill(0x00ff00);native.flush(pixels,{valueOf(){"
    "native.flush(pixels,0,0,0,0,true);native.setPower(true);return 2;}},1,3,2,false,rows)",false);
  CHECK(update_count==4&&framebuffer_stats.converted_pixels==converted+1152);area(3,0,0,12,96);
  for(unsigned y=0;y<96;++y)for(unsigned x=0;x<12;++x)expect_pixel(x,y,0x00ff00);
  /* force与known_clean只忽略扫描限制，不能绕过tracker验证。 */
  evaluate(ctx,"native.setPower(true)",false);
  rejected_without_write(ctx,"(()=>{const r=new Uint16Array(192);r[191]=1;"
    "native.flush(pixels,0,0,0,0,true,r);})()");
  CHECK(framebuffer_force_full);
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true,rows);"
    "native.setRotation(90);pixels.fill(0);native.flush(pixels,0,0,0,0,true,rows)",false);
  CHECK(update_count==6);area(4,0,0,12,96);area(5,0,0,12,96);display_matches_mapping();
  rejected_without_write(ctx,"native.flush(pixels,0,0,0,0,true,new Uint16Array(191))");

  /* 第二段失败：C保留完整pending，JS tracker保持原样，零扫描也能补发漏段。 */
  converted=framebuffer_stats.converted_pixels;fail_update_at=update_count+2;
  evaluate(ctx,"rows.fill(0);rows[6]=3;rows[7]=3;rows[40]=9;rows[41]=9;rows[160]=6;rows[161]=6;"
    "pixels[38]=pixels[248]=pixels[965]=0xffffff;native.flush(pixels,0,0,12,96,false,rows)",true);
  CHECK(update_count==8&&framebuffer_stats.converted_pixels==converted+3);
  area(6,2,3,1,1);area(7,8,20,1,1);
  evaluate(ctx,"if(rows[6]!==3||rows[41]!==9||rows[160]!==6)throw new Error('failure cleared rows');"
    "native.flush(pixels,0,0,0,0,true,rows)",false);
  CHECK(update_count==9&&framebuffer_stats.converted_pixels==converted+3);
  area(8,2,3,7,78);display_matches_mapping();
  /* 失败后添加新稀疏范围，重试并集要保留旧成功段、失败段及未发送段。 */
  fail_update_at=update_count+2;converted=framebuffer_stats.converted_pixels;
  evaluate(ctx,"pixels[38]=pixels[248]=pixels[965]=0x00ff00;"
    "native.flush(pixels,0,0,12,96,false,rows)",true);
  CHECK(update_count==11&&framebuffer_stats.converted_pixels==converted+3);
  evaluate(ctx,"rows[2]=1;rows[3]=1;rows[188]=12;rows[189]=12;"
    "pixels[12]=pixels[1139]=0xff0000;native.flush(pixels,0,0,12,96,false,rows)",false);
  CHECK(update_count==12&&framebuffer_stats.converted_pixels==converted+8);
  area(11,0,1,12,94);display_matches_mapping();padding();
  /* 未传tracker的手动flush保持全屏扫描，发现直接改写的未标记像素。 */
  converted=framebuffer_stats.converted_pixels;
  evaluate(ctx,"rows.fill(0);pixels[1140]=0x0000ff;native.flush(pixels)",false);
  CHECK(update_count==13&&framebuffer_stats.converted_pixels==converted+1152);area(12,0,95,1,1);
  display_matches_mapping();padding();
  fail_update_at=0;px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void run_blocks_validation(int format,unsigned bpp,unsigned row_padding)
{
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=269,.yres=40};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=269*(bpp/8)+row_padding};
  mock_plane.fblen=mock_plane.stride*40;CHECK(mock_plane.fblen<=sizeof(memory));
  memset(memory,0xa5,sizeof(memory));memset(displayed,0x5a,sizeof(displayed));
  for(unsigned y=0;y<40;++y)memset(memory+y*mock_plane.stride,0,269*(bpp/8));
  update_count=power_calls=fail_update_at=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  evaluate(ctx,"globalThis.pixels=new Uint32Array(new ArrayBuffer(43048),4,10760);"
    "globalThis.rows=new Uint16Array(new ArrayBuffer(164),2,80);"
    "globalThis.blocks=new Uint32Array(new ArrayBuffer(328),4,80);"
    "native.flush(pixels,0,0,269,40,false,rows,blocks)",false);
  CHECK(update_count==1&&framebuffer_stats.converted_pixels==10760);area(0,0,0,269,40);
  /* 两行间隔超过纵向合并阈值；横向块与bbox、行范围求交。 */
  evaluate(ctx,"pixels.fill(0xffffff);rows[0]=6;rows[1]=22;rows[18]=251;rows[19]=269;"
    "blocks[0]=5;blocks[18]=0x80000000;blocks[19]=3;"
    "native.flush(pixels,3,0,263,10,false,rows,blocks)",false);
  CHECK(update_count==3&&framebuffer_stats.converted_pixels==10785&&framebuffer_stats.changed_pixels==25);
  CHECK(framebuffer_stats.frames==2&&framebuffer_stats.transmitted_pixels<10760+100);
  for(unsigned y=0;y<40;++y)for(unsigned x=0;x<269;++x)
    expect_pixel(x,y,(y==0&&((x>=5&&x<8)||(x>=16&&x<22)))||(y==9&&x>=250&&x<266)?0xffffff:0);
  display_matches_mapping();padding();
  evaluate(ctx,"if(blocks[0]!==5||blocks[18]!==0x80000000||blocks[19]!==3)throw new Error('C clears bits');"
    "blocks.fill(0);native.flush(pixels,0,0,269,40,false,undefined,blocks)",false);
  CHECK(update_count==3&&framebuffer_stats.converted_pixels==10785);
  /* 单独bits无需rows；窄屏同行两端变化时，一次开窗的固定成本更低。 */
  evaluate(ctx,"blocks[4]=1;blocks[5]=2;native.flush(pixels,0,2,269,1,false,undefined,blocks)",false);
  CHECK(update_count==4&&framebuffer_stats.converted_pixels==10798);
  area(3,0,2,269,1);
  expect_pixel(0,2,0xffffff);expect_pixel(7,2,0xffffff);expect_pixel(8,2,0);expect_pixel(268,2,0xffffff);

  /* 全表校验：末行高bit即使不在bbox内也必须拒绝，任何错误均无部分写入。 */
  const char *invalid_types[]={"null","new Uint16Array(160)","new Uint8Array(320)",
    "new DataView(new ArrayBuffer(320))","new Uint32Array(79)","new Uint32Array(81)"};
  for(unsigned i=0;i<sizeof(invalid_types)/sizeof(invalid_types[0]);++i) {
    char code[256];snprintf(code,sizeof(code),"native.flush(pixels,0,0,269,1,false,rows,%s)",invalid_types[i]);
    rejected_without_write(ctx,code);
  }
  for(unsigned bit=2;bit<32;++bit) {
    char code[300];snprintf(code,sizeof(code),
      "(()=>{const b=new Uint32Array(80);b[0]=1;b[79]=2**%u;native.flush(pixels,0,0,269,1,false,undefined,b);})()",bit);
    rejected_without_write(ctx,code);
  }
  for(unsigned victim=0;victim<3;++victim) {
    const char *name=victim==0?"p":victim==1?"r":"b";
    char code[512];snprintf(code,sizeof(code),
      "(()=>{const p=new Uint32Array(10760),r=new Uint16Array(80),b=new Uint32Array(80);"
      "detach(%s.buffer);native.flush(p,0,0,269,40,false,r,b);})()",name);
    rejected_without_write(ctx,code);
    for(unsigned field=1;field<5;++field) {
      snprintf(code,sizeof(code),"(()=>{const p=new Uint32Array(10760),r=new Uint16Array(80),b=new Uint32Array(80),"
        "a=[p,0,0,269,40,false,r,b],v=a[%u];a[%u]={valueOf(){detach(%s.buffer);return v;}};native.flush(...a);})()",
        field,field,name);
      rejected_without_write(ctx,code);
    }
  }
  rejected_without_write(ctx,"(()=>{const owner=new ArrayBuffer(43360),p=new Uint32Array(owner,0,10760),"
    "b=new Uint32Array(owner,43040,80);native.flush(p,0,0,269,40,false,undefined,b);})()");
  rejected_without_write(ctx,"(()=>{const owner=new ArrayBuffer(43040),p=new Uint32Array(owner),"
    "b=new Uint32Array(owner,0,80);native.flush(p,0,0,269,40,false,undefined,b);})()");
  rejected_without_write(ctx,"(()=>{const owner=new ArrayBuffer(480),r=new Uint16Array(owner,0,80),"
    "b=new Uint32Array(owner,160,80);native.flush(pixels,0,0,269,40,false,r,b);})()");
  rejected_without_write(ctx,"(()=>{const owner=new ArrayBuffer(320),r=new Uint16Array(owner,0,80),"
    "b=new Uint32Array(owner);native.flush(pixels,0,0,269,40,false,r,b);})()");
  rejected_without_write(ctx,"(()=>{const b=new Uint32Array(80);native.flush(pixels,{valueOf(){b[79]=4;return 0;}},"
    "0,269,1,false,undefined,b);})()");
  rejected_without_write(ctx,"(()=>{const b=new Uint32Array(80);b[79]=4;"
    "native.flush(pixels,0,0,0,0,true,undefined,b);})()");
  /* 劫持JS属性不能更改原生typed array视图；同次调用重入亮屏应全屏扫描。 */
  evaluate(ctx,"Object.defineProperty(blocks,'length',{get(){throw new Error('length');}});"
    "Object.defineProperty(blocks,'buffer',{get(){throw new Error('buffer');}});"
    "blocks.fill(0);rows.fill(0);pixels.fill(0x00ff00);native.flush(pixels,"
    "{valueOf(){native.flush(pixels,0,0,0,0,true,rows,blocks);native.setPower(true);return 1;}},0,2,1,false,rows,blocks)",false);
  CHECK(update_count==5&&framebuffer_stats.converted_pixels==21558);area(4,0,0,269,40);
  evaluate(ctx,"native.setPower(true)",false);
  rejected_without_write(ctx,"(()=>{const b=new Uint32Array(80);b[79]=4;native.flush(pixels,0,0,0,0,true,rows,b);})()");
  CHECK(framebuffer_force_full);
  evaluate(ctx,"native.flush(pixels,0,0,0,0,true,rows,blocks);native.setRotation(90);"
    "pixels.fill(0);native.flush(pixels,0,0,0,0,true,rows,blocks)",false);
  CHECK(update_count==7);area(5,0,0,269,40);area(6,0,0,269,40);
  display_matches_mapping();padding();

  /* 第二纵向段失败后保留整个pending；干净帧不扫描仍补发第三个未发送段。 */
  uint64_t converted=framebuffer_stats.converted_pixels;fail_update_at=update_count+2;
  evaluate(ctx,"rows[6]=3;rows[7]=3;rows[40]=257;rows[41]=257;rows[78]=269;rows[79]=269;"
    "blocks[6]=1;blocks[41]=1;blocks[79]=2;pixels[809]=pixels[5636]=pixels[10759]=0xffffff;"
    "native.flush(pixels,0,0,269,40,false,rows,blocks)",true);
  CHECK(update_count==9&&framebuffer_stats.converted_pixels==converted+3);area(7,2,3,1,1);area(8,256,20,1,1);
  evaluate(ctx,"if(blocks[6]!==1||blocks[41]!==1||blocks[79]!==2)throw new Error('failed bits cleared');"
    "native.flush(pixels,0,0,0,0,true,rows,blocks)",false);
  CHECK(update_count==10&&framebuffer_stats.converted_pixels==converted+3);area(9,2,3,267,37);display_matches_mapping();
  /* 新块扩展重试并集，既往成功/失败/未发送段均不丢失。 */
  fail_update_at=update_count+2;
  evaluate(ctx,"pixels[809]=pixels[5636]=pixels[10759]=0x00ff00;native.flush(pixels,0,0,269,40,false,rows,blocks)",true);
  CHECK(update_count==12);
  evaluate(ctx,"rows[0]=1;rows[1]=1;blocks[0]=1;pixels[0]=0xff0000;"
    "native.flush(pixels,0,0,269,40,false,rows,blocks)",false);
  CHECK(update_count==13&&framebuffer_stats.converted_pixels==converted+10);area(12,0,0,269,40);display_matches_mapping();
  converted=framebuffer_stats.converted_pixels;
  evaluate(ctx,"blocks.fill(0);rows.fill(0);pixels[100]=0x0000ff;native.flush(pixels)",false);
  CHECK(update_count==14&&framebuffer_stats.converted_pixels==converted+10760);area(13,100,0,1,1);
  display_matches_mapping();padding();
  fail_update_at=0;px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static uint8_t *typed_data(JSContext *ctx,const char *name,JSValue *view,JSValue *owner)
{
  JSValue global=JS_GetGlobalObject(ctx);*view=JS_GetPropertyStr(ctx,global,name);JS_FreeValue(ctx,global);
  size_t offset,size,element,capacity;
  *owner=JS_GetTypedArrayBuffer(ctx,*view,&offset,&size,&element);CHECK(!JS_IsException(*owner));
  uint8_t *base=JS_GetArrayBuffer(ctx,&capacity,*owner);CHECK(base&&offset<=capacity&&size<=capacity-offset);
  return base+offset;
}

static void run_spatial_grid(int format,unsigned bpp,unsigned row_padding,
                            unsigned width,unsigned height)
{
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=width,.yres=height};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=width*(bpp/8)+row_padding};
  mock_plane.fblen=mock_plane.stride*height;CHECK(mock_plane.fblen<=sizeof(memory));
  memset(memory,0xa5,sizeof(memory));memset(displayed,0x5a,sizeof(displayed));
  for(unsigned y=0;y<height;++y)memset(memory+y*mock_plane.stride,0,width*(bpp/8));
  update_count=power_calls=fail_update_at=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  char code[128];snprintf(code,sizeof(code),"globalThis.pixels=new Uint32Array(%u);native.flush(pixels)",width*height);
  evaluate(ctx,code,false);area(0,0,0,width,height);
  JSValue view,owner;uint32_t *pixels=(uint32_t *)(void *)typed_data(ctx,"pixels",&view,&owner);

  /* 逐像素核对真实尺寸的列表式左右两列；八个不同滚动偏移覆盖网格边缘。 */
  if(width==480&&height==480)for(unsigned frame=0;frame<8;++frame) {
    memset(pixels,0,width*height*sizeof(*pixels));
    for(unsigned row=0;row<8;++row)for(unsigned y=32+row*52+frame;y<52+row*52+frame;++y) {
      for(unsigned x=24;x<152;++x)pixels[y*width+x]=0xffffff;
      for(unsigned x=408;x<432;++x)pixels[y*width+x]=0x00ff00;
    }
    uint64_t sent=framebuffer_stats.transmitted_pixels;update_count=0;
    evaluate(ctx,"native.flush(pixels)",false);
    CHECK(update_count>1&&update_count<=FRAMEBUFFER_MAX_RECTS);
    /* 原先每行带须发送408×20像素；8×2网格扩展后仍不到其一半。 */
    CHECK(framebuffer_stats.transmitted_pixels-sent<408*20*8/2);
    if(frame==0&&format==FB_FMT_RGB16_565&&!row_padding)
      printf("480×480合成列表：%llu发送像素/%u事务，原行带65280像素/8事务\n",
        (unsigned long long)(framebuffer_stats.transmitted_pixels-sent),update_count);
    for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x)expect_pixel(x,y,pixels[y*width+x]);
    display_matches_mapping();padding();
  }

  /* 棋盘碎片制造远超32个候选，适配长宽超过512的网格，仍有界且没有漏点。 */
  memset(pixels,0,width*height*sizeof(*pixels));
  for(unsigned y=0;y<height;y+=16)for(unsigned x=(y/16&1)*8;x<width;x+=16)
    pixels[y*width+x]=0xff0000;
  pixels[width*height-1]=0x0000ff;
  update_count=0;evaluate(ctx,"native.flush(pixels)",false);
  CHECK(update_count>0&&update_count<=FRAMEBUFFER_MAX_RECTS);
  for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x)expect_pixel(x,y,pixels[y*width+x]);
  display_matches_mapping();padding();

  if(width==480&&height==480) {
    memset(pixels,0,width*height*sizeof(*pixels));update_count=0;
    evaluate(ctx,"native.flush(pixels)",false);display_matches_mapping();
    for(unsigned y=100;y<220;++y)for(unsigned x=24;x<48;++x)
      pixels[y*width+x]=pixels[y*width+x+408]=0xffffff;
    update_count=0;fail_update_at=2;
    uint64_t completed=framebuffer_stats.updates,errors=framebuffer_stats.errors;
    evaluate(ctx,"native.flush(pixels)",true);
    CHECK(update_count==2&&framebuffer_stats.updates==completed&&framebuffer_stats.errors==errors+1);
    /* 真正二维左右矩形的第二段失败，零扫描补发两列及中间并集。 */
    uint64_t converted=framebuffer_stats.converted_pixels;
    evaluate(ctx,"native.flush(pixels,0,0,0,0,true)",false);
    CHECK(update_count==3&&framebuffer_stats.converted_pixels==converted);
    area(2,24,100,432,120);display_matches_mapping();
    evaluate(ctx,"native.flush(pixels)",false);CHECK(update_count==3);
    fail_update_at=0;
  }
  JS_FreeValue(ctx,owner);JS_FreeValue(ctx,view);
  px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static void run_blocks_random(int format,unsigned bpp,unsigned row_padding,unsigned width)
{
  unsigned height=13,words=(((width+7)/8)+31)/32;
  mock_video=(struct fb_videoinfo_s){.fmt=format,.xres=width,.yres=height};
  mock_plane=(struct fb_planeinfo_s){.bpp=bpp,.stride=width*(bpp/8)+row_padding};
  mock_plane.fblen=mock_plane.stride*height;CHECK(mock_plane.fblen<=sizeof(memory));
  memset(memory,0xa5,sizeof(memory));memset(displayed,0x5a,sizeof(displayed));
  for(unsigned y=0;y<height;++y)memset(memory+y*mock_plane.stride,0,width*(bpp/8));
  update_count=power_calls=fail_update_at=0;rotation=0;power=1;fail_update=fail_power=0;
  JSRuntime *rt=JS_NewRuntime();CHECK(rt);JSContext *ctx=JS_NewContext(rt);CHECK(ctx);install(ctx);
  char code[512];snprintf(code,sizeof(code),"globalThis.pixels=new Uint32Array(%u);globalThis.rows=new Uint16Array(%u);"
    "globalThis.blocks=new Uint32Array(%u);native.flush(pixels)",width*height,height*2,words*height);
  evaluate(ctx,code,false);
  JSValue pv,po,rv,ro,bv,bo;
  uint32_t *pixels=(uint32_t *)(void *)typed_data(ctx,"pixels",&pv,&po);
  uint16_t *rows=(uint16_t *)(void *)typed_data(ctx,"rows",&rv,&ro);
  uint32_t *bits=(uint32_t *)(void *)typed_data(ctx,"blocks",&bv,&bo);
  uint32_t *expected=calloc(width*height,sizeof(*expected));CHECK(expected);
  uint32_t random=0x63528dea;unsigned tail=((width+7)/8)&31;
  /* 独立逐像素oracle仅用于测试，覆盖全空/全满/交错/随机word及奇偶扫描端点。 */
  for(unsigned frame=0;frame<96;++frame) {
    unsigned left=(frame*17)%width,right=left+1+(frame*23)%(width-left);
    unsigned top=frame%height,bottom=top+1+(frame*3)%(height-top);
    bool use_rows=frame&1,clean=frame%19==0,force=frame%23==0;
    for(unsigned y=0;y<height;++y) {
      unsigned x=(frame+y*3)%width,end=x+1+(frame*7+y)%(width-x);
      rows[y*2]=frame%9==0?0:x+1;rows[y*2+1]=frame%9==0?0:end;
      for(unsigned word=0;word<words;++word) {
        random=random*1664525+1013904223;
        uint32_t value=frame%5==0?0:frame%5==1?UINT32_MAX:frame%5==2?0xaaaaaaaa:random;
        if(word==words-1&&tail)value&=(1u<<tail)-1;
        bits[y*words+word]=value;
      }
    }
    unsigned scanned=0,changed=0;
    for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x) {
      random=random*1664525+1013904223;
      pixels[y*width+x]=frame%7==0?0xffffff:frame%7==1?0:random&0xffffff;
      bool selected=force||(!clean&&x>=left&&x<right&&y>=top&&y<bottom&&
        (!use_rows||(rows[y*2]&&x>=rows[y*2]-1u&&x<rows[y*2+1]))&&
        (bits[y*words+x/256]&(1u<<((x/8)&31))));
      if(!selected)continue;
      ++scanned;uint32_t old=expected[y*width+x],value=pixels[y*width+x];
      if(format==FB_FMT_RGB16_565) {
        uint32_t before=(((old>>16)&255)>>3)*2048+(((old>>8)&255)>>2)*32+((old&255)>>3);
        uint32_t after=(((value>>16)&255)>>3)*2048+(((value>>8)&255)>>2)*32+((value&255)>>3);
        changed+=before!=after;
      } else changed+=old!=value;
      expected[y*width+x]=value;
    }
    uint64_t converted=framebuffer_stats.converted_pixels,previous_changed=framebuffer_stats.changed_pixels;
    uint64_t frames=framebuffer_stats.frames;
    update_count=0;
    snprintf(code,sizeof(code),"%snative.flush(pixels,%u,%u,%u,%u,%s,%s,blocks)",force?"native.setPower(true);":"",
      left,top,right-left,bottom-top,clean?"true":"false",use_rows?"rows":"undefined");
    evaluate(ctx,code,false);
    CHECK(framebuffer_stats.frames==frames+1&&framebuffer_stats.converted_pixels==converted+scanned);
    CHECK(framebuffer_stats.changed_pixels==previous_changed+changed);
    CHECK(update_count>0||(!changed&&!force));
    for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x)expect_pixel(x,y,expected[y*width+x]);
    display_matches_mapping();padding();
  }
  free(expected);JS_FreeValue(ctx,bo);JS_FreeValue(ctx,bv);JS_FreeValue(ctx,ro);JS_FreeValue(ctx,rv);
  JS_FreeValue(ctx,po);JS_FreeValue(ctx,pv);px_close_framebuffer();JS_FreeContext(ctx);JS_FreeRuntime(rt);
}

static unsigned wifi_scene_pixel(unsigned x,unsigned y,unsigned scroll)
{
  if(y<120)return 0;
  unsigned local=(y-120+scroll)%48;
  if(local==47&&x>=29&&x<451)return 1;
  if(local>=12&&local<36&&x>=29&&x<229&&
     ((x+y)%5<2||(x%12)<2))return 2;
  if(local>=12&&local<36&&x>=365&&x<433&&((x/8+local/4)%3))return 3;
  return 0;
}

static void run_planner_benchmark(void)
{
  struct framebuffer_dirty_grid_s grid={0};grid.xshift=3;grid.yshift=1;
  struct fb_area_s bounds={29,120,422,360},rectangles[FRAMEBUFFER_MAX_RECTS];
  struct fb_area_s bands[FRAMEBUFFER_MAX_BANDS];
  unsigned changed=0,band_count=0;
  for(unsigned y=120;y<480;++y) {
    unsigned first=451,last=29;
    for(unsigned x=29;x<451;++x)
      if(wifi_scene_pixel(x,y,0)!=wifi_scene_pixel(x,y,13)) {
        ++changed;mark_dirty_tile(grid.bits[y>>grid.yshift],grid.xshift,x);
        if(first==451)first=x;
        last=x+1;
      }
    if(first<last)add_dirty_band(bands,&band_count,first,last,y);
  }
  unsigned count=build_dirty_rectangles(&grid,&bounds,rectangles),pixels=0;
  for(unsigned i=0;i<count;++i)pixels+=(unsigned)rectangles[i].w*rectangles[i].h;
  unsigned band_pixels=0,band_cost=0,rectangle_cost_total=0;
  unsigned selected_band_count=band_count;
  if(selected_band_count>FRAMEBUFFER_MAX_BANDS) {
    /* flush() 的同一回退：超过带数上限时只提交 bbox，再由二维规划决定是否拆分。 */
    bands[0]=bounds;
    selected_band_count=1;
  }
  for(unsigned i=0;i<selected_band_count;++i) {
    band_pixels+=(unsigned)bands[i].w*bands[i].h;
    band_cost+=rectangle_cost(&bands[i]);
  }
  for(unsigned i=0;i<count;++i)rectangle_cost_total+=rectangle_cost(&rectangles[i]);
  /* 独立逐像素覆盖检查，矩形布局和顺序不作为正确性的依据。 */
  for(unsigned y=120;y<480;++y)for(unsigned x=29;x<451;++x)
    if(wifi_scene_pixel(x,y,0)!=wifi_scene_pixel(x,y,13)) {
      bool covered=false;
      for(unsigned i=0;i<count;++i)if(x>=rectangles[i].x&&x<(unsigned)rectangles[i].x+rectangles[i].w&&
        y>=rectangles[i].y&&y<(unsigned)rectangles[i].y+rectangles[i].h)covered=true;
      CHECK(covered);
    }
  unsigned (*volatile planner)(const struct framebuffer_dirty_grid_s *,const struct fb_area_s *,
    struct fb_area_s *)=build_dirty_rectangles;
  struct timespec begin,end;clock_gettime(CLOCK_MONOTONIC,&begin);unsigned total=0;
  for(unsigned i=0;i<2000;++i)total+=planner(&grid,&bounds,rectangles);
  clock_gettime(CLOCK_MONOTONIC,&end);CHECK(total>0);
  bool use_rect=rectangle_cost_total<band_cost&&pixels<band_pixels;
  printf("Wi-Fi合成差分planner(gap=%u)：%u变化/bands=%u->%u/%u像素，rect=%u/%u像素，选=%s/%u像素/%u事务，成本=%u/%u，host %.3f us/帧\n",
    (unsigned)FRAMEBUFFER_SPLIT_GAP,changed,band_count,selected_band_count,band_pixels,count,pixels,
    use_rect?"rect":"bands",use_rect?pixels:band_pixels,use_rect?count:selected_band_count,
    band_cost,rectangle_cost_total,elapsed_ns(&begin,&end)/2000000.0);
}

int main(int argc, char **argv)
{
  if (argc == 2 && !strcmp(argv[1], "fast-path")) {
    run_known_clean();
    run_solid_change();
    puts("framebuffer fast path通过：静止帧计数/计时、失败重试、实心区域单次提交");
    return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "planner")) {
    run_planner_benchmark();
    return 0;
  }
  run_planner_benchmark();
  run(FB_FMT_RGB16_565,16,4);run(FB_FMT_RGB16_565,16,5);
  run(FB_FMT_RGB24,24,5);run(FB_FMT_RGB32,32,5);
  run565_pairs(0);run565_pairs(2);run565_pairs(3);
  run_known_clean();
  run_bands(FB_FMT_RGB16_565,16,2);run_bands(FB_FMT_RGB16_565,16,3);
  run_bands(FB_FMT_RGB24,24,3);run_bands(FB_FMT_RGB32,32,3);
  run_rows(FB_FMT_RGB16_565,16,2);run_rows(FB_FMT_RGB16_565,16,3);
  run_rows(FB_FMT_RGB24,24,3);run_rows(FB_FMT_RGB32,32,3);
  const unsigned widths[]={1,7,8,9,17,255,256,257,269,512};
  for(unsigned i=0;i<sizeof(widths)/sizeof(widths[0]);++i) {
    run_blocks_random(FB_FMT_RGB16_565,16,2,widths[i]);run_blocks_random(FB_FMT_RGB16_565,16,3,widths[i]);
    run_blocks_random(FB_FMT_RGB24,24,3,widths[i]);run_blocks_random(FB_FMT_RGB32,32,3,widths[i]);
  }
  run_blocks_validation(FB_FMT_RGB16_565,16,2);run_blocks_validation(FB_FMT_RGB16_565,16,3);
  run_blocks_validation(FB_FMT_RGB24,24,3);run_blocks_validation(FB_FMT_RGB32,32,3);
  run_solid_change();
  run_spatial_grid(FB_FMT_RGB16_565,16,0,480,480);
  run_spatial_grid(FB_FMT_RGB16_565,16,3,480,480);
  run_spatial_grid(FB_FMT_RGB24,24,3,480,480);
  run_spatial_grid(FB_FMT_RGB32,32,3,480,480);
  run_spatial_grid(FB_FMT_RGB16_565,16,2,1025,13);
  run_spatial_grid(FB_FMT_RGB32,32,3,7,2049);
  puts("dirty blocks通过：3840帧独立逐像素oracle、4格式/stride、10行宽、跨32bit连续段、尾bit验证、bbox/rows交集、owner/detach/getter、force/pending跨段失败重试");
  puts("framebuffer delta通过：真实QuickJS/565/24/32转换、stride/offset、稀疏rows与bbox交集、完整验证/owner隔离/detach/重入、行带和二维成本择优、32矩形上限、480×480列表与棋盘/自适应网格、跨段失败完整重试、扫描面积计数、旋转/亮屏强制整屏、VM重建");
}
