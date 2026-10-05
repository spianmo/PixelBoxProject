/* 直接比较真实Canvas快路径与其Double定义，覆盖认证域、抵消和半像素相邻值。 */
#include <stdio.h>
#include <float.h>
#include "../src/canvas.c"

int px_runtime_poll_interrupt(JSContext *ctx) { (void)ctx; return 0; }
static uint32_t random_state=0x93ca5731;
static uint64_t checked_rects,certified_edges,fallback_edges;

static double random_signed(void)
{
  random_state=random_state*1664525u+1013904223u;
  return ((double)random_state/4294967296.0)*2-1;
}

static int verify(double x,double y,double w,double h,double scale)
{
  struct physical_bounds output={0};
  unsigned mask=layout_fast_rectangle(scale<=2?(float)scale:0,x,y,w,h,&output);
  double reference[4]={layout_round(x*scale),layout_round(y*scale),
    layout_round((x+w)*scale),layout_round((y+h)*scale)};
  int32_t values[4]={output.left,output.top,output.right,output.bottom};
  ++checked_rects;
  for(unsigned i=0;i<4;++i) {
    if(mask&(1u<<i)) {
      ++certified_edges;
      if(values[i]!=reference[i]) {
        fprintf(stderr,"wrong certificate edge=%u x=%a y=%a w=%a h=%a scale=%a actual=%d reference=%a\n",
          i,x,y,w,h,scale,values[i],reference[i]);
        return 1;
      }
    } else ++fallback_edges;
    if((mask&FAST_DOMAIN)&&(!(reference[i]>=-8193&&reference[i]<=8193))) {
      fputs("Float certificate exceeded proven integer range\n",stderr);return 1;
    }
  }
  return 0;
}


/* 独立按JS定义计算物理矩形；尤其不能把“回绕后的宽高”改成“回绕后的终点”。 */
static int64_t reference_int32(double value)
{
  double bits=fmod(value,4294967296.0);
  if(bits<0)bits+=4294967296.0;
  return bits>=2147483648.0?(int64_t)bits-4294967296LL:(int64_t)bits;
}

static double reference_round(double value)
{
  double lower=floor(value);
  return value-lower<.5?lower:lower+1;
}

static int verify_physical(double x,double y,double w,double h,double scale)
{
  enum { WIDTH=32,HEIGHT=24 };
  uint32_t pixels[WIDTH*HEIGHT]={0},blocks[HEIGHT]={0};
  uint16_t rows[HEIGHT*2]={0};
  struct layer_painter painter={.pixels=pixels,.changed_rows=rows,.dirty_blocks=blocks,
    .width=WIDTH,.height=HEIGHT,.left=WIDTH,.top=HEIGHT,.scale=scale,
    .fast_scale=scale<=2?(float)scale:0};
  double left=reference_round(x*scale),top=reference_round(y*scale);
  double right=reference_round((x+w)*scale),bottom=reference_round((y+h)*scale);
  int64_t px=reference_int32(left),py=reference_int32(top);
  int64_t pw=reference_int32(right-left),ph=reference_int32(bottom-top);
  int64_t end=px+pw,base=py+ph;
  int present=pw>0&&ph>0&&px<WIDTH&&py<HEIGHT&&end>0&&base>0;
  if(px<0)px=0;
  if(py<0)py=0;
  if(end>WIDTH)end=WIDTH;
  if(base>HEIGHT)base=HEIGHT;
  if(paint_physical(&painter,x,y,w,h,0x1739ab)<0)return 1;
  for(int row=0;row<HEIGHT;++row)for(int col=0;col<WIDTH;++col) {
    int drawn=present&&col>=px&&col<end&&row>=py&&row<base;
    uint32_t expected=drawn?0x1739ab:0;
    if(pixels[row*WIDTH+col]!=expected||
       (drawn&&(!(blocks[row]&(1u<<(col/8)))||!rows[row*2]||
                col<rows[row*2]-1||col>=rows[row*2+1]))) {
      fprintf(stderr,"physical oracle mismatch xywh=%a,%a,%a,%a scale=%a pixel=%d,%d\n",
        x,y,w,h,scale,col,row);return 1;
    }
  }
  for(int row=0;row<HEIGHT;++row)if(blocks[row]&~15u)return 1;
  if(painter.left!=(present?px:WIDTH)||painter.top!=(present?py:HEIGHT)||
     painter.right!=(present?end:0)||painter.bottom!=(present?base:0)) {
    fputs("physical oracle dirty bounds mismatch\n",stderr);return 1;
  }
  return 0;
}

