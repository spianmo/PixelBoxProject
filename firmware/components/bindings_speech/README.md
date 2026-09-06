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
`build/srmodels/srmodels.bin`；模型约 2.6 MiB。`partitions_speech.csv`
包含两个 5 MiB 应用槽、独立存储区和 3 MiB 模型分区，与旧非语音固件布局不同。
从旧布局升级需要完整分区迁移，不能向旧布局发送单应用 OTA，也不能只更新应用镜像。
`idf.py merge-bin` 和 IDE 打包会包含模型。`sdkconfig.speech` 仍可用于独立构建目录。
真机诊断和测量见 [语音与网络排查记录](../../../docs/speech-network-performance.md)。

## 唤醒词与识别

语音 worker 的 16 KiB 栈使用 PSRAM，TCB 保持内部 RAM，退出时通过
`vTaskDeleteWithCaps` 释放。模型分区由内部栈的 JS 线程在首次唤醒前映射，
该只读映射保持到设备重启，跨轮次和 JS 热更新复用。模型与命令表在语音轮次间缓存，
空闲 60 秒或语音 worker 退出后释放，减少重复唤醒初始化。
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

短语固定为 **你好小川**，通过 ESP-SR MultiNet7 中文模型注册拼音命令
`ni hao xiao chuan` 检测。它是离线命令识别方案，不是针对该短语训练的专用 WakeNet
模型。真实距离、噪声条件下的漏唤醒和误唤醒率需要在设备上测量。

`wakeword.start()` 成功后持续监听，命中一次便停止采音并触发 `onWake`。
调用方完成当前录音、对话和播报后需要再次启动。默认阈值为 `0.8`，可配置范围为
`0.5` 至 `0.99`。模型启动要求至少 4 MiB 空闲 PSRAM 总量；MultiNet7 工作区分多次分配，
不要求一个连续 4 MiB 块。最大连续块仍记录用于诊断，实际模型分配失败会单独报错。
模型缺失、内存不足和麦克风无数据会显式报错。

首次启动校验模型目录的计数、字符串和数据边界，并核验四个 MultiNet7 文件的 SHA-256。
只读模型分区每次开机校验一次，后续重用校验结果；升级模型后需重启设备。
校验值由构建时的 ESP-SR 依赖生成；模型内容损坏或与固件不匹配时拒绝加载。
映射失败会返回错误，避免进入供应库的 `ESP_ERROR_CHECK` 重启路径。
4 MiB PSRAM 检查是一道资源门，不代表已验证整机峰值；供应库部分内部申请没有完整的失败恢复，
仍须在真实设备的显示、Wi-Fi 和 JS VM 同时运行时测量余量。

`recognize()` 默认最多录音 15 秒，连续语音成立后静音 800 毫秒结束；上传格式为
16 kHz 单声道 PCM16LE WAV。它返回 Azure 最终 `DisplayText`，不提供中间转写。
`onLevel` 仅为本地音量，范围 0 至 100。录音前的唤醒监听必须暂停，避免麦克风重复占用。
录音回调直接写入预分配的 PSRAM WAV 数据区，通过原子发布已写入的 PCM 前缀供 VAD 消费，
不经过只能缓冲约半秒音频的中间队列。达到最长录音时只停止追加，不把正常录满视为积压。
音量通知最多保留一个待处理回调，队列满时不阻塞采音或 VAD；下次重试发送最新音量。
实时唤醒检测及 VAD 的 worker 优先级临时高于 JS 渲染，并在等待数据时让出 CPU；
模型初始化和语音网络阶段同样临时提高优先级，避免被持续渲染饿死。正常取消不记录为故障。
VAD 采用较低的起始阈值和结束迟滞，以支持桌面距离的 ES7210 拾音；连续语音至少 180 毫秒，
避免瞬间脉冲触发。上传去除开口前多余静音，保留 200 毫秒前导音频。

`speak()` 接收 1 至 6000 UTF-8 字节文本，将 Azure 原始 PCM 流送至扬声器，
最多接收 4 MiB，并在实际播放完成后兑现 Promise。长回答需要在示例层按完整字符分段。
播报过程中暂停唤醒，防止设备的声音触发新一轮。

## 配置与调用

语音区域和订阅密钥在 `examples/07-obeing-harness` 的语音配置中输入。
企业 ID、账号、密码用于企业登录，和 Azure 语音订阅密钥是不同凭据。

```ts
px.speech.configure({ region, key, language: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' });
await px.speech.wakeword.start({
    phrase: '你好小川',
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

网络仅访问区域对应的 `*.stt.speech.microsoft.com` 和
`*.tts.speech.microsoft.com` HTTPS 地址，使用 ESP-IDF 证书包验证服务端，禁止自动重定向。
订阅密钥只存于 RAM，不写入 NVS；配置替换和 native 对象销毁时覆盖其字符串内容。
TLS 请求不输出密钥或服务响应正文。

`cancel()` 立即停止采音与播放并拒绝当前 Promise；已阻塞的 TLS 读取由 worker
在下一数据块或 socket 超时后清理；连接最长 15 秒，识别响应等待受剩余 timeoutMs 限制。
绑定层使用递增代数屏蔽已入队的旧唤醒、
错误和音量回调，以及旧 Promise 的成功结果。每次开始新任务会取消此前任务。

## 验证

```sh
c++ -std=c++17 -pthread -Wall -Wextra -Werror \
  -I firmware/components/bindings_speech/src \
  firmware/components/bindings_speech/tests/speech_core_test.cpp \
  -o /private/tmp/obeing-speech-core-test
/private/tmp/obeing-speech-core-test firmware/build/srmodels/srmodels.bin
node firmware/components/bindings_speech/tests/check-prelude.mjs
node firmware/components/bindings_speech/tests/check-model-hashes.mjs
```

上述测试覆盖区域与 SSML 校验、WAV 格式、静音截断、瞬时噪声过滤，以及取消后的过期回调。
独立语音配置和默认配置已通过 ESP-IDF 构建。物理麦克风、扬声器、真实 Azure 账号、
TLS 设备时钟、模型运行时内存及唤醒准确率尚未在真机验证。
