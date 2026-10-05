# example07 NuttX 真机帧率记录

设备：Waveshare ESP32-S3-Touch-AMOLED-2.16，480×480 RGB565，QSPI 40 MHz，CPU 240 MHz，Octal PSRAM 80 MHz。

用户提供的原理图中，U1为ESP32-S3R8、U2为XM25QH128DHIQT；本机esptool探测为Flash ID `0x204018`、16MB、quad接口（`tmp/fps-optimization-rom-probe-20261002.log`）。NuttX使用的WROOM1N16R8名称是匹配内存容量的配置选项，不代表实物是WROOM模组。

**已达到动态全屏约30 FPS目标。** native20 已烧录到真机并确认实际 Flash QIO。关闭分项性能插桩，example07 真实渲染路径的三个动态场景各测量120秒，结果如下：

|场景|平均绘制 FPS|平均有效提交 FPS|显示错误|
|---|---:|---:|---:|
|全屏说话＋模拟倾斜|29.951|29.951|0|
|全屏动画|29.641|29.641|0|
|普通说话＋模拟倾斜|30.002|27.712|0|

普通场景会跳过没有变化的画面，不重复传屏增加计数。以上是应用绘制和驱动成功提交的平均帧率，未测面板物理扫描率；音量与倾斜使用模拟输入。测试后已恢复正式example07，核对应用与文件哈希、确认benchmark入口不存在，并观察约15.9秒内完成446次flush、2次有效提交、显示错误0。没有人工按键复位。

最终采用的优化包括：原生背景恢复与主体融合、整数布局端点计算、按行和8像素块缩小RGB565转换范围、变化行分段传屏、JS场景/字幕/投影数据缓存和临时对象省写，以及SimpleBoot的Flash QIO启动接线。保持480×480、CPU 240MHz、Flash/PSRAM 80MHz、屏幕QSPI 40MHz。无真机收益的同色块缓存、IRAM放置、Float64批量API和O2候选均未进入交付。

原始结果、源码绑定、健康快照和正式应用恢复证据见末尾native20节。native07–native19各节为历史实验记录，其中的“待验证”“未达成”只描述当时状态。本次帧率验收不代表原ESP-IDF全部功能已完成迁移或真实语音并发已验收。

## 测量口径

- 运行 example07 的真实 drawHarness 路径，测试入口为 examples/07-obeing-harness/fps-benchmark.ts。
- callbackFps：完成绘制并成功执行flush的次数 / 设备单调时钟时间。
- submittedFps：实际RGB565有变化且FBIO_UPDATE成功的次数 / 同一时间。静态/量化相同画面不会重复提交充数。
- profile=false关闭分项时间包装；profile=true只用于定位耗时。两者不可混作同一基线。
- speaking-imu 和 fullscreen-speaking 使用正弦模拟的音量和倾斜输入，不包含真实音频与IMU采集的并发开销。
- 软件计数不能证明面板物理扫描率、肉眼亮屏、无撕裂；本次没有摄像或光电测量。

## 30秒场景实测（profile=false）

| 固件/测试包 | 场景 | 绘制FPS | 有效提交FPS | 显示错误 |
|---|---|---:|---:|---:|
| native07 / 原背景 | 全屏 | 18.54 | 18.54 | 0 |
| native07 / 原背景 | 说话+倾斜 | 22.22 | 21.26 | 0 |
| native07 / 原背景 | 全屏说话+倾斜 | 18.85 | 18.85 | 0 |
| native07 / 背景省写 | 全屏说话+倾斜 | 19.14 | 19.14 | 0 |
| native07 / 背景省写 | 说话+倾斜 | 22.15 | 21.06 | 0 |
| native08 / 背景省写 | 全屏说话+倾斜 | 18.85 | 18.85 | 0 |
| native08 / 背景省写 | 说话+倾斜 | 22.06 | 20.83 | 0 |
| native08 / 背景省写 | 全屏 | 18.03 | 18.03 | 0 |
| native08 / 背景省写 | 待机 | 20.58 | 8.23 | 0 |
| native08 / 背景省写 | Kitty | 18.29 | 3.08 | 0 |

每场实际窗口超过30秒。待机使用随机动作且场景初始时刻不固定，提交率随量化重复率变化，不能单凭此列推断绘制能力提升。

native08增加经过逐端点认证的Float布局路径，480²下94%端点可快算，但真机整体收益不明显。保留实际结果，不以宿主耗时或命中率替代真机验收。

## 原始证据

- tmp/example07-fps-native07-unprofiled/{initial,results}.json
- tmp/example07-fps-native07-fullscreen-speaking/{initial,results}.json
- tmp/example07-fps-native07-bgcutout/{initial,results}.json
- tmp/example07-fps-native08-unprofiled/{initial,results}.json
- tmp/example07-fps-native08-profiled/results.json
- tmp/fps-native-flash-20261003-08/state.json：备份、写入、独立校验、RTC复位和NSH启动完成。
- tmp/fps-native08-source-state.json：固件与关键源码SHA256。

