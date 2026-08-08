/**
 * 外壳 OpenSCAD 模板生成器(shared:main 脚手架与 renderer 旧工程迁移共用)
 *
 * 把参数化外壳(EnclosureParams,旧 enclosure.json 模型)展开为一份完整、
 * 自解释、可继续手改的 design/enclosure.scad:
 * - 顶部为 Customizer 风格变量块(数值即当时参数;此后 .scad 文本是唯一真源,
 *   IDE 不再反向解析参数 —— 用户直接改代码,即时重渲染)
 * - 几何复刻 enclosureBuilder.ts 的策略:圆角外形、内腔、四角支撑柱、
 *   侧壁开孔、顶盖(顶板 + 外裙边 + 内唇 + 屏幕窗)
 * - part 变量分件渲染("base"/"lid"),IDE 以 -D part=... 各编译一次拿分件 STL
 *   (爆炸视图与分件打印用);"all" 为完整装配
 * - PB_META echo:一行 JSON 契约(boardTopZ / screenFaceZ / 外形尺寸 / 颜色),
 *   IDE 从编译日志解析,用于板卡抬高、屏幕贴图定位与爆炸距离 ——
 *   删掉这行 IDE 会回退到包围盒推导,屏幕可能贴错高度
 *
 * 坐标约定:OpenSCAD Z 朝上、底盒底面 z=0(即 3D 打印床面);IDE 的 three 场景
 * Y 朝上,加载 STL 时做 -90° X 旋转,scad z 即 three y,无需换算。
 */
import type { EnclosureParams, ScreenPlacement } from './ipc-types'

