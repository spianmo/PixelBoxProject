/* 批量矩形由原生循环裁剪/填充，避免每个矩形创建子数组并跨越 JS 调用层。 */
#include "quickjs.h"
#include "pixelbox.h"
#include <stdbool.h>
#include <stdint.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* JS 对乘法和加法分别舍入；禁止隐式 FMA 改变恰好半像素的边界。 */
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC push_options
#pragma GCC optimize ("fp-contract=off")
#endif

static inline void fill_span(uint32_t *pixels, unsigned count, uint32_t color)
{
  /* 子视图仅保证4字节对齐；连续32位写入避免每像素重读行宽和计算行偏移。 */
  while(count>=8) {
    /* 整组已同色时保留缓存行的干净状态，避免PSRAM重复写回。
     * 首个不同像素即短路；需要更新的组仍保持八个连续32位写入。 */
    if(pixels[0]!=color||pixels[1]!=color||pixels[2]!=color||pixels[3]!=color||
       pixels[4]!=color||pixels[5]!=color||pixels[6]!=color||pixels[7]!=color) {
      pixels[0]=color;pixels[1]=color;pixels[2]=color;pixels[3]=color;
      pixels[4]=color;pixels[5]=color;pixels[6]=color;pixels[7]=color;
    }
    pixels+=8;count-=8;
  }
  while(count--) {if(*pixels!=color)*pixels=color;pixels++;}
}

/* 每行编码为[left+1,right)，left字段为0表示本帧尚未写入；最多2048像素宽。 */
static void mark_changed_span(uint16_t *row,unsigned left,unsigned right)
{
  if(!row[0]||left+1<row[0])row[0]=(uint16_t)(left+1);
  if(right>row[1])row[1]=(uint16_t)right;
}

static void invalidate_changed_rows(uint16_t *rows,unsigned width,unsigned height)
{
  if(rows)for(unsigned y=0;y<height;++y){rows[y*2]=1;rows[y*2+1]=(uint16_t)width;}
}

/* 单个span按x递增，只暂存当前字的实际写入位；跨字时提交，保留中间干净块。 */
struct dirty_block_accumulator {
  uint32_t *words;
  unsigned word;
  uint32_t pending;
};

static inline void commit_changed_blocks(struct dirty_block_accumulator *a)
{
  if(a->words&&a->pending)a->words[a->word]|=a->pending;
}

static inline void mark_changed_blocks(struct dirty_block_accumulator *a,unsigned x,unsigned count)
{
  if(!a->words)return;
  unsigned word=x/256;
  if(word!=a->word) {
    commit_changed_blocks(a);a->word=word;a->pending=0;
  }
  uint32_t bit=UINT32_C(1)<<((x/8)%32);
  a->pending|=bit;
  /* 完整8像素组未对齐时还写下一块；尾像素不扩大标记。 */
  if(count==8&&(x&7)) {
    if(bit==UINT32_C(0x80000000)) {
      commit_changed_blocks(a);++a->word;a->pending=1;
    } else a->pending|=bit<<1;
  }
}

static void invalidate_changed_blocks(uint32_t *blocks,unsigned width,unsigned height)
{
  if(!blocks)return;
  unsigned columns=(width+7)/8,words=(columns+31)/32,remainder=columns%32;
  uint32_t last=remainder?(UINT32_C(1)<<remainder)-1:UINT32_MAX;
  /* 异常后的整个屏幕均待扫描，末字仅保留有效bit，避免宽度外假脏块。 */
  for(unsigned y=0;y<height;++y) {
    for(unsigned word=0;word+1<words;++word)blocks[y*words+word]=UINT32_MAX;
    blocks[y*words+words-1]=last;
  }
}

static inline void fill_tracked_span(uint32_t *pixels,unsigned count,uint32_t color,
                                     uint16_t *row,unsigned x,uint32_t *blocks)
{
  /* 离屏画布不分配tracker；沿用原循环，避免每组额外追踪开销。 */
  if(!row&&!blocks){fill_span(pixels,count,color);return;}
  struct dirty_block_accumulator pending={.words=blocks,.word=x/256};
  unsigned first=0,last=0;
  while(count>=8) {
    if(pixels[0]!=color||pixels[1]!=color||pixels[2]!=color||pixels[3]!=color||
       pixels[4]!=color||pixels[5]!=color||pixels[6]!=color||pixels[7]!=color) {
      if(!last)first=x;
      last=x+8;
      mark_changed_blocks(&pending,x,8);
      pixels[0]=color;pixels[1]=color;pixels[2]=color;pixels[3]=color;
      pixels[4]=color;pixels[5]=color;pixels[6]=color;pixels[7]=color;
    }
    pixels+=8;count-=8;x+=8;
  }
  while(count--) {
    if(*pixels!=color){if(!last)first=x;last=x+1;mark_changed_blocks(&pending,x,1);*pixels=color;}
    ++pixels;++x;
  }
  /* 每段只合并一次；变化组中已同色的像素也保守覆盖，绝不漏掉真实写入。 */
  commit_changed_blocks(&pending);
  if(last&&row)mark_changed_span(row,first,last);
}

struct canvas_view {
  JSValue owner;
  uint8_t *data;
  size_t offset, bytes;
};

/* composeRows 在滚动时每帧使用同样大小的候选位图。保留已分配容量，
 * 避免在 QuickJS/NuttX 堆上反复 calloc/free；容量只向上增长到本进程
 * 见过的最大视口，下一次调用仍会清零实际使用范围，语义与原实现一致。 */
static uint32_t *g_compose_candidate_rows;
static size_t g_compose_candidate_capacity;

static uint32_t *compose_candidate_reserve(size_t bytes)
{
  if (bytes <= g_compose_candidate_capacity) {
    memset(g_compose_candidate_rows, 0, bytes);
    return g_compose_candidate_rows;
  }

  uint32_t *candidate = (uint32_t *)realloc(g_compose_candidate_rows, bytes);
  if (!candidate) {
    return NULL;
  }

  g_compose_candidate_rows = candidate;
  g_compose_candidate_capacity = bytes;
  memset(candidate, 0, bytes);
  return candidate;
}

static int acquire_canvas_view(JSContext *ctx, JSValueConst value, int type, struct canvas_view *v)
{
  size_t length=0,element;
  v->owner=JS_UNDEFINED;v->data=NULL;v->bytes=0;v->offset=0;
  if(JS_GetTypedArrayType(value)!=type) {JS_ThrowTypeError(ctx,"invalid canvas typed array");return -1;}
  v->owner=JS_GetTypedArrayBuffer(ctx,value,&v->offset,&v->bytes,&element);
  if(JS_IsException(v->owner)) return -1;
  uint8_t *base=JS_GetArrayBuffer(ctx,&length,v->owner);
  if(JS_HasException(ctx)) return -1;
  if(v->offset>length||v->bytes>length-v->offset||(!base&&v->bytes)) {
    JS_ThrowRangeError(ctx,"invalid canvas buffer");return -1;
  }
  v->data=base?base+v->offset:NULL;return 0;
}

static int views_overlap(const struct canvas_view *a, const struct canvas_view *b)
{
  return a->bytes&&b->bytes&&JS_VALUE_GET_PTR(a->owner)==JS_VALUE_GET_PTR(b->owner)&&
    a->offset<b->offset+b->bytes&&b->offset<a->offset+a->bytes;
}

static int views_share_owner(const struct canvas_view *a,const struct canvas_view *b)
{
  return !JS_IsUndefined(a->owner)&&!JS_IsUndefined(b->owner)&&
    JS_VALUE_GET_PTR(a->owner)==JS_VALUE_GET_PTR(b->owner);
}

/* 清屏和填充一样在原生侧完成，避免 JS TypedArray.fill 后再逐行构造
 * dirty tracker。只把实际变色的像素写回，并保留异常时的整屏重扫语义。 */
