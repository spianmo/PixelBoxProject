# 03 语音助手

完整的语音对话示例:按键/触摸唤起收音,屏幕随状态切换动画,识别文本与 LLM 流式回复实时滚动显示,支持打断(barge-in)。

## 交互

| 操作 | 效果 |
|---|---|
| idle 时触摸屏幕 / BOOT 单击 | 开始一轮对话(听 → 想 → 说) |
| BOOT 长按 | 持续对话模式(说完自动再听) |
| BOOT 双击 | 停止 |
| **speaking 时触摸屏幕 / BOOT 单击** | **`px.voice.interrupt()` 打断播报** |

## 状态动画

- `listening` 聆听:绿色扩散波纹 + 底部麦克风音量律动条(来自 `level` 事件)
- `thinking` 思考:黄色八点旋转
- `speaking` 播报:像素脸,嘴型按双频正弦开合

## 运行前提

1. 启动中继服务器(见 `server/README.md`):`cd server && npm run dev`
2. 把服务器地址告诉设备,两种方式任选:
   - 改代码里的默认值 `ws://192.168.1.100:8787/realtime`;
   - 或提前写入 KV(如在模拟器控制台 / `pixelbox` REPL 执行):
     ```js
     px.storage.kv.set('voice.server', 'ws://<你的电脑IP>:8787/realtime')
     px.storage.kv.set('voice.token', '<VOICE_TOKEN,未启用可不设>')
     ```
3. 设备已配网,与服务器在同一局域网(模拟器直接连本机 `ws://127.0.0.1:8787/realtime`)。

## 演示的 API

`px.voice.configure/start/startContinuous/stop/interrupt`、事件 `stateChange / userText / assistantDelta / assistantText / level / error`,以及 `px.input.onButton` 的 click/doubleClick/longPress 三种手势。
