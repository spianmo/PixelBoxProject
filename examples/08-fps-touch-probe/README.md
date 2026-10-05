# 08 刷新率触摸测试

这个示例直接运行在真机上，绘制可拖动的28行列表，并显示两项独立指标：

- `callbackFps`：`px.screen.onFrame` 回调频率；
- `submittedFps`：原生 framebuffer 成功提交有效更新的频率。

通过 devd 可以读取：

```js
JSON.stringify(__refreshProbe.snapshot())
```

自动化真机测试使用：

```sh
node examples/scripts/measure-all-device.mjs --host 设备IP --output output/新的测试目录 --seconds 10
```

脚本以设备端16ms定时器连续调用 `down/move/up`，复用真实触摸的滚动处理函数。`swipe()` 是一次同步手势，不能用它测持续滚动FPS。列表用一屏加两行的有界离屏缓存，再通过原生 `drawImage` 裁剪拷贝；静止时只按秒更新指标。
快照还会返回 `changedPixels`、`transmittedPixels`、`conversionMs` 和 `updateMs`。

这两个指标都是软件路径指标，不等于 AMOLED 面板的物理扫描频率。