static JSValue clear_canvas(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if(argc<4 || JS_GetTypedArrayType(argv[0])!=JS_TYPED_ARRAY_UINT32)
    return JS_ThrowTypeError(ctx,"clearCanvas needs Uint32Array pixels");
  double w,h;
  int32_t raw_color;
  if(JS_ToFloat64(ctx,&w,argv[1])||JS_ToFloat64(ctx,&h,argv[2])||
     JS_ToInt32(ctx,&raw_color,argv[3])) return JS_EXCEPTION;
  if(!isfinite(w)||!isfinite(h)||w<1||h<1||w>2048||h>2048||
     floor(w)!=w||floor(h)!=h)
    return JS_ThrowRangeError(ctx,"invalid canvas dimensions");

  struct canvas_view pixels={.owner=JS_UNDEFINED};
  struct canvas_view tracker={.owner=JS_UNDEFINED};
  struct canvas_view changed_blocks={.owner=JS_UNDEFINED};
  uint16_t *rows=NULL;
  uint32_t *blocks=NULL;
  JSValue result=JS_EXCEPTION;
  if(acquire_canvas_view(ctx,argv[0],JS_TYPED_ARRAY_UINT32,&pixels)<0)goto done;
  if(pixels.bytes/4<(size_t)(w*h)||!pixels.data) {
    JS_ThrowRangeError(ctx,"invalid canvas pixel buffer");goto done;
  }
  if(argc>4&&!JS_IsUndefined(argv[4])) {
    if(acquire_canvas_view(ctx,argv[4],JS_TYPED_ARRAY_UINT16,&tracker)<0)goto done;
    if(tracker.bytes!=(size_t)h*2*sizeof(uint16_t)||views_share_owner(&tracker,&pixels)) {
      JS_ThrowRangeError(ctx,"invalid or overlapping canvas row tracker");goto done;
    }
    rows=(uint16_t *)tracker.data;
  }
  if(argc>5&&!JS_IsUndefined(argv[5])) {
    if(acquire_canvas_view(ctx,argv[5],JS_TYPED_ARRAY_UINT32,&changed_blocks)<0)goto done;
    if(changed_blocks.bytes!=(size_t)(((unsigned)w+255)/256)*(size_t)h*sizeof(uint32_t)||
       views_share_owner(&changed_blocks,&pixels)||views_share_owner(&changed_blocks,&tracker)) {
      JS_ThrowRangeError(ctx,"invalid or overlapping canvas dirty blocks");goto done;
    }
    blocks=(uint32_t *)changed_blocks.data;
  }
  {
    uint32_t color=(uint32_t)raw_color&0xffffff;
    uint32_t *out=(uint32_t *)pixels.data;
    unsigned width=(unsigned)w,height=(unsigned)h;
    int left=(int)width,top=(int)height,right=0,bottom=0;
    unsigned work=0;
    result=JS_NULL;
    for(unsigned y=0;y<height;++y) {
      unsigned before_left=rows?rows[y*2]:0,before_right=rows?rows[y*2+1]:0;
      fill_tracked_span(out+(size_t)y*width,width,color,rows?rows+y*2:NULL,0,
                        blocks?blocks+y*((width+255)/256):NULL);
      if(rows && rows[y*2]) {
        unsigned changed_left=rows[y*2]-1,changed_right=rows[y*2+1];
        /* 只把本次新增的范围并入返回值；旧 tracker 仍由调用方保留。 */
        if(!before_left || changed_left<before_left-1) {
          if((int)changed_left<left)left=(int)changed_left;
        }
        if(changed_right>before_right) {
          if((int)changed_right>right)right=(int)changed_right;
        }
        if(changed_left<changed_right) {
          if((int)y<top)top=(int)y;
          if((int)y+1>bottom)bottom=(int)y+1;
        }
      } else if(!rows) {
        /* 无tracker的调用只用于离屏兼容路径，整行写入即视为脏。 */
        left=0;right=(int)width;top=0;bottom=(int)height;
      }
      work+=width;
      if(work>=4096) {
        /* 保留 QuickJS 异常状态；否则 goto 清理后 JS 会误收到成功返回值。 */
        if(px_runtime_poll_interrupt(ctx)<0) { result=JS_EXCEPTION; goto done; }
        work=0;
      }
    }
    if(rows) {
      /* tracker 可能在调用前已有范围；返回值应覆盖其最终并集，避免丢失旧脏区。 */
      for(unsigned y=0;y<height;++y) {
        if(!rows[y*2])continue;
        unsigned row_left=rows[y*2]-1,row_right=rows[y*2+1];
        if((int)row_left<left)left=(int)row_left;
        if((int)row_right>right)right=(int)row_right;
        if((int)y<top)top=(int)y;
        if((int)y+1>bottom)bottom=(int)y+1;
      }
    }
    if(right>left&&bottom>top) {
      result=JS_NewObject(ctx);
      if(JS_IsException(result))goto done;
      JS_SetPropertyStr(ctx,result,"x",JS_NewInt32(ctx,left));
      JS_SetPropertyStr(ctx,result,"y",JS_NewInt32(ctx,top));
      JS_SetPropertyStr(ctx,result,"width",JS_NewInt32(ctx,right-left));
      JS_SetPropertyStr(ctx,result,"height",JS_NewInt32(ctx,bottom-top));
    }
  }
done:
  if(JS_IsException(result)) {
    invalidate_changed_rows(rows,(unsigned)w,(unsigned)h);
    invalidate_changed_blocks(blocks,(unsigned)w,(unsigned)h);
  }
  JS_FreeValue(ctx,changed_blocks.owner);JS_FreeValue(ctx,tracker.owner);JS_FreeValue(ctx,pixels.owner);
  return result;
}

static JSValue fill_rects(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if(argc<5 || JS_GetTypedArrayType(argv[0])!=JS_TYPED_ARRAY_UINT32 ||
     JS_GetTypedArrayType(argv[3])!=JS_TYPED_ARRAY_INT32)
    return JS_ThrowTypeError(ctx,"fillRects needs Uint32Array pixels and Int32Array rectangles");
  double w,h,n;
  if(JS_ToFloat64(ctx,&w,argv[1])||JS_ToFloat64(ctx,&h,argv[2])||JS_ToFloat64(ctx,&n,argv[4])) return JS_EXCEPTION;
  if(!isfinite(w)||!isfinite(h)||!isfinite(n)||w<1||h<1||w>2048||h>2048||n<0||n>8192||
     floor(w)!=w||floor(h)!=h||floor(n)!=n) return JS_ThrowRangeError(ctx,"invalid canvas dimensions or rectangle count");
  struct canvas_view pixels={.owner=JS_UNDEFINED},rectangles={.owner=JS_UNDEFINED};
  struct canvas_view tracker={.owner=JS_UNDEFINED},changed_blocks={.owner=JS_UNDEFINED};
  uint16_t *rows=NULL;
  uint32_t *blocks=NULL;
  JSValue result=JS_EXCEPTION;
  /* 所有valueOf已执行完；之后获取并持有各缓冲owner，不再运行用户代码。 */
  if(acquire_canvas_view(ctx,argv[0],JS_TYPED_ARRAY_UINT32,&pixels)<0||
     acquire_canvas_view(ctx,argv[3],JS_TYPED_ARRAY_INT32,&rectangles)<0)goto done;
  if(pixels.bytes/4<(size_t)(w*h)||rectangles.bytes/4<(size_t)n*5||
     !pixels.data||(n&&!rectangles.data)) {
    JS_ThrowRangeError(ctx,"invalid canvas pixel or rectangle buffer");goto done;
  }
  if(argc>5&&!JS_IsUndefined(argv[5])) {
    if(acquire_canvas_view(ctx,argv[5],JS_TYPED_ARRAY_UINT16,&tracker)<0)goto done;
    if(tracker.bytes!=(size_t)h*2*sizeof(uint16_t)||views_share_owner(&tracker,&pixels)||
       views_share_owner(&tracker,&rectangles)) {
      JS_ThrowRangeError(ctx,"invalid or overlapping canvas row tracker");goto done;
    }
    rows=(uint16_t *)tracker.data;
  }
  if(argc>6&&!JS_IsUndefined(argv[6])) {
    if(acquire_canvas_view(ctx,argv[6],JS_TYPED_ARRAY_UINT32,&changed_blocks)<0)goto done;
    if(changed_blocks.bytes!=(size_t)(((unsigned)w+255)/256)*(size_t)h*sizeof(uint32_t)||
       views_share_owner(&changed_blocks,&pixels)||views_share_owner(&changed_blocks,&rectangles)||
       views_share_owner(&changed_blocks,&tracker)) {
      JS_ThrowRangeError(ctx,"invalid or shared canvas dirty blocks");goto done;
    }
    blocks=(uint32_t *)changed_blocks.data;
  }
  {
    result=JS_UNDEFINED;
    uint32_t *out=(uint32_t *)pixels.data;const int32_t *rects=(const int32_t *)rectangles.data;
    int width=(int)w,height=(int)h;
    int left=width,top=height,rightmost=0,bottommost=0;
    unsigned work=0;
    for(int i=0;i<(int)n;++i) {
      /* 空/屏外矩形也需响应停止；密集填充每约4096像素检查已有轮次预算。 */
      if((i&63)==0 && px_runtime_poll_interrupt(ctx)<0) {result=JS_EXCEPTION;break;}
      int64_t x=rects[i*5],y=rects[i*5+1],rw=rects[i*5+2],rh=rects[i*5+3];
      uint32_t color=(uint32_t)rects[i*5+4]&0xffffff;
      int64_t right=x+rw,bottom=y+rh;
      if(rw<=0||rh<=0||x>=width||y>=height||right<=0||bottom<=0) continue;
      if(x<0)x=0;
      if(y<0)y=0;
      if(right>width)right=width;
      if(bottom>height)bottom=height;
      /* 在原生填充时合并裁剪后的脏区，JS 每批只处理一次边界。 */
      if(x<left)left=(int)x;
      if(y<top)top=(int)y;
      if(right>rightmost)rightmost=(int)right;
      if(bottom>bottommost)bottommost=(int)bottom;
      unsigned span=(unsigned)(right-x);
      for(int row=(int)y;row<(int)bottom;++row) {
        fill_tracked_span(out+row*width+(int)x,span,color,rows?rows+row*2:NULL,(unsigned)x,
                          blocks?blocks+row*((width+255)/256):NULL);
        work+=span;
        if(work>=4096) {
          if(px_runtime_poll_interrupt(ctx)<0) {result=JS_EXCEPTION;goto done;}
          work=0;
        }
      }
    }
    if(!JS_IsException(result)) {
      result=JS_NULL;
      if(rightmost>left && bottommost>top) {
        result=JS_NewObject(ctx);
        if(JS_IsException(result)) goto done;
        JS_SetPropertyStr(ctx,result,"x",JS_NewInt32(ctx,left));
        JS_SetPropertyStr(ctx,result,"y",JS_NewInt32(ctx,top));
        JS_SetPropertyStr(ctx,result,"width",JS_NewInt32(ctx,rightmost-left));
        JS_SetPropertyStr(ctx,result,"height",JS_NewInt32(ctx,bottommost-top));
      }
    }
  }
done:
  if(JS_IsException(result)) {
    invalidate_changed_rows(rows,(unsigned)w,(unsigned)h);
    invalidate_changed_blocks(blocks,(unsigned)w,(unsigned)h);
  }
  JS_FreeValue(ctx,changed_blocks.owner);JS_FreeValue(ctx,tracker.owner);JS_FreeValue(ctx,rectangles.owner);JS_FreeValue(ctx,pixels.owner);
  return result;
}

struct layer_options {
  double count, step, scale, padding, left, right, clip_top, clip_bottom;
  double margin, x, y;
  uint32_t color;
  int has_margin;
  JSValue layers;
};

struct axis_coordinate { int16_t raw, pixel; };
struct covered_row { int16_t left, right; };
struct layer_painter {
  JSContext *ctx;
  uint32_t *pixels;
  uint16_t *changed_rows;
  uint32_t *dirty_blocks;
  int width, height, left, top, right, bottom;
  unsigned work;
  double scale, clip_top, clip_bottom, dx, dy, logical_width;
  double painted_left, painted_top, painted_right, painted_bottom;
  float fast_scale;
  struct covered_row *covered;
  struct axis_coordinate (*axis_cache)[64];
  int logical_left,logical_top,logical_right,logical_bottom;
  int restore_mode; /* 1只记录主体覆盖；2恢复背景时扣除覆盖；0正常绘制。 */
};