/** 数字格式化:最多 3 位小数,去尾零(避免 0.30000000000000004 进模板) */
function n(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

export interface EnclosureScadBoard {
  widthMM: number
  heightMM: number
  thicknessMM: number
}

/**
 * 生成完整 enclosure.scad 文本。
 * screen 为 null 时不开屏幕窗(screen_w/h 置 0)。
 */
export function enclosureScadFromParams(
  params: EnclosureParams,
  board: EnclosureScadBoard,
  screen: ScreenPlacement | null
): string {
  const colorHex = params.colorHex ?? '#98a2ad'
  const portsLit = params.ports
    .map(
      (p) =>
        `  ["${p.wall}", ${n(p.x)}, ${n(p.y)}, ${n(p.w)}, ${n(p.h)}, ${n(p.r ?? 0)}]`
    )
    .join(',\n')
  return `/**
 * PixelBox 外壳 —— OpenSCAD 源(IDE 硬件面板即时渲染;直接改代码即改外形)
 *
 * 结构:底盒 base()(底板 + 圆角侧壁 + 四角支撑柱 + 侧壁开孔)
 *      顶盖 lid()(顶板 + 外裙边 + 内唇卡合 + 屏幕开窗)
 * 打印:IDE「打印」页签分件导出 base / lid 的 STL(part 变量,IDE 自动传参)。
 * 契约:文件末尾 PB_META echo 供 IDE 定位板卡与屏幕贴图,勿删;
 *      板长宽改动请与 design/board.tsx 的 <board> 保持一致。
 */

/* [渲染] */
// 分件渲染(IDE 自动传参:all=装配 base=底盒 lid=顶盖)
part = "all"; // [all, base, lid]
// 圆弧面数(导出打印建议 >= 48;调试可临时改小加速)
$fn = 64;

/* [板卡(与 board.tsx 一致)] */
board_w = ${n(board.widthMM)};        // 板宽 mm
board_d = ${n(board.heightMM)};        // 板深 mm
board_t = ${n(board.thicknessMM)};       // 板厚 mm

/* [壳体主参数] */
wall = ${n(Math.max(params.wallMM, 0.8))};            // 壁厚(含底板/顶板厚)
clearance = ${n(params.clearanceMM)};       // 板与内壁间隙
base_height = ${n(params.baseHeightMM)};    // 底盒侧壁高(底板之上)
lid_height = ${n(params.lidHeightMM)};    // 顶盖裙边高(顶板之下)
corner_r = ${n(params.cornerR)};       // 外轮廓圆角半径

/* [支撑柱(板卡螺柱)] */
standoff_h = ${n(params.standoffHeightMM)};      // 柱高(底板顶面到板底面)
standoff_outer_r = ${n(params.standoffOuterR)};  // 柱外半径
standoff_inner_r = ${n(params.standoffInnerR)};  // 螺孔半径

/* [顶盖屏幕窗] */
screen_window = ${params.screenWindow && screen ? 'true' : 'false'};  // 是否开窗
screen_x = ${n(screen?.x ?? 0)};        // 窗中心(板面坐标,板心为原点)
screen_y = ${n(screen?.y ?? 0)};
screen_w = ${n(screen?.w ?? 0)};       // 可视区尺寸(窗口各边再外扩 margin)
screen_h = ${n(screen?.h ?? 0)};
screen_margin = 0.8;   // 窗口单边外扩
screen_corner_r = 1;   // 窗口圆角

/* [顶盖卡合] */
lip_clearance = 0.25;  // 内唇与内壁单边间隙
lip_depth = 2.5;       // 内唇伸入底盒深度
lip_thick = 1.2;       // 内唇壁厚

/* [侧壁开孔] */
// 每行 [墙, 沿墙偏移 x, 距内腔地面高 y, 宽 w, 高 h, 圆角 r]
// 墙方位:north/south 沿 +X 计 x;east/west 沿板面 -Y 计 x(与 IDE 手册一致)
ports = [
${portsLit}
];

/* [电池占位(非打印,仅 3D 展示)] */
// 3.7V 锂电池的可视化占位:IDE 从 PB_META 读取,不进 STL;任一值 ≤0 即关闭。
// 厚度按板下真实净空钳制:可用高度 = standoff_h − board_t − board_under_clearance,
// 电池装不下时先加高 standoff_h(板抬高,壳外形不变)
battery_w = ${n(params.batteryMM?.w ?? 0)};
battery_d = ${n(params.batteryMM?.h ?? 0)};
battery_t = ${n(params.batteryMM?.t ?? 0)};
board_under_clearance = 2.7;  // 板下元件高(≈2.5)+ 间隙

/* [外观] */
color_hex = "${colorHex}";  // 预览着色(仅显示;STL 无颜色,IDE 顶盖自动提亮)

/* ---------------- 派生尺寸(勿直接改,改上面的主参数) ---------------- */
inner_w = board_w + 2 * clearance;
inner_d = board_d + 2 * clearance;
outer_w = inner_w + 2 * wall;
outer_d = inner_d + 2 * wall;
base_top = wall + base_height;               // 底盒顶缘 z
inner_corner_r = max(0.01, corner_r - wall); // 内腔圆角
lid_plate_bottom = base_top + lid_height;    // 顶板底面 z
lid_top = lid_plate_bottom + wall;           // 壳体总高
board_top = wall + standoff_h;               // 板顶面 z(IDE 契约)
// 电池占位钳制(与 IDE 旧参数化渲染同规则):足印收进支撑柱内缘与内腔,
// 厚度不越过板底面;IDE 直接消费钳出的最终盒体,零二次推导
bat_so = max(standoff_outer_r, standoff_inner_r + 0.6);
bat_sx = max(board_w / 2 - bat_so, bat_so);
bat_sy = max(board_d / 2 - bat_so, bat_so);
bat_hw = min(battery_w / 2, inner_w / 2 - 0.5, max(2, bat_sx - bat_so));
bat_hd = min(battery_d / 2, inner_d / 2 - 0.5, max(2, bat_sy - bat_so));
bat_tc = min(battery_t, max(1, standoff_h - board_t - board_under_clearance));
bat_on = battery_w > 0 && battery_d > 0 && battery_t > 0;

/* ---------------- 基础形体 ---------------- */
// 圆角矩形(2D,中心对齐)
module rrect(w, d, r) {
  rr = min(r, w / 2 - 0.01, d / 2 - 0.01);
  if (rr <= 0.05) square([w, d], center = true);
  else hull() for (sx = [-1, 1], sy = [-1, 1])
    translate([sx * (w / 2 - rr), sy * (d / 2 - rr)]) circle(r = rr);
}
// 圆角矩形柱(z 从 0 到 h)
module rbox(w, d, h, r) { linear_extrude(height = h) rrect(w, d, r); }

// 单个侧壁开孔实体(贯穿壁厚;差集用)
module port_hole(wname, px, py, pw, ph, pr) {
  cz = wall + py; // 孔心 z:距内腔地面(底板顶面)py
  if (wname == "north")
    translate([px, (inner_d + wall) / 2, cz]) rotate([90, 0, 0]) hole2d(pw, ph, pr);
  else if (wname == "south")
    translate([px, -(inner_d + wall) / 2, cz]) rotate([90, 0, 0]) hole2d(pw, ph, pr);
  else if (wname == "east")
    translate([(inner_w + wall) / 2, -px, cz]) rotate([90, 0, 90]) hole2d(pw, ph, pr);
  else // west
    translate([-(inner_w + wall) / 2, -px, cz]) rotate([90, 0, 90]) hole2d(pw, ph, pr);
}
module hole2d(w, h, r) {
  linear_extrude(height = wall * 2 + 2, center = true) rrect(w, h, r);
}

/* ---------------- 底盒 ---------------- */
module base() {
  color(color_hex) union() {
    difference() {
      // 外形实体(底板 + 侧壁一体)
      rbox(outer_w, outer_d, base_top, corner_r);
      // 挖内腔(自底板顶面向上,穿出顶缘)
      translate([0, 0, wall]) rbox(inner_w, inner_d, base_top, inner_corner_r);
      // 侧壁开孔
      for (p = ports) port_hole(p[0], p[1], p[2], p[3], p[4], p[5]);
    }
    // 四角支撑柱(环形,螺孔贯穿;柱心从板角内缩到柱外半径)
    so = max(standoff_outer_r, standoff_inner_r + 0.6);
    sh = max(0.5, standoff_h - board_t);
    sx = max(board_w / 2 - so, so);
    sy = max(board_d / 2 - so, so);
    for (cx = [-1, 1], cy = [-1, 1]) translate([cx * sx, cy * sy, wall])
      difference() {
        cylinder(h = sh, r = so);
        translate([0, 0, -1]) cylinder(h = sh + 2, r = max(standoff_inner_r, 0.2));
      }
  }
}

/* ---------------- 顶盖 ---------------- */
module lid() {
  color(color_hex) difference() {
    union() {
      // 顶板
      translate([0, 0, lid_plate_bottom]) rbox(outer_w, outer_d, wall, corner_r);
      // 外裙边(环)
      difference() {
        translate([0, 0, base_top]) rbox(outer_w, outer_d, lid_height, corner_r);
        translate([0, 0, base_top - 1]) rbox(inner_w, inner_d, lid_height + 2, inner_corner_r);
      }
      // 内唇(伸入底盒卡合)
      lip_w = inner_w - 2 * lip_clearance;
      lip_d = inner_d - 2 * lip_clearance;
      difference() {
        translate([0, 0, base_top - lip_depth]) rbox(lip_w, lip_d, lip_depth + 0.01, inner_corner_r);
        translate([0, 0, base_top - lip_depth - 1])
          rbox(lip_w - 2 * lip_thick, lip_d - 2 * lip_thick, lip_depth + 2, max(0.01, inner_corner_r - lip_thick));
      }
    }
    // 屏幕开窗(贯穿顶板)
    if (screen_window)
      translate([screen_x, screen_y, lid_plate_bottom - 1])
        rbox(screen_w + 2 * screen_margin, screen_h + 2 * screen_margin, wall + 2, screen_corner_r);
  }
}

/* ---------------- 分件调度 ---------------- */
if (part == "all" || part == "base") base();
if (part == "all" || part == "lid") lid();

/* ---------------- IDE 契约(勿删):板卡/屏幕定位元数据 ---------------- */
echo(str("PB_META{\\"boardTopZ\\":", board_top,
  ",\\"screenFaceZ\\":", lid_top - 0.2,
  ",\\"lidTopZ\\":", lid_top,
  ",\\"baseTopZ\\":", base_top,
  ",\\"outerW\\":", outer_w, ",\\"outerD\\":", outer_d,
  ",\\"screenWindow\\":", screen_window ? "true" : "false",
  ",\\"battery\\":", bat_on ? str("[", 2 * bat_hw, ",", 2 * bat_hd, ",", bat_tc, "]") : "null",
  ",\\"batteryZ\\":", wall,
  ",\\"colorHex\\":\\"", color_hex, "\\"}"));
`
}
