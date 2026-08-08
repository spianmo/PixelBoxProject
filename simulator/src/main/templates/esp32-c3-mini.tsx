/**
 * ESP32-C3-MINI-1 —— 乐鑫官方模组的真实 PCB 封装(tscircuit)
 *
 * 来源:github.com/espressif/kicad-libraries(Apache-2.0)
 *       footprints/Espressif.pretty/ESP32-C3-MINI-1.kicad_mod(raw:
 *       raw.githubusercontent.com/espressif/kicad-libraries/main/footprints/
 *       Espressif.pretty/ESP32-C3-MINI-1.kicad_mod)
 * 转换说明(kicad_mod → tscircuit):
 * - kicad +y 向下、tscircuit pcbY 向上 → 所有 pad 的 Y 取反;
 *   带 90° 角度参数的 pad 其 size 宽高互换;剥掉 fp_line/fp_text 等图形,
 *   手工保留:模组本体丝印框(13.2×16.6)、天线区分隔线、courtyard(13.6×17)
 * - kicad 焊盘号 1..53 与乐鑫 datasheet v2.2 Table 3-1 引脚号一一对应;
 *   其中 49 号(EPAD 接地散热盘)在 kicad 里是同号 9 分块 3×3 阵列 →
 *   第 1 块保留 pin49,其余 8 块顺延编号 pin54..pin61(全部归入 GND 序列);
 *   阵列第 1 块为带切角的 custom 多边形,近似为 1.45×1.45 方盘(面积等效)
 * - 重复标签唯一化:GND 编号为 GND1..GND30,NC 编号为 NC1..NC14
 *
 * 53 个 datasheet 引脚 + EPAD 阵列顺延 8 块,共 61 个 SMT 焊盘:
 *   IO0..IO10、IO18/IO19、EN、TXD0/RXD0(UART0)、3V3、GND×30、NC×14
 * 焊盘外接尺寸约 12.6×10.6mm;北侧为板载 PCB 天线区(courtyard 至 y+8.5)。
 *
 * 用法(props 原样透传给 <chip>,支持 name/pcbX/pcbY/layer/pcbRotation/
 * schPinArrangement/connections 等):
 *   import { ESP32_C3_MINI_1 } from './esp32-c3-mini'
 *   <ESP32_C3_MINI_1 name="U1" layer="bottom" pcbX={0} pcbY={-9.6} />
 */
import type { ChipProps } from "@tscircuit/props";

const pinLabels = {
  pin1: ["GND1"],
  pin2: ["GND2"],
  pin3: ["3V3"],
  pin4: ["NC1"],
  pin5: ["IO2"],
  pin6: ["IO3"],
  pin7: ["NC2"],
  pin8: ["EN"],
  pin9: ["NC3"],
  pin10: ["NC4"],
  pin11: ["GND3"],
  pin12: ["IO0"],
  pin13: ["IO1"],
  pin14: ["GND4"],
  pin15: ["NC5"],
  pin16: ["IO10"],
  pin17: ["NC6"],
  pin18: ["IO4"],
  pin19: ["IO5"],
  pin20: ["IO6"],
  pin21: ["IO7"],
  pin22: ["IO8"],
  pin23: ["IO9"],
  pin24: ["NC7"],
  pin25: ["NC8"],
  pin26: ["IO18"],
  pin27: ["IO19"],
  pin28: ["NC9"],
  pin29: ["NC10"],
  pin30: ["RXD0"],
  pin31: ["TXD0"],
  pin32: ["NC11"],
  pin33: ["NC12"],
  pin34: ["NC13"],
  pin35: ["NC14"],
  pin36: ["GND5"],
  pin37: ["GND6"],
  pin38: ["GND7"],
  pin39: ["GND8"],
  pin40: ["GND9"],
  pin41: ["GND10"],
  pin42: ["GND11"],
  pin43: ["GND12"],
  pin44: ["GND13"],
  pin45: ["GND14"],
  pin46: ["GND15"],
  pin47: ["GND16"],
  pin48: ["GND17"],
  pin49: ["GND18"],
  pin50: ["GND19"],
  pin51: ["GND20"],
  pin52: ["GND21"],
  pin53: ["GND22"],
  pin54: ["GND23"],
  pin55: ["GND24"],
  pin56: ["GND25"],
  pin57: ["GND26"],
  pin58: ["GND27"],
  pin59: ["GND28"],
  pin60: ["GND29"],
  pin61: ["GND30"],
} as const;