/* step为1..2048整数；Int32输入乘step及合并跨度始终小于2^44，Double原算法亦精确。 */
struct canvas_run { int64_t x, y, width; };

static int option_number(JSContext *ctx, JSValueConst options, const char *key,
                         double fallback, double *out, int *present)
{
  JSValue value=JS_IsUndefined(options)?JS_UNDEFINED:JS_GetPropertyStr(ctx,options,key);
  if(JS_IsException(value)) return -1;
  int exists=!JS_IsUndefined(value);
  if(present) *present=exists;
  int result=exists?JS_ToFloat64(ctx,out,value):0;
  if(!exists) *out=fallback;
  JS_FreeValue(ctx,value);
  return result;
}

static int read_layer_options(JSContext *ctx, JSValueConst value, int is_run,
                               double height, struct layer_options *o)
{
  memset(o,0,sizeof(*o));o->layers=JS_UNDEFINED;
  if(!JS_IsUndefined(value)&&!JS_IsObject(value)) {
    JS_ThrowTypeError(ctx,"layer options must be an object");return -1;
  }
  int has_count;
  if(option_number(ctx,value,"count",-1,&o->count,&has_count)||
     option_number(ctx,value,"step",1,&o->step,NULL)||
     option_number(ctx,value,"scale",1,&o->scale,NULL)) return -1;
  if(!is_run&&(option_number(ctx,value,"x",0,&o->x,NULL)||
              option_number(ctx,value,"y",0,&o->y,NULL))) return -1;
  if(!JS_IsUndefined(value)) {
    o->layers=JS_GetPropertyStr(ctx,value,"layers");
    if(JS_IsException(o->layers)) return -1;
    if(JS_IsNull(o->layers)) {JS_FreeValue(ctx,o->layers);o->layers=JS_UNDEFINED;}
  }
  if(is_run) {
    int has_left,has_right;
    double color;
    if(option_number(ctx,value,"padding",1,&o->padding,NULL)||
       option_number(ctx,value,"left",INFINITY,&o->left,&has_left)||
       option_number(ctx,value,"right",-INFINITY,&o->right,&has_right)||
       option_number(ctx,value,"clipTop",0,&o->clip_top,NULL)||
       option_number(ctx,value,"clipBottom",height/o->scale,&o->clip_bottom,NULL)||
       option_number(ctx,value,"margin",0,&o->margin,&o->has_margin)||
       option_number(ctx,value,"color",0xffffff,&color,NULL)) return -1;
    if(!isfinite(color)) {JS_ThrowRangeError(ctx,"invalid layer color");return -1;}
    double bits=fmod(trunc(color),4294967296.0);
    if(bits<0) bits+=4294967296.0;
    o->color=(uint32_t)bits&0xffffff;
    if((has_left&&(!isfinite(o->left)||fabs(o->left)>1e6))||
       (has_right&&(!isfinite(o->right)||fabs(o->right)>1e6))||
       !isfinite(o->padding)||o->padding<0||o->padding>1e6||
       !isfinite(o->clip_top)||fabs(o->clip_top)>1e6||
       !isfinite(o->clip_bottom)||fabs(o->clip_bottom)>1e6||o->clip_bottom<o->clip_top||
       !isfinite(o->margin)||o->margin<0||o->margin>1e6||floor(o->step)!=o->step) {
      JS_ThrowRangeError(ctx,"invalid run options");return -1;
    }
  } else {
    if(!isfinite(o->x)||fabs(o->x)>1e6||!isfinite(o->y)||fabs(o->y)>1e6) {
      JS_ThrowRangeError(ctx,"invalid rectangle origin");return -1;
    }
  }
  if(!isfinite(o->count)||(has_count&&(o->count<0||o->count>8192||floor(o->count)!=o->count))||
     !isfinite(o->step)||o->step<=0||o->step>2048||
     !isfinite(o->scale)||o->scale<1.0/2048||o->scale>2048) {
    JS_ThrowRangeError(ctx,"invalid layer count, step or scale");return -1;
  }
  return 0;
}


static int32_t layout_int32(double value)
{
  /* Math.round 的负半整数向正无穷取整；Int32Array 写入按模 2^32 转换。 */
  /* 此处输入已取整，常用屏幕坐标无需执行软件Double余数；超界仍走回绕路径。 */
  if(value>=INT32_MIN&&value<=INT32_MAX)return (int32_t)value;
  double bits=fmod(value,4294967296.0);
  if(bits<0) bits+=4294967296.0;
  uint32_t u=(uint32_t)bits;
  return u<=INT32_MAX?(int32_t)u:(int32_t)((int64_t)u-4294967296LL);
}

static double layout_round(double value)
{
  double base=floor(value);
  return value-base<0.5?base:base+1;
}

struct physical_bounds { int32_t left, top, right, bottom; };
enum { FAST_LEFT=1, FAST_TOP=2, FAST_RIGHT=4, FAST_BOTTOM=8, FAST_DOMAIN=16 };
#ifdef PX_TEST_CANVAS
static uint32_t canvas_fast_rects,canvas_partial_rects,canvas_fallback_rects;
static uint32_t canvas_fast_edges,canvas_fallback_edges;
static uint32_t canvas_integer_batches,canvas_double_batches;
static uint32_t canvas_restored_batches,canvas_restore_skipped_pixels,canvas_restore_pixels;
static JSValue canvas_test_stats(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;
  JSValue result=JS_NewObject(ctx);
  JS_SetPropertyStr(ctx,result,"fastRects",JS_NewUint32(ctx,canvas_fast_rects));
  JS_SetPropertyStr(ctx,result,"partialRects",JS_NewUint32(ctx,canvas_partial_rects));
  JS_SetPropertyStr(ctx,result,"fallbackRects",JS_NewUint32(ctx,canvas_fallback_rects));
  JS_SetPropertyStr(ctx,result,"fastEdges",JS_NewUint32(ctx,canvas_fast_edges));
  JS_SetPropertyStr(ctx,result,"fallbackEdges",JS_NewUint32(ctx,canvas_fallback_edges));
  JS_SetPropertyStr(ctx,result,"integerShadowBatches",JS_NewUint32(ctx,canvas_integer_batches));
  JS_SetPropertyStr(ctx,result,"doubleShadowBatches",JS_NewUint32(ctx,canvas_double_batches));
  JS_SetPropertyStr(ctx,result,"restoredBatches",JS_NewUint32(ctx,canvas_restored_batches));
  JS_SetPropertyStr(ctx,result,"restoreSkippedPixels",JS_NewUint32(ctx,canvas_restore_skipped_pixels));
  JS_SetPropertyStr(ctx,result,"restorePixels",JS_NewUint32(ctx,canvas_restore_pixels));
  return result;
}
#endif

static bool layout_fast_round(float value,int32_t *pixel)
{
  float shifted=value+.5f;
  int32_t whole=(int32_t)shifted;
  if((float)whole>shifted)--whole;
  /* ±8193范围内，整数±1/256可由Float精确表示；区间不能碰到舍入边界。 */
  if(!(shifted>(float)whole+0x1p-8f&&shifted<(float)(whole+1)-0x1p-8f))return false;
  *pixel=whole;return true;
}

static unsigned layout_fast_rectangle(float scale,double x,double y,double w,double h,
                                       struct physical_bounds *out)
{
  if(!scale)return 0;
  float fx=(float)x,fy=(float)y,fw=(float)w,fh=(float)h;
  if(!(fabsf(fx)<=2048&&fabsf(fy)<=2048&&fabsf(fw)<=2048&&fabsf(fh)<=2048))return 0;
  /* 原Double scale<=2，u=2^-24。即使原输入略超2048但Float舍入成2048，
   * 每个输入转换误差仍<=2048u，scale转换误差<=2u；
   * x+w的Float加法及输入误差累计<8192u+2^-40，缩放后<32768u+2^-38；
   * 加0.5后总误差<40962u<1/256，已包含原Double加法/乘法舍入及次正规冲刷。
   * 原Double端点及其整数差均在Int32内；半像素只回退该端点，其余继续快算。 */
  unsigned mask=FAST_DOMAIN;
  if(layout_fast_round(fx*scale,&out->left))mask|=FAST_LEFT;
  if(layout_fast_round(fy*scale,&out->top))mask|=FAST_TOP;
  if(layout_fast_round((fx+fw)*scale,&out->right))mask|=FAST_RIGHT;
  if(layout_fast_round((fy+fh)*scale,&out->bottom))mask|=FAST_BOTTOM;
  return mask;
}

/* 常见布局已得到四个Int32端点；直接裁剪，避免重复宽高运算与64位参数。 */
static int paint_pixel_bounds(struct layer_painter *p,int32_t px,int32_t py,
                              int32_t end,int32_t base,uint32_t color)
{
  /* 裁剪后判空同时覆盖反向区间和完全屏外区间，无需重复六次边界判断。 */
  if(px<0)px=0;if(py<0)py=0;if(end>p->width)end=p->width;if(base>p->height)base=p->height;
  if(end<=px||base<=py)return 0;
  if(p->restore_mode==1) {
    for(int row=(int)py;row<(int)base;++row) {
      struct covered_row *covered=&p->covered[row];
      /* 每行只保存已证实连续的主体区间；分离的双耳不能用包围盒跨洞合并。 */
      if(covered->right>covered->left&&px<=covered->right&&end>=covered->left) {
        if(px<covered->left)covered->left=(int16_t)px;
        if(end>covered->right)covered->right=(int16_t)end;
      } else if(end-px>covered->right-covered->left) {
        covered->left=(int16_t)px;covered->right=(int16_t)end;
      }
    }
    return 0;
  }
  if(px<p->left)p->left=(int)px;if(py<p->top)p->top=(int)py;
  if(end>p->right)p->right=(int)end;if(base>p->bottom)p->bottom=(int)base;
  unsigned span=(unsigned)(end-px);
  color&=0xffffff;
  for(int row=(int)py;row<(int)base;++row) {
    int start=(int)px,stop=(int)end;
#ifdef PX_TEST_CANVAS
    if(p->restore_mode==2)canvas_restore_pixels+=span;
#endif
    if(p->restore_mode==2&&p->covered) {
      const struct covered_row *covered=&p->covered[row];
      int cut_left=covered->left>start?covered->left:start;
      int cut_right=covered->right<stop?covered->right:stop;
      if(cut_right>cut_left) {
#ifdef PX_TEST_CANVAS
        canvas_restore_skipped_pixels+=(uint32_t)(cut_right-cut_left);
#endif
        fill_tracked_span(p->pixels+row*p->width+start,(unsigned)(cut_left-start),color,
                          p->changed_rows?p->changed_rows+row*2:NULL,(unsigned)start,
                          p->dirty_blocks?p->dirty_blocks+row*((p->width+255)/256):NULL);
        start=cut_right;
      }
    }
    fill_tracked_span(p->pixels+row*p->width+start,(unsigned)(stop-start),color,
                      p->changed_rows?p->changed_rows+row*2:NULL,(unsigned)start,
                          p->dirty_blocks?p->dirty_blocks+row*((p->width+255)/256):NULL);
    p->work+=span;
    if(p->work>=4096) {p->work=0;if(px_runtime_poll_interrupt(p->ctx)<0)return -1;}
  }
  return 0;
}

