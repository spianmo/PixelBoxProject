#ifdef __NuttX__
#  include <nuttx/config.h>
#endif
#include "quickjs.h"
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#if defined(__NuttX__) && defined(CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER)
# include <syslog.h>
#  include <nuttx/video/fb.h>
#  include <fcntl.h>
#  include <sys/ioctl.h>
#  include <sys/mman.h>
#  include <unistd.h>
#  include "pixelbox_board.h"
static int framebuffer_fd = -1;
static struct fb_videoinfo_s video;
static struct fb_planeinfo_s plane;
static uint8_t *framebuffer;
/* 只报告一次首个 flush 结果，避免动画刷新持续写日志。 */
static bool framebuffer_flush_reported;
static bool framebuffer_force_full, framebuffer_dirty;
static unsigned dirty_x0, dirty_y0, dirty_x1, dirty_y1;
static struct {
  uint64_t frames, updates, errors, converted_pixels, changed_pixels;
  uint64_t transactions, transmitted_pixels;
  uint64_t conversion_ns, planning_ns, update_ns;
  struct fb_area_s last_area;
} framebuffer_stats;

static void mark_dirty_row(unsigned x0, unsigned x1, unsigned y)
{
  if (!framebuffer_dirty) {
    dirty_x0=x0;dirty_y0=y;dirty_x1=x1;dirty_y1=y+1;
    framebuffer_dirty=true;
  } else {
    if(x0<dirty_x0)dirty_x0=x0;
    if(y<dirty_y0)dirty_y0=y;
    if(x1>dirty_x1)dirty_x1=x1;
    if(y>=dirty_y1)dirty_y1=y+1;
  }
}

#  ifdef CONFIG_FB_UPDATE
#    define FRAMEBUFFER_MAX_BANDS 32
#    ifndef FRAMEBUFFER_SPLIT_GAP
#      define FRAMEBUFFER_SPLIT_GAP 8
#    endif
#    define FRAMEBUFFER_MAX_RECTS 32
#    define FRAMEBUFFER_GRID_SIDE 64
#    define FRAMEBUFFER_GRID_ROWS 256
#    ifndef FRAMEBUFFER_WINDOW_COST
#      define FRAMEBUFFER_WINDOW_COST 2048
#    endif
#    ifndef FRAMEBUFFER_SMALL_WINDOW_COST
#      define FRAMEBUFFER_SMALL_WINDOW_COST 512
#    endif
/* 行带是低碎片候选；二维网格候选只有估算传输成本更低时才替换它。
 * 网格从8×2像素开始，长边超过512时按2倍放大；固定2048字节，不随屏幕分配。
 * 小窗口使用512像素、大窗口使用2048像素固定成本，抵消多次ioctl/窗口命令。
 */
struct framebuffer_dirty_grid_s {
  uint32_t bits[FRAMEBUFFER_GRID_ROWS][2];
  unsigned xshift,yshift;
};

static void add_dirty_band(struct fb_area_s *bands, unsigned *count,
                           unsigned x0, unsigned x1, unsigned y)
{
  /* count==MAX 表示最后一个带仍可合并；无法合并时用 MAX+1 标记溢出，
   * 后续调用直接返回，避免把 bands[MAX] 当作有效数组写入。 */
  if(*count>FRAMEBUFFER_MAX_BANDS)return;
  if(*count) {
    struct fb_area_s *last=&bands[*count-1];
    if(y-((unsigned)last->y+last->h)<FRAMEBUFFER_SPLIT_GAP) {
      unsigned right=(unsigned)last->x+last->w;
      if(x0<last->x)last->x=x0;
      if(x1>right)right=x1;
      last->w=right-last->x;last->h=y+1-last->y;
      return;
    }
  }
  if(*count==FRAMEBUFFER_MAX_BANDS) {
    ++*count;
    return;
  }
  bands[*count]=(struct fb_area_s){x0,y,x1-x0,1};
  ++*count;
}

static unsigned rectangle_cost(const struct fb_area_s *area)
{
  /* 板级驱动在旋转前将两个轴对齐到2像素，成本须包含该扩展。 */
  unsigned right=((unsigned)area->x+area->w+1)&~1u;
  unsigned bottom=((unsigned)area->y+area->h+1)&~1u;
  unsigned pixels=(right-(area->x&~1u))*(bottom-(area->y&~1u));
  /* 小碎片通常来自字形或触摸指示点；对它们保留精确行带收益，
   * 大窗口才提高事务固定成本，避免滚动时被拆成过多矩形。 */
  unsigned window_cost=pixels<4096?FRAMEBUFFER_SMALL_WINDOW_COST:
                                  FRAMEBUFFER_WINDOW_COST;
  return pixels+window_cost;
}

struct framebuffer_split_s {
  struct fb_area_s area,first,second;
  unsigned saving;
};

static struct fb_area_s grid_rectangle(const struct framebuffer_dirty_grid_s *grid,
                                       const struct fb_area_s *bounds,
                                       unsigned x0,unsigned y0,unsigned x1,unsigned y1)
{
  x0<<=grid->xshift;x1<<=grid->xshift;y0<<=grid->yshift;y1<<=grid->yshift;
  if(x0<bounds->x)x0=bounds->x;if(x1>(unsigned)bounds->x+bounds->w)x1=(unsigned)bounds->x+bounds->w;
  if(y0<bounds->y)y0=bounds->y;if(y1>(unsigned)bounds->y+bounds->h)y1=(unsigned)bounds->y+bounds->h;
  return (struct fb_area_s){x0,y0,x1-x0,y1-y0};
}