native08镜像SHA256：f211377c995962f7b6f04e5799548ae906745af2714ea10ea13fc7e8d5275558。

## 历史计划：native09验证内容

native09拟验证：整数阴影重叠计算、同色像素组省写、相同RGB像素对转换缓存、Kitty连续相同帧复用、自动干净帧免扫描。均须先验证像素等价、异常后的显示重试，再真机测量。

复现命令：

```sh
node examples/scripts/measure-obeing-device.mjs --host DEVICE_IP --output tmp/new-fps-result --seconds 30
```

脚本拒绝覆盖已有results.json；--no-deploy用于重复测量当前已确认的benchmark。最终验收还应包含动态场景延长测量，并恢复正式example07应用。

## native09中间结果

已实测刷写、verify和NSH重启成功；镜像SHA256 `5384d2e4592fe279bda402d832b5beb660bbca2ae6e3964491e38dc3b42b5b3a`。加入整数布局、同色span省写、pair缓存、Kitty复用、known-clean自动flush及dirty语义补齐。

使用背景批次缓存的新bundle：`e4981840cd3e9db10cf5220389b5037b48cf07b03074d2ded4ff310153895ea3`。

|场景|绘制FPS|有效提交FPS|错误|
|---|---:|---:|---:|
|fullscreen-speaking|20.366|20.366|0|
|speaking-imu|22.979|21.751|0|
|idle|22.321|8.026|0|
|fullscreen|20.293|20.293|0|
|kitty-classic|28.603|3.459|0|

证据：`tmp/example07-fps-native09-{unprofiled,grid,profiled}/results.json`、`tmp/fps-native09-grid-source-state.json`。仍未达30 FPS动态目标。Kitty回调28.6 FPS包含保留不变图像的帧，不应宣传为28.6次有效图像提交。

## native10构建与回归

本版加入原生旧背景/网格恢复与主体融合、按真实变化行拆分最多8段输出，以及默认方向的RGB565双像素字节序打包。有效FPS仍以一整帧所有提交成功后updates加1计数。新诊断transactions是成功ioctl次数，transmittedPixels是其逻辑面积，不含面板偶数对齐扩展。

镜像SHA256：`0c1b9797167a8ea16edc0f11887aee81d4b2d8883f8f07c87d41f682c935dff8`。内部堆检查余量19904字节。构建源码绑定记录为`tmp/fps-native10-source-state.json`。

回归证据：

- 原生融合恢复839组像素/边界对照、1249790个数值边界、864帧历史画面逐像素一致：`tmp/canvas-restoration-review-20261003/report.json`。
- TS接线960帧、能力探测、异常与批次顺序：`tmp/restored-run-layers-integration/REPORT.md`。
- 分段输出O1/O2/O3+UBSan、失败后完整画面恢复、整帧计数及目标芯片编译：`tmp/framebuffer-bands-audit/REPORT.md`。
- 驱动传输15/15：`tmp/fps-native10-transport-tests.log`；benchmark38/38：`tmp/fps-native10-benchmark-final-tests.log`；宿主运行接口：`tmp/fps-native10-runtime-tests.log`。
- example06和example07 TypeScript检查通过。

烧录备份、写入、独立校验和软件重启均完成：`tmp/fps-native-flash-20261003-10/state.json` 的 phase 为 booted。

### native10真机30秒测量

|场景|绘制FPS|有效提交FPS|转换毫秒/帧|传屏毫秒/有效帧|错误|
|---|---:|---:|---:|---:|---:|
|fullscreen-speaking|23.831|23.831|6.643|4.979|0|
|speaking-imu|27.959|26.164|4.882|3.699|0|
|fullscreen|23.016|23.016|8.306|2.089|0|
|idle|26.784|8.188|6.345|2.725|0|
|kitty-classic|29.424|3.095|1.150|15.022|0|

证据：`tmp/example07-fps-native10-unprofiled/results.json`。动态场景进一步提升，但仍未达到约30 FPS目标，继续优化。

### native10 + JS重复工作缓存

在相同固件上热推精简JS优化：缓存13字段场景键与7字段字幕键、将面部/波形循环不变量移到循环外。原生和宿主各2460帧对照通过，含131键值和12字幕getter用例。

|场景|绘制FPS|有效提交FPS|错误|
|---|---:|---:|---:|
|fullscreen-speaking|25.066|25.066|0|
|speaking-imu|28.437|26.479|0|
|fullscreen|24.331|24.331|0|

证据：`tmp/example07-fps-native10-js-cache/results.json`、`tmp/fps-native10-js-source-state.json`。全屏说话提升到25.07 FPS，仍继续优化原生布局。

未采用的候选：RGB565四像素循环展开虽通过随机/真实像素与计数对照，但目标汇编热路径指令数未减少，宿主实测变慢；因此未进入固件。证据`tmp/framebuffer-unroll4-review-20261003/report.json`。

## native11整数布局版