export const ESP32_C3_MINI_1 = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      manufacturerPartNumber="ESP32_C3_MINI_1"
      schPinStyle={{
        EN: {
          marginBottom: 0.2,
        },
        RXD0: {
          marginBottom: 0.2,
        },
        IO10: {
          marginBottom: 0.2,
        },
      }}
      footprint={
        <footprint>
          <smtpad
            portHints={["pin1"]}
            pcbX="-5.9mm"
            pcbY="1.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin2"]}
            pcbX="-5.9mm"
            pcbY="0.5mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin3"]}
            pcbX="-5.9mm"
            pcbY="-0.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin4"]}
            pcbX="-5.9mm"
            pcbY="-1.1mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin5"]}
            pcbX="-5.9mm"
            pcbY="-1.9mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin6"]}
            pcbX="-5.9mm"
            pcbY="-2.7mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin7"]}
            pcbX="-5.9mm"
            pcbY="-3.5mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin8"]}
            pcbX="-5.9mm"
            pcbY="-4.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin9"]}
            pcbX="-5.9mm"
            pcbY="-5.1mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin10"]}
            pcbX="-5.9mm"
            pcbY="-5.9mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin11"]}
            pcbX="-5.9mm"
            pcbY="-6.7mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin12"]}
            pcbX="-4.8mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin13"]}
            pcbX="-4mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin14"]}
            pcbX="-3.2mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin15"]}
            pcbX="-2.4mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin16"]}
            pcbX="-1.6mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin17"]}
            pcbX="-0.8mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin18"]}
            pcbX="0mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin19"]}
            pcbX="0.8mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin20"]}
            pcbX="1.6mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin21"]}
            pcbX="2.4mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin22"]}
            pcbX="3.2mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin23"]}
            pcbX="4mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin24"]}
            pcbX="4.8mm"
            pcbY="-7.6mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin25"]}
            pcbX="5.9mm"
            pcbY="-6.7mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin26"]}
            pcbX="5.9mm"
            pcbY="-5.9mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin27"]}
            pcbX="5.9mm"
            pcbY="-5.1mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin28"]}
            pcbX="5.9mm"
            pcbY="-4.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin29"]}
            pcbX="5.9mm"
            pcbY="-3.5mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin30"]}
            pcbX="5.9mm"
            pcbY="-2.7mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin31"]}
            pcbX="5.9mm"
            pcbY="-1.9mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin32"]}
            pcbX="5.9mm"
            pcbY="-1.1mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin33"]}
            pcbX="5.9mm"
            pcbY="-0.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin34"]}
            pcbX="5.9mm"
            pcbY="0.5mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin35"]}
            pcbX="5.9mm"
            pcbY="1.3mm"
            width="0.8mm"
            height="0.4mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin36"]}
            pcbX="4.8mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin37"]}
            pcbX="4mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin38"]}
            pcbX="3.2mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin39"]}
            pcbX="2.4mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin40"]}
            pcbX="1.6mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin41"]}
            pcbX="0.8mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin42"]}
            pcbX="0mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin43"]}
            pcbX="-0.8mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin44"]}
            pcbX="-1.6mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin45"]}
            pcbX="-2.4mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin46"]}
            pcbX="-3.2mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin47"]}
            pcbX="-4mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin48"]}
            pcbX="-4.8mm"
            pcbY="2.2mm"
            width="0.4mm"
            height="0.8mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin49"]}
            pcbX="-1.975mm"
            pcbY="-0.725mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin50"]}
            pcbX="5.95mm"
            pcbY="2.25mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin51"]}
            pcbX="5.95mm"
            pcbY="-7.65mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin52"]}
            pcbX="-5.95mm"
            pcbY="-7.65mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin53"]}
            pcbX="-5.95mm"
            pcbY="2.25mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin54"]}
            pcbX="-1.975mm"
            pcbY="-2.7mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin55"]}
            pcbX="-1.975mm"
            pcbY="-4.675mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin56"]}
            pcbX="0mm"
            pcbY="-0.725mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin57"]}
            pcbX="0mm"
            pcbY="-2.7mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin58"]}
            pcbX="0mm"
            pcbY="-4.675mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin59"]}
            pcbX="1.975mm"
            pcbY="-0.725mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin60"]}
            pcbX="1.975mm"
            pcbY="-2.7mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin61"]}
            pcbX="1.975mm"
            pcbY="-4.675mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          {/* 模组本体丝印框(13.2×16.6,kicad F.SilkS 外框) */}
          <silkscreenpath
            route={[
              { x: -6.6, y: 8.3 },
              { x: 6.6, y: 8.3 },
              { x: 6.6, y: -8.3 },
              { x: -6.6, y: -8.3 },
              { x: -6.6, y: 8.3 },
            ]}
          />
          {/* 天线区分隔线(kicad y=-2.9 取反;y∈[2.9,8.3] 为板载天线净空区) */}
          <silkscreenpath
            route={[
              { x: -6.6, y: 2.9 },
              { x: 6.6, y: 2.9 },
            ]}
          />
          <silkscreentext
            text="{NAME}"
            pcbX="0mm"
            pcbY="9.4mm"
            anchorAlignment="center"
            fontSize="1mm"
          />
          {/* kicad F.CrtYd 原样(±6.8 × ±8.5,含天线区) */}
          <courtyardoutline
            outline={[
              { x: -6.8, y: 8.5 },
              { x: 6.8, y: 8.5 },
              { x: 6.8, y: -8.5 },
              { x: -6.8, y: -8.5 },
              { x: -6.8, y: 8.5 },
            ]}
          />
        </footprint>
      }
      {...props}
    />
  );
};