static void consider_split(struct framebuffer_split_s *split,unsigned cost,
                           const struct fb_area_s *first,const struct fb_area_s *second)
{
  unsigned divided=rectangle_cost(first)+rectangle_cost(second);
  if(divided<cost&&cost-divided>split->saving) {
    split->first=*first;split->second=*second;split->saving=cost-divided;
  }
}

/* 每个叶子只求一次最佳切分；行/列投影共用512字节，避免递归或面积大小的临时表。
 * 竖向投影只登记每列第一次/最后一次出现的位置，稠密区域也不逐tile枚举。
 */
static __attribute__((noinline)) void find_rectangle_split(
    const struct framebuffer_dirty_grid_s *grid,struct framebuffer_split_s *split)
{
  const struct fb_area_s *bounds=&split->area;
  unsigned cost=rectangle_cost(bounds);split->saving=0;
  if(cost<=2*FRAMEBUFFER_SMALL_WINDOW_COST)return;
  unsigned x0=bounds->x>>grid->xshift,y0=bounds->y>>grid->yshift;
  unsigned x1=((unsigned)bounds->x+bounds->w+(1u<<grid->xshift)-1)>>grid->xshift;
  unsigned y1=((unsigned)bounds->y+bounds->h+(1u<<grid->yshift)-1)>>grid->yshift;
  uint32_t mask[2]={
    (x0>=32?0:UINT32_MAX<<x0)&(x1>=32?UINT32_MAX:(1u<<x1)-1),
    (x0<=32?UINT32_MAX:UINT32_MAX<<(x0-32))&
      (x1<=32?0:x1==64?UINT32_MAX:(1u<<(x1-32))-1)
  };
  union {
    uint8_t row_suffix[FRAMEBUFFER_GRID_ROWS][2];
    struct {uint16_t extent[FRAMEBUFFER_GRID_SIDE][2],suffix[FRAMEBUFFER_GRID_SIDE][2];} column;
  } work;
  unsigned left=FRAMEBUFFER_GRID_SIDE,right=0;
  for(unsigned y=y1;y-->y0;) {
    uint32_t a=grid->bits[y][0]&mask[0],b=grid->bits[y][1]&mask[1];
    if(a||b) {
      unsigned l=a?(unsigned)__builtin_ctz(a):32+(unsigned)__builtin_ctz(b);
      unsigned r=b?64-(unsigned)__builtin_clz(b):32-(unsigned)__builtin_clz(a);
      if(l<left)left=l;if(r>right)right=r;
    }
    work.row_suffix[y][0]=left;work.row_suffix[y][1]=right;
  }
  left=FRAMEBUFFER_GRID_SIDE;right=0;
  for(unsigned y=y0;y<y1;++y) {
    uint32_t a=grid->bits[y][0]&mask[0],b=grid->bits[y][1]&mask[1];
    if(!(a||b))continue;
    unsigned l=a?(unsigned)__builtin_ctz(a):32+(unsigned)__builtin_ctz(b);
    unsigned r=b?64-(unsigned)__builtin_clz(b):32-(unsigned)__builtin_clz(a);
    if(l<left)left=l;if(r>right)right=r;
    unsigned next=y+1;
    while(next<y1&&!(grid->bits[next][0]&mask[0])&&!(grid->bits[next][1]&mask[1]))++next;
    if(next<y1) {
      struct fb_area_s first=grid_rectangle(grid,bounds,left,y0,right,y+1);
      struct fb_area_s second=grid_rectangle(grid,bounds,work.row_suffix[next][0],next,
                                            work.row_suffix[next][1],y1);
      consider_split(split,cost,&first,&second);
    }
    y=next-1;
  }
  for(unsigned x=x0;x<x1;++x) {
    work.column.extent[x][0]=y1;work.column.extent[x][1]=0;
  }
  uint32_t seen[2]={0,0};
  for(unsigned y=y0;y<y1;++y)for(unsigned word=0;word<2;++word) {
    uint32_t bits=grid->bits[y][word]&mask[word]&~seen[word];seen[word]|=bits;
    while(bits) {unsigned x=word*32+(unsigned)__builtin_ctz(bits);bits&=bits-1;work.column.extent[x][0]=y;}
  }
  seen[0]=seen[1]=0;
  for(unsigned y=y1;y-->y0;)for(unsigned word=0;word<2;++word) {
    uint32_t bits=grid->bits[y][word]&mask[word]&~seen[word];seen[word]|=bits;
    while(bits) {unsigned x=word*32+(unsigned)__builtin_ctz(bits);bits&=bits-1;work.column.extent[x][1]=y+1;}
  }
  unsigned top=y1,bottom=0;
  for(unsigned x=x1;x-->x0;) {
    if(work.column.extent[x][0]<top)top=work.column.extent[x][0];
    if(work.column.extent[x][1]>bottom)bottom=work.column.extent[x][1];
    work.column.suffix[x][0]=top;work.column.suffix[x][1]=bottom;
  }
  top=y1;bottom=0;
  for(unsigned x=x0;x<x1;++x) {
    if(!work.column.extent[x][1])continue;
    if(work.column.extent[x][0]<top)top=work.column.extent[x][0];
    if(work.column.extent[x][1]>bottom)bottom=work.column.extent[x][1];
    unsigned next=x+1;
    while(next<x1&&!work.column.extent[next][1])++next;
    if(next<x1) {
      struct fb_area_s first=grid_rectangle(grid,bounds,x0,top,x+1,bottom);
      struct fb_area_s second=grid_rectangle(grid,bounds,next,work.column.suffix[next][0],
                                            x1,work.column.suffix[next][1]);
      consider_split(split,cost,&first,&second);
    }
    x=next-1;
  }
}

