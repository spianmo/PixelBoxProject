# PixelBox 独立语音

`px.speech` 为 `examples/07-obeing-harness` 提供本机麦克风、离线短语检测及
Azure Speech STT/TTS。企业账号登录和 AI 对话由示例调用现有服务；语音不经手机转发。

## 固件配置

需要 ESP32-S3、16 MiB flash、8 MiB PSRAM，以及工作于 16 kHz 的麦克风和扬声器。
S3 默认构建启用独立语音，直接运行：

```sh
cd firmware
idf.py build
```

先在当前终端加载 ESP-IDF 5.5 环境。构建生成 `build/pixelbox.bin` 和
`build/srmodels/srmodels.bin`；模型约 2.56 MiB。`partitions_speech.csv`
包含两个 5 MiB 应用槽、独立存储区和 3 MiB 模型分区，与旧非语音固件布局不同。
从旧布局升级需要完整分区迁移，不能向旧布局发送单应用 OTA，也不能只更新应用镜像。
`idf.py merge-bin` 和 IDE 打包会包含模型。`sdkconfig.speech` 仍可用于独立构建目录。
真机诊断和测量见 [语音与网络排查记录](../../../docs/speech-network-performance.md)。

## 唤醒词与识别

语音 worker 的 16 KiB 栈使用 PSRAM，TCB 保持内部 RAM，退出时通过
`vTaskDeleteWithCaps` 释放。模型分区由内部栈的 JS 线程在首次唤醒前映射，
该只读映射保持到设备重启，跨轮次和 JS 热更新复用。模型与命令表在语音 worker 生命周期内缓存，
只在 worker 退出时释放，设置页停留和长回答不会触发 60 秒淘汰后重新初始化。
worker 仅读取已映射的模型并进行网络与音频操作，不能执行 Flash 写入或 mmap/munmap，
这些操作可能冻结缓存，PSRAM 栈会触发断言。初始化失败分别报告音频硬件未就绪和线程内存不足；
配置阶段不会请求 Azure，也不会把线程创建失败当成 Azure 认证失败。

唤醒采音 StreamBuffer 的 16 KiB 数据区显式放在 PSRAM，使用静态创建接口；FreeRTOS 的动态
StreamBuffer 即使启用 `SPIRAM_USE_MALLOC` 也会占用内部 RAM。MultiNet7 的 `destroy()`
同时释放命令表，调用方不再提前调用 `esp_mn_commands_free()`。

S3 默认及独立 speech 配置使用 `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=256` 和
`CONFIG_MDNS_MEMORY_ALLOC_SPIRAM=y`，为 Wi-Fi、DMA 与 FreeRTOS 保留内部 RAM。
已有构建的 `sdkconfig` 不会自动采用修改后的 defaults，需同步这两项并重新构建、烧录固件；
只更新 example07 的 JS 无法改变原生内存分配方式。
`px.speech` 在模型创建、命令注册、采音就绪及释放时分别记录内部 RAM / PSRAM 的空闲总量和
最大连续块，失败时记录具体原因。mDNS 日志里的总 free heap 包含 PSRAM，不能据此判断内部 RAM 是否充足。

唤醒词由业务应用通过 `wakeword.start({ phrase, pinyin, threshold, onWake })` 注册，
固件不内置业务唤醒词或默认阈值。`phrase` 是显示名（1 至 96 UTF-8 字节，不能包含控制字符及首尾空格），
实际识别使用 `pinyin`（2 至 63 字节的小写无声调拼音，音节间用单个空格分隔）。
应用需明确提供发音，固件不做汉字转拼音；模型不支持的拼音会使注册失败。
底层通过 ESP-SR MultiNet7 的 `mn7_cn` 中文模型检测拼音命令，这是离线命令识别方案，
不是定制 WakeNet 模型。真实距离、噪声条件下的漏唤醒和误唤醒率需要在设备上测量。

`wakeword.start()` 成功后持续监听，命中一次便停止采音并触发 `onWake`。
调用方每次收到 `onWake` 后需要再次传入完整配置启动；可与录音、识别请求及播报并行。
`threshold` 必须显式提供，采用模型支持的 `0` 至 `0.9999` 范围；缺失、非数值、非有限值或越界直接报错，
不会自动截断。重复调用会替换旧监听和阈值，拼音发生变化时重建命令表；相同拼音复用注册结果，
每轮都重新应用阈值并清空推理上下文。注册失败不会开始采音，下次调用会重新尝试注册。
同步参数校验失败保留原监听；提交后的模型注册失败会结束本次监听，通过 Promise 报错。
模型启动保留至少 4 MiB 空闲 PSRAM 总量的资源门；MultiNet7 工作区分多次分配，
不要求一个连续 4 MiB 块。最大连续块仍记录用于诊断，实际模型分配失败会单独报错。
模型缺失、内存不足和麦克风无数据会显式报错。

