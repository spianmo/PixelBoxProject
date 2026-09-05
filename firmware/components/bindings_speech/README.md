# PixelBox 独立语音

`px.speech` 为 `examples/07-obeing-harness` 提供本机麦克风、离线短语检测及
Azure Speech STT/TTS。企业账号登录和 AI 对话由示例调用现有服务；语音不经手机转发。

## 固件配置

需要 ESP32-S3、16 MiB flash、8 MiB PSRAM，以及工作于 16 kHz 的麦克风和扬声器。
默认固件只注册返回 `ENOTSUP` 的接口；启用版本使用独立构建目录和配置：

```sh
cd firmware
idf.py -B build_speech \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.speech' \
  -D SDKCONFIG=build_speech/sdkconfig build
```

先在当前终端加载 ESP-IDF 5.5 环境。构建生成 `build_speech/pixelbox.bin` 和
`build_speech/srmodels/srmodels.bin`；模型约 2.6 MiB。`partitions_speech.csv`
包含两个 5 MiB 应用槽、独立存储区和 3 MiB 模型分区，与默认固件布局不同。
首次安装需要经过确认的完整分区迁移，不能向默认布局发送单应用 OTA，也不能只更新应用镜像。
本组件的实现与验证没有执行任何烧录。

## 唤醒词与识别

短语固定为 **你好小川**，通过 ESP-SR MultiNet7 中文模型注册拼音命令
`ni hao xiao chuan` 检测。它是离线命令识别方案，不是针对该短语训练的专用 WakeNet
模型。真实距离、噪声条件下的漏唤醒和误唤醒率需要在设备上测量。

`wakeword.start()` 成功后持续监听，命中一次便停止采音并触发 `onWake`。
调用方完成当前录音、对话和播报后需要再次启动。默认阈值为 `0.8`，可配置范围为
`0.5` 至 `0.99`。模型启动要求至少 4 MiB 连续空闲 PSRAM；模型缺失、内存不足和
麦克风无数据会显式报错。

启动前校验模型目录的计数、字符串和数据边界，并核验四个 MultiNet7 文件的 SHA-256。
校验值由构建时的 ESP-SR 依赖生成；模型内容损坏或与固件不匹配时拒绝加载。
映射失败会返回错误，避免进入供应库的 `ESP_ERROR_CHECK` 重启路径。
4 MiB PSRAM 检查是一道资源门，不代表已验证整机峰值；供应库部分内部申请没有完整的失败恢复，
仍须在真实设备的显示、Wi-Fi 和 JS VM 同时运行时测量余量。

`recognize()` 默认最多录音 15 秒，连续语音成立后静音 800 毫秒结束；上传格式为
16 kHz 单声道 PCM16LE WAV。它返回 Azure 最终 `DisplayText`，不提供中间转写。
`onLevel` 仅为本地音量，范围 0 至 100。录音前的唤醒监听必须暂停，避免麦克风重复占用。

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
在下一数据块或最多 5 秒 socket 超时后清理。绑定层使用递增代数屏蔽已入队的旧唤醒、
错误和音量回调，以及旧 Promise 的成功结果。每次开始新任务会取消此前任务。

## 验证

```sh
c++ -std=c++17 -Wall -Wextra -Werror \
  -I firmware/components/bindings_speech/src \
  firmware/components/bindings_speech/tests/speech_core_test.cpp \
  -o /private/tmp/obeing-speech-core-test
/private/tmp/obeing-speech-core-test firmware/build_speech/srmodels/srmodels.bin
node firmware/components/bindings_speech/tests/check-prelude.mjs
node firmware/components/bindings_speech/tests/check-model-hashes.mjs
```

上述测试覆盖区域与 SSML 校验、WAV 格式、静音截断、瞬时噪声过滤，以及取消后的过期回调。
独立语音配置和默认配置已通过 ESP-IDF 构建。物理麦克风、扬声器、真实 Azure 账号、
TLS 设备时钟、模型运行时内存及唤醒准确率尚未在真机验证。