static unsigned build_dirty_rectangles(const struct framebuffer_dirty_grid_s *grid,
                                       const struct fb_area_s *bounds,
                                       struct fb_area_s *rectangles)
{
  /* 每轮只分割省时最多的窗口，最多32叶；已规划叶子不重复扫描网格。
   * 分割后的窗口互不重叠，不能因到达上限把后续碎片并回宽矩形。
   */
  struct framebuffer_split_s leaves[FRAMEBUFFER_MAX_RECTS];
  unsigned count=1;leaves[0].area=*bounds;find_rectangle_split(grid,&leaves[0]);
  while(count<FRAMEBUFFER_MAX_RECTS) {
    unsigned best=0;
    for(unsigned i=1;i<count;++i)if(leaves[i].saving>leaves[best].saving)best=i;
    if(!leaves[best].saving)break;
    leaves[count].area=leaves[best].second;leaves[best].area=leaves[best].first;
    find_rectangle_split(grid,&leaves[best]);find_rectangle_split(grid,&leaves[count]);++count;
  }
  for(unsigned i=0;i<count;++i)rectangles[i]=leaves[i].area;
  return count;
}
#  endif

static inline void mark_dirty_tile(uint32_t *tiles,unsigned shift,unsigned x)
{
  if(tiles) {unsigned tile=x>>shift;tiles[tile>>5]|=1u<<(tile&31);}
}

static uint64_t elapsed_ns(const struct timespec *start, const struct timespec *end)
{
  int64_t elapsed=(int64_t)(end->tv_sec-start->tv_sec)*1000000000+
                  end->tv_nsec-start->tv_nsec;
  return elapsed>0?(uint64_t)elapsed:0;
}

static inline uint16_t rgb565(uint32_t rgb)
{
  return (uint16_t)(((rgb>>8)&0xf800)|((rgb>>5)&0x7e0)|((rgb>>3)&0x1f));
}

/* 将转换循环隔离，避免flush的大量状态挤占Xtensa通用寄存器。
 * 显式对齐承诺只在逐像素处理首端后使用；memcpy保留别名规则。
 */
static __attribute__((noinline)) unsigned convert_rgb565_row(
    uint16_t *destination, const uint32_t *source, unsigned begin, unsigned end,
    unsigned *first, unsigned *last,uint32_t *tiles,unsigned tile_shift)
{
  unsigned changed=0,x=begin;
  if(x<end && ((uintptr_t)(destination+x)&3)) {
    uint16_t value=rgb565(source[x]);
    if(destination[x]!=value) {
      destination[x]=value;changed=1;*first=x;*last=x+1;
      mark_dirty_tile(tiles,tile_shift,x);
    }
    ++x;
  }
  uint8_t *aligned=__builtin_assume_aligned(destination+x,4);
  const uint32_t *input=source+x;
  /* 黑色输入对的打包值为零，可直接作为有效初始缓存。 */
  uint32_t cached_a=0,cached_b=0,value=0;
  unsigned marked_tile=UINT32_MAX;
  for(;x+1<end;x+=2,aligned+=sizeof(uint32_t),input+=2) {
    uint32_t raw_a=input[0],raw_b=input[1];
    /* 只缓存本行上一输入对；每一对仍比较目标映射并准确统计脏像素。 */
    if((raw_a^cached_a)|(raw_b^cached_b)) {
      cached_a=raw_a;cached_b=raw_b;
      uint32_t a=rgb565(raw_a),b=rgb565(raw_b);
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
      value=a|(b<<16);
#else
      value=(a<<16)|b;
#endif
    }
    /* destination+x 已在上面的首像素处理后保证四字节对齐。 */
    uint32_t previous;
    memcpy(&previous,aligned,sizeof(previous));
    uint32_t difference=previous^value;
    if(!difference)continue;
    memcpy(aligned,&value,sizeof(value));
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    unsigned low=difference&0xffff,high=difference>>16;
#else
    unsigned low=difference>>16,high=difference&0xffff;
#endif
    if(tiles) {
      unsigned left=(low?x:x+1)>>tile_shift,right=(high?x+1:x)>>tile_shift;
      /* 同一8像素块只写一次位图，文字实心区域不为每个像素对重复读写。 */
      if(left!=marked_tile)tiles[left>>5]|=1u<<(left&31);
      if(right!=left)tiles[right>>5]|=1u<<(right&31);
      marked_tile=right;
    }
    if(low) {
      if(changed++==0)*first=x;
      *last=x+1;
    }
    if(high) {
      if(changed++==0)*first=x+1;
      *last=x+2;
    }
  }
  if(x<end) {
    uint16_t tail_value=rgb565(source[x]);
    if(destination[x]!=tail_value) {
      destination[x]=tail_value;
      if(changed++==0)*first=x;
      *last=x+1;
      mark_dirty_tile(tiles,tile_shift,x);
    }
  }
  return changed;
}

/* 按32位字跳过空块，再合并连续置位块；跨字边界的连续范围只返回一次。
 * cursor/limit以8像素块为单位，调用者随后与实际像素边界求交集。 */