首次启动校验模型目录的计数、字符串和数据边界，并核验 `mn7_index`、`mn7_data`、
`_MODEL_INFO_` 和 `vocab` 四个文件的 SHA-256；缺少分词词表也会拒绝加载。
只读模型分区每次开机校验一次，后续重用校验结果；升级模型后需重启设备。
校验值由构建时的 ESP-SR 依赖生成；模型内容损坏或与固件不匹配时拒绝加载。
映射失败会返回错误，避免进入供应库的 `ESP_ERROR_CHECK` 重启路径。
4 MiB PSRAM 检查是一道资源门，不代表已验证整机峰值；供应库部分内部申请没有完整的失败恢复，
仍须在真实设备的显示、Wi-Fi 和 JS VM 同时运行时测量余量。

从 MultiNet5 版本升级时，必须同时更新应用镜像和 `model` 分区的 `srmodels.bin`。
分区布局不变，现有账号、应用数据不需要清除；只更新 JS 或单独 OTA 应用镜像无法迁移模型。
defaults 不会覆盖已有 `sdkconfig`。推荐使用独立目录采用新的 S3 默认配置：

```sh
idf.py -B build_mn7 -D SDKCONFIG=build_mn7/sdkconfig build
```

已有自定义板型的构建需在自己的 `sdkconfig` 中将 `CONFIG_SR_MN_CN_MULTINET5_RECOGNITION_QUANT8=y`
改为 `# CONFIG_SR_MN_CN_MULTINET5_RECOGNITION_QUANT8 is not set`，并设置
`CONFIG_SR_MN_CN_MULTINET7_QUANT=y`。构建会拒绝残留的 MultiNet5 配置，
运行时会拒绝旧模型内容，避免把不匹配的权重交给供应库。