/* 域外必须保留先将宽高按Int32回绕、再用64位相加的语义。
 * 成功裁剪后四端点均在0..2048，再交给同一个32位绘制核心。 */
static int paint_pixels_wide(struct layer_painter *p,int64_t px,int64_t py,
                             int64_t pw,int64_t ph,uint32_t color)
{
  int64_t end=px+pw,base=py+ph;
  if(pw<=0||ph<=0||px>=p->width||py>=p->height||end<=0||base<=0)return 0;
  if(px<0)px=0;
  if(py<0)py=0;
  if(end>p->width)end=p->width;
  if(base>p->height)base=p->height;
  return paint_pixel_bounds(p,(int32_t)px,(int32_t)py,(int32_t)end,(int32_t)base,color);
}

static int paint_physical(struct layer_painter *p,double x,double y,double w,double h,uint32_t color)
{
  struct physical_bounds rounded;
  unsigned fast=layout_fast_rectangle(p->fast_scale,x,y,w,h,&rounded);
  int64_t px,py,pw,ph;
#ifdef PX_TEST_CANVAS
  unsigned edges=(unsigned)__builtin_popcount(fast&15);
  canvas_fast_edges+=edges;canvas_fallback_edges+=4-edges;
  if(edges==4)++canvas_fast_rects;
  else if(edges)++canvas_partial_rects;
  else ++canvas_fallback_rects;
#endif
  if(fast&FAST_DOMAIN) {
    if(!(fast&FAST_LEFT))rounded.left=(int32_t)layout_round(x*p->scale);
    if(!(fast&FAST_TOP))rounded.top=(int32_t)layout_round(y*p->scale);
    if(!(fast&FAST_RIGHT))rounded.right=(int32_t)layout_round((x+w)*p->scale);
    if(!(fast&FAST_BOTTOM))rounded.bottom=(int32_t)layout_round((y+h)*p->scale);
    /* Float认证域含半像素回退端点也在±8193以内，不改变原Double取整。 */
    return paint_pixel_bounds(p,rounded.left,rounded.top,rounded.right,rounded.bottom,color);
  } else {
    double left=layout_round(x*p->scale),top=layout_round(y*p->scale);
    double right=layout_round((x+w)*p->scale),bottom=layout_round((y+h)*p->scale);
    px=layout_int32(left);py=layout_int32(top);
    pw=layout_int32(right-left);ph=layout_int32(bottom-top);
  }
  return paint_pixels_wide(p,px,py,pw,ph,color);
}

static int paint_logical(struct layer_painter *p,double x,double y,double w,double h,uint32_t color)
{
  x+=p->dx;y+=p->dy;
  double width=p->logical_width;
  if(x<0){w+=x;x=0;}if(y<p->clip_top){h-=p->clip_top-y;y=p->clip_top;}
  if(x+w>width)w=width-x;if(y+h>p->clip_bottom)h=p->clip_bottom-y;
  if(w<=0||h<=0)return 0;
  if(x<p->painted_left)p->painted_left=x;if(y<p->painted_top)p->painted_top=y;
  if(x+w>p->painted_right)p->painted_right=x+w;if(y+h>p->painted_bottom)p->painted_bottom=y+h;
  return paint_physical(p,x,y,w,h,color);
}

/* 本批次的整数端点与平移都已证明在精确二进制网格内，按轴复用相同端点。 */
static int cached_axis_pixel(struct layer_painter *p,int axis,int raw)
{
  struct axis_coordinate *cached=&p->axis_cache[axis][(unsigned)raw&63];
  if(cached->raw!=raw) {
    double translated=raw+(axis?p->dy:p->dx);
    int32_t pixel;
    if(!layout_fast_round((float)translated*p->fast_scale,&pixel))
      pixel=(int32_t)layout_round(translated*p->scale);
    cached->raw=raw;cached->pixel=pixel;
  }
  return cached->pixel;
}

static int paint_run_rect(struct layer_painter *p,int x,int y,int w,int h,uint32_t color)
{
  if(!p->axis_cache)return paint_logical(p,x,y,w,h,color);
  if(w<=0||h<=0)return 0;
  int right=x+w,bottom=y+h;
  if(x<p->logical_left)p->logical_left=x;
  if(y<p->logical_top)p->logical_top=y;
  if(right>p->logical_right)p->logical_right=right;
  if(bottom>p->logical_bottom)p->logical_bottom=bottom;
  int px=cached_axis_pixel(p,0,x),py=cached_axis_pixel(p,1,y);
  int end=cached_axis_pixel(p,0,right),base=cached_axis_pixel(p,1,bottom);
  /* prepare_integer_layout已证明平移/缩放后的端点在±1024以内。 */
  return paint_pixel_bounds(p,px,py,end,base,color);
}

static void prepare_integer_layout(struct layer_painter *p,const struct canvas_run *runs,
                                   int count,const int32_t *offsets,int layers,int step,int padding,
                                   struct axis_coordinate cache[2][64])
{
  if(!count||!p->fast_scale||fabs(p->dx)>512||fabs(p->dy)>512||
     floor(p->dx*0x1p44)!=p->dx*0x1p44||floor(p->dy*0x1p44)!=p->dy*0x1p44)return;
  int edge=0;
  for(int l=0;l<layers;++l) {
    int x=abs(offsets[l*3]),y=abs(offsets[l*3+1]);
    if(x>edge)edge=x;
    if(y>edge)edge=y;
  }
  int left=512,top=512,right=-512,bottom=-512;
  for(int i=0;i<count;++i) {
    int x=(int)runs[i].x-edge,y=(int)runs[i].y-edge;
    int end=(int)(runs[i].x+runs[i].width)+edge+padding;
    int base=(int)runs[i].y+edge+step+padding;
    if(x<left)left=x;
    if(y<top)top=y;
    if(end>right)right=end;
    if(base>bottom)bottom=base;
  }
  /* 参与平移的原始/平移端点乘2^44后绝对值不超过2^53，Double加法精确；
   * 宽高最多1024，是精确整数，原始端点与平移端点的两种结合顺序结果相同。
   * 整批外界均在逻辑clip以内，可省去每个矩形重复的Double裁剪及bounds比较。 */
  if(left< -512||top< -512||right>512||bottom>512||
     left+p->dx<0||right+p->dx>p->logical_width||right+p->dx>512||
     top+p->dy<p->clip_top||bottom+p->dy>p->clip_bottom||
     top+p->dy< -512||bottom+p->dy>512)return;
  for(int axis=0;axis<2;++axis)for(int i=0;i<64;++i)cache[axis][i].raw=INT16_MIN;
  p->axis_cache=cache;
  p->logical_left=p->logical_top=INT32_MAX;
  p->logical_right=p->logical_bottom=INT32_MIN;
}

static int paint_integer_shadows(struct layer_painter *p,const struct canvas_run *runs,
                                  int count,const int32_t *offsets,int layers,int step,int padding)
{
  /* 已验证坐标/宽度/偏移绝对值<=2^20。端点均落Int32内，交叠面积<2^46，
   * 原Double链的全部中间整数精确；最终平移、裁剪和缩放仍由原paint_logical完成。 */
  for(int l=0;l<layers;++l) {
    int32_t lx=offsets[l*3],ly=offsets[l*3+1];
    uint32_t ink=(uint32_t)offsets[l*3+2];
    int row=0;
    for(int i=0;i<count;++i) {
      if((i&63)==0&&px_runtime_poll_interrupt(p->ctx)<0)return -1;
      int32_t x=(int32_t)runs[i].x+lx,y=(int32_t)runs[i].y+ly;
      int32_t right=x+(int32_t)runs[i].width+padding,bottom=y+step+padding;
      /* C负数除法向零截断，负余数时补减一步才等于原Math.floor(y/step)。 */
      int32_t row_index=y/step;if(y%step<0)--row_index;
      int32_t grid_y=row_index*step;
      while(row<count&&runs[row].y<grid_y)++row;
      int32_t cut_left=0,cut_top=0,cut_right=0,cut_bottom=0;
      int64_t area=0;
      for(int j=row;j<count&&runs[j].y==grid_y;++j) {
        if((j&63)==0&&px_runtime_poll_interrupt(p->ctx)<0)return -1;
        int32_t bx=(int32_t)runs[j].x,by=(int32_t)runs[j].y;
        int32_t br=bx+(int32_t)runs[j].width+padding,bb=by+step+padding;
        int32_t left=x>bx?x:bx,top=y>by?y:by,end=right<br?right:br,base=bottom<bb?bottom:bb;
        if(end<=left||base<=top)continue;
        int64_t overlap=(int64_t)(end-left)*(base-top);
        if(overlap>area){area=overlap;cut_left=left;cut_top=top;cut_right=end;cut_bottom=base;}
      }
      if(!area) {if(paint_run_rect(p,x,y,right-x,bottom-y,ink)<0)return -1;}
      else {
        if(cut_top>y&&paint_run_rect(p,x,y,right-x,cut_top-y,ink)<0)return -1;
        if(cut_bottom<bottom&&paint_run_rect(p,x,cut_bottom,right-x,bottom-cut_bottom,ink)<0)return -1;
        if(cut_left>x&&paint_run_rect(p,x,cut_top,cut_left-x,cut_bottom-cut_top,ink)<0)return -1;
        if(cut_right<right&&paint_run_rect(p,cut_right,cut_top,right-cut_right,cut_bottom-cut_top,ink)<0)return -1;
      }
    }
  }
  return 0;
}