static bool next_dirty_blocks(const uint32_t *bits,unsigned *cursor,unsigned limit,
                              unsigned *first,unsigned *last)
{
  unsigned block=*cursor;
  while(block<limit) {
    uint32_t word=bits[block>>5]&(UINT32_MAX<<(block&31));
    if(word) {block=(block&~31u)+(unsigned)__builtin_ctz(word);break;}
    block=(block|31u)+1;
  }
  if(block>=limit)return false;
  *first=block;
  while(block<limit) {
    uint32_t zeros=(~bits[block>>5])>>(block&31);
    if(zeros) {block+=(unsigned)__builtin_ctz(zeros);break;}
    block=(block|31u)+1;
  }
  if(block>limit)block=limit;
  *cursor=*last=block;
  return true;
}

static JSValue frame_stats(JSContext *ctx, JSValueConst self, int argc,
                           JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;
  JSValue result=JS_NewObject(ctx),area=JS_NewObject(ctx);
  if(JS_IsException(result)||JS_IsException(area)) {
    JS_FreeValue(ctx,result);JS_FreeValue(ctx,area);return JS_EXCEPTION;
  }
  JS_SetPropertyStr(ctx,result,"frames",JS_NewFloat64(ctx,(double)framebuffer_stats.frames));
  JS_SetPropertyStr(ctx,result,"updates",JS_NewFloat64(ctx,(double)framebuffer_stats.updates));
  JS_SetPropertyStr(ctx,result,"errors",JS_NewFloat64(ctx,(double)framebuffer_stats.errors));
  JS_SetPropertyStr(ctx,result,"convertedPixels",JS_NewFloat64(ctx,(double)framebuffer_stats.converted_pixels));
  JS_SetPropertyStr(ctx,result,"changedPixels",JS_NewFloat64(ctx,(double)framebuffer_stats.changed_pixels));
  JS_SetPropertyStr(ctx,result,"transactions",JS_NewFloat64(ctx,(double)framebuffer_stats.transactions));
  /* 成功 ioctl 的逻辑面积，不含驱动为 DMA/面板施加的对齐扩展。 */
  JS_SetPropertyStr(ctx,result,"transmittedPixels",JS_NewFloat64(ctx,(double)framebuffer_stats.transmitted_pixels));
  uint64_t elapsed=framebuffer_stats.conversion_ns+framebuffer_stats.planning_ns+framebuffer_stats.update_ns;
  JS_SetPropertyStr(ctx,result,"elapsedMs",JS_NewFloat64(ctx,elapsed/1000000.0));
  JS_SetPropertyStr(ctx,result,"conversionMs",JS_NewFloat64(ctx,framebuffer_stats.conversion_ns/1000000.0));
  JS_SetPropertyStr(ctx,result,"planningMs",JS_NewFloat64(ctx,framebuffer_stats.planning_ns/1000000.0));
  JS_SetPropertyStr(ctx,result,"updateMs",JS_NewFloat64(ctx,framebuffer_stats.update_ns/1000000.0));
  struct timespec resolution;
  if(clock_getres(CLOCK_MONOTONIC,&resolution)==0)
    JS_SetPropertyStr(ctx,result,"clockResolutionMs",JS_NewFloat64(ctx,
      (double)resolution.tv_sec*1000+resolution.tv_nsec/1000000.0));
  JS_SetPropertyStr(ctx,area,"x",JS_NewUint32(ctx,framebuffer_stats.last_area.x));
  JS_SetPropertyStr(ctx,area,"y",JS_NewUint32(ctx,framebuffer_stats.last_area.y));
  JS_SetPropertyStr(ctx,area,"width",JS_NewUint32(ctx,framebuffer_stats.last_area.w));
  JS_SetPropertyStr(ctx,area,"height",JS_NewUint32(ctx,framebuffer_stats.last_area.h));
  JS_SetPropertyStr(ctx,result,"lastArea",area);
  return result;
}

