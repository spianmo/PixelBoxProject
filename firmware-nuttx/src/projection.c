/* 与原 ESP-IDF 投影契约一致；密集 TypedArray 运算由原生循环完成，避免阻塞采音轮询。 */
#include "quickjs.h"
#include "pixelbox.h"
#include <math.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

/* JS 在每个乘法/加法后分别舍入；隐式 FMA 会让半像素边界跨格。
 * 只约束本文件，不改变其它 DSP 或固件组件的编译选项。 */
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC push_options
#pragma GCC optimize ("fp-contract=off")
#endif

struct typed_buffer {
  JSValue owner;
  uint8_t *base;
  void *data;
  size_t count;
};
static void release_buffer(JSContext *ctx, struct typed_buffer *buffer)
{ JS_FreeValue(ctx, buffer->owner); buffer->owner = JS_UNDEFINED; }
static bool read_buffer(JSContext *ctx, JSValueConst value, JSTypedArrayEnum type,
                        struct typed_buffer *buffer)
{
  if (JS_GetTypedArrayType(value) != (int)type) return false;
  size_t offset, bytes, element, capacity;
  buffer->owner = JS_GetTypedArrayBuffer(ctx, value, &offset, &bytes, &element);
  if (JS_IsException(buffer->owner)) return false;
  buffer->base = JS_GetArrayBuffer(ctx, &capacity, buffer->owner);
  if (JS_HasException(ctx) || offset > capacity || bytes > capacity - offset ||
      (bytes && !buffer->base)) return false;
  buffer->data = buffer->base ? buffer->base + offset : NULL;
  buffer->count = bytes / 4;
  return true;
}
static JSValue blend(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (argc < 3 || !JS_IsArray(argv[0]))
    return JS_ThrowTypeError(ctx, "blendPoints needs an array of Float32Array, weights and output");
  uint32_t count = 0;
  JSValue length = JS_GetPropertyStr(ctx, argv[0], "length");
  int error = JS_ToUint32(ctx, &count, length); JS_FreeValue(ctx, length);
  if (error) return JS_EXCEPTION;
  if (count < 1 || count > 32) return JS_ThrowRangeError(ctx, "blendPoints accepts 1 to 32 point sets");
  struct typed_buffer inputs[32], weights = {.owner=JS_UNDEFINED}, output = {.owner=JS_UNDEFINED};
  JSValue sources[32], result = JS_UNDEFINED;
  memset(inputs, 0, sizeof(inputs));
  for (unsigned i=0;i<32;++i) { sources[i]=JS_UNDEFINED; inputs[i].owner=JS_UNDEFINED; }
  /* getter 可执行脚本并分离 ArrayBuffer；先取齐对象，再获取底层地址。 */
  for (unsigned i=0;i<count;++i) {
    sources[i]=JS_GetPropertyUint32(ctx,argv[0],i);
    if(JS_IsException(sources[i])) { result=JS_EXCEPTION; goto done; }
  }
  if (!read_buffer(ctx,argv[1],JS_TYPED_ARRAY_FLOAT32,&weights) ||
      !read_buffer(ctx,argv[2],JS_TYPED_ARRAY_FLOAT32,&output)) {
    result=JS_HasException(ctx)?JS_EXCEPTION:JS_ThrowTypeError(ctx,"blendPoints needs Float32Array buffers"); goto done;
  }
  if(weights.count!=count || output.count%3 || output.count>8192*3 ||
     (output.count && output.base==weights.base)) {
    result=JS_ThrowRangeError(ctx,"invalid blend lengths or aliased output"); goto done;
  }
  for(unsigned i=0;i<count;++i) {
    if(!read_buffer(ctx,sources[i],JS_TYPED_ARRAY_FLOAT32,&inputs[i])) {
      result=JS_HasException(ctx)?JS_EXCEPTION:JS_ThrowTypeError(ctx,"point sets must be Float32Array"); goto done;
    }
    if(inputs[i].count!=output.count || (output.count && inputs[i].base==output.base) ||
       !isfinite(((float *)weights.data)[i])) {
      result=JS_ThrowRangeError(ctx,"invalid point set or weight"); goto done;
    }
  }
  for(size_t j=0;j<output.count;++j) {
    if((j&127)==0 && px_runtime_poll_interrupt(ctx)<0) { result=JS_EXCEPTION; goto done; }
    float value=0;
    for(unsigned i=0;i<count;++i) {
      float weight=((float *)weights.data)[i];
      if(weight!=0) value=(float)((double)value+(double)((float *)inputs[i].data)[j]*(double)weight);
    }
    ((float *)output.data)[j]=value;
  }
done:
  for(unsigned i=0;i<32;++i) { JS_FreeValue(ctx,sources[i]); release_buffer(ctx,&inputs[i]); }
  release_buffer(ctx,&weights); release_buffer(ctx,&output); return result;
}
static bool option(JSContext *ctx, JSValueConst object, const char *name, double fallback, double *out)
{
  JSValue value=JS_GetPropertyStr(ctx,object,name); *out=fallback;
  bool ok=!JS_IsException(value) && (JS_IsUndefined(value)||!JS_ToFloat64(ctx,out,value));
  JS_FreeValue(ctx,value);
  if(!ok) return false;
  if(!isfinite(*out)) { JS_ThrowRangeError(ctx,"projection options must be finite"); return false; }
  return true;
}
struct fast_projection {
  float ca,sa,cb,sb,squash,lift,scale,cx,cy;
  int32_t grid;
};
#ifdef PX_TEST_PROJECTION
uint32_t px_projection_test_fast,px_projection_test_fallback;
#endif
static int32_t quantize_grid(int32_t pixel, int32_t grid)
{
  /* pixel 在 ±3137 内，grid 为 1..64 整数：Double 的除法误差小于 2^-39，
   * 非半整数与舍入边界至少相隔 1/128；恰好半整数则可精确表示。 */
  if(grid==1) return pixel;
  int32_t shifted=pixel+grid/2;
  return shifted>=0?shifted/grid:(shifted+1)/grid-1;
}
static bool project_fast_point(const float *point, const struct fast_projection *fast,
                               int32_t *px, int32_t *py)
{
  if(!fast->grid || !(fabsf(point[0])<=16 && fabsf(point[1])<=16 && fabsf(point[2])<=16))
    return false;
  float x=point[0]*fast->ca+point[2]*fast->sa,z=-point[0]*fast->sa+point[2]*fast->ca;
  float y=point[1]*fast->squash*fast->cb-z*fast->sb,depth=point[1]*fast->sb+z*fast->cb;
  if(!(fabsf(depth)<=32)) return false;
  float perspective=64.f/(64.f-depth);
  float fx=fast->cx+x*fast->scale*perspective+.5f;
  float fy=fast->cy+y*fast->scale*perspective+fast->lift+.5f;
  int32_t ix=(int32_t)fx,iy=(int32_t)fy;
  if((float)ix>fx) --ix;
  if((float)iy>fy) --iy;
  /* u=2^-24。逐步绝对误差上界（均含 Double 舍入和次正规数冲刷）：
   * x/z <128u，y/depth <512u，64-depth <640u，透视因子 <48u；
   * x/y 缩放项 <4096u/12288u。最终 floor 输入 X/Y 误差严格小于
   * 65536u=1/256、131072u=1/128；靠近格边界时必须回退原 Double。
   * 此范围内整数 ± 误差半径可由 Float 精确表示，不扩大接受区间。 */
  if(!(fx>(float)ix+0x1p-8f && fx<(float)(ix+1)-0x1p-8f &&
       fy>(float)iy+0x1p-7f && fy<(float)(iy+1)-0x1p-7f)) return false;
  *px=quantize_grid(ix,fast->grid);*py=quantize_grid(iy,fast->grid);
  return true;
}
static JSValue project(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int mode)
{
  (void)self;
  if(argc<3 || JS_GetTypedArrayType(argv[0])!=JS_TYPED_ARRAY_FLOAT32 || !JS_IsObject(argv[1]) ||
     JS_GetTypedArrayType(argv[2])!=JS_TYPED_ARRAY_INT32)
    return JS_ThrowTypeError(ctx,"projectPoints needs Float32Array, options, Int32Array");
  double yaw,pitch,squash,lift,scale,cx,cy,distance,grid;
  if(!option(ctx,argv[1],"yaw",0,&yaw)||!option(ctx,argv[1],"pitch",0,&pitch)||
     !option(ctx,argv[1],"squash",1,&squash)||!option(ctx,argv[1],"lift",0,&lift)||
     !option(ctx,argv[1],"scale",1,&scale)||!option(ctx,argv[1],"cx",0,&cx)||
     !option(ctx,argv[1],"cy",0,&cy)||!option(ctx,argv[1],"distance",64,&distance)||
     !option(ctx,argv[1],"grid",1,&grid)) return JS_EXCEPTION;
  if(scale<=0 || distance<=0 || grid<1) return JS_ThrowRangeError(ctx,"invalid projection options");
  struct typed_buffer input={.owner=JS_UNDEFINED},output={.owner=JS_UNDEFINED},indices={.owner=JS_UNDEFINED};
  bool bounds=mode==2,runs=mode==1,indexed=bounds&&argc>3&&!JS_IsUndefined(argv[3]);
  JSValue result=mode?JS_NewInt32(ctx,0):JS_UNDEFINED;
  if(!read_buffer(ctx,argv[0],JS_TYPED_ARRAY_FLOAT32,&input)||!read_buffer(ctx,argv[2],JS_TYPED_ARRAY_INT32,&output)) {
    result=JS_HasException(ctx)?JS_EXCEPTION:JS_ThrowTypeError(ctx,"invalid projection buffers"); goto done;
  }
  if(indexed&&!read_buffer(ctx,argv[3],JS_TYPED_ARRAY_UINT32,&indices)) {
    result=JS_HasException(ctx)?JS_EXCEPTION:JS_ThrowTypeError(ctx,"projection indices must be Uint32Array"); goto done;
  }
  if(input.count%3 || input.count>8192*3 || output.count<(bounds?4:input.count/3*(runs?3:2)) ||
     (indexed&&indices.count>8192) ||
     (input.count && input.base==output.base)) {
    result=JS_ThrowRangeError(ctx,"invalid projection lengths or aliased buffers"); goto done;
  }
  const float *points=input.data; int32_t *out=output.data;
  size_t count=indexed?indices.count:input.count/3;
  if(!count) { if(bounds) memset(out,0,4*sizeof(*out));goto done; }
  double ca=cos(yaw),sa=sin(yaw),cb=cos(pitch),sb=sin(pitch);
  struct fast_projection fast={0};
  /* 默认模型参数可走硬件单精度；域外输入维持原有 Double 契约。 */
  if(distance==64 && fabs(squash)<=2 && scale<=16 && fabs(cx)<=1024 && fabs(cy)<=1024 &&
     fabs(lift)<=64 && grid<=64 && grid==floor(grid) &&
     fabs(ca)<=1 && fabs(sa)<=1 && fabs(cb)<=1 && fabs(sb)<=1) {
    fast=(struct fast_projection){.ca=(float)ca,.sa=(float)sa,.cb=(float)cb,.sb=(float)sb,
      .squash=(float)squash,.lift=(float)lift,.scale=(float)scale,.cx=(float)cx,.cy=(float)cy,
      .grid=(int32_t)grid};
  }
  int32_t minx=INT32_MAX,miny=INT32_MAX,maxx=INT32_MIN,maxy=INT32_MIN;
  for(size_t k=0,j=0;k<count;++k,j+=2) {
    if((j&255)==0 && px_runtime_poll_interrupt(ctx)<0) { result=JS_EXCEPTION; goto done; }
    size_t index=indexed?((uint32_t *)indices.data)[k]:k;
    if(index>=input.count/3) { result=JS_ThrowRangeError(ctx,"projection index is out of range");goto done; }
    size_t i=index*3;
    int32_t px,py;
    if(project_fast_point(points+i,&fast,&px,&py)) {
#ifdef PX_TEST_PROJECTION
      ++px_projection_test_fast;
#endif
    } else {
#ifdef PX_TEST_PROJECTION
      ++px_projection_test_fallback;
#endif
      double x=points[i]*ca+points[i+2]*sa,z=-points[i]*sa+points[i+2]*ca;
      double y=points[i+1]*squash*cb-z*sb,depth=points[i+1]*sb+z*cb;
      double perspective=distance/(distance-depth);
      double gx=floor(floor(cx+x*scale*perspective+.5)/grid+.5);
      double gy=floor(floor(cy+y*scale*perspective+lift+.5)/grid+.5);
      if(depth>=distance || !isfinite(gx)||!isfinite(gy)||gx<INT32_MIN||gx>INT32_MAX||gy<INT32_MIN||gy>INT32_MAX) {
        result=JS_ThrowRangeError(ctx,"point is outside the projection range"); goto done;
      }
      px=(int32_t)gx;py=(int32_t)gy;
    }
    if(!bounds) { out[j]=px;out[j+1]=py; }
    if(px<minx)minx=px;
    if(px>maxx)maxx=px;
    if(py<miny)miny=py;
    if(py>maxy)maxy=py;
  }
  if(bounds) {
    /* fit 只消费量化边界，不创建掩码，也不把逐点坐标穿过 JS 边界。 */
    out[0]=minx;out[1]=miny;out[2]=maxx;out[3]=maxy;
    result=JS_NewInt32(ctx,(int)count);
  } else if(runs) {
    int64_t width=(int64_t)maxx-minx+1,height=(int64_t)maxy-miny+1;
    if(width>65536||height>65536||width*height>65536) {
      result=JS_ThrowRangeError(ctx,"projected grid exceeds 65536 cells"); goto done;
    }
    /* 上面已证明宽高及总格数均不超过65536；掩码索引使用32位，
     * 避免Xtensa为每个点/格执行64位乘加。端点范围检查仍保留64位。 */
    unsigned columns=(unsigned)width,rows=(unsigned)height;
    uint8_t *mask=js_mallocz(ctx,(columns*rows+7)/8);
    if(!mask) { result=JS_EXCEPTION; goto done; }
    for(size_t i=0;i<input.count/3;++i) {
      /* 无符号差精确表示0..65535，包含跨INT32符号边界的合法坐标。 */
      unsigned x=(uint32_t)out[i*2]-(uint32_t)minx;
      unsigned y=(uint32_t)out[i*2+1]-(uint32_t)miny;
      unsigned cell=y*columns+x;
      mask[cell/8]|=(uint8_t)(1u<<(cell%8));
    }
    int emitted=0;
    for(unsigned y=0;y<rows;++y) {
      if(px_runtime_poll_interrupt(ctx)<0) { js_free(ctx,mask);result=JS_EXCEPTION;goto done; }
      unsigned row=y*columns;
      for(unsigned x=0;x<columns;) {
        unsigned cell=row+x;
        if(!(mask[cell/8]&(1u<<(cell%8)))) { ++x;continue; }
        unsigned start=x;
        do {++x;cell=row+x;} while(x<columns && (mask[cell/8]&(1u<<(cell%8))));
        /* 已知最终坐标介于已验证min/max之间，加法不会溢出int32。 */
        out[emitted*3]=minx+(int32_t)start;out[emitted*3+1]=miny+(int32_t)y;
        out[emitted*3+2]=(int32_t)(x-start);++emitted;
      }
    }
    js_free(ctx,mask); result=JS_NewInt32(ctx,emitted);
  }
done:
  release_buffer(ctx,&input);release_buffer(ctx,&output);release_buffer(ctx,&indices);return result;
}
void px_install_projection(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx,native,"blendPoints",JS_NewCFunction(ctx,blend,"blendPoints",3));
  JS_SetPropertyStr(ctx,native,"projectPoints",JS_NewCFunctionMagic(ctx,project,"projectPoints",3,JS_CFUNC_generic_magic,0));
  JS_SetPropertyStr(ctx,native,"projectPointRuns",JS_NewCFunctionMagic(ctx,project,"projectPointRuns",3,JS_CFUNC_generic_magic,1));
  JS_SetPropertyStr(ctx,native,"projectPointBounds",JS_NewCFunctionMagic(ctx,project,"projectPointBounds",4,JS_CFUNC_generic_magic,2));
}
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC pop_options
#endif