static JSValue painter_dirty(struct layer_painter *p)
{
  if(p->right<=p->left||p->bottom<=p->top)return JS_NULL;
  JSValue dirty=JS_NewObject(p->ctx);
  if(JS_IsException(dirty))return dirty;
  /* 返回普通自有数据属性，不执行原型 setter；分配失败不能返回半成品记录。 */
  if(JS_DefinePropertyValueStr(p->ctx,dirty,"x",JS_NewInt32(p->ctx,p->left),JS_PROP_C_W_E)<0||
     JS_DefinePropertyValueStr(p->ctx,dirty,"y",JS_NewInt32(p->ctx,p->top),JS_PROP_C_W_E)<0||
     JS_DefinePropertyValueStr(p->ctx,dirty,"width",JS_NewInt32(p->ctx,p->right-p->left),JS_PROP_C_W_E)<0||
     JS_DefinePropertyValueStr(p->ctx,dirty,"height",JS_NewInt32(p->ctx,p->bottom-p->top),JS_PROP_C_W_E)<0) {
    JS_FreeValue(p->ctx,dirty);return JS_EXCEPTION;
  }
  return dirty;
}

static int restore_run_background(struct layer_painter *p,const struct canvas_run *runs,
                                   int count,const struct layer_options *o,const double *restore)
{
  /* 只在常见小坐标域预计算白主体轮廓。域外保持完整恢复，避免扩展回绕证明。
   * 分配失败也只失去省写优化，仍完成同一背景/主体绘制。最多2048行、8KiB。 */
  bool coverage=o->color==0xffffff&&p->scale<=2&&fabs(p->dx)<=2048&&fabs(p->dy)<=2048&&
    o->padding<=2048&&fabs(p->clip_top)<=2048&&fabs(p->clip_bottom)<=2048;
  for(int i=0;coverage&&i<count;++i)
    if(runs[i].x < -2048||runs[i].x>2048||runs[i].y < -2048||runs[i].y>2048||runs[i].width>2048)
      coverage=false;
  if(coverage&&count)p->covered=calloc((size_t)p->height,sizeof(*p->covered));
  if(p->covered) {
    struct layer_painter capture=*p;capture.restore_mode=1;
    for(int i=0;i<count;++i) {
      if((i&63)==0&&px_runtime_poll_interrupt(p->ctx)<0)return -1;
      int result=p->axis_cache?
        paint_run_rect(&capture,(int)runs[i].x,(int)runs[i].y,(int)runs[i].width+(int)o->padding,
                       (int)o->step+(int)o->padding,o->color):
        paint_logical(&capture,runs[i].x,runs[i].y,runs[i].width+o->padding,
                      o->step+o->padding,o->color);
      if(result<0)return -1;
    }
  }
  p->restore_mode=2;
#ifdef PX_TEST_CANVAS
  ++canvas_restored_batches;
#endif
  double left=fmax(0,floor(restore[0])),top=fmax(0,floor(restore[1]));
  double right=fmin(p->logical_width,ceil(restore[2]));
  double bottom=fmin(p->height/p->scale,ceil(restore[3]));
  /* 与layoutScreen相同：先求宽高，再做x+w/y+h和四次round，不改写终点表达式。 */
  if(paint_physical(p,left,top,right-left,bottom-top,(uint32_t)restore[4])<0)return -1;
  if(restore[8]) {
    double grid_top=restore[5],grid_bottom=restore[6];
    uint32_t color=(uint32_t)restore[7];
    double vy=fmax(top,grid_top),vh=fmax(0,fmin(bottom,grid_bottom)-vy);
    double hx=fmax(left,24),hw=fmax(0,fmin(right,p->logical_width-24)-hx);
    unsigned work=0;
    for(double x=24;x<p->logical_width-20;x+=20) {
      if((work++&63)==0&&px_runtime_poll_interrupt(p->ctx)<0)return -1;
      if(x>=left&&x<right&&paint_physical(p,x,vy,1,vh,color)<0)return -1;
    }
    for(double y=grid_top;y<grid_bottom;y+=20) {
      if((work++&63)==0&&px_runtime_poll_interrupt(p->ctx)<0)return -1;
      if(y>=top&&y<bottom&&paint_physical(p,hx,y,hw,1,color)<0)return -1;
    }
  }
  p->restore_mode=0;
  return 0;
}