static JSValue flush(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (framebuffer_fd < 0) return JS_ThrowInternalError(ctx, "ENOTSUP");
  if (!argc || JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT32)
    return JS_ThrowTypeError(ctx, "framebuffer needs Uint32Array RGB pixels");
  bool has_rows=argc>=7&&!JS_IsUndefined(argv[6]);
  if(has_rows&&JS_GetTypedArrayType(argv[6])!=JS_TYPED_ARRAY_UINT16)
    return JS_ThrowTypeError(ctx,"framebuffer rows need Uint16Array");
  bool has_blocks=argc>=8&&!JS_IsUndefined(argv[7]);
  if(has_blocks&&JS_GetTypedArrayType(argv[7])!=JS_TYPED_ARRAY_UINT32)
    return JS_ThrowTypeError(ctx,"framebuffer blocks need Uint32Array");
  unsigned scan_x0=0, scan_y0=0, scan_x1=video.xres, scan_y1=video.yres;
  /* 自动帧且Canvas未写入时只处理待重试事务；显式flush仍默认扫描整屏。
   * 首帧、亮屏和旋转的强制提交优先，不能被干净帧标志吞掉。 */
  bool known_clean=argc>=6&&JS_IsBool(argv[5])&&JS_ToBool(ctx,argv[5]);
  if (known_clean && !framebuffer_force_full) {
    scan_x1=scan_y1=0;
  } else if (argc >= 5 && !framebuffer_force_full) {
    int32_t x, y, width, height;
    if (JS_ToInt32(ctx, &x, argv[1]) || JS_ToInt32(ctx, &y, argv[2]) ||
        JS_ToInt32(ctx, &width, argv[3]) || JS_ToInt32(ctx, &height, argv[4])) {
      return JS_EXCEPTION;
    }
    if (x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x >= video.xres || y >= video.yres) {
      return JS_ThrowRangeError(ctx, "invalid framebuffer dirty area");
    }
    scan_x0=(unsigned)x; scan_y0=(unsigned)y;
    scan_x1=(unsigned)((int64_t)x+width > video.xres ? video.xres : x+width);
    scan_y1=(unsigned)((int64_t)y+height > video.yres ? video.yres : y+height);
  }
  /* valueOf可重入亮屏/旋转并设置强制提交，最终范围必须采用转换后的状态。 */
  if(framebuffer_force_full) {
    scan_x0=scan_y0=0;scan_x1=video.xres;scan_y1=video.yres;
  }
  /* valueOf可分离ArrayBuffer；所有参数转换完成后才获取并持有各个owner。
   * tracker即使本帧被force/known_clean忽略，也要完整校验后才能写映射。 */
  size_t offset, size, element, capacity;
  JSValue owner = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &size, &element);
  if (JS_IsException(owner)) return owner;
  uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, owner);
  if(JS_HasException(ctx)) {JS_FreeValue(ctx,owner);return JS_EXCEPTION;}
  if (!base || offset > capacity || size > capacity - offset ||
      size != (size_t)video.xres * video.yres * sizeof(uint32_t)) {
    JS_FreeValue(ctx, owner);
    return JS_ThrowRangeError(ctx, "invalid framebuffer dimensions");
  }
  const uint32_t *pixels = (const uint32_t *)(base + offset);
  JSValue rows_owner=JS_UNDEFINED;
  const uint16_t *rows=NULL;
  if(has_rows) {
    rows_owner=JS_GetTypedArrayBuffer(ctx,argv[6],&offset,&size,&element);
    if(JS_IsException(rows_owner)) {JS_FreeValue(ctx,owner);return JS_EXCEPTION;}
    base=JS_GetArrayBuffer(ctx,&capacity,rows_owner);
    if(JS_HasException(ctx)) {
      JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);return JS_EXCEPTION;
    }
    if(!base||offset>capacity||size>capacity-offset||
       size!=(size_t)video.yres*2*sizeof(uint16_t)||
       JS_VALUE_GET_PTR(owner)==JS_VALUE_GET_PTR(rows_owner)) {
      JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
      return JS_ThrowRangeError(ctx,"invalid framebuffer rows buffer");
    }
    rows=(const uint16_t *)(const void *)(base+offset);
    for(unsigned y=0;y<video.yres;++y) {
      unsigned left=rows[y*2],right=rows[y*2+1];
      if((!left&&right)||(left&&(left>right||right>video.xres))) {
        JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
        return JS_ThrowRangeError(ctx,"invalid framebuffer row range");
      }
    }
  }
  JSValue blocks_owner=JS_UNDEFINED;
  const uint32_t *blocks=NULL;
  unsigned block_count=(video.xres+7u)/8,block_words=(block_count+31)/32;
  if(has_blocks) {
    blocks_owner=JS_GetTypedArrayBuffer(ctx,argv[7],&offset,&size,&element);
    if(JS_IsException(blocks_owner)) {
      JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);return JS_EXCEPTION;
    }
    base=JS_GetArrayBuffer(ctx,&capacity,blocks_owner);
    if(JS_HasException(ctx)) {
      JS_FreeValue(ctx,blocks_owner);JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
      return JS_EXCEPTION;
    }
    if(!base||offset>capacity||size>capacity-offset||
       size!=(size_t)block_words*video.yres*sizeof(uint32_t)||
       JS_VALUE_GET_PTR(blocks_owner)==JS_VALUE_GET_PTR(owner)||
       (has_rows&&JS_VALUE_GET_PTR(blocks_owner)==JS_VALUE_GET_PTR(rows_owner))) {
      JS_FreeValue(ctx,blocks_owner);JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
      return JS_ThrowRangeError(ctx,"invalid framebuffer blocks buffer");
    }
    blocks=(const uint32_t *)(const void *)(base+offset);
    /* 每行末字只允许实际存在的块，先检查全表再修改任何映射。 */
    unsigned tail=block_count&31;
    if(tail)for(unsigned y=0;y<video.yres;++y) {
      if(blocks[(size_t)y*block_words+block_words-1]>>tail) {
        JS_FreeValue(ctx,blocks_owner);JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
        return JS_ThrowRangeError(ctx,"invalid framebuffer block bits");
      }
    }
  }
  if(scan_y1==0&&!framebuffer_dirty&&!framebuffer_force_full) {
    /* 静止帧已完成参数校验，且没有失败事务需要重发。 */
    ++framebuffer_stats.frames;
    JS_FreeValue(ctx,blocks_owner);JS_FreeValue(ctx,rows_owner);JS_FreeValue(ctx,owner);
    return JS_UNDEFINED;
  }
  struct timespec started,conversion_finished;
  bool timing_valid=clock_gettime(CLOCK_MONOTONIC,&started)==0;
  ++framebuffer_stats.frames;
  unsigned changed_pixels=0;
