/**
 * ESP32-P4 —— 乐鑫官方 QFN104 芯片级封装(tscircuit;P4 无官方 RF 模组,
 * 以芯片 footprint 直接落板,微雪实板同为裸片直贴方案,原理图位号 U8)
 *
 * 来源:https://raw.githubusercontent.com/espressif/kicad-libraries/main/footprints/Espressif.pretty/ESP32-P4.kicad_mod
 *       (espressif/kicad-libraries,Apache-2.0)
 * 转换:kicad +y 向下 → pcbY 取反;pad 角度 90 时 size w/h 互换;oval → rect
 *       (0.2×0.65 小盘几何差异可忽略);剥掉 fp_line/fp_text 等图形,仅保留
 *       F.Fab 10×10 外形(pin1 角斜切)换成丝印与 F.CrtYd ±5.6 courtyard
 *       (均手工 Y 取反);不带 cadModel 段(IDE 模板离线原则,不引用 CDN)。
 * 焊盘交叉核对:kicad_mod 共 113 个 pad 条目 —— 周边 104 个 oval(0.2×0.65,
 *       pitch 0.35,每边 26)与 datasheet v0.7 Table 2-1 的 104 引脚一一对应;
 *       中央散热盘 EP 编号全部为 "105"(2.1mm 方盘 3×3 网格、2.7mm 间距),
 *       重编为 pin105..pin113 并归入 GND 序列(GND1..GND9,datasheet pin105=GND),
 *       共 113 个 SMT 焊盘。命名以 datasheet 为准(微雪原理图符号名有差异,
 *       如 VDDPST_x↔VDD_IO_x、VCCA↔VDD_USBPHY)。
 *
 * 引脚要点(微雪 ESP32-P4-WIFI6-Touch-LCD-4.3 用法):
 *   GPIO0..GPIO54 可按名连线(如 .U1 > .GPIO35 = BOOT 键);CHIP_PU = RESET;
 *   FLASH_CS/Q/WP/HOLD/CK/D 接片外 32MB NOR;DSI_*(pin35-40)接 MIPI-DSI 屏;
 *   CSI_*(pin42-47)接摄像头;USB_DM/DP(pin49/50)为专用 USB OTG PHY;
 *   EN_DCDC/FB_DCDC 闭环控制片外核压 buck(MP1605);XTAL_P/N 接 40MHz 晶振。
 *
 * 用法(props 原样透传给 <chip>,支持 name/pcbX/pcbY/layer/pcbRotation/
 * schPinArrangement/connections 等):
 *   import { ESP32_P4 } from './esp32-p4'
 *   <ESP32_P4 name="U1" layer="bottom" pcbX={0} pcbY={0} />
 */
import type { ChipProps } from "@tscircuit/props";

