/**
 * ESP32-WROOM-32E —— 乐鑫官方模组的真实 PCB 封装(tscircuit)
 *
 * 来源:https://raw.githubusercontent.com/espressif/kicad-libraries/main/footprints/Espressif.pretty/ESP32-WROOM-32E.kicad_mod
 *       (espressif/kicad-libraries,Apache-2.0)
 * 转换:kicad +y 向下 → pcbY 取反;pad 角度 90 时 size w/h 互换;剥掉 fp_line/
 *       fp_text 图形,仅保留模组外形/天线分界两条丝印与 F.CrtYd courtyard(手工
 *       换算 Y 取反);不带 cadModel 段(IDE 模板离线原则,不引用 CDN)。
 * 焊盘交叉核对:kicad_mod 列出 50 个 pad 条目,其中散热盘 EP 全部编号 "39"
 *       (3×3 小盘阵列 12 条含 3 条 tstamp 完全重复的行,按坐标去重后 9 个)——
 *       周边 38 焊盘与 datasheet v2.1 Table 3 引脚表逐一一致;EP 阵列重编为
 *       pin39..pin47 并归入 GND 序列(GND4..GND12),共 47 个 SMT 焊盘。
 *
 * 38 个信号/电源引脚 + 底部 GND 散热盘 3×3 阵列:
 *   IO0/2/4/5、IO12..IO19、IO21..IO23、IO25..IO27、IO32..IO35、SENSOR_VP/VN、
 *   EN、TXD0/RXD0(UART0)、3V3、GND×12;pin17..22/32 为 NC(-32E 无内引 Flash 脚)
 * 模组本体 18×25.5mm(北端 y∈[8.56,14.5] 为天线净空区);courtyard 19.6×26.6mm,
 * 比焊盘外接矩形(≈19×21.4)大——板级布局按 courtyard 留净空,重叠会 DRC 报错。
 *
 * 用法(props 原样透传给 <chip>,支持 name/pcbX/pcbY/layer/pcbRotation/
 * schPinArrangement/connections 等):
 *   import { ESP32_WROOM_32E } from './esp32-wroom-32e'
 *   <ESP32_WROOM_32E name="U1" pcbX={-2} pcbY={-1.5} pcbRotation={90} />
 */
import type { ChipProps } from "@tscircuit/props";

const pinLabels = {
  pin1: ["GND1"],
  pin2: ["3V3"],
  pin3: ["EN"],
  pin4: ["SENSOR_VP"],
  pin5: ["SENSOR_VN"],
  pin6: ["IO34"],
  pin7: ["IO35"],
  pin8: ["IO32"],
  pin9: ["IO33"],
  pin10: ["IO25"],
  pin11: ["IO26"],
  pin12: ["IO27"],
  pin13: ["IO14"],
  pin14: ["IO12"],
  pin15: ["GND2"],
  pin16: ["IO13"],
  pin17: ["NC1"],
  pin18: ["NC2"],
  pin19: ["NC3"],
  pin20: ["NC4"],
  pin21: ["NC5"],
  pin22: ["NC6"],
  pin23: ["IO15"],
  pin24: ["IO2"],
  pin25: ["IO0"],
  pin26: ["IO4"],
  pin27: ["IO16"],
  pin28: ["IO17"],
  pin29: ["IO5"],
  pin30: ["IO18"],
  pin31: ["IO19"],
  pin32: ["NC7"],
  pin33: ["IO21"],
  pin34: ["RXD0"],
  pin35: ["TXD0"],
  pin36: ["IO22"],
  pin37: ["IO23"],
  pin38: ["GND3"],
  pin39: ["GND4"],
  pin40: ["GND5"],
  pin41: ["GND6"],
  pin42: ["GND7"],
  pin43: ["GND8"],
  pin44: ["GND9"],
  pin45: ["GND10"],
  pin46: ["GND11"],
  pin47: ["GND12"],
} as const;