#  ifdef CONFIG_FB_UPDATE
  struct fb_area_s bands[FRAMEBUFFER_MAX_BANDS];
  struct fb_area_s rectangles[FRAMEBUFFER_MAX_RECTS];
  struct framebuffer_dirty_grid_s grid;
  unsigned band_count=0;
  /* 前次失败后映射已改变，新的差分不能覆盖全部待重试区域，必须发送并集。 */
  bool split_bands=!framebuffer_force_full&&!framebuffer_dirty;
  if(split_bands) {
    memset(&grid,0,sizeof(grid));grid.xshift=3;grid.yshift=1;
    while(((unsigned)video.xres-1)>>grid.xshift>=FRAMEBUFFER_GRID_SIDE)++grid.xshift;
    while(((unsigned)video.yres-1)>>grid.yshift>=FRAMEBUFFER_GRID_ROWS)++grid.yshift;
  }
#  endif
  /* 每段使用格式专用像素循环；整行只合并一次脏区，真实stride保留非对齐映射。 */
  for (unsigned y=scan_y0; y<scan_y1; ++y) {
    unsigned begin=scan_x0,end=scan_x1;
    if(rows&&!framebuffer_force_full) {
      if(!rows[y*2])continue;
      unsigned left=rows[y*2]-1,right=rows[y*2+1];
      if(left>begin)begin=left;
      if(right<end)end=right;
      if(begin>=end)continue;
    }
    uint8_t *row=framebuffer+(size_t)y*plane.stride;
    const uint32_t *source=pixels+(size_t)y*video.xres;
    unsigned row_changed=0,x0=0,x1=0;
    uint32_t *dirty_tiles=NULL;unsigned tile_shift=0;
#  ifdef CONFIG_FB_UPDATE
    if(split_bands) {dirty_tiles=grid.bits[y>>grid.yshift];tile_shift=grid.xshift;}
#  endif
    const uint32_t *row_blocks=blocks&&!framebuffer_force_full?blocks+(size_t)y*block_words:NULL;
    unsigned cursor=begin/8;
    do {
      unsigned segment_begin=begin,segment_end=end;
      if(row_blocks) {
        unsigned first,last;
        if(!next_dirty_blocks(row_blocks,&cursor,(end+7)/8,&first,&last))break;
        if(first*8>segment_begin)segment_begin=first*8;
        if(last*8<segment_end)segment_end=last*8;
      }
      framebuffer_stats.converted_pixels+=segment_end-segment_begin;
      if (video.fmt==FB_FMT_RGB16_565 && ((uintptr_t)row % _Alignof(uint16_t))==0) {
        /* 对齐行直接读写 16 位像素；奇数 stride 的非对齐行走 memcpy。 */
        uint16_t *destination=(uint16_t *)(void *)row;
        unsigned first=0,last=0;
        unsigned changed=convert_rgb565_row(destination,source,segment_begin,segment_end,
                                            &first,&last,dirty_tiles,tile_shift);
        if(changed) {
          if(!row_changed)x0=first;
          x1=last;row_changed+=changed;
        }
      } else if (video.fmt==FB_FMT_RGB16_565) {
        for (unsigned x=segment_begin; x<segment_end; ++x) {
          uint16_t value=rgb565(source[x]);
          uint16_t previous;memcpy(&previous,row+x*2,2);
          if(previous!=value) {
            memcpy(row+x*2,&value,2);
            if(row_changed++==0)x0=x;
            x1=x+1;
            mark_dirty_tile(dirty_tiles,tile_shift,x);
          }
        }
      } else if (video.fmt==FB_FMT_RGB32) {
        for (unsigned x=segment_begin; x<segment_end; ++x) {
          uint32_t rgb=source[x],previous;memcpy(&previous,row+x*4,4);
          if(previous!=rgb) {
            memcpy(row+x*4,&rgb,4);
            if(row_changed++==0)x0=x;
            x1=x+1;
            mark_dirty_tile(dirty_tiles,tile_shift,x);
          }
        }
      } else {
        for (unsigned x=segment_begin; x<segment_end; ++x) {
          uint32_t rgb=source[x];
          uint8_t value[3]={(uint8_t)rgb,(uint8_t)(rgb>>8),(uint8_t)(rgb>>16)};
          if(memcmp(row+x*3,value,3)!=0) {
            memcpy(row+x*3,value,3);
            if(row_changed++==0)x0=x;
            x1=x+1;
            mark_dirty_tile(dirty_tiles,tile_shift,x);
          }
        }
      }
    } while(row_blocks);
    if(row_changed) {
      mark_dirty_row(x0,x1,y);
#  ifdef CONFIG_FB_UPDATE
      if(split_bands)add_dirty_band(bands,&band_count,x0,x1,y);
#  endif
    }
    changed_pixels+=row_changed;
  }
  framebuffer_stats.changed_pixels+=changed_pixels;
  if(timing_valid && clock_gettime(CLOCK_MONOTONIC,&conversion_finished)==0)
    framebuffer_stats.conversion_ns+=elapsed_ns(&started,&conversion_finished);
  JS_FreeValue(ctx, owner);
  /* C只消费范围；JS必须等全部事务成功后再清tracker，失败时保留并集重试。 */
  JS_FreeValue(ctx, rows_owner);
  JS_FreeValue(ctx, blocks_owner);
