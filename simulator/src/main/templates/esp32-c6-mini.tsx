/**
 * ESP32-C6-MINI-1 —— 乐鑫官方模组的真实 PCB 封装(tscircuit)
 *
 * 来源:https://raw.githubusercontent.com/espressif/kicad-libraries/main/footprints/Espressif.pretty/ESP32-C6-MINI-1.kicad_mod
 *       (espressif/kicad-libraries,Apache-2.0;本机 raw 域名被网络拦截时可经
 *       api.github.com 同路径 Accept: vnd.github.raw 获取,内容一致)
 * 转换:kicad +y 向下 → pcbY 取反;pad 角度 90 时 size w/h 互换;剥掉 fp_line/
 *       fp_text 图形与天线禁布 zone,仅保留模组外形/天线分界两条丝印与 F.CrtYd
 *       courtyard(手工换算 Y 取反);不带 cadModel 段(IDE 模板离线原则,不引 CDN)。
 * 焊盘交叉核对:kicad_mod 共 61 个 pad 条目 —— 周边 pin1..pin48 与 datasheet
 *       Table 5 引脚表(spec.modulePinout 53 逻辑引脚)逐一一致;散热盘 EP 逻辑
 *       编号 "49" 实为 9 个物理盘(1 个 custom 切角盘按 primitives 外扩 1.45×1.45
 *       以 rect 近似 + 8 个 1.45 方盘),重编为 pin49..pin57;datasheet 角部接地
 *       盘 50..53 顺延为 pin58..pin61 —— EP/角盘全部归入 GND 序列(GND18..GND30),
 *       共 61 个 SMT 焊盘(物理焊盘数以 kicad_mod 为准,多于 53 逻辑引脚)。
 *
 * 31 个信号/电源引脚 + 底部 GND 散热盘 3×3 阵列 + 4 角接地盘:
 *   IO0..IO9、IO12..IO15、IO18..IO23、EN、TXD0/RXD0(UART0)、3V3、GND×30;
 *   pin4/7/21/32..35 为 NC(C6-MINI-1 未引出脚)
 * 模组本体 13.2×16.6mm(北端 y∈[2.9,8.3] 为天线净空区);courtyard 13.6×17mm,
 * 比焊盘外接矩形(≈12.6×16)大 —— 板级布局按 courtyard 留净空,重叠会 DRC 报错。
 *
 * 用法(props 原样透传给 <chip>,支持 name/pcbX/pcbY/layer/pcbRotation/
 * schPinArrangement/connections 等):
 *   import { ESP32_C6_MINI_1 } from './esp32-c6-mini'
 *   <ESP32_C6_MINI_1 name="U1" layer="bottom" pcbX={0} pcbY={2} />
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
  pin9: ["IO4"],
  pin10: ["IO5"],
  pin11: ["GND3"],
  pin12: ["IO0"],
  pin13: ["IO1"],
  pin14: ["GND4"],
  pin15: ["IO6"],
  pin16: ["IO7"],
  pin17: ["IO12"],
  pin18: ["IO13"],
  pin19: ["IO14"],
  pin20: ["IO15"],
  pin21: ["NC3"],
  pin22: ["IO8"],
  pin23: ["IO9"],
  pin24: ["IO18"],
  pin25: ["IO19"],
  pin26: ["IO20"],
  pin27: ["IO21"],
  pin28: ["IO22"],
  pin29: ["IO23"],
  pin30: ["RXD0"],
  pin31: ["TXD0"],
  pin32: ["NC4"],
  pin33: ["NC5"],
  pin34: ["NC6"],
  pin35: ["NC7"],
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

export const ESP32_C6_MINI_1 = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      manufacturerPartNumber="ESP32-C6-MINI-1"
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
            pcbX="0mm"
            pcbY="-0.725mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin51"]}
            pcbX="1.975mm"
            pcbY="-0.725mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin52"]}
            pcbX="-1.975mm"
            pcbY="-2.7mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin53"]}
            pcbX="0mm"
            pcbY="-2.7mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin54"]}
            pcbX="1.975mm"
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
            pcbY="-4.675mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin57"]}
            pcbX="1.975mm"
            pcbY="-4.675mm"
            width="1.45mm"
            height="1.45mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin58"]}
            pcbX="5.95mm"
            pcbY="2.25mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin59"]}
            pcbX="5.95mm"
            pcbY="-7.65mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin60"]}
            pcbX="-5.95mm"
            pcbY="-7.65mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin61"]}
            pcbX="-5.95mm"
            pcbY="2.25mm"
            width="0.7mm"
            height="0.7mm"
            shape="rect"
          />
          {/* 模组外形 13.2×16.6(kicad 外形线 (±6.6, -8.3..8.3) Y 取反) */}
          <silkscreenpath
            route={[
              { x: -6.6, y: 8.3 },
              { x: 6.6, y: 8.3 },
              { x: 6.6, y: -8.3 },
              { x: -6.6, y: -8.3 },
              { x: -6.6, y: 8.3 },
            ]}
          />
          {/* 天线净空分界线(kicad y=-2.9 取反;北侧为 PCB 天线区,禁布铜/器件) */}
          <silkscreenpath
            route={[
              { x: -6.6, y: 2.9 },
              { x: 6.6, y: 2.9 },
            ]}
          />
          <silkscreentext
            text="{NAME}"
            pcbX="0mm"
            pcbY="9.5mm"
            anchorAlignment="center"
            fontSize="1mm"
          />
          {/* F.CrtYd 矩形 (-6.8,-8.5)-(6.8,8.5) → Y 取反 */}
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