const pinLabels = {
  pin1: ["GPIO1"],
  pin2: ["GPIO2"],
  pin3: ["GPIO3"],
  pin4: ["GPIO4"],
  pin5: ["GPIO5"],
  pin6: ["GPIO6"],
  pin7: ["GPIO7"],
  pin8: ["GPIO8"],
  pin9: ["VDD_LP"],
  pin10: ["GPIO9"],
  pin11: ["GPIO10"],
  pin12: ["GPIO11"],
  pin13: ["GPIO12"],
  pin14: ["GPIO13"],
  pin15: ["GPIO14"],
  pin16: ["GPIO15"],
  pin17: ["GPIO16"],
  pin18: ["GPIO17"],
  pin19: ["GPIO18"],
  pin20: ["GPIO19"],
  pin21: ["VDD_IO_0"],
  pin22: ["GPIO20"],
  pin23: ["GPIO21"],
  pin24: ["GPIO22"],
  pin25: ["GPIO23"],
  pin26: ["VDD_HP_0"],
  pin27: ["FLASH_CS"],
  pin28: ["FLASH_Q"],
  pin29: ["FLASH_WP"],
  pin30: ["VDD_FLASHIO"],
  pin31: ["FLASH_HOLD"],
  pin32: ["FLASH_CK"],
  pin33: ["FLASH_D"],
  pin34: ["DSI_REXT"],
  pin35: ["DSI_DATAP1"],
  pin36: ["DSI_DATAN1"],
  pin37: ["DSI_CLKN"],
  pin38: ["DSI_CLKP"],
  pin39: ["DSI_DATAP0"],
  pin40: ["DSI_DATAN0"],
  pin41: ["VDD_MIPI_DPHY"],
  pin42: ["CSI_DATAN0"],
  pin43: ["CSI_DATAP0"],
  pin44: ["CSI_CLKP"],
  pin45: ["CSI_CLKN"],
  pin46: ["CSI_DATAN1"],
  pin47: ["CSI_DATAP1"],
  pin48: ["CSI_REXT"],
  pin49: ["USB_DM"],
  pin50: ["USB_DP"],
  pin51: ["VDD_USBPHY"],
  pin52: ["GPIO24"],
  pin53: ["GPIO25"],
  pin54: ["VDD_HP_1"],
  pin55: ["GPIO26"],
  pin56: ["GPIO27"],
  pin57: ["GPIO28"],
  pin58: ["GPIO29"],
  pin59: ["VDD_PSRAM_0"],
  pin60: ["GPIO30"],
  pin61: ["GPIO31"],
  pin62: ["VDD_IO_4"],
  pin63: ["GPIO32"],
  pin64: ["GPIO33"],
  pin65: ["GPIO34"],
  pin66: ["GPIO35"],
  pin67: ["VDD_PSRAM_1"],
  pin68: ["GPIO36"],
  pin69: ["GPIO37"],
  pin70: ["GPIO38"],
  pin71: ["VDDO_FLASH"],
  pin72: ["VDDO_PSRAM"],
  pin73: ["VDDO_3"],
  pin74: ["VDDO_4"],
  pin75: ["VDD_LDO"],
  pin76: ["VDD_HP_2"],
  pin77: ["VDD_DCDCC"],
  pin78: ["FB_DCDC"],
  pin79: ["EN_DCDC"],
  pin80: ["GPIO39"],
  pin81: ["GPIO40"],
  pin82: ["GPIO41"],
  pin83: ["GPIO42"],
  pin84: ["GPIO43"],
  pin85: ["VDD_IO_5"],
  pin86: ["GPIO44"],
  pin87: ["GPIO45"],
  pin88: ["GPIO46"],
  pin89: ["GPIO47"],
  pin90: ["GPIO48"],
  pin91: ["VDD_HP_3"],
  pin92: ["GPIO49"],
  pin93: ["GPIO50"],
  pin94: ["GPIO51"],
  pin95: ["GPIO52"],
  pin96: ["VDD_IO_6"],
  pin97: ["GPIO53"],
  pin98: ["GPIO54"],
  pin99: ["XTAL_N"],
  pin100: ["XTAL_P"],
  pin101: ["VDD_ANA"],
  pin102: ["VDD_BAT"],
  pin103: ["CHIP_PU"],
  pin104: ["GPIO0"],
  pin105: ["GND1"],
  pin106: ["GND2"],
  pin107: ["GND3"],
  pin108: ["GND4"],
  pin109: ["GND5"],
  pin110: ["GND6"],
  pin111: ["GND7"],
  pin112: ["GND8"],
  pin113: ["GND9"],
} as const;