#  ifdef CONFIG_FB_UPDATE
  if(!framebuffer_force_full&&!framebuffer_dirty) {
    return JS_UNDEFINED;
  }
  /* 映射已经写入新颜色，失败后单靠像素比较无法重试；成功之前保留脏区。
   * 这里提交逻辑矩形，两像素对齐和四方向旋转继续由板级驱动处理。
   */
  struct fb_area_s area=framebuffer_force_full?
    (struct fb_area_s){0,0,video.xres,video.yres}:
    (struct fb_area_s){dirty_x0,dirty_y0,dirty_x1-dirty_x0,dirty_y1-dirty_y0};
  if(!split_bands||!band_count||band_count>FRAMEBUFFER_MAX_BANDS) {
    bands[0]=area;band_count=1;
  }
  struct fb_area_s *selected=bands;
  unsigned selected_count=band_count;
  if(split_bands&&changed_pixels!=(uint64_t)area.w*area.h) {
    struct timespec planning_started,planning_finished;
    bool planning_timing_valid=clock_gettime(CLOCK_MONOTONIC,&planning_started)==0;
    unsigned rectangle_count=build_dirty_rectangles(&grid,&area,rectangles);
    unsigned bands_cost=0,rectangles_cost=0,bands_pixels=0,rectangles_pixels=0;
    for(unsigned i=0;i<band_count;++i) {
      bands_cost+=rectangle_cost(&bands[i]);bands_pixels+=(unsigned)bands[i].w*bands[i].h;
    }
    for(unsigned i=0;i<rectangle_count;++i) {
      rectangles_cost+=rectangle_cost(&rectangles[i]);
      rectangles_pixels+=(unsigned)rectangles[i].w*rectangles[i].h;
    }
    /* 只有总成本和发送面积同时下降才切二维路径；精确小行带保持原面积。 */
    if(rectangle_count&&rectangles_cost<bands_cost&&rectangles_pixels<bands_pixels) {
      selected=rectangles;selected_count=rectangle_count;
    }
    if(planning_timing_valid&&clock_gettime(CLOCK_MONOTONIC,&planning_finished)==0)
      framebuffer_stats.planning_ns+=elapsed_ns(&planning_started,&planning_finished);
  }
  for(unsigned band=0;band<selected_count;++band) {
    struct timespec update_started,update_finished;
    bool update_timing_valid=clock_gettime(CLOCK_MONOTONIC,&update_started)==0;
    int update_result=ioctl(framebuffer_fd,FBIO_UPDATE,(unsigned long)&selected[band]);
    int update_error=errno;
    if(update_timing_valid && clock_gettime(CLOCK_MONOTONIC,&update_finished)==0)
      framebuffer_stats.update_ns+=elapsed_ns(&update_started,&update_finished);
    if (!framebuffer_flush_reported) {
      framebuffer_flush_reported=true;
      if(update_result<0) {
        syslog(LOG_WARNING,
               "[pixelbox] framebuffer first FBIO_UPDATE failed errno=%d\n",
               update_error);
      } else {
        syslog(LOG_INFO,
               "[pixelbox] framebuffer first FBIO_UPDATE complete x=%u y=%u w=%u h=%u\n",
               (unsigned)selected[band].x,(unsigned)selected[band].y,
               (unsigned)selected[band].w,(unsigned)selected[band].h);
      }
    }
    if(update_result<0) {
      /* 任一段失败都保留整帧并集；下一帧可重发已成功段，不能漏掉未发送段。 */
      ++framebuffer_stats.errors;
      return JS_ThrowInternalError(ctx,"framebuffer update failed");
    }
    ++framebuffer_stats.transactions;
    framebuffer_stats.transmitted_pixels+=(uint64_t)selected[band].w*selected[band].h;
  }
  /* FPS 继续按成功整帧计数，lastArea 保留该帧的逻辑并集。 */
  ++framebuffer_stats.updates;
  framebuffer_stats.last_area=area;
#  endif
  framebuffer_dirty=false;framebuffer_force_full=false;
  return JS_UNDEFINED;
}

static JSValue set_power(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (framebuffer_fd<0 || !argc) return JS_ThrowInternalError(ctx,"ENOTSUP");
  int on=JS_ToBool(ctx,argv[0]);
  if(on<0) return JS_EXCEPTION;
  /* 点亮驱动可能已改电源状态但整帧传输失败，下一次flush必须仍可补发。 */
  if(on)framebuffer_force_full=true;
  if(ioctl(framebuffer_fd,FBIOSET_POWER,on?1:0)<0) return JS_ThrowInternalError(ctx,"ENOTSUP");
  return JS_UNDEFINED;
}

static JSValue display_setting(JSContext *ctx, JSValueConst self, int argc,
                               JSValueConst *argv, int operation)
{
  (void)self;
  if (framebuffer_fd < 0) return JS_ThrowInternalError(ctx, "ENOTSUP");
  int32_t value = 0;
  if (operation != 1 && (!argc || JS_ToInt32(ctx, &value, argv[0])))
    return argc ? JS_EXCEPTION : JS_ThrowTypeError(ctx, "display setting needs a value");
  int previous = operation == 2 ? pixelbox_board_display_get_rotation() : 0;
  int result = operation == 0 ? pixelbox_board_display_set_brightness(value) :
               operation == 1 ? pixelbox_board_display_get_brightness() :
                                pixelbox_board_display_set_rotation(value);
  if (result < 0) return JS_ThrowInternalError(ctx, "display setting failed (%d)", result);
  if (operation == 1) return JS_NewInt32(ctx, result);
  if (operation == 2) {
    /* 旋转会清零映射，黑色新画布与映射相同也必须清除屏上旧画面。 */
    if(previous!=value)framebuffer_force_full=true;
    return JS_NewBool(ctx, previous != value);
  }
  return JS_UNDEFINED;
}
#endif