static int verify_physical_extremes(void)
{
  const double inputs[]={-4294967297.,-4294967296.,-4294967295.,-2147483649.,INT32_MIN,
    -2048.0001220703125,-2048,-32,-1,-.5,0,.5,1,31,32,2048,2048.0001220703125,
    INT32_MAX,2147483648.,2147483649.,4294967295.,4294967296.,4294967297.};
  const double scales[]={1.0/2048,.5,1,15.0/14,2,nextafter(2,INFINITY),2048};
  unsigned trials=0;
  for(unsigned s=0;s<sizeof(scales)/sizeof(*scales);++s)
    for(unsigned i=0;i<sizeof(inputs)/sizeof(*inputs);++i)
      for(unsigned j=0;j<sizeof(inputs)/sizeof(*inputs);++j) {
        /* 横纵互换，覆盖加法跨Int32、宽高回绕负数及半像素/认证域边缘。 */
        if(verify_physical(inputs[i],1,inputs[j],23,scales[s])||
           verify_physical(1,inputs[i],31,inputs[j],scales[s]))return 1;
        trials+=2;
      }
  printf("PASS Canvas physical endpoint oracle: %u cases, exact pixels, dirty coverage and bounds\n",trials);
  return 0;
}

int main(void)
{
  if(verify_physical_extremes())return 1;
  const double scales[]={1.0/2048,.25,.5,.75,1,15.0/14,1.5,2,nextafter(2,0),nextafter(2,INFINITY)};
  const double inputs[]={-2048-0x1p-12,-2048-0x1p-13,nextafter(-2048,-INFINITY),-2048,
    nextafter(-2048,0),-.5,-DBL_MIN,-0x1p-126,-0x1p-149,-0.0,0,0x1p-149,0x1p-126,DBL_MIN,.5,
    nextafter(2048,0),2048,nextafter(2048,INFINITY),2048+0x1p-13,2048+0x1p-12};
  for(unsigned s=0;s<sizeof(scales)/sizeof(scales[0]);++s)
    for(unsigned i=0;i<sizeof(inputs)/sizeof(inputs[0]);++i)
      for(unsigned j=0;j<sizeof(inputs)/sizeof(inputs[0]);++j)
        if(verify(inputs[i],inputs[j],inputs[j],-inputs[i],scales[s]))return 1;
  /* nextafter构造真实Double半像素两侧，不能用Float生成参照而遗漏关键误差。 */
  for(unsigned s=0;s<sizeof(scales)/sizeof(scales[0]);++s)
    for(int target=-4096;target<=4096;++target) {
      double half=(target+.5)/scales[s];
      double adjacent[3]={nextafter(half,-INFINITY),half,nextafter(half,INFINITY)};
      for(unsigned i=0;i<3;++i)
        if(verify(adjacent[i],-adjacent[i],7,-7,scales[s]))return 1;
    }
  for(unsigned i=0;i<1000000;++i) {
    double scale=(i&1)?scales[i%10]:1.0/2048+(random_signed()+1)*(2-1.0/2048)/2;
    double x=random_signed()*2048,y=random_signed()*2048;
    double w=random_signed()*2048,h=random_signed()*2048;
    if((i&3)==0) {
      /* 大数抵消后落近半像素；输入转换/加法的误差在此最容易改变取整。 */
      w=(floor(random_signed()*2048)+.5)/scale-x;
      h=(floor(random_signed()*2048)+.5)/scale-y;
      w=nextafter(w,(i&4)?INFINITY:-INFINITY);
      h=nextafter(h,(i&8)?INFINITY:-INFINITY);
    }
    if(verify(x,y,w,h,scale))return 1;
  }
  if(certified_edges<100000||fallback_edges<100000)return 1;
  printf("PASS Canvas Float certificate: %llu rects, %llu fast edges, %llu fallback edges\n",
    (unsigned long long)checked_rects,(unsigned long long)certified_edges,(unsigned long long)fallback_edges);
  return 0;
}
