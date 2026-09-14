# ESP32-S3-Touch-AMOLED-2.16 官方资料对照

来源：用户提供的 `/Users/finger/Downloads/ESP32-S3-Touch-AMOLED-2.16`；核对日期 2026-09-12。

2026-09-12 目标变更：用户不再要求官方 1:1，新建项目默认采用自主 ESP32-S3 主控扩展板。此目录仅保留旧官方拓扑与尺寸参考；新版工程见 `output/hardware/esp32s3-functional`。

- `ESP32-S3-Touch-AMOLED-2.16-Schematic.pdf`：官方原理图、PCB 正反面打印页。
- `ESP32-S3-Touch-AMOLED-2.16-Dxf.pdf` / `.dxf`：外壳正面、背面和四侧尺寸图。DXF 的 INSUNITS 声明英寸，实体数值实际是毫米，不能乘 25.4。
- `official-netlist.json`：213 个元件（含机械/标识项）、642 个引脚、181 个非空网络。文件附原 PDF SHA256、提取时间与数据可信状态。

## 核对结果

| 项目 | 结果 | 证据与边界 |
| --- | --- | --- |
| 壳体外形 | 46×46×22.50 mm，R5.80 | DXF 明确标注；STL 外形已量测 |
| 屏幕 | VA 38.99±0.10 mm、R4.70；玻璃 OD 43.30±0.05 mm | VA/OD 为两种不同尺寸，分别用于开窗和台阶 |
| 右侧按钮 | 3×Ø5.30，中心节距 10 mm，距屏面 9.60 mm | Ø5.30 为按钮标注，按此开孔的装配余量仍需试装 |
| 外壳螺钉 | 34×37 mm，边距 6/4.5 mm | 后壳标注；不是 PCB 钻孔直径、镀层或安装孔中心的独立证明 |
| USB/SD | 左侧 USB、上侧 SD；距屏面基准 8.6/8.3 mm | 8.6/8.3 不是开口宽度。孔宽高按图形比例重建，需试装 |
| 扬声器 | 下侧壁六条长孔 | 数量/方位按视图；尺寸未标注，当前为比例重建 |
| PCB 轮廓 | 恢复包围盒约 40.119×40.9898 mm | 由放大打印页以按钮 10 mm 节距标定；不是带制造公差的板框源文件 |
| 电路拓扑 | 213 个元件、642 个引脚、181 个网络全部接入 | Electron 实际求值后按引脚连接分组逐一对比，包含 USB 复合编号 |
| 主控 | U1 ESP32-S3R8，57 个引脚记录 | 替换旧模板中 ESP32-S3-MINI-1-N8 模组等代方式 |

## IDE 改动

历史官方参考模板（`esp32s3-official.ts`）生成 `board.tsx`、可编辑的 `official-data.ts`、只读对照 `official-netlist.json`、`reference.json` 和 `enclosure.scad`。

PCB 示例保留官方引脚编号与完整网络，通过显式网络标签显示原理图。PDF 引脚点击框含原理图坐标，不能当作 PCB 焊盘位置；此前误用会把 R2 计算成约 25mm 宽并造成穿壳。参考模板现仅以居中 0.15mm 小阵列显示引脚标记，器件丝印带 `?`；原始 padCenters 留作提取证据，不能用于物理布局。底层 DRC 会报告重叠/越界，不能据此制造。PCB 走线默认关闭，不捏造官方铜箔。

外壳支持独立外尺寸、显式螺柱中心、VA 窗圆角、OD 台阶和各侧壁孔。SCAD 是工作区预览与打印的同一几何源，跨分件开口同时切除顶盖裙边和内唇。STL 单件导出自动居中、落床并量测宽深；底盒/顶盖全质量网格每条边均有两个邻接三角形。板卡 STL 仅供装配验证，不能打印出电子电路。

导出菜单可生成 `export/validation/report.json`。报告区分打印尺寸检查与 PCB 制造检查，记录 DRC、未布线连接、拓扑差异和资料缺项。损坏的基准文件会阻止导出。外壳外形检查量测实际编译网格；孔位/圆角/台阶检查基于 SCAD 导出的参数元数据，不能替代独立几何检测或实物装配。

打印页增加本机 PrusaSlicer CLI 调用入口：先导出最新 STL，再选择 CLI 与打印机/喷嘴/材料 INI，60 秒超时，成功后接入已有 G-code 上传流程。当前机器没有切片器/打印配置，实际切片与实体打印**未验证**。拓竹继续使用 Bambu Studio/OrcaSlicer 的切片 3MF。

## 验证

```sh
pnpm --filter pixelbox-simulator run check:hardware:reference
pnpm --filter pixelbox-simulator run build
pnpm --filter pixelbox-simulator run check:hardware
```

回归检查覆盖完整官方网表、漏连、误短接、外形尺寸漂移、螺柱错位、无效基准、板卡安装孔几何和 STL 落床。Electron 冒烟覆盖实际 Worker 求值、拓扑、制造拦截、SCAD、3D、STL、PCB/原理图 SVG、Monaco 补全及跨文件零错误诊断。软件链路 PASS 不代表 PCB DRC 或实物装配通过。

提取复现（需要 `pymupdf`）：

```sh
python simulator/scripts/extract-official-hardware.py \
  --source docs/hardware/reference/ESP32-S3-Touch-AMOLED-2.16/ESP32-S3-Touch-AMOLED-2.16-Schematic.pdf \
  --out /tmp/official-netlist.json
```

## 距离制造级 1:1 的缺项

官方目录只有三个 PDF/DXF 文件，没有 PcbDoc/KiCad、Gerber、层叠/阻抗约束、封装库、BOM 或 STEP/STL。元件值的邻近文字提取也需人工复核。目前未完成真实封装、铜箔布线、PCB 钻孔、屏幕 FPC/胶层、电池、按钮帽、螺钉锁合与内部装配验证。外壳壁厚、台阶深度和卡合参数是重建设计，未称为官方内部结构。

若以后重新要求制造级完全对齐，需要补充官方 PCB 制造工程及 STEP/内部尺寸，或通过实物测绘和电气验证补齐。当前模板的 Gerber 制造导出被明确阻止；外壳 STL 可用于原型试装。