export const ESP32_WROOM_32E = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      manufacturerPartNumber="ESP32-WROOM-32E"
      footprint={
        <footprint>
          <smtpad
            portHints={["pin1"]}
            pcbX="-8.75mm"
            pcbY="7.01mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin2"]}
            pcbX="-8.75mm"
            pcbY="5.74mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin3"]}
            pcbX="-8.75mm"
            pcbY="4.47mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin4"]}
            pcbX="-8.75mm"
            pcbY="3.2mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin5"]}
            pcbX="-8.75mm"
            pcbY="1.93mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin6"]}
            pcbX="-8.75mm"
            pcbY="0.66mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin7"]}
            pcbX="-8.75mm"
            pcbY="-0.61mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin8"]}
            pcbX="-8.75mm"
            pcbY="-1.88mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin9"]}
            pcbX="-8.75mm"
            pcbY="-3.15mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin10"]}
            pcbX="-8.75mm"
            pcbY="-4.42mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin11"]}
            pcbX="-8.75mm"
            pcbY="-5.69mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin12"]}
            pcbX="-8.75mm"
            pcbY="-6.96mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin13"]}
            pcbX="-8.75mm"
            pcbY="-8.23mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin14"]}
            pcbX="-8.75mm"
            pcbY="-9.5mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin15"]}
            pcbX="-5.72mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin16"]}
            pcbX="-4.45mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin17"]}
            pcbX="-3.18mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin18"]}
            pcbX="-1.91mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin19"]}
            pcbX="-0.64mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin20"]}
            pcbX="0.63mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin21"]}
            pcbX="1.9mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin22"]}
            pcbX="3.17mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin23"]}
            pcbX="4.44mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin24"]}
            pcbX="5.71mm"
            pcbY="-10.75mm"
            width="0.9mm"
            height="1.5mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin25"]}
            pcbX="8.75mm"
            pcbY="-9.5mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin26"]}
            pcbX="8.75mm"
            pcbY="-8.23mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin27"]}
            pcbX="8.75mm"
            pcbY="-6.96mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin28"]}
            pcbX="8.75mm"
            pcbY="-5.69mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin29"]}
            pcbX="8.75mm"
            pcbY="-4.42mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin30"]}
            pcbX="8.75mm"
            pcbY="-3.15mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin31"]}
            pcbX="8.75mm"
            pcbY="-1.88mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin32"]}
            pcbX="8.75mm"
            pcbY="-0.61mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin33"]}
            pcbX="8.75mm"
            pcbY="0.66mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin34"]}
            pcbX="8.75mm"
            pcbY="1.93mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin35"]}
            pcbX="8.75mm"
            pcbY="3.2mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin36"]}
            pcbX="8.75mm"
            pcbY="4.47mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin37"]}
            pcbX="8.75mm"
            pcbY="5.74mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin38"]}
            pcbX="8.75mm"
            pcbY="7.01mm"
            width="1.5mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin39"]}
            pcbX="-2.9mm"
            pcbY="0.69mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin40"]}
            pcbX="-1.5mm"
            pcbY="0.69mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin41"]}
            pcbX="-0.1mm"
            pcbY="0.69mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin42"]}
            pcbX="-2.9mm"
            pcbY="-0.71mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin43"]}
            pcbX="-1.5mm"
            pcbY="-0.71mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin44"]}
            pcbX="-0.1mm"
            pcbY="-0.71mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin45"]}
            pcbX="-2.9mm"
            pcbY="-2.11mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin46"]}
            pcbX="-1.5mm"
            pcbY="-2.11mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin47"]}
            pcbX="-0.1mm"
            pcbY="-2.11mm"
            width="0.9mm"
            height="0.9mm"
            shape="rect"
          />
          {/* 模组外形 18×25.5(kicad 外形线 y∈[-14.5,11] 取反后 y∈[-11,14.5]) */}
          <silkscreenpath
            route={[
              { x: -9, y: 14.5 },
              { x: 9, y: 14.5 },
              { x: 9, y: -11 },
              { x: -9, y: -11 },
              { x: -9, y: 14.5 },
            ]}
          />
          {/* 天线净空分界线(kicad y=-8.56 取反;北侧为 PCB 天线区,禁布铜/器件) */}
          <silkscreenpath
            route={[
              { x: -9, y: 8.56 },
              { x: 9, y: 8.56 },
            ]}
          />
          <silkscreentext
            text="{NAME}"
            pcbX="0mm"
            pcbY="15.8mm"
            anchorAlignment="center"
            fontSize="1mm"
          />
          {/* F.CrtYd 矩形(-9.8,-14.8)-(9.8,11.8) → Y 取反 */}
          <courtyardoutline
            outline={[
              { x: -9.8, y: 14.8 },
              { x: 9.8, y: 14.8 },
              { x: 9.8, y: -11.8 },
              { x: -9.8, y: -11.8 },
              { x: -9.8, y: 14.8 },
            ]}
          />
        </footprint>
      }
      {...props}
    />
  );
};