static JSValue fill_layers(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv,
                            int is_run,int restored)
{
  (void)self;
  if(argc<4)return JS_ThrowTypeError(ctx,"layer drawing needs pixels, dimensions and geometry");
  double w,h;
  if(JS_ToFloat64(ctx,&w,argv[1])||JS_ToFloat64(ctx,&h,argv[2]))return JS_EXCEPTION;
  if(!isfinite(w)||!isfinite(h)||w<1||h<1||w>2048||h>2048||floor(w)!=w||floor(h)!=h)
    return JS_ThrowRangeError(ctx,"invalid canvas dimensions");
  struct layer_options o;
  JSValue result=JS_EXCEPTION;
  struct canvas_view pixels={.owner=JS_UNDEFINED},input={.owner=JS_UNDEFINED},layers={.owner=JS_UNDEFINED};
  struct canvas_view restoration={.owner=JS_UNDEFINED},tracker={.owner=JS_UNDEFINED};
  struct canvas_view changed_blocks={.owner=JS_UNDEFINED};
  uint16_t *rows=NULL;
  uint32_t *blocks=NULL;
  double restore[9];
  struct covered_row *covered=NULL;
  struct canvas_run *runs=NULL;
  if(read_layer_options(ctx,argc>4?argv[4]:JS_UNDEFINED,is_run,h,&o)<0)goto done;
  /* 用户 getter/valueOf 全部结束后才取得地址，防止参数转换分离 backing buffer。 */
  if(acquire_canvas_view(ctx,argv[0],JS_TYPED_ARRAY_UINT32,&pixels)<0||
     acquire_canvas_view(ctx,argv[3],JS_TYPED_ARRAY_INT32,&input)<0)goto done;
  if(!JS_IsUndefined(o.layers)&&acquire_canvas_view(ctx,o.layers,JS_TYPED_ARRAY_INT32,&layers)<0)goto done;
  if(restored) {
    if(argc<6){JS_ThrowTypeError(ctx,"restored runs need Float64Array background description");goto done;}
    if(acquire_canvas_view(ctx,argv[5],JS_TYPED_ARRAY_FLOAT64,&restoration)<0)goto done;
    if(restoration.bytes!=sizeof(restore)||views_overlap(&restoration,&pixels)||
       views_overlap(&restoration,&input)||views_overlap(&restoration,&layers)) {
      JS_ThrowRangeError(ctx,"invalid or overlapping background description");goto done;
    }
    memcpy(restore,restoration.data,sizeof(restore));
    for(int i=0;i<9;++i) {
      bool color=i==4||i==7,enabled=i==8;
      if(!isfinite(restore[i])||(color?(restore[i]<0||restore[i]>UINT32_MAX||floor(restore[i])!=restore[i]):
          enabled?(restore[i]!=0&&restore[i]!=1):fabs(restore[i])>1e6)) {
        JS_ThrowRangeError(ctx,"invalid background description values");goto done;
      }
    }
  }
  size_t stride=is_run?3:5,capacity=input.bytes/(stride*4);
  double requested=o.count==-1?(double)capacity:o.count;
  if(input.bytes%(stride*4)||requested>8192||requested>capacity||pixels.bytes/4<(size_t)(w*h)||
     layers.bytes%12||layers.bytes>48*4||views_overlap(&pixels,&input)||views_overlap(&pixels,&layers)) {
    JS_ThrowRangeError(ctx,"invalid layer buffers or overlapping pixels");goto done;
  }
  int tracker_arg=restored?6:5;
  if(argc>tracker_arg&&!JS_IsUndefined(argv[tracker_arg])) {
    if(acquire_canvas_view(ctx,argv[tracker_arg],JS_TYPED_ARRAY_UINT16,&tracker)<0)goto done;
    if(tracker.bytes!=(size_t)h*2*sizeof(uint16_t)||views_share_owner(&tracker,&pixels)||
       views_share_owner(&tracker,&input)||views_share_owner(&tracker,&layers)||views_share_owner(&tracker,&restoration)) {
      JS_ThrowRangeError(ctx,"invalid or overlapping canvas row tracker");goto done;
    }
    rows=(uint16_t *)tracker.data;
  }
  int blocks_arg=tracker_arg+1;
  if(argc>blocks_arg&&!JS_IsUndefined(argv[blocks_arg])) {
    if(acquire_canvas_view(ctx,argv[blocks_arg],JS_TYPED_ARRAY_UINT32,&changed_blocks)<0)goto done;
    if(changed_blocks.bytes!=(size_t)(((unsigned)w+255)/256)*(size_t)h*sizeof(uint32_t)||
       views_share_owner(&changed_blocks,&pixels)||views_share_owner(&changed_blocks,&input)||
       views_share_owner(&changed_blocks,&layers)||views_share_owner(&changed_blocks,&restoration)||
       views_share_owner(&changed_blocks,&tracker)) {
      JS_ThrowRangeError(ctx,"invalid or shared canvas dirty blocks");goto done;
    }
    blocks=(uint32_t *)changed_blocks.data;
  }
  int count=(int)requested,layer_count=(int)(layers.bytes/12);
  int32_t offsets[48];if(layers.bytes)memcpy(offsets,layers.data,layers.bytes);
  const int32_t *data=(const int32_t *)input.data;
  /* 同一批次的逻辑宽度固定，只对run布局执行一次Double除法。 */
  struct layer_painter p={.ctx=ctx,.pixels=(uint32_t *)pixels.data,.changed_rows=rows,.dirty_blocks=blocks,.width=(int)w,.height=(int)h,
    .left=(int)w,.top=(int)h,.scale=o.scale,.clip_top=o.clip_top,.clip_bottom=o.clip_bottom,
    .logical_width=is_run?w/o.scale:0,.fast_scale=o.scale<=2?(float)o.scale:0,
    .painted_left=INFINITY,.painted_top=INFINITY,.painted_right=-INFINITY,.painted_bottom=-INFINITY};
  double cells=0;
  int merged=0;
  int integer_layers=is_run&&o.padding<=2048&&floor(o.padding)==o.padding;
  if(is_run&&count) {
    runs=malloc((size_t)count*sizeof(*runs));
    if(!runs){JS_ThrowOutOfMemory(ctx);goto done;}
    double left=o.left,right=o.right,top=INFINITY,bottom=-INFINITY;
    int64_t edge=0,step=(int64_t)o.step;
    for(int l=0;l<layer_count;++l) {
      int64_t lx=llabs((int64_t)offsets[l*3]),ly=llabs((int64_t)offsets[l*3+1]);
      if(lx>edge)edge=lx;if(ly>edge)edge=ly;
    }
    if(edge>1048576)integer_layers=0;
    /* 校验、原始边界与针孔合并共享一次遍历，平移仍根据合并前的边界求值。 */
    for(int i=0;i<count;++i) {
      if((i&63)==0&&px_runtime_poll_interrupt(ctx)<0)goto done;
      int64_t gx=data[i*3],gy=data[i*3+1],gw=data[i*3+2];
      if(gw<=0||(i&&(gy<data[i*3-2]||(gy==data[i*3-2]&&gx<(int64_t)data[i*3-3]+data[i*3-1])))) {
        JS_ThrowRangeError(ctx,"runs must be positive, sorted and nonoverlapping");goto done;
      }
      int64_t x=gx*step,y=gy*step,rw=gw*step;
      if(x < -1048576||x>1048576||y < -1048576||y>1048576||rw>1048576)integer_layers=0;
      if(x-edge<left)left=x-edge;if(x+rw+edge+1>right)right=x+rw+edge+1;
      if(y-edge<top)top=y-edge;if(y+step+edge+1>bottom)bottom=y+step+edge+1;
      cells+=(double)gw;
      if(merged&&y==runs[merged-1].y&&x-runs[merged-1].x-runs[merged-1].width<=step)
        runs[merged-1].width=x+rw-runs[merged-1].x;
      else runs[merged++]=(struct canvas_run){x,y,rw};
      if(runs[merged-1].width>1048576)integer_layers=0;
    }
    if(o.has_margin) {
      double width=p.logical_width;
      p.dx=left<o.margin?o.margin-left:right>width-o.margin?width-o.margin-right:0;
      p.dy=top<o.clip_top?o.clip_top-top:bottom>o.clip_bottom?o.clip_bottom-bottom:0;
    }
  }
#ifdef PX_TEST_CANVAS
  if(is_run){if(integer_layers)++canvas_integer_batches;else ++canvas_double_batches;}
#endif
  struct axis_coordinate axis_cache[2][64];
  if(integer_layers)
    prepare_integer_layout(&p,runs,merged,offsets,layer_count,(int)o.step,(int)o.padding,axis_cache);
  if(restored) {
    int restored_result=restore_run_background(&p,runs,merged,&o,restore);
    covered=p.covered;
    if(restored_result<0)goto done;
  }
  if(integer_layers) {
    if(paint_integer_shadows(&p,runs,merged,offsets,layer_count,(int)o.step,(int)o.padding)<0)goto done;
  } else for(int l=0;l<layer_count+(is_run?0:1);++l) {
    int body=l==layer_count;
    double lx=body?0:offsets[l*3],ly=body?0:offsets[l*3+1];
    uint32_t ink=body?0:(uint32_t)offsets[l*3+2];
    int row=0;
    for(int i=0;i<(is_run?merged:count);++i) {
      if((i&63)==0&&px_runtime_poll_interrupt(ctx)<0)goto done;
      if(!is_run) {
        if(data[i*5+2]<=0||data[i*5+3]<=0)continue;
        if(paint_physical(&p,o.x+data[i*5]*o.step+lx,o.y+data[i*5+1]*o.step+ly,
          data[i*5+2]*o.step,data[i*5+3]*o.step,body?(uint32_t)data[i*5+4]:ink)<0)goto done;
        continue;
      }
      double x=runs[i].x+lx,y=runs[i].y+ly,right=x+runs[i].width+o.padding,bottom=y+o.step+o.padding;
      double grid_y=floor(y/o.step)*o.step;
      while(row<merged&&runs[row].y<grid_y)++row;
      double cut_left=0,cut_top=0,cut_right=0,cut_bottom=0,area=0;
      for(int j=row;j<merged&&runs[j].y==grid_y;++j) {
        if((j&63)==0&&px_runtime_poll_interrupt(ctx)<0)goto done;
        double bx=runs[j].x,by=runs[j].y,br=bx+runs[j].width+o.padding,bb=by+o.step+o.padding;
        double left=x>bx?x:bx,top=y>by?y:by,end=right<br?right:br,base=bottom<bb?bottom:bb;
        if(end<=left||base<=top)continue;
        double overlap=(end-left)*(base-top);
        if(overlap>area){area=overlap;cut_left=left;cut_top=top;cut_right=end;cut_bottom=base;}
      }
      if(!area) {if(paint_logical(&p,x,y,right-x,bottom-y,ink)<0)goto done;}
      else {
        if(cut_top>y&&paint_logical(&p,x,y,right-x,cut_top-y,ink)<0)goto done;
        if(cut_bottom<bottom&&paint_logical(&p,x,cut_bottom,right-x,bottom-cut_bottom,ink)<0)goto done;
        if(cut_left>x&&paint_logical(&p,x,cut_top,cut_left-x,cut_bottom-cut_top,ink)<0)goto done;
        if(cut_right<right&&paint_logical(&p,cut_right,cut_top,right-cut_right,cut_bottom-cut_top,ink)<0)goto done;
      }
    }
  }
  if(is_run) {
    for(int i=0;i<merged;++i) {
      if((i&63)==0&&px_runtime_poll_interrupt(ctx)<0)goto done;
      int painted=p.axis_cache?
        paint_run_rect(&p,(int)runs[i].x,(int)runs[i].y,(int)runs[i].width+(int)o.padding,
                       (int)o.step+(int)o.padding,o.color):
        paint_logical(&p,runs[i].x,runs[i].y,runs[i].width+o.padding,o.step+o.padding,o.color);
      if(painted<0)goto done;
    }
    if(p.axis_cache&&p.logical_right>p.logical_left&&p.logical_bottom>p.logical_top) {
      p.painted_left=p.logical_left+p.dx;p.painted_top=p.logical_top+p.dy;
      p.painted_right=p.logical_right+p.dx;p.painted_bottom=p.logical_bottom+p.dy;
    }
    JSValue bounds=JS_NewObject(ctx);
    if(JS_IsException(bounds))goto done;
    if(JS_DefinePropertyValueStr(ctx,bounds,"left",JS_NewFloat64(ctx,p.painted_left),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"top",JS_NewFloat64(ctx,p.painted_top),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"right",JS_NewFloat64(ctx,p.painted_right),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"bottom",JS_NewFloat64(ctx,p.painted_bottom),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"dx",JS_NewFloat64(ctx,p.dx),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"dy",JS_NewFloat64(ctx,p.dy),JS_PROP_C_W_E)<0||
       JS_DefinePropertyValueStr(ctx,bounds,"pixels",JS_NewFloat64(ctx,cells),JS_PROP_C_W_E)<0) {
      JS_FreeValue(ctx,bounds);goto done;
    }
    result=JS_NewObject(ctx);
    if(JS_IsException(result)){JS_FreeValue(ctx,bounds);goto done;}
    if(JS_DefinePropertyValueStr(ctx,result,"bounds",bounds,JS_PROP_C_W_E)<0) {
      JS_FreeValue(ctx,result);result=JS_EXCEPTION;goto done;
    }
    JSValue dirty=painter_dirty(&p);
    if(JS_IsException(dirty)){JS_FreeValue(ctx,result);result=JS_EXCEPTION;goto done;}
    if(JS_DefinePropertyValueStr(ctx,result,"dirty",dirty,JS_PROP_C_W_E)<0) {
      JS_FreeValue(ctx,result);result=JS_EXCEPTION;goto done;
    }
  } else result=painter_dirty(&p);
done:
  if(JS_IsException(result)) {
    invalidate_changed_rows(rows,(unsigned)w,(unsigned)h);
    invalidate_changed_blocks(blocks,(unsigned)w,(unsigned)h);
  }
  free(covered);free(runs);JS_FreeValue(ctx,changed_blocks.owner);JS_FreeValue(ctx,tracker.owner);JS_FreeValue(ctx,restoration.owner);
  JS_FreeValue(ctx,layers.owner);JS_FreeValue(ctx,input.owner);JS_FreeValue(ctx,pixels.owner);
  JS_FreeValue(ctx,o.layers);return result;
}

