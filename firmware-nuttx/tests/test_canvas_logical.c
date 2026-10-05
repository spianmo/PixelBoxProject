/* 同一次调用序列分别走原Double定义及整数候选；直接验证像素与逻辑/物理边界。 */
#include <stdio.h>
#include <float.h>
#include "../src/canvas.c"
int px_runtime_poll_interrupt(JSContext *ctx){(void)ctx;return 0;}
static unsigned cases,fast_cases,fallback_cases;
static uint32_t random_state=0x37bac416;
static unsigned random_u(void){random_state=random_state*1664525u+1013904223u;return random_state;}
static int same_double(double a,double b){return a==b&&signbit(a)==signbit(b);}
static int trial(double dx,double dy,double scale,double clip_top,double clip_bottom,
                 int shift,int dimension,int padding,int expect_fast)
{
  enum{WIDTH=96,HEIGHT=96};uint32_t a[WIDTH*HEIGHT]={0},b[WIDTH*HEIGHT]={0};
  struct canvas_run runs[12];
  for(int i=0;i<12;++i)runs[i]=(struct canvas_run){8+shift+(i%3)*5,8+i*4,6+i%4};
  int32_t offsets[]={-3,-3,0xff0000,2,-2,0x00ff00,-1,2,0x0000ff};
  struct layer_painter original={.pixels=a,.width=WIDTH,.height=HEIGHT,.scale=scale,
    .fast_scale=scale<=2?(float)scale:0,.logical_width=dimension,.dx=dx,.dy=dy,
    .clip_top=clip_top,.clip_bottom=clip_bottom,.left=WIDTH,.top=HEIGHT,
    .painted_left=INFINITY,.painted_top=INFINITY,.painted_right=-INFINITY,.painted_bottom=-INFINITY};
  struct layer_painter candidate=original;candidate.pixels=b;
  struct axis_coordinate cache[2][64];
  prepare_integer_layout(&candidate,runs,12,offsets,3,4,padding,cache);
  ++cases;if(candidate.axis_cache)++fast_cases;else ++fallback_cases;
  if(expect_fast>=0&&!!candidate.axis_cache!=expect_fast){fprintf(stderr,"eligibility mismatch case%u dx=%a dy=%a scale=%a clip=%a,%a actual=%d\n",cases,dx,dy,scale,clip_top,clip_bottom,!!candidate.axis_cache);return 1;}
  for(unsigned i=0;i<100;++i) {
    /* 只产生外界以内的原始整数矩形，包括同坐标复用/槽冲突/细线/空矩形。 */
    int x=5+shift+(int)(random_u()%12),y=5+(int)(random_u()%45);
    int w=(int)(random_u()%5),h=(int)(random_u()%4);uint32_t color=random_u()&0xffffff;
    if(paint_logical(&original,x,y,w,h,color)<0||paint_run_rect(&candidate,x,y,w,h,color)<0)return 1;
  }
  if(candidate.axis_cache&&candidate.logical_right>candidate.logical_left&&candidate.logical_bottom>candidate.logical_top) {
    candidate.painted_left=candidate.logical_left+dx;candidate.painted_top=candidate.logical_top+dy;
    candidate.painted_right=candidate.logical_right+dx;candidate.painted_bottom=candidate.logical_bottom+dy;
  }
  if(memcmp(a,b,sizeof(a))||original.left!=candidate.left||original.top!=candidate.top||
     original.right!=candidate.right||original.bottom!=candidate.bottom||
     !same_double(original.painted_left,candidate.painted_left)||
     !same_double(original.painted_top,candidate.painted_top)||
     !same_double(original.painted_right,candidate.painted_right)||
     !same_double(original.painted_bottom,candidate.painted_bottom)) {
    fprintf(stderr,"difference case%u dx=%a dy=%a scale=%a fast=%d bounds old=%a,%a,%a,%a new=%a,%a,%a,%a\n",cases,dx,dy,scale,!!candidate.axis_cache,
      original.painted_left,original.painted_top,original.painted_right,original.painted_bottom,
      candidate.painted_left,candidate.painted_top,candidate.painted_right,candidate.painted_bottom);return 1;
  }
  return 0;
}
int main(void)
{
  double grid=0x1p-44;
  const double offsets[]={0.,-0.,grid,-grid,nextafter(grid,0),nextafter(grid,INFINITY),
    .5,-.5,nextafter(.5,0),nextafter(.5,INFINITY),1.5,-1.5,-4.6,4.6,0x1p-43,-0x1p-43};
  const double scales[]={1.0/2048,.25,.5,.75,1,15.0/14,1.5,2,nextafter(2,0),nextafter(2,INFINITY)};
  for(unsigned d=0;d<sizeof(offsets)/sizeof(*offsets);++d)
    for(unsigned e=0;e<sizeof(offsets)/sizeof(*offsets);++e)
      for(unsigned s=0;s<sizeof(scales)/sizeof(*scales);++s)
        if(trial(offsets[d],offsets[e],scales[s],0,96,0,96,1,-1))return 1;
  /* 外界触clip允许快路径，越过1 ULP必须整体fallback。 */
  if(trial(0,0,1,5,60,0,96,1,1)||trial(0,0,1,nextafter(5,INFINITY),60,0,96,1,0)||
     trial(0,0,1,0,nextafter(60,0),0,96,1,0))return 1;
  for(unsigned i=0;i<12000;++i) {
    double dx=(int)(random_u()%17)-8.,dy=(int)(random_u()%17)-8.;
    if(i&1)dx+=((int)(random_u()%31)-15)*grid;
    if(i&2)dy+=((int)(random_u()%31)-15)*grid;
    double scale=1.0/2048+(random_u()/4294967296.0)*(2-1.0/2048);
    if(trial(dx,dy,scale,(i%11==0)?10:0,(i%13==0)?48:96,0,96,1,-1))return 1;
  }
  printf("PASS integer logical boundaries: %u cases, %u fast, %u fallback, exact pixels and signed logical bounds\n",cases,fast_cases,fallback_cases);
  return fast_cases<1000||fallback_cases<1000;
}
