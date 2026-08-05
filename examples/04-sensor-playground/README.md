# 04 传感器游乐场

拿在手里玩的物理小球:倾斜盒子,小球沿重力方向滚动、碰壁反弹、拖出彩色残影;摇一摇随机换色并闪光;顶部常驻电池 / 内存状态栏。

## 演示的 API

| API | 用途 |
|---|---|
| `px.sensors.imu.available()` | 能力检测,不可用时自动降级(固定重力 + 触摸拨动) |
| `px.sensors.imu.start({ rateHz, onData })` | 50Hz 读取加速度,驱动物理积分 |
| `px.sensors.imu.onShake(cb)` | 摇一摇换色 + 闪光 + 双音效 |
| `px.system.battery()` / `px.system.memory()` | 顶部状态栏(每秒刷新缓存,不在渲染帧里反复查询) |
| `px.screen.fillCircle / drawRect` | 小球、残影与电池图标 |

## 物理参数速查(都在 main.ts 顶部)

- `G_SCALE`:重力换算系数(像素/秒² 每 1g)。IMU 若输出 m/s²,把它除以 9.8;
- `BOUNCE`:碰壁能量保留(0.72 = 每次反弹损失 28%);
- `FRICTION`:滚动摩擦;
- 加速度到屏幕坐标的符号映射在 `onData` 里,安装方位不同时调整正负号即可。

## 运行

模拟器中用右侧面板的 IMU 摇杆 / 摇一摇按钮模拟传感器;真机直接上手倾斜与摇晃。
