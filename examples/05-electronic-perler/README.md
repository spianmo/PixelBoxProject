# 05 电子拼豆

手机或电脑与 PixelBox 处在同一局域网时，可上传 JPG、PNG、WEBP 或 GIF，也可填写网络 MP3 地址让设备扬声器播放、暂停、继续或停止。设备可显示无间隙方块组成的像素拼豆图案，也可以显示网页当前方形裁剪后的原图或 GIF。有内容时屏幕只显示画面，无内容时才显示局域网访问地址。

## 数据流程

```text
像素图案: 浏览器裁剪 -> 8-64 密度采样 -> 拼豆色板量化
          -> 紧凑 JSON 网格 -> NVS 持久化 -> ESP 方块渲染

静态原图: 浏览器读取当前方形裁剪框 -> 按屏幕尺寸缩放 -> 可选边界连通去背景
          -> 透明 PNG -> 8 KiB 分块上传 -> LittleFS -> ESP 黑底绘制

GIF:      保留原文件、帧延时和网页裁剪框 -> 8 KiB 分块上传 -> LittleFS
          -> 每帧边界连通去背景 -> 方形裁剪 -> 60 FPS 播放

音乐:     Web 提交 HTTP(S) MP3 地址 -> ESP 流式下载和解码
          -> 播放句柄控制暂停 / 继续 / 停止 -> Web 轮询播放状态
```

智能去背景使用四连通泛洪：只删除与图像边界连通且接近背景色的像素，封闭轮廓内的同色区域会保留。PNG 原有 Alpha 会保留；当前真机 PNG 解码使用 1-bit 透明掩码，`alpha < 128` 透明，其余按不透明绘制。GIF 开启去背景后会在解码的每帧上执行同样的边界泛洪，真机把外部区域写为黑色，模拟器把该区域写为透明；在本应用的黑底上视觉结果一致。

GIF 始终按原始顺序单向无限循环，并保留文件中的逐帧延时。解码器发现末帧与首帧完全相同时会自动删除重复末帧，避免循环边界把同一画面连续显示两次。设备帧循环运行在 60 FPS，短于 34 ms 的 GIF 帧延时不再因 30 FPS 屏幕节拍频繁跳帧。

## 运行

1. 在 PixelBox IDE 中打开本目录，选择模拟器或真机后运行。
2. 真机先连接 Wi-Fi；没有图案或媒体时，屏幕中央会显示 `http://<设备IP>:8080`。
3. 同一局域网的手机或电脑打开该地址，在“裁剪”页调整方形区域，选择“像素图案”或“裁剪原图 / GIF”后发送。
4. 在“设备音乐”中填写 ESP 可以访问的 `http://` 或 `https://` MP3 地址，使用网页按钮控制播放，或短按真机键2切换暂停/继续。

命令行热更新：

```bash
cd examples/05-electronic-perler
pixelbox dev
```

模拟器会在开发机监听 `8080` 端口，可直接打开 `http://127.0.0.1:8080`。端口被其他程序占用时，先释放该端口再运行示例。

## 存储与限制

- 媒体单文件上限为 2 MiB，上传块为 8 KiB。
- `/data/perler-0.bin` 和 `/data/perler-1.bin` 交替写入；只有文件完整且解码成功后才会切换，上传中断不会破坏当前画面。
- GIF 最多解码 256 帧，真机解码帧总内存以约 4 MiB 为保护界限；更长的动图只保留限制内的帧。
- MP3 地址最多 1024 个字符；音乐通过网络流式播放，不会下载到 LittleFS，也不会在设备重启后自动恢复。
- 局域网 HTTP 未提供公网鉴权，不要把设备的 `8080` 端口转发到互联网。

## 关键实现

| 文件 / 方法 | 真实行为 |
|---|---|
| `assets/app.js#exteriorBackgroundMask` | 从画布边界做四连通泛洪，不进入封闭内部 |
| `assets/app.js#createCroppedDeviceCanvas` | 把网页当前裁剪框生成匹配真机分辨率的方形透明 PNG |
| `src/pattern.ts#parseMediaPayload` | 校验媒体类型、宽高、存储槽和 2 MiB 上限 |
| `src/main.ts#appendMediaChunk` | 校验会话、偏移和分块大小后直接追加到 LittleFS |
| `src/main.ts#activateMedia` | 先解码新媒体，成功后再持久化并切换屏幕模式 |
| `src/main.ts#beginMusicPlayback` | 异步打开网络 MP3，以 generation 隔离较慢的旧播放请求 |
| `src/main.ts#pauseMusicPlayback` | 通过同一 `PxPlayHandle` 暂停并继续流式音乐 |
| `bindings_screen.cpp#remove_gif_exterior_background` | 在 GIF 每帧进入动画缓存前清黑外部连通背景 |
| `bindings_screen.cpp#gif_frames_equal` | 比较解码后的完整首尾帧并删除重复末帧 |
| `prelude_screen.js#PxAnimationImpl._tick` | 按 GIF 原帧延时单向循环推进 |
| `src/main.ts#drawPattern` | 黑色背景上以无间隙小方块居中渲染拼豆图案 |