export const ESP32_P4 = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      manufacturerPartNumber="ESP32-P4"
      footprint={
        <footprint>
          <smtpad
            portHints={["pin1"]}
            pcbX="-4.875mm"
            pcbY="4.375mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin2"]}
            pcbX="-4.875mm"
            pcbY="4.025mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin3"]}
            pcbX="-4.875mm"
            pcbY="3.675mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin4"]}
            pcbX="-4.875mm"
            pcbY="3.325mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin5"]}
            pcbX="-4.875mm"
            pcbY="2.975mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin6"]}
            pcbX="-4.875mm"
            pcbY="2.625mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin7"]}
            pcbX="-4.875mm"
            pcbY="2.275mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin8"]}
            pcbX="-4.875mm"
            pcbY="1.925mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin9"]}
            pcbX="-4.875mm"
            pcbY="1.575mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin10"]}
            pcbX="-4.875mm"
            pcbY="1.225mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin11"]}
            pcbX="-4.875mm"
            pcbY="0.875mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin12"]}
            pcbX="-4.875mm"
            pcbY="0.525mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin13"]}
            pcbX="-4.875mm"
            pcbY="0.175mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin14"]}
            pcbX="-4.875mm"
            pcbY="-0.175mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin15"]}
            pcbX="-4.875mm"
            pcbY="-0.525mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin16"]}
            pcbX="-4.875mm"
            pcbY="-0.875mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin17"]}
            pcbX="-4.875mm"
            pcbY="-1.225mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin18"]}
            pcbX="-4.875mm"
            pcbY="-1.575mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin19"]}
            pcbX="-4.875mm"
            pcbY="-1.925mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin20"]}
            pcbX="-4.875mm"
            pcbY="-2.275mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin21"]}
            pcbX="-4.875mm"
            pcbY="-2.625mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin22"]}
            pcbX="-4.875mm"
            pcbY="-2.975mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin23"]}
            pcbX="-4.875mm"
            pcbY="-3.325mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin24"]}
            pcbX="-4.875mm"
            pcbY="-3.675mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin25"]}
            pcbX="-4.875mm"
            pcbY="-4.025mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin26"]}
            pcbX="-4.875mm"
            pcbY="-4.375mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin27"]}
            pcbX="-4.375mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin28"]}
            pcbX="-4.025mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin29"]}
            pcbX="-3.675mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin30"]}
            pcbX="-3.325mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin31"]}
            pcbX="-2.975mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin32"]}
            pcbX="-2.625mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin33"]}
            pcbX="-2.275mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin34"]}
            pcbX="-1.925mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin35"]}
            pcbX="-1.575mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin36"]}
            pcbX="-1.225mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin37"]}
            pcbX="-0.875mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin38"]}
            pcbX="-0.525mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin39"]}
            pcbX="-0.175mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin40"]}
            pcbX="0.175mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin41"]}
            pcbX="0.525mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin42"]}
            pcbX="0.875mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin43"]}
            pcbX="1.225mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin44"]}
            pcbX="1.575mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin45"]}
            pcbX="1.925mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin46"]}
            pcbX="2.275mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin47"]}
            pcbX="2.625mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin48"]}
            pcbX="2.975mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin49"]}
            pcbX="3.325mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin50"]}
            pcbX="3.675mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin51"]}
            pcbX="4.025mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin52"]}
            pcbX="4.375mm"
            pcbY="-4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin53"]}
            pcbX="4.875mm"
            pcbY="-4.375mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin54"]}
            pcbX="4.875mm"
            pcbY="-4.025mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin55"]}
            pcbX="4.875mm"
            pcbY="-3.675mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin56"]}
            pcbX="4.875mm"
            pcbY="-3.325mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin57"]}
            pcbX="4.875mm"
            pcbY="-2.975mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin58"]}
            pcbX="4.875mm"
            pcbY="-2.625mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin59"]}
            pcbX="4.875mm"
            pcbY="-2.275mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin60"]}
            pcbX="4.875mm"
            pcbY="-1.925mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin61"]}
            pcbX="4.875mm"
            pcbY="-1.575mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin62"]}
            pcbX="4.875mm"
            pcbY="-1.225mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin63"]}
            pcbX="4.875mm"
            pcbY="-0.875mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin64"]}
            pcbX="4.875mm"
            pcbY="-0.525mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin65"]}
            pcbX="4.875mm"
            pcbY="-0.175mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin66"]}
            pcbX="4.875mm"
            pcbY="0.175mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin67"]}
            pcbX="4.875mm"
            pcbY="0.525mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin68"]}
            pcbX="4.875mm"
            pcbY="0.875mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin69"]}
            pcbX="4.875mm"
            pcbY="1.225mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin70"]}
            pcbX="4.875mm"
            pcbY="1.575mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin71"]}
            pcbX="4.875mm"
            pcbY="1.925mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin72"]}
            pcbX="4.875mm"
            pcbY="2.275mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin73"]}
            pcbX="4.875mm"
            pcbY="2.625mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin74"]}
            pcbX="4.875mm"
            pcbY="2.975mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin75"]}
            pcbX="4.875mm"
            pcbY="3.325mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin76"]}
            pcbX="4.875mm"
            pcbY="3.675mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin77"]}
            pcbX="4.875mm"
            pcbY="4.025mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin78"]}
            pcbX="4.875mm"
            pcbY="4.375mm"
            width="0.65mm"
            height="0.2mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin79"]}
            pcbX="4.375mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin80"]}
            pcbX="4.025mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin81"]}
            pcbX="3.675mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin82"]}
            pcbX="3.325mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin83"]}
            pcbX="2.975mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin84"]}
            pcbX="2.625mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin85"]}
            pcbX="2.275mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin86"]}
            pcbX="1.925mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin87"]}
            pcbX="1.575mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin88"]}
            pcbX="1.225mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin89"]}
            pcbX="0.875mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin90"]}
            pcbX="0.525mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin91"]}
            pcbX="0.175mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin92"]}
            pcbX="-0.175mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin93"]}
            pcbX="-0.525mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin94"]}
            pcbX="-0.875mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin95"]}
            pcbX="-1.225mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin96"]}
            pcbX="-1.575mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin97"]}
            pcbX="-1.925mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin98"]}
            pcbX="-2.275mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin99"]}
            pcbX="-2.625mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin100"]}
            pcbX="-2.975mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin101"]}
            pcbX="-3.325mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin102"]}
            pcbX="-3.675mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin103"]}
            pcbX="-4.025mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin104"]}
            pcbX="-4.375mm"
            pcbY="4.875mm"
            width="0.2mm"
            height="0.65mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin105"]}
            pcbX="-2.7mm"
            pcbY="2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin106"]}
            pcbX="0mm"
            pcbY="2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin107"]}
            pcbX="2.7mm"
            pcbY="2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin108"]}
            pcbX="-2.7mm"
            pcbY="0mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin109"]}
            pcbX="0mm"
            pcbY="0mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin110"]}
            pcbX="2.7mm"
            pcbY="0mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin111"]}
            pcbX="-2.7mm"
            pcbY="-2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin112"]}
            pcbX="0mm"
            pcbY="-2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          <smtpad
            portHints={["pin113"]}
            pcbX="2.7mm"
            pcbY="-2.7mm"
            width="2.1mm"
            height="2.1mm"
            shape="rect"
          />
          {/* 芯片外形 10×10(F.Fab,pin1 角斜切;kicad Y 取反后斜切角在左上) */}
          <silkscreenpath
            route={[
              { x: -5, y: 4 },
              { x: -4, y: 5 },
              { x: 5, y: 5 },
              { x: 5, y: -5 },
              { x: -5, y: -5 },
              { x: -5, y: 4 },
            ]}
          />
          <silkscreentext
            text="{NAME}"
            pcbX="0mm"
            pcbY="6.4mm"
            anchorAlignment="center"
            fontSize="1mm"
          />
          {/* F.CrtYd 矩形 ±5.6 → Y 取反(对称,数值不变) */}
          <courtyardoutline
            outline={[
              { x: -5.6, y: 5.6 },
              { x: 5.6, y: 5.6 },
              { x: 5.6, y: -5.6 },
              { x: -5.6, y: -5.6 },
              { x: -5.6, y: 5.6 },
            ]}
          />
        </footprint>
      }
      {...props}
    />
  );
};