同批次先证明全部投影行和阴影处于逻辑裁剪范围、端点绝对值≤512且平移在2^-44网格内，随后用整数维护边界、按轴缓存重复物理端点。其余输入回退原Double链。512B局部cache使S3 fill_layers栈帧从1200增至1776字节（+576）；native10真机应用栈32696字节，峰值使用13008（39.7%）。native11后续真机ps同样为峰值13008（39.7%），证据tmp/fps-native11-good-device-ps.log。

镜像SHA256：`6f1f57bea43b119fc4538367dc5e04674afc6fec11bb3f1c941804a860c63765`，内部堆余量19904。源码绑定`tmp/fps-native11-source-state.json`。

最终生产源码验证：839融合场景、160连续融合帧、1249790 Float数值认证、14563整数边界×100矩形、864真实原生帧像素/边界/脏区对照均通过。报告`tmp/canvas-logical-audit/REPORT.md`。真机FPS测量待补充。

### native11真机回归失败（不可作为性能交付）

镜像虽通过宿主与目标编译，但首轮热推app.push_begin超时；日志出现fillRunLayersRestored interrupted和VM watchdog progress lost。软件reboot后不再推送、直接运行原benchmark仍出现eval超时/watchdog。新布局尚无有效FPS，不能算已优化成功。证据`tmp/fps-native11-{push-timeout,post-reboot}-serial.log`、`tmp/example07-fps-native11-{unprofiled,existing}.log`。

已将canvas源码恢复到native10（SHA29fa9c7d…），失败候选完整保存在`tmp/canvas-native11-faulty.c`；测试/报告仍保留用于定位。回退重建镜像`a545668c2dc7d07347f94fd6e2fc5192438037029b3983d1bb0dd9fa5b1e2ee9`，刷写phase=booted，证据`tmp/fps-native-flash-20261003-rollback/state.json`。仍在定位因果，暂未判定为画面算法错误。

### native11低频诊断与重测

在native10先安装低频离屏诊断、再更换相同native11 C源码固件，保持串口持续读取，10步全部完成，返回边界和像素样本相同（真实角色单次14/10/8/8ms，native10为14/10/9/9ms）。随后热推完整benchmark，五场30秒测量成功；此前故障原因仍待定位，不可删除失败证据。

|场景|绘制FPS|有效提交FPS|错误|
|---|---:|---:|---:|
|fullscreen-speaking|25.288|25.288|0|
|speaking-imu|28.316|26.258|0|
|fullscreen|23.852|23.852|0|
|idle|27.661|8.072|0|
|kitty-classic|29.313|3.061|0|

证据`tmp/example07-fps-native11-after-diag/results.json`、`tmp/native11-canvas-diagnostic/native11-device.json`。此轮重测收益不明显，目标仍未完成。


## native12逐行扫描与USB背压保护

原生绘制沿用同色八像素组省写，同时累计每行实际写入范围；自动flush仅比较对应行范围与dirty矩形的交集。JS绘制、文字和异常路径保守扩大范围；手动flush保持全屏扫描。buffer所有权、offset、detach及整表边界均在修改映射前校验；提交失败仍完整重试，不用重复提交制造FPS。

Canvas新增1200混合绘制帧与rows漏写/中断/alias测试通过；真实420帧测量范围与独立底层写入探针一致。framebuffer四格式/stride组合、稀疏行、getter重入亮屏、部分提交失败重试通过O3+UBSan；JS接线5项通过。宿主5/5测试通过。证据tmp/fps-native12-{canvas,framebuffer,runtime,usbserial}-tests.log和firmware-nuttx/tests/test_canvas_rows.mjs。

串口背压修复仅作用于ESP32-S3原生USB控制台：普通发送锁和队列空间等待20ms后丢弃日志，IRQ直接写共享2ms等待预算；正常UART与O_NONBLOCK原语义保留。该修复消除代码中已确认的无限等待路径，尚不能证明它是native11首次故障的唯一根因。6个补丁测试含真实串口函数10组桩回归通过。

镜像SHA256 `48411a98e5ee9b91c397421d4124949104d1bbe3de0a89537130b6845b39beb1`；烧录、独立校验、软件复位与NSH启动已确认，tmp/fps-native-flash-20261003-12/state.json phase=booted。源码绑定tmp/fps-native12-source-state.json。五场30秒真机测量完成，本轮关闭串口读取器。

|场景|绘制FPS|有效提交FPS|错误|
|---|---:|---:|---:|
|fullscreen-speaking|26.148|26.148|0|
|speaking-imu|28.317|26.256|0|
|fullscreen|24.592|24.592|0|
|idle|26.238|8.261|0|
|kitty-classic|28.854|3.258|0|

证据tmp/example07-fps-native12-unprofiled/results.json；全屏说话转换6.86→5.04ms/帧，但总有效帧率仅25.29→26.15，逐行记录有额外成本，目标仍未达成。

USB日志背压真机验证通过：关闭reader时8轮合计约64KiB console.log，每轮70–92ms返回；继续35秒确认同一VM token、100ms定时器和应用帧均推进，framebuffer errors=0。恢复reader后收到独立NSH健康回声；64条测试日志未进入恢复输出，证明有丢弃，未仅靠宿主缓存暂存掩盖背压。证据tmp/native12-usb-backpressure/result.json。该测试不证明USB物理断线/电源故障恢复。


