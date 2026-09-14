/** 装配包络检查：元件体积、焊接面引脚、内壁和上下盖必须使用同一坐标系。 */
import type { BoardSpec, EnclosureScadMeta } from '../../../shared/ipc-types'

// 圆角矩形是凸集：逐顶点验收即可约束整块 PCB / 元件包络，不能只比长宽。
function insideRounded(x:number,y:number,halfW:number,halfD:number,r:number):boolean {
  return Math.abs(x)<=halfW+.01 && Math.abs(y)<=halfD+.01 &&
    Math.hypot(Math.max(0,Math.abs(x)-halfW+r),Math.max(0,Math.abs(y)-halfD+r))<=r+.01
}
function corners(x:number,y:number,w:number,h:number):Array<[number,number]> {
  return [-1,1].flatMap(sx=>[-1,1].map(sy=>[x+sx*w/2,y+sy*h/2] as [number,number]))
}
export function checkAssembly(board:BoardSpec, meta:EnclosureScadMeta|null):string[] {
  if(!meta || !meta.outerW || !meta.outerD || !meta.lidTopZ)return []
  const errors:string[]=[], wall=meta.batteryZ??2, top=meta.boardTopZ
  const insideW=meta.outerW/2-wall,insideD=meta.outerD/2-wall,roof=meta.lidTopZ-wall
  if(board.widthMM/2>insideW+.01||board.heightMM/2>insideD+.01)errors.push('PCB 板体超出外壳内腔')
  const innerR=Math.max(0,(meta.design?.cornerR??wall)-wall)
  const outline=board.outline?.length?board.outline.map(p=>[p.x,p.y] as [number,number]):corners(0,0,board.widthMM,board.heightMM)
  if(outline.some(([x,y])=>!insideRounded(x,y,insideW,insideD,innerR)))errors.push('PCB 轮廓穿过外壳内壁或圆角')
  if(top-board.thicknessMM<wall-.01||top>roof+.01)errors.push('PCB 高度穿过底板或顶盖')
  for(const c of board.components){
    if(![c.x,c.y,c.w,c.h,c.heightMM,c.oppositeHeightMM??0].every(Number.isFinite)||c.w<=0||c.h<=0||c.heightMM<=0){errors.push(`${c.name} 机械尺寸无效`);continue}
    const lower=c.layer==='bottom'?top-board.thicknessMM-c.heightMM:top-board.thicknessMM-(c.oppositeHeightMM??0)
    const upper=c.layer==='bottom'?top+(c.oppositeHeightMM??0):top+c.heightMM
    if(lower<wall-.01)errors.push(`${c.name} 穿过底板 ${Number(wall-lower).toFixed(2)} mm`)
    if(upper>roof+.01)errors.push(`${c.name} 穿过顶盖 ${Number(upper-roof).toFixed(2)} mm`)
    const footprint=corners(c.x,c.y,c.w,c.h)
    if(footprint.some(([x,y])=>Math.abs(x)<=insideW&&Math.abs(y)<=insideD&&!insideRounded(x,y,insideW,insideD,innerR)))errors.push(`${c.name} 穿过内腔圆角`)
    const lip=meta.design?.lip
    if(lip&&lower<lip[5]-.01&&upper>lip[4]+.01&&footprint.some(([x,y])=>!insideRounded(x,y,lip[0]/2-lip[3],lip[1]/2-lip[3],Math.max(0,lip[2]-lip[3]))))errors.push(`${c.name} 与顶盖内唇干涉`)
    // 支撑柱到板底面；M2 螺钉头在板上预留 1.6 mm，二者均不能穿进元件和焊脚。
    if(meta.design?.standoffOuterR&&lower<top+1.6-.01)for(const [x,y] of meta.design.standoffs){
      const distance=Math.hypot(Math.max(0,Math.abs(c.x-x)-c.w/2),Math.max(0,Math.abs(c.y-y)-c.h/2))
      if(distance<meta.design.standoffOuterR-.01)errors.push(`${c.name} 与螺柱/螺钉头干涉`)
    }
    const walls:Array<[string,number,number,number]>=[['east',c.x+c.w/2-insideW,-c.y,c.h],['west',-c.x+c.w/2-insideW,-c.y,c.h],['north',c.y+c.h/2-insideD,c.x,c.w],['south',-c.y+c.h/2-insideD,c.x,c.w]]
    for(const [side,excess,across,size] of walls){
      if(excess<=.01)continue
      // 合法连接器可穿过对应开口，必须整个横截面都在开口内（圆角按保守内接矩形）。
      const open=meta.design?.ports.some(p=>p[0]===side&&Math.abs(across-p[1])+size/2<=p[3]/2-p[5]&&lower>=wall+p[2]-p[4]/2+p[5]&&upper<=wall+p[2]+p[4]/2-p[5])
      if(!open)errors.push(`${c.name} 穿过 ${side} 侧壁 ${excess.toFixed(2)} mm`)
    }
  }
  for(let i=0;i<board.components.length;i++)for(const b of board.components.slice(i+1)){
    const a=board.components[i]
    if(a.layer===b.layer&&Math.abs(a.x-b.x)<(a.w+b.w)/2-.01&&Math.abs(a.y-b.y)<(a.h+b.h)/2-.01)errors.push(`${a.name} 与 ${b.name} 元件包络重叠`)
  }
  return errors
}