static JSValue fill_run_layers(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{return fill_layers(ctx,self,argc,argv,1,0);}
static JSValue fill_run_layers_restored(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{return fill_layers(ctx,self,argc,argv,1,1);}
static JSValue fill_rect_layers(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{return fill_layers(ctx,self,argc,argv,0,0);}


/* 只登记最终值真正变化的组；列表合成与普通缓存复制共用同一写入路径。 */
static inline void copy_tracked_span(uint32_t *dest,const uint32_t *src,unsigned count,
                                     unsigned pos,uint16_t *rows,uint32_t *blocks)
{
  unsigned first=0,last=0;
    struct dirty_block_accumulator a={.words=blocks,.word=pos/256};
    // 连续8像素一组比较，干净组直接跳过；变化组只合并一次tracker。
    // 避免滚动背景中的每个像素都支付循环/脏块登记开销。
    while(count>=8) {
      if(dest[0]!=(src[0]&0xffffff)||dest[1]!=(src[1]&0xffffff)||
         dest[2]!=(src[2]&0xffffff)||dest[3]!=(src[3]&0xffffff)||
         dest[4]!=(src[4]&0xffffff)||dest[5]!=(src[5]&0xffffff)||
         dest[6]!=(src[6]&0xffffff)||dest[7]!=(src[7]&0xffffff)) {
        dest[0]=src[0]&0xffffff;dest[1]=src[1]&0xffffff;
        dest[2]=src[2]&0xffffff;dest[3]=src[3]&0xffffff;
        dest[4]=src[4]&0xffffff;dest[5]=src[5]&0xffffff;
        dest[6]=src[6]&0xffffff;dest[7]=src[7]&0xffffff;
        if(!last)first=pos;last=pos+8;mark_changed_blocks(&a,pos,8);
      }
      dest+=8;src+=8;pos+=8;count-=8;
    }
    while(count--) {
      uint32_t color=*src++&0xffffff;
      if(*dest!=color) {
        *dest=color;if(!last)first=pos;last=pos+1;mark_changed_blocks(&a,pos,1);
      }
      ++dest;++pos;
    }
    commit_changed_blocks(&a);
    if(last&&rows)mark_changed_span(rows,first,last);
}

/* 不缩放的离屏行缓存直接在 C 中拷贝；只登记真正变化的8像素块。
 * 所有数字转换先完成，之后持有 buffer owner，避免 getter 分离造成悬空指针。 */
static JSValue blit_canvas(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if(argc<12)return JS_ThrowTypeError(ctx,"blitCanvas needs pixels and integer geometry");
  double d[8];
  const int args[8]={1,2,4,5,6,7,8,9};
  for(int i=0;i<8;++i) {
    if(JS_ToFloat64(ctx,&d[i],argv[args[i]]))return JS_EXCEPTION;
    if(!isfinite(d[i])||floor(d[i])!=d[i]||d[i]<-16384||d[i]>16384)
      return JS_ThrowRangeError(ctx,"invalid blit geometry");
  }
  int w=d[0],h=d[1],sw=d[2],sh=d[3],x=d[4],y=d[5],sx=d[6],sy=d[7];
  int32_t bw,bh;
  if(JS_ToInt32(ctx,&bw,argv[10])||JS_ToInt32(ctx,&bh,argv[11]))return JS_EXCEPTION;
  /* 内置列表将同一缓存行的多个内容矩形一次提交，减少 JS/C 参数解析。
   * 裁剪数值仍须先转换，再获取所有 ArrayBuffer，防止 valueOf 分离 owner。 */
  bool regions=argc>14&&!JS_IsUndefined(argv[14]);
  int32_t clip_top=0,clip_bottom=h;
  if(regions && argc<17)return JS_ThrowTypeError(ctx,"blit rectangles need viewport");
  if(regions && (JS_ToInt32(ctx,&clip_top,argv[15])||
                 JS_ToInt32(ctx,&clip_bottom,argv[16])))return JS_EXCEPTION;
  if(clip_top<0||clip_bottom<clip_top||clip_bottom>h)
    return JS_ThrowRangeError(ctx,"invalid blit viewport");
  if(w<1||h<1||sw<1||sh<1||w>2048||h>2048||sw>2048||sh>2048||bw<0||bh<0||bw>8192||bh>8192)
    return JS_ThrowRangeError(ctx,"invalid blit size");
  struct canvas_view out={.owner=JS_UNDEFINED},in={.owner=JS_UNDEFINED};
  struct canvas_view tracker={.owner=JS_UNDEFINED},dirty={.owner=JS_UNDEFINED};
  struct canvas_view rectangles={.owner=JS_UNDEFINED};
  const int32_t *rects=NULL;
  unsigned rect_count=1;
  uint16_t *rows=NULL;uint32_t *blocks=NULL;
  JSValue result=JS_EXCEPTION;
  if(acquire_canvas_view(ctx,argv[0],JS_TYPED_ARRAY_UINT32,&out)<0||
     acquire_canvas_view(ctx,argv[3],JS_TYPED_ARRAY_UINT32,&in)<0)goto done;
  if(out.bytes!=(size_t)w*h*4||in.bytes!=(size_t)sw*sh*4||views_overlap(&out,&in)) {
    JS_ThrowRangeError(ctx,"invalid or overlapping blit pixels");goto done;
  }
  if(argc>12&&!JS_IsUndefined(argv[12])) {
    if(acquire_canvas_view(ctx,argv[12],JS_TYPED_ARRAY_UINT16,&tracker)<0)goto done;
    if(tracker.bytes!=(size_t)h*4||views_share_owner(&tracker,&out)||views_share_owner(&tracker,&in)) {
      JS_ThrowRangeError(ctx,"invalid blit rows");goto done;
    }
    rows=(uint16_t *)tracker.data;
  }
  if(argc>13&&!JS_IsUndefined(argv[13])) {
    if(acquire_canvas_view(ctx,argv[13],JS_TYPED_ARRAY_UINT32,&dirty)<0)goto done;
    if(dirty.bytes!=(size_t)((w+255)/256)*h*4||views_share_owner(&dirty,&out)||
       views_share_owner(&dirty,&in)||views_share_owner(&dirty,&tracker)) {
      JS_ThrowRangeError(ctx,"invalid blit blocks");goto done;
    }
    blocks=(uint32_t *)dirty.data;
  }
  if(regions) {
    if(acquire_canvas_view(ctx,argv[14],JS_TYPED_ARRAY_INT32,&rectangles)<0)goto done;
    if(rectangles.bytes%16||rectangles.bytes>256*16||
       views_share_owner(&rectangles,&out)||views_share_owner(&rectangles,&in)||
       views_share_owner(&rectangles,&tracker)||views_share_owner(&rectangles,&dirty)) {
      JS_ThrowRangeError(ctx,"invalid or shared blit rectangles");goto done;
    }
    rects=(const int32_t *)rectangles.data;rect_count=rectangles.bytes/16;
    /* 全表先验证，尾部无效矩形不能留下半帧写入。 */
    for(unsigned i=0;i<rect_count;++i) {
      if(rects[i*4]<-16384||rects[i*4]>16384||rects[i*4+1]<-16384||rects[i*4+1]>16384||
         rects[i*4+2]<0||rects[i*4+2]>8192||rects[i*4+3]<0||rects[i*4+3]>8192) {
        JS_ThrowRangeError(ctx,"invalid blit rectangle geometry");goto done;
      }
    }
  }
  /* 同时裁剪输入和输出，保持源/目的像素一一对应。 */
  int left=0,top=0,right=bw,bottom=bh;
  if(-x>left)left=-x;if(-sx>left)left=-sx;
  if(clip_top-y>top)top=clip_top-y;if(-sy>top)top=-sy;
  if(w-x<right)right=w-x;if(sw-sx<right)right=sw-sx;
  if(clip_bottom-y<bottom)bottom=clip_bottom-y;if(sh-sy<bottom)bottom=sh-sy;
  unsigned work=0;
  int all_left=left,all_top=top,all_right=right,all_bottom=bottom;
  for(unsigned region=0;region<rect_count;++region) {
    if((region&63)==0 && px_runtime_poll_interrupt(ctx)<0)goto done;
    left=all_left;top=all_top;right=all_right;bottom=all_bottom;
    if(rects) {
      const int32_t *r=rects+region*4;
      if(r[0]>left)left=r[0];if(r[1]>top)top=r[1];
      if(r[0]+r[2]<right)right=r[0]+r[2];if(r[1]+r[3]<bottom)bottom=r[1]+r[3];
    }
  for(int row=top;row<bottom&&left<right;++row) {
    uint32_t *dest=(uint32_t *)out.data+(y+row)*w+x+left;
    const uint32_t *src=(const uint32_t *)in.data+(sy+row)*sw+sx+left;
    copy_tracked_span(dest,src,right-left,x+left,rows?rows+(y+row)*2:NULL,
                      blocks?blocks+(y+row)*((w+255)/256):NULL);
    work+=right-left;
    if(work>=4096) {
      if(px_runtime_poll_interrupt(ctx)<0)goto done;
      work=0;
    }
  }
  }
  result=JS_UNDEFINED;
done:
  if(JS_IsException(result)) {
    invalidate_changed_rows(rows,w,h);invalidate_changed_blocks(blocks,w,h);
  }
  JS_FreeValue(ctx,out.owner);JS_FreeValue(ctx,in.owner);
  JS_FreeValue(ctx,tracker.owner);JS_FreeValue(ctx,dirty.owner);
  JS_FreeValue(ctx,rectangles.owner);
  return result;
}

/* 不透明、互不重叠的列表行一次合成最终像素。候选区域包含新旧内容，
 * 每扫描行用32字节位图去重；不需要整屏中间缓冲，也不会先擦除产生假脏。
 * geometry 每行 [屏幕y, 高度]；regions 每块 [x,y,w,h]，均为屏幕坐标。 */
static JSValue compose_rows(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv)
{
  (void)self;
  if(argc<9)return JS_ThrowTypeError(ctx,"composeRows needs row sources and geometry");
  double numbers[5];const int indices[5]={1,2,6,7,8};
  for(unsigned i=0;i<5;++i)
    if(JS_ToFloat64(ctx,&numbers[i],argv[indices[i]]))return JS_EXCEPTION;
  for(unsigned i=0;i<5;++i)
    if(!isfinite(numbers[i])||floor(numbers[i])!=numbers[i])
      return JS_ThrowRangeError(ctx,"invalid row composition number");
  if(numbers[0]<1||numbers[0]>2048||numbers[1]<1||numbers[1]>2048||
     numbers[2]<0||numbers[3]<numbers[2]||numbers[3]>numbers[1]||
     numbers[4]<0||numbers[4]>0xffffff)
    return JS_ThrowRangeError(ctx,"invalid row composition viewport");
  int w=numbers[0],h=numbers[1],top=numbers[2],bottom=numbers[3];
  uint32_t background=numbers[4];
  JSValue length=JS_GetPropertyStr(ctx,argv[3],"length");
  if(JS_IsException(length))return JS_EXCEPTION;
  double n;int failed=JS_ToFloat64(ctx,&n,length);JS_FreeValue(ctx,length);
  if(failed)return JS_EXCEPTION;
  if(!isfinite(n)||n<0||n>32||floor(n)!=n)
    return JS_ThrowRangeError(ctx,"too many composed rows");
  unsigned count=n;
  JSValue values[32];struct canvas_view sources[32];
  for(unsigned i=0;i<32;++i){values[i]=JS_UNDEFINED;sources[i]=(struct canvas_view){.owner=JS_UNDEFINED};}
  struct canvas_view out={.owner=JS_UNDEFINED},geometry={.owner=JS_UNDEFINED},regions={.owner=JS_UNDEFINED};
  struct canvas_view tracker={.owner=JS_UNDEFINED},dirty={.owner=JS_UNDEFINED};
  JSValue result=JS_EXCEPTION;uint16_t *rows=NULL;uint32_t *blocks=NULL;
  uint32_t *candidate_rows=NULL;
  /* 所有数组 getter 先执行完，再获取 owner；恶意 getter 分离任意输入也能安全拒绝。 */
  for(unsigned i=0;i<count;++i) {
    values[i]=JS_GetPropertyUint32(ctx,argv[3],i);
    if(JS_IsException(values[i]))goto done;
  }
  if(acquire_canvas_view(ctx,argv[0],JS_TYPED_ARRAY_UINT32,&out)<0||
     acquire_canvas_view(ctx,argv[4],JS_TYPED_ARRAY_INT32,&geometry)<0||
     acquire_canvas_view(ctx,argv[5],JS_TYPED_ARRAY_INT32,&regions)<0)goto done;
  if(out.bytes!=(size_t)w*h*4||geometry.bytes!=count*8||regions.bytes%16||regions.bytes>512*16||
     views_share_owner(&out,&geometry)||views_share_owner(&out,&regions)||views_share_owner(&geometry,&regions)) {
    JS_ThrowRangeError(ctx,"invalid composition buffers");goto done;
  }
  const int32_t *g=(const int32_t *)geometry.data,*r=(const int32_t *)regions.data;
  for(unsigned i=0;i<count;++i) {
    if(g[i*2]<-16384||g[i*2]>16384||g[i*2+1]<1||g[i*2+1]>2048||
       (i&&g[i*2]<g[(i-1)*2]+g[(i-1)*2+1])) {
      JS_ThrowRangeError(ctx,"composed rows must be ordered and nonoverlapping");goto done;
    }
    if(acquire_canvas_view(ctx,values[i],JS_TYPED_ARRAY_UINT32,&sources[i])<0)goto done;
    if(sources[i].bytes!=(size_t)w*g[i*2+1]*4||views_share_owner(&sources[i],&out)||
       views_share_owner(&sources[i],&geometry)||views_share_owner(&sources[i],&regions)) {
      JS_ThrowRangeError(ctx,"invalid composition source");goto done;
    }
  }
  unsigned rectangle_count=regions.bytes/16;
  for(unsigned i=0;i<rectangle_count;++i)
    if(r[i*4]<-16384||r[i*4]>16384||r[i*4+1]<-16384||r[i*4+1]>16384||
       r[i*4+2]<0||r[i*4+2]>8192||r[i*4+3]<0||r[i*4+3]>8192) {
      JS_ThrowRangeError(ctx,"invalid composition rectangle");goto done;
    }
  if(argc>9&&!JS_IsUndefined(argv[9])) {
    if(acquire_canvas_view(ctx,argv[9],JS_TYPED_ARRAY_UINT16,&tracker)<0)goto done;
    if(tracker.bytes!=(size_t)h*4||views_share_owner(&tracker,&out)||
       views_share_owner(&tracker,&geometry)||views_share_owner(&tracker,&regions)) {
      JS_ThrowRangeError(ctx,"invalid composition row tracker");goto done;
    }
    for(unsigned i=0;i<count;++i)if(views_share_owner(&tracker,&sources[i])) {
      JS_ThrowRangeError(ctx,"shared composition row tracker");goto done;
    }
    rows=(uint16_t *)tracker.data;
  }
  if(argc>10&&!JS_IsUndefined(argv[10])) {
    if(acquire_canvas_view(ctx,argv[10],JS_TYPED_ARRAY_UINT32,&dirty)<0)goto done;
    if(dirty.bytes!=(size_t)((w+255)/256)*h*4||views_share_owner(&dirty,&out)||
       views_share_owner(&dirty,&geometry)||views_share_owner(&dirty,&regions)||views_share_owner(&dirty,&tracker)) {
      JS_ThrowRangeError(ctx,"invalid composition block tracker");goto done;
    }
    for(unsigned i=0;i<count;++i)if(views_share_owner(&dirty,&sources[i])) {
      JS_ThrowRangeError(ctx,"shared composition block tracker");goto done;
    }
    blocks=(uint32_t *)dirty.data;
  }
  unsigned source_index=0,words=(w+255)/256,work=0;
  /*
   * 先把矩形列表编译成每个扫描行的 8 像素块位图。旧实现每一行都
   * 重新遍历全部 regions；Wi-Fi 页面滚动时这段循环会占掉合成器的
   * 主要时间。候选位图上限为 2048*8*4 字节，不进入 JS 堆，也不改
   * 写入语义：仍然只合成矩形覆盖到的完整 8 像素块。
   */
  unsigned row_count=(unsigned)(bottom-top);
  if(row_count&&rectangle_count&&words) {
    size_t bytes=(size_t)row_count*words*sizeof(*candidate_rows);
    candidate_rows=compose_candidate_reserve(bytes);
    if(!candidate_rows) {
      JS_ThrowInternalError(ctx,"composition candidate allocation failed");
      goto done;
    }
    /* 候选位图本身已经是每行的稀疏索引；扫描时直接找首尾非空字，
     * 不再维护两个 2048 项的常驻数组，避免占用 16 KiB 内部 DRAM。 */
    for(unsigned i=0;i<rectangle_count;++i) {
      const int32_t *rect=r+i*4;
      int y0=rect[1]>top?rect[1]:top;
      int y1=rect[1]+rect[3]<bottom?rect[1]+rect[3]:bottom;
      int left=rect[0]>0?rect[0]:0,right=rect[0]+rect[2];
      if(right>w)right=w;
      if(y1<=y0||right<=left)continue;
      unsigned first=(unsigned)left/8,last=(unsigned)(right-1)/8;
      unsigned first_word=first/32,last_word=last/32;
      uint32_t first_mask=UINT32_MAX<<(first%32);
      uint32_t last_mask=UINT32_MAX>>(31-(last%32));
      for(int yy=y0;yy<y1;++yy) {
        uint32_t *row=candidate_rows+(unsigned)(yy-top)*words;
        if(first_word==last_word)row[first_word]|=first_mask&last_mask;
        else {
          row[first_word]|=first_mask;
          for(unsigned word=first_word+1;word<last_word;++word)row[word]=UINT32_MAX;
          row[last_word]|=last_mask;
        }
      }
    }
  }
  for(int y=top;y<bottom;++y) {
    if((y&15)==0&&px_runtime_poll_interrupt(ctx)<0)goto done;
    uint32_t *candidates=candidate_rows?candidate_rows+(unsigned)(y-top)*words:NULL;
    while(source_index<count&&y>=g[source_index*2]+g[source_index*2+1])++source_index;
    const uint32_t *input=source_index<count&&y>=g[source_index*2]?
      (const uint32_t *)sources[source_index].data+(y-g[source_index*2])*w:NULL;
    uint32_t *dest=(uint32_t *)out.data+y*w,*dirty_row=blocks?blocks+y*words:NULL;
    uint16_t *row=rows?rows+y*2:NULL;
    unsigned first_word=0,last_word=words;
    if(candidate_rows) {
      while(first_word<words && candidates[first_word]==0)++first_word;
      while(last_word>first_word && candidates[last_word-1]==0)--last_word;
      if(first_word>=last_word) continue;
    }
    for(unsigned word=first_word;word<last_word;++word) {
      uint32_t bits=candidates?candidates[word]:0;
      while(bits) {
        unsigned first=__builtin_ctz(bits),run_blocks;
        uint32_t zeros=~(bits>>first);
        run_blocks=zeros?(unsigned)__builtin_ctz(zeros):32;
        unsigned x=word*256+first*8,pixels=run_blocks*8;
        if(x+pixels>(unsigned)w)pixels=w-x;
        if(input)copy_tracked_span(dest+x,input+x,pixels,x,row,dirty_row);
        else fill_tracked_span(dest+x,pixels,background,row,x,dirty_row);
        bits&=run_blocks==32?0:~(((UINT32_C(1)<<run_blocks)-1)<<first);
        work+=pixels;
        if(work>=4096) {if(px_runtime_poll_interrupt(ctx)<0)goto done;work=0;}
      }
    }
  }
  result=JS_UNDEFINED;
done:
  if(JS_IsException(result)) {
    invalidate_changed_rows(rows,w,h);invalidate_changed_blocks(blocks,w,h);
  }
  for(unsigned i=0;i<count;++i){JS_FreeValue(ctx,values[i]);JS_FreeValue(ctx,sources[i].owner);}
  JS_FreeValue(ctx,out.owner);JS_FreeValue(ctx,geometry.owner);JS_FreeValue(ctx,regions.owner);
  JS_FreeValue(ctx,tracker.owner);JS_FreeValue(ctx,dirty.owner);return result;
}

void px_install_canvas(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx,native,"composeRows",JS_NewCFunction(ctx,compose_rows,"composeRows",9));
  JS_SetPropertyStr(ctx,native,"blitCanvas",JS_NewCFunction(ctx,blit_canvas,"blitCanvas",14));
  JS_SetPropertyStr(ctx,native,"clearCanvas",JS_NewCFunction(ctx,clear_canvas,"clearCanvas",6));
  JS_SetPropertyStr(ctx,native,"fillRects",JS_NewCFunction(ctx,fill_rects,"fillRects",5));
  JS_SetPropertyStr(ctx,native,"fillRunLayers",JS_NewCFunction(ctx,fill_run_layers,"fillRunLayers",5));
  JS_SetPropertyStr(ctx,native,"fillRunLayersRestored",JS_NewCFunction(ctx,fill_run_layers_restored,"fillRunLayersRestored",6));
  JS_SetPropertyStr(ctx,native,"fillRectLayers",JS_NewCFunction(ctx,fill_rect_layers,"fillRectLayers",5));
#ifdef PX_TEST_CANVAS
  JS_SetPropertyStr(ctx,native,"canvasStats",JS_NewCFunction(ctx,canvas_test_stats,"canvasStats",0));
#endif
}
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC pop_options
#endif