## native13同色块缓存

主屏每aligned8像素保存已认证RGB24颜色，完整组已同色才跳过像素重复读取。部分写入和JS绘制使缓存失效；异常保守失效；图片绘制期间暂停认证以处理透明掩码getter重入。像素与缓存置于闭包WeakMap，外部_pixels获取或替换后永久关闭缓存并全扫，避免可写引用使认证过期。480屏缓存115200B，逐行范围1920B。

宿主新增1980混合绘制帧、输入owner隔离/detach、13项JS缓存/重入接线测试通过。两场各420帧使用真实QuickJS、projection、text.c、pxfont和WeakMap Prelude，对比无cache参考的480² RGB888全部像素一致，每个有效块与像素一致；419/420帧确有cache有效，并未因测试取_pixels而退化。证据tmp/canvas-uniform-cache-audit/*-closedloop.json、quickjs-wiring.log；最终生产测试tmp/fps-native13-{canvas,prelude,runtime}-tests.log。

镜像SHA256 b0eba52d93ca3b7b4bfce9f21fd8253b3fe58086f490fca63d7eb8fdccec6991；源码绑定tmp/fps-native13-source-state.json。烧录、独立校验与NSH软件启动完成（tmp/fps-native-flash-20261003-13/state.json phase=booted），性能正在真机测量。

### native13实测回退（不采用）

|场景|绘制FPS|有效提交FPS|错误|
|---|---:|---:|---:|
|fullscreen-speaking|25.158|25.158|0|
|speaking-imu|26.705|24.776|0|
|fullscreen|24.179|24.179|0|
|idle|24.501|8.817|0|
|kitty-classic|28.817|3.121|0|

证据tmp/example07-fps-native13-unprofiled/results.json。fullcolor cache在多数场景倒退，不进入最终交付；后续native14以native12为基础，只加入3840B脏块图，不保留115200B同色缓存及其额外像素封装。Dcache为64KiB，扩大working set与回退相容，但未用硬件计数器证明根因。全部候选/测试保留在tmp作为负面实验记录。


## native14稀疏变化块

本版恢复native12像素存储，只增加每行8像素一bit的3840B变化块图；保留1920B行范围表。原生绘制标记实际写入组，JS绘制保守标记声明范围；flush取bbox、rows和bits交集，按字跳过未写入块。传屏仍按原有变化行合并，CPU转换小段不会逐个变成面板事务。失败保留pending整帧并集，成功才清除JS标记。

最终生产组合通过Canvas O3+UBSan、1249790数值边界、14563整数布局边界、11项JS接线与图片回归、framebuffer 3840帧独立oracle及宿主FFI回归。独立真实QuickJS、字体、projection的两组动画各420帧逐像素一致，全部变化像素被rows/bits覆盖。证据tmp/fps-native14-{canvas,prelude,framebuffer,runtime}-tests.log和tmp/canvas-dirty-block-prelude/REPORT.md。

固定动画warm120测300的扫描像素面积减少约49–55%，尚不等于真机帧率收益。镜像SHA256 `0725dc48e50aa8ea7e84edd4b4e5350dfedf1237faf111f12f677a3f2936f1d9`，源码绑定tmp/fps-native14-source-state.json。内部堆余量19904B。正在烧录及测量。

### native14真机30秒测量

|场景|绘制FPS|有效提交FPS|转换ms/帧|显示错误|
|---|---:|---:|---:|---:|
|fullscreen-speaking|26.258|26.258|3.436|0|
|speaking-imu|28.042|25.918|3.746|0|
|fullscreen|25.974|25.974|3.834|0|
|idle|28.337|7.713|4.178|0|
|kitty-classic|28.785|3.361|1.246|0|

烧录独立校验与软件启动成功，tmp/fps-native-flash-20261003-14/state.json phase=booted。测量证据tmp/example07-fps-native14-unprofiled/results.json。全屏idle从24.592提高到25.974，全屏说话从26.148提高到26.258；仍未达到约30FPS目标。稀疏转换收益被其他绘制开销部分抵消，继续依据分项实测优化。


## native15减少位图写回及64位端点计算

每段span将实际脏bit先合并在一个本地32位word中，跨字及span结束才写回，保持中间干净块不标记。固定动画中位图读改写减少84.65%–87.81%；没有新增跨帧缓存。Canvas常见布局直接使用已认证的32位四端点，域外继续保留Int32宽高回绕和64位求端点行为。投影掩码在64位验证65536格上限后使用32位索引，保留所有投影/量化数学。

Canvas完整回归、rows1200/bits1600及另1600轮逐word差分通过；42218个32位端点差分case、原数值认证全部通过。最终Canvas+projection组合两场840帧像素、rows和bits与native14逐项相同。投影原回归和256组65536格/INT32端点case双版本O3+UBSan通过。最终生产回归证据tmp/fps-native15-{canvas,projection,runtime}-tests.log，候选审阅位于tmp/canvas-dirty-block-audit及tmp/canvas-endpoint32-audit。

目标编译成功，Canvas text39695→38730B；projection8245→8101B，projection栈416→400B。独立S3 Canvas编译仍有既有缩进与条件初始化警告，不能称无警告；新增wide adapter缩进提示已用换行消除，不改变逻辑。

镜像SHA256 `830112e11ff9dc3f076f04ff76027849e543d00f32067ed70946217c4606d188`，源码绑定tmp/fps-native15-source-state.json，内部堆余量19904B。真机烧录与性能待验证。

### native15真机30秒结果

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|26.449|26.449|0|
|speaking-imu|28.330|25.969|0|
|fullscreen|25.765|25.765|0|
|idle|27.162|9.665|0|
|kitty-classic|29.418|2.925|0|

烧录、独立校验及软件启动成功，tmp/fps-native-flash-20261003-15/state.json phase=booted。证据tmp/example07-fps-native15-unprofiled/results.json。全屏说话26.449FPS，仍未达到目标；本轮总体收益小，不能将位图写回次数下降等同FPS增幅。下一步测通用逻辑矩形原生批量转换，避免每帧JS约140次坐标round。

### native15 + JS临时数组与assistant键缓存候选

保持同固件，仅热推JS候选；尚未合入正式应用源码。候选使用已分配typed数组直接写12/9元素，避免临时Array；assistant复合场景键仅缓存最近base/page/phrase。

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|27.626|27.626|0|
|fullscreen|27.246|27.246|0|
|speaking-imu|29.084|25.963|0|

候选bundleSHA256 `3303ce4c274e1636e7cea325519ec50e19fb844168d29f2268aec6eca4271e82`，证据tmp/fps-native15-js-candidate/identity.json、tmp/example07-fps-native15-js-candidate/results.json。相较同固件原JS全屏说话26.449→27.626、全屏25.765→27.246，正在三场各120秒稳定性检查。

### native15 + JS三场各120秒稳定性

JS候选已合入生产render；4000 getter/字段/异常用例、2460帧既有render缓存对照以及example06/07 TypeScript检查均通过。

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|27.641|27.641|0|
|speaking-imu|29.113|26.808|0|
|fullscreen|27.519|27.519|0|

证据tmp/example07-fps-native15-js-120s/results.json；持续运行健康检查tmp/fps-native15-js-120s-health.json，累计15957帧/errors0，heapFree5498432B。有效动态全屏稳定在27.5–27.6FPS，继续目标优化。

同轮NSH `ps`验证应用栈峰值13008/32696B（39.7%），证据tmp/fps-native15-js-device-ps.log；本轮端点与位图优化未增加观测到的栈峰值。


## native16-iram单独试验

仅将paint_pixel_bounds和convert_rgb565_row放入ESP32-S3 IRAM，两函数及literal独立对象共2129B，其它函数/数据仍按原链接规则。保持缓存开启，paint仍可调用Flash中的中断检查；该改动不承诺cache关闭时可用。不改变算法和JS测试包。

完整目标构建与内部堆检查通过：paint_pixel_bounds=0x4037b350/1709B，convert_rgb565_row=0x40380d28/412B，_iram_end=0x40388500，_sheap=0x3fcba874，固定堆0x30000，距已实测ROM保留起点余17856B（原19904B）。镜像SHA256 `2234b35277d992e0166e3b75bb6854f8d581b0614b37efb0612678b6d120720d`；源码绑定tmp/fps-native16-iram-source-state.json。正在独立烧录测量，尚不算采用。

### native16-iram结果：无明确收益，不采用

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|27.722|27.722|0|
|fullscreen|27.141|27.141|0|
|speaking-imu|28.962|26.535|0|

烧录/独立校验/NSH软件启动成功，证据tmp/fps-native-flash-20261003-16-iram/state.json和tmp/example07-fps-native16-iram/results.json。与native15+相同JS的长短窗口相比没有稳定收益，已从生产移除IRAM属性，保留2KiB内部内存余量；候选仍完整存tmp/iram-hotpath-audit。


## native17逻辑矩形原生批处理

新增可选fillLogicalRects(Float64Array,count,scale)，布局将number矩形直接排入Float64队列，原生一次执行原有四次Math.round和Int32转换后有序填充。逻辑/物理模式共用40KiB backing buffer，比旧队列增加20KiB；旧固件没有该能力时保留原20KiB队列。模式切换和1024上限先提交，网格缓存独立slice；非number参数将待处理逻辑队列原地物化并切回原路径。转换异常不加入未完整记录，保留之前完整矩形。

新C入口18498次数值oracle与所有权/offset/detach/中断回归通过，三组各3200帧（含热身）和1400页/主题/字段切换帧共11000帧真实QuickJS+字体+projection逐像素、rows、bits对照通过。最终生产20项JS接线、Canvas+math+logical O3UBSan、宿主FFI与两example TypeScript均通过。证据tmp/fps-native17-{canvas,js,runtime}-tests.log、tmp/canvas-logical-batch/REPORT.md。仍以真机收益决定采用。

native17镜像SHA256 `a2d45d9fc2c57c5b94b6df4f79dbb20024726a927c324481be2965f0388bfad6`，源码绑定tmp/fps-native17-source-state.json。烧录、独立校验与软件启动成功，tmp/fps-native-flash-20261003-17/state.json phase=booted；内部堆余量恢复19904B。额外真实QuickJS追踪四场各1000帧，800热稳帧中动态场景始终恰好融合主体→逻辑矩形两次原生调用，与原调用次数逐帧一致，无新增flush，证据tmp/canvas-logical-batch/*-flush-trace.json。

### native17真机结果：无明确收益，不采用

五场均关闭分项插桩，每场测量超过30秒。

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|27.461|27.461|0|
|fullscreen|26.731|26.731|0|
|speaking-imu|28.910|26.288|0|
|idle|28.375|8.178|0|
|kitty-classic|29.131|3.196|0|

证据为`tmp/example07-fps-native17-unprofiled/results.json`。全屏说话、全屏待机、普通说话的有效提交率均未超过已保留的native15+JS各120秒基线27.641、27.519、26.808FPS。测量时长与动画采样不同，不能把各项差值当作严格配对的退化幅度；本轮没有足够收益支持新增API和20KiB队列成本，因此撤回该实现。主机侧全屏5.5%～6.2%的耗时下降未在真机整体帧率上兑现，目标仍未完成。

补齐`fillLogicalRects`计时包装后，20秒诊断确认两种全屏场景每帧仍是两次矩形原生调用：全屏说话487帧/974次，全屏待机477帧/954次。

|诊断场景|绘制ms/帧|矩形原生合计ms/帧|flush ms/帧|
|---|---:|---:|---:|
|fullscreen-speaking|28.049|12.682|9.634|
|fullscreen|31.210|15.935|7.442|

证据为`tmp/example07-fps-native17-profile/results.json`。矩形列按两次调用合计；插桩有额外开销，不与无插桩帧率混用。

### 排除固定33毫秒追加等待

`firmware-nuttx/src/prelude.js#onFrame:312`使用绝对`deadline`；绘制和同步flush后，只等待`max(0, deadline - performance.now())`（第324行）。`runtime.c#js_timer:320`允许setTimeout零延时，只有setInterval具有1ms下限；`runtime.c#event_loop:963`按最近定时器计算等待，执行过回调后第986行设置`next = now`，不会再睡固定33ms。第993行的50ms是空闲等待上限。

临时将目标设为60FPS、关闭分项插桩后，三场各20秒的实际结果为：

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|27.062|27.062|0|
|fullscreen|26.462|26.462|0|
|speaking-imu|29.923|27.094|0|

证据为`tmp/example07-fps-native17-capacity60/results.json`。提高目标未使全屏达到30FPS；普通说话回调有所增加，但有效提交仍受重复量化画面影响。这是容量诊断，不把应用目标改成60FPS，也不证明调度、并发任务和驱动没有任何开销。

### native17源码回退核对

已应用`tmp/native17-rollback/rollback-native17.patch`，只恢复7个受影响文件并移除4个native17专用测试/fixture。C恢复到`b8156d1c`、Prelude到`90cdf5d9`、layout到`e62ef5d4`、SDK类型到`1535e349`，均与冻结基线完整SHA256一致。旧layout的同名CPU辅助函数以及`test_canvas_logical.c`原有整数布局压力测试继续保留。

两个生产render的keys/arrays优化、framebuffer、dirtybits/rows测试等8个保留文件哈希均未变化；11个回退路径逐项核对通过，证据`tmp/native17-rollback/verified.json`。回退后benchmark38/38测试通过，example06和example07 TypeScript检查退出0。此处确认源码恢复，回退镜像的重新构建、烧录与真机运行另记，不能仅凭源码核对声称设备已恢复。


## native18：Canvas 单独使用 O2

保持 native15 + JS keys/arrays 源码，只把 Canvas 的目标编译参数从 `-O3` 换成 `-O2`，其它文件不变。当前基线目标代码38730→34565B（-10.75%），保留8像素比较与连续写循环，但增加 span 函数调用；代码更小不代表运行更快。完整数值/像素回归通过，见 `tmp/fps-native18-o2-canvas-tests.log`。

|场景|绘制FPS|有效提交FPS|显示错误|
|---|---:|---:|---:|
|fullscreen-speaking|28.008|28.008|0|
|fullscreen|27.304|27.304|0|
|speaking-imu|28.928|26.301|0|

各30秒，profile=false。证据 `tmp/example07-fps-native18-o2/results.json`；与 O3 稳定基线相比没有一致提升，暂不采用。镜像 SHA256 `9f841794b60b783d0a038fedbcd4dc2f24820856ef4f26f7b42ef6dec28171d9`，构建源码绑定 `tmp/fps-native18-o2-source-state.json`；烧录、独立校验、软件启动完成，见 `tmp/fps-native-flash-20261003-18-o2/state.json`。内部堆余量19904B。

下一项仅尝试一次 `-O3 -fno-inline-functions` 对照，避免把继续缩码当作优化成果。目标编译审阅见 `tmp/canvas-optlevel-native15-audit/README.md`。

## native19 与 JS 小优化：30 秒对照和 120 秒稳定基线

native19 的 Canvas 使用 `-O3 -fno-inline-functions`。镜像 SHA256 为 `90310d51b32220fef1c08f86b2f7af45b37e395d438aaa559eda3f60c4eba4eb`，源码绑定 `tmp/fps-native19-noinline-source-state.json`；烧录、独立校验及软件启动见 `tmp/fps-native-flash-20261003-19-noinline/state.json`（`phase=booted`）。这组编译参数本身的收益仍以实测为准。

在同一 native19 固件上，JS 仅省去无扫描条帧的数学运算、波形状态临时数组、内部 Pose 的对象展开以及已预热形态的临时数组。保留 `clock`、`state`、`shape`、`weights` 的原读取顺序和异常行为，不改外部 Pose 的复制语义。

三场各 30 秒、`profile=false` 的前后对照：

|场景|基线绘制 FPS|JS 优化绘制 FPS|基线有效提交 FPS|JS 优化有效提交 FPS|两组显示错误|
|---|---:|---:|---:|---:|---:|
|fullscreen-speaking|28.075|28.734|28.075|28.734|0|
|fullscreen|27.662|28.774|27.662|28.774|0|
|speaking-imu|29.186|29.463|26.360|26.573|0|

来源分别为 `tmp/example07-fps-native19-noinline/results.json` 和 `tmp/example07-fps-native19-js-lowcost/results.json`，实际测量时长为 30069–30166ms。优化已合入生产，随后三场各 120 秒测量完成：

|场景|测量时长 ms|绘制 FPS|有效提交 FPS|显示错误|
|---|---:|---:|---:|---:|
|fullscreen-speaking|120114|28.556|28.556|0|
|fullscreen|120109|28.749|28.749|0|
|speaking-imu|120103|29.458|27.043|0|

来源 `tmp/example07-fps-native19-js-lowcost-120s/results.json`。结束后的健康快照 `tmp/fps-native19-js-lowcost-120s-health.json` 记录累计 framebuffer frames=16896、updates=15645、errors=0、heapFree=5496928B；该堆统计不等同内部堆余量。这里确认的是本轮运行和显示提交稳定，不宣称全部 ESP-IDF 功能或约 30 FPS 目标已验收。普通说话中的重复量化画面不计为有效提交。

JS 身份：正式 ESM benchmark 包 `tmp/js-drawcat-lowcost/main.js`，83211B，SHA256 `c50acbc407dc32f29ec1f743388c69c300f7a1a0c5a48cb8e2908b9bd9cf169e`。生产 `examples/06-obeing-pixel/src/render.ts` 为 `faf54260c2591cbfdd3d57a2aa9a5f7137f0afa4576b6f123cc6a5cc9e822d27`；`model.ts` 为 `ada2aff1977c64c8432b98625158f3b32288192955ffcdfc40b86d097cade27b`，均与测量候选一致。

新增持久回归 `node examples/scripts/test-lowcost-fields.mjs` 已通过：12000 个 Pose、3000 次形态预热、3 组预热 getter 模式、18 组绘制 getter 情况。测试将生产代码与独立冻结的旧函数比较，校验字段顺序、可选 weights、对象隔离、普通/变化/抛错 getter 的读取轨迹及绘制命令；参考文件为 `examples/scripts/fixtures/{model,render}-lowcost-reference.ts`，不在运行时由候选生成。两个生产示例的 TypeScript 检查均退出 0。此前真实 QuickJS 与冻结 C 的 14200 帧逐像素、rows/bits 对照见 `tmp/js-drawcat-lowcost/REPORT.md`；宿主耗时不代替上述真机测量。

后续 QIO 配置仍在准备；本节不包含其构建、烧录或性能验证。


## native20：补齐 SimpleBoot 四线 Flash 启动

当前 NuttX HAL 的 sdkconfig 固定启用 DIO，并且 SimpleBoot 未编译官方 QE/wrap 支持；单独改镜像头不足以可靠切换 QIO。本版保持 native19 编译参数和已验证的 JS 优化，只修复上述启动接线。ROM 仍以 DIO 加载内部 RAM，官方启动代码按 JEDEC ID 读改写并验证 QE 后启用 QIO；失败保留原读取模式。启动后只读 SPI0_CTRL 寄存器并记录实际 mode。CPU、PSRAM 和屏幕 QSPI 时钟不变。

`simpleboot_qio_patch.py` 只修改工程隔离快照，五文件全部检查通过后写入，重复运行幂等。新增 QE/wrap 源文件仅在 SimpleBoot QIO 组合编译，其代码/literal 放 IRAM，匹配表及字符串放 DRAM，避免在映射 Flash 前调用外部代码；QE日志使用EARLY路径。4项回归含真实cc/make八组合模式矩阵、漂移拒绝；原构建入口70项测试通过。

原理图与esptool探测确认本板 Flash 为 XM25QH128DHIQT / `0x204018`。XMC官方v1.2手册第16/22/29/70页确认QE为SR2 bit1（S9），读/写命令35h/31h；本机烧录前只读状态为`0x0200`（`tmp/fps-native20-preflash-status.log`）。没有修改eFuse。

镜像SHA256 `876ffe4754826dbb6b335e5f845fb8d78bfcfc3ac49ca62811fec14c195b4064`，ROM头mode=2(DIO)。最终ELF审计见 `tmp/qio-simpleboot-audit/native20-final-audit.json`，内部堆余量18672B；构建源码绑定 `tmp/fps-native20-qio-source-state.json`。完整重编保留旧源码快照，归档旧版镜像/ELF/配置/堆证据并重新验证，见 `tmp/fps-native20-qio-reconfigure/` 与 `tmp/fps-native20-rollback-validation.json`。

烧录、独立校验和软件启动已完成：`tmp/fps-native-flash-20261003-20-qio/state.json` 为 `phase=booted`，`verify.log` 为 `verify OK (digest matched)`。`boot.log:19` 确认 `flash read mode=QIO ctrl=0x012c2008`；CO5300屏幕总线仍为40MHz。没有人工按键复位。启动原理及维护方法见 [Flash QIO说明](../../firmware-nuttx/docs/flash-qio.md)。

### native20五场30秒实测

|场景|测量时长 ms|绘制 FPS|有效提交 FPS|显示错误|
|---|---:|---:|---:|---:|
|fullscreen-speaking|30080|29.820|29.820|0|
|fullscreen|30069|29.665|29.665|0|
|speaking-imu|30084|29.983|27.589|0|
|idle|30107|29.893|8.005|0|
|kitty-classic|30033|30.000|2.764|0|

证据：`tmp/example07-fps-native20-qio/{initial,results}.json`。`profile=false`，实际benchmark SHA256仍为`c50acbc407dc32f29ec1f743388c69c300f7a1a0c5a48cb8e2908b9bd9cf169e`，与native19 JS优化对照一致。普通说话、待机和Kitty存在RGB565不变的绘制回调，跳过重复画面后有效提交低于回调次数；不强制重传相同画面来增加计数。

### native20三场120秒验收

|场景|测量时长 ms|成功绘制帧|有效提交帧|平均绘制 FPS|平均有效提交 FPS|显示错误|
|---|---:|---:|---:|---:|---:|---:|
|fullscreen-speaking|120062|3596|3596|29.951|29.951|0|
|fullscreen|120072|3559|3559|29.641|29.641|0|
|speaking-imu|120093|3603|3328|30.002|27.712|0|

证据：`tmp/example07-fps-native20-qio-120s/{initial,results}.json`，测量进程退出0。与native19同一benchmark包、同为每场120秒及`profile=false`的有效提交结果28.556/28.749/27.043 FPS相比，native20为29.951/29.641/27.712 FPS。动画时间和采样不同，这不是逐帧相同输入的配对实验；不能把普通场景的提交率差异全部归因于执行速度。

测量后`tmp/fps-native20-qio-120s-health.json`记录累计framebuffer frames=22967、errors=0、heapFree=5383344B、jsHeapUsed=2294703B；该内存统计不等同内部堆尾区。NSH仍正常响应，`tmp/fps-native20-qio-device-ps.log`中应用栈峰值13008/32696B（39.7%）。本轮证明这些测量窗口内运行和显示提交正常，不外推无限期稳定性。

`tmp/fps-native20-final-source-verification.json`重新核对16个关键文件/产物哈希全部匹配native20源码绑定，烧录记录中的镜像SHA与当前镜像一致，设备benchmark SHA与测量候选一致。只读统计审阅见`tmp/native20-fps-evidence-review.md`：有效帧计数在一帧全部`FBIO_UPDATE`成功后增加，不能用分段传输次数代替FPS。已有像素一致性、边界、失败重试及USB背压回归继续保留；QIO补丁4项和构建入口70项测试均通过。

### 恢复正式example07

测量结束后重新编译`examples/07-obeing-harness/src/main.ts`并热推正式应用，证据为`tmp/example07-native20-final-restore/result.json`，脚本退出0、`status=running`。实际应用ID为`com.obeing.harness.assistant`，正式包SHA256为`a5ee8e34d257fe4551359eef5676bd321717313e4e43d919108ac2e023b6e119`，与设备`/app/main.js`一致；`typeof __fps`为`undefined`，说明未遗留测试入口。等待15秒并读取快照后，设备单调时钟前进15880ms，累计446次flush、2次有效提交、显示错误0。正式应用此时的静态页面提交次数不作为动态场景帧率。

正式应用仍通过`main.ts`的`px.screen.setFps(30)`请求30FPS。这次恢复确认应用身份、事件循环和显示提交；未进行云登录、真实语音与IMU并发压力或面板目视验收。