使用项目已有 ESP-SR 2.4.7 的 S3 量化内核，不额外叠加 ESP-NN：ESP-NN 是算子库，
当前 MultiNet 通过预编译 `libmultinet.a` / `libdl_lib.a` 执行，新增依赖不能替换内部算子。
该版本 MN7 未实现 `switch_loader_mode`，使用模型默认加载方式，不调用空接口。
选型参考 [esp-sr-multinet](https://github.com/36dian5hao/esp-sr-multinet) 的拼音命令方案。

采音端仍使用单生产者队列；推理线程发现待处理音频超过 160 ms 时丢弃旧前缀，
出现溢出缺口时清空当时积压并重置模型。连续静音后在下一次发声前刷新模型，并回放约
200 ms 完整帧前导音频（512 samples 帧下为 224 ms），保留低于能量门限的轻声词首。
回放与实时帧使用相同候选判定，回放命中后立即停止后续推理，避免忽略或覆盖检测结果。
该边界限制排队音频量，不是整句唤醒延迟保证。
候选日志额外记录 `replay`、`window`、`reset`、`rms`、`peak` 和 `clipped`：分别表示是否来自回放、
自上次模型重置后送入的音频时长、重置原因、该窗口 RMS、PCM16 峰值及触及幅度上下限的采样数。
这些指标用于对照高低置信分数时的输入；窗口包含静音，RMS 必须结合窗口长度比较。
`probability` 是模型候选分数，不能当作独立于音频窗口的文本相似度；降低门限不等于提高模型稳定性。
每 5 秒记录平均/最大推理耗时、模型帧长、积压、丢弃量和重置次数；持续丢帧表示推理
仍未达到实时速度，需要结合真机日志继续排查，不能靠降低阈值掩盖。

`recognize()` 默认最多录音 15 秒，连续语音成立后静音 800 毫秒结束；上传格式为
16 kHz 单声道 PCM16LE，通过 Azure WSS 边录边发，首包带流式 WAV 头，约 100 ms 一包。
`onPartial` 更新累计中间转写，Promise 在 `turn.end` 后返回最终 `DisplayText`。
`onLevel` 为本地音量，范围 0 至 100。底层麦克风支持多订阅；示例在采集正文、
识别上传和等待、云端思考以及播报阶段均保持唤醒监听。
`recognize()` 提交时即订阅麦克风，旧 TLS 尚未退出时也先录入本轮独立缓冲。
取消会停掉对应轮次的订阅，旧 worker 收尾不影响新录音；连续取消会清掉过期排队任务。
VAD 处理与后续网络请求仍等待旧请求到达 I/O 边界或超时。建连最多 `min(timeoutMs,15000)` ms，
输入结束后等待最多 `timeoutMs`；总截止为采音截止与建连截止中较晚者再加 `timeoutMs`。
录音回调直接写入预分配的 PSRAM WAV 数据区，通过原子发布已写入的 PCM 前缀供 VAD 消费，
不经过只能缓冲约半秒音频的中间队列。达到最长录音时只停止追加，不把正常录满视为积压。
音量通知最多保留一个待处理回调，队列满时不阻塞采音或 VAD；下次重试发送最新音量。
实时唤醒检测及 VAD 的 worker 优先级临时高于 JS 渲染，并在等待数据时让出 CPU；
模型初始化和语音网络阶段同样临时提高优先级，避免被持续渲染饿死。正常取消不记录为故障。
VAD 采用较低的起始阈值和结束迟滞，以支持桌面距离的 ES7210 拾音；连续语音至少 180 毫秒，
避免瞬间脉冲触发。流式发送保留建连期间的完整已采音频；到达采音时限仍处理并发送积压，
不会因停止录音而丢掉缓冲中的开头。ASR 不再以本地 VAD 是否命中作为上传前置条件。

`speak()` 接收 1 至 6000 UTF-8 字节文本，将 Azure 原始 PCM 流送至扬声器，
最多接收 4 MiB，并在实际播放完成后兑现 Promise。长回答需要在示例层按完整字符分段。
播报和唤醒检测由两个独立 worker 并行运行。命中后调用 `speech.cancel()` 会立即停止当前
播放并取消旧操作；设备没有接入 AEC，回答本身包含当前唤醒词时需要防范扬声器回灌自触发。

## 配置与调用

语音区域和订阅密钥在 `examples/07-obeing-harness` 的语音配置中输入。
企业 ID、账号、密码用于企业登录，和 Azure 语音订阅密钥是不同凭据。

```ts
px.speech.configure({ region, key, language: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' });
await px.speech.wakeword.start({
    phrase: '你好小川',
    pinyin: 'ni hao xiao chuan',
    threshold: 0.30,
    onWake: () => startTurn(),
    onError: (message) => showError(message),
});

async function startTurn(): Promise<void> {
    px.speech.wakeword.stop();
    const text = await px.speech.recognize({ maxMs: 15000, silenceMs: 800 });
    // 将真实转写交给企业 AI 服务，然后调用 speak 播报其回答。
    showTranscript(text);
}
```

`examples/07-obeing-harness/src/wakeword-config.ts` 集中保存示例应用的词、拼音和阈值。
首次使用此接口需要安装支持动态注册的固件；此后改词或调阈值只需重新下发业务 JS，
也可以在运行时再次调用 `wakeword.start()` 传入新配置，无需重新编译固件。

网络仅访问区域对应的 `*.stt.speech.microsoft.com` 和
`*.tts.speech.microsoft.com` HTTPS 地址，使用 ESP-IDF 证书包验证服务端，禁止自动重定向。
订阅密钥只存于 RAM，不写入 NVS；配置替换和 native 对象销毁时覆盖其字符串内容。
TLS 请求不输出密钥或服务响应正文。

`cancel()` 立即停止采音与播放并拒绝当前 Promise；已阻塞的 TLS 读取由 worker
在下一数据块或 socket 超时后清理；连接最长 15 秒，识别响应等待受剩余 timeoutMs 限制。
绑定层使用递增代数屏蔽已入队的旧唤醒、
错误和音量回调，以及旧 Promise 的成功结果。唤醒与识别/播报有独立代数及 worker，
新任务只替换同通道旧任务；`wakeword.stop()` 仅停止唤醒，`cancel()` 则同时取消两条通道。

## 验证

```sh
c++ -std=c++17 -pthread -Wall -Wextra -Werror \
  -I firmware/components/bindings_speech/src \
  firmware/components/bindings_speech/tests/speech_core_test.cpp \
    -o /private/tmp/obeing-speech-core-test
/private/tmp/obeing-speech-core-test firmware/build/srmodels/srmodels.bin
node firmware/components/bindings_speech/tests/check-prelude.mjs
node firmware/components/bindings_speech/tests/check-wake-registration.mjs
node firmware/components/bindings_speech/tests/check-model-hashes.mjs firmware/build
```

上述测试覆盖区域与 SSML 校验、WAV 格式、静音截断、瞬时噪声过滤、唤醒前导音频环绕与清空，
以及参数边界、缓存模型换词、单独修改阈值、注册失败恢复、并行唤醒和取消后的过期回调。
本次 MN7 切换及动态唤醒词注册的真机识别效果尚未验证；桌面注册测试中的模型接口为替身。
此前语音版本在 PixelBox S3 的物理麦克风、扬声器和真实 Azure 账号上，
已通过实际 Azure WSS 握手、两轮识别与 TTS 播放、并行唤醒及 AI 连接复用检查；
完整数据与网络限制见 [语音与网络诊断](../../../docs/speech-network-performance.md)。
这组固定句测试不代表长时间稳定性或不同噪声/距离下的识别准确率。