void px_install_framebuffer(JSContext *ctx, JSValue native)
{
  int width=0,height=0;
#if defined(__NuttX__) && defined(CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER)
  framebuffer_fd=open(CONFIG_INTERPRETERS_PIXELBOX_FB_DEVICE,O_RDWR);
  framebuffer_dirty=false;framebuffer_force_full=true;
  memset(&framebuffer_stats,0,sizeof(framebuffer_stats));
  memset(&video,0,sizeof(video));memset(&plane,0,sizeof(plane));
  if(framebuffer_fd<0)
    {
      syslog(LOG_WARNING, "[pixelbox] framebuffer open %s failed errno=%d\n",
             CONFIG_INTERPRETERS_PIXELBOX_FB_DEVICE, errno);
    }
  else if(ioctl(framebuffer_fd,FBIOGET_VIDEOINFO,(unsigned long)&video)<0)
    {
      syslog(LOG_WARNING, "[pixelbox] framebuffer video info failed errno=%d\n",
             errno);
    }
  else if(ioctl(framebuffer_fd,FBIOGET_PLANEINFO,(unsigned long)&plane)<0)
    {
      syslog(LOG_WARNING, "[pixelbox] framebuffer plane info failed errno=%d\n",
             errno);
    }
  else if(!((video.fmt==FB_FMT_RGB16_565 && plane.bpp==16) ||
            (video.fmt==FB_FMT_RGB24 && plane.bpp==24) ||
            (video.fmt==FB_FMT_RGB32 && plane.bpp==32)) ||
          !video.xres || !video.yres ||
          (size_t)video.xres*video.yres>1024*1024 ||
          plane.stride<(size_t)video.xres*(plane.bpp/8) ||
          plane.fblen<(size_t)plane.stride*video.yres)
    {
      syslog(LOG_WARNING,
             "[pixelbox] framebuffer geometry rejected fmt=%d bpp=%d x=%u y=%u stride=%u len=%u\n",
             video.fmt, plane.bpp, (unsigned)video.xres, (unsigned)video.yres,
             (unsigned)plane.stride, (unsigned)plane.fblen);
    }
  else
    {
      framebuffer=mmap(NULL,plane.fblen,PROT_READ|PROT_WRITE,MAP_SHARED,framebuffer_fd,0);
      if(framebuffer!=MAP_FAILED)
        {
          width=video.xres;height=video.yres;
          framebuffer_flush_reported=false;
          syslog(LOG_INFO,
                 "[pixelbox] framebuffer mapped %ux%u fmt=%d stride=%u len=%u\n",
                 (unsigned)video.xres, (unsigned)video.yres, video.fmt,
                 (unsigned)plane.stride, (unsigned)plane.fblen);
        }
      else
        {
          framebuffer=NULL;
          syslog(LOG_WARNING, "[pixelbox] framebuffer mmap failed errno=%d\n",
                 errno);
        }
    }
  if(!width && framebuffer_fd>=0) { close(framebuffer_fd);framebuffer_fd=-1; }
  JS_SetPropertyStr(ctx,native,"flush",JS_NewCFunction(ctx,flush,"flush",1));
  JS_SetPropertyStr(ctx,native,"frameStats",JS_NewCFunction(ctx,frame_stats,"frameStats",0));
  JS_SetPropertyStr(ctx,native,"setPower",JS_NewCFunction(ctx,set_power,"setPower",1));
  JS_SetPropertyStr(ctx,native,"setBrightness",JS_NewCFunctionMagic(ctx,display_setting,"setBrightness",1,JS_CFUNC_generic_magic,0));
  JS_SetPropertyStr(ctx,native,"getBrightness",JS_NewCFunctionMagic(ctx,display_setting,"getBrightness",0,JS_CFUNC_generic_magic,1));
  JS_SetPropertyStr(ctx,native,"setRotation",JS_NewCFunctionMagic(ctx,display_setting,"setRotation",1,JS_CFUNC_generic_magic,2));
#endif
  JS_SetPropertyStr(ctx,native,"width",JS_NewInt32(ctx,width));
  JS_SetPropertyStr(ctx,native,"height",JS_NewInt32(ctx,height));
}

void px_close_framebuffer(void)
{
#if defined(__NuttX__) && defined(CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER)
  if(framebuffer) { munmap(framebuffer,plane.fblen);framebuffer=NULL; }
  if(framebuffer_fd>=0) { close(framebuffer_fd);framebuffer_fd=-1; }
  framebuffer_flush_reported=false;
  framebuffer_dirty=false;framebuffer_force_full=false;
#endif
}

int px_toggle_framebuffer_power(void)
{
#if defined(__NuttX__) && defined(CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER)
  if (framebuffer_fd < 0) return -ENODEV;
  int power = 0;
  if (ioctl(framebuffer_fd, FBIOGET_POWER, (unsigned long)&power) < 0)
    return -(errno ? errno : EIO);
  if (power < 0) return power;
  if(!power)framebuffer_force_full=true;
  return ioctl(framebuffer_fd, FBIOSET_POWER, power ? 0 : 1) < 0 ? -(errno ? errno : EIO) : 0;
#else
  return -ENOTSUP;
#endif
}
