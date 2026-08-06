# @pixelbox/sdk

PixelBox 像素盒应用开发 SDK 与 `pixelbox` 命令行工具。

- **契约文件**:`types/pixelbox.d.ts` 是全项目唯一事实源,声明设备端 `px.*` 全部 API(固件 bindings、模拟器 shim 均与其逐一对齐),随包发布、禁止修改。
- **CLI**:创建 / 构建 / 推送热更新 / 实时日志 / 设备发现 / 远程执行。
- **库**:导出 `DevdClient` 等能力,模拟器 IDE 与第三方工具可直接复用 devd 协议客户端。

## 安装

```bash
# 全局安装(获得 pixelbox 命令),npm / pnpm 任选
npm install -g @pixelbox/sdk
pnpm add -g @pixelbox/sdk

# 若网络原因安装失败,可改用镜像
npm install -g @pixelbox/sdk --registry=https://registry.npmmirror.com
pnpm add -g @pixelbox/sdk --registry=https://registry.npmmirror.com
```

仓库源码内使用(无需发布;monorepo 为 pnpm workspace,在仓库根安装):

```bash
pnpm install                # 仓库根执行
cd sdk && pnpm run build
node dist/cli.js --help
```

## CLI 命令

| 命令 | 说明 |
|---|---|
| `pixelbox create <dir>` | 创建应用模板(pixelbox.json、tsconfig、src/main.ts 像素动画示例、README、.gitignore) |
| `pixelbox build` | esbuild 打包 `src/main.ts` → `dist/main.js`(ES2020 单文件、无 sourcemap),拷贝 `assets/` 与 manifest 到 `dist/` |
| `pixelbox push [--device <ip\|名称>]` | devd 协议推送应用包(hello → push_begin(sha256 清单) → 32KB 分块 push_chunk → push_end 原子切换热重启 VM);未指定设备时 mDNS 发现 `_pixelbox._tcp` 并交互选择 |
| `pixelbox dev` | 开发闭环:监听 `src/`、`assets/`、`pixelbox.json` → 增量构建 → 自动推送 → 常驻订阅日志彩色打印 |
| `pixelbox logs [--device ...]` | 仅订阅设备日志(console.* 与 ESP_LOG 均转发) |
| `pixelbox devices` | 列出局域网内的 PixelBox 设备(mDNS) |
| `pixelbox eval "<code>" [--device ...]` | 在设备 JS VM 中执行一段代码并打印字符串化结果 |

`--device` 支持三种写法:`192.168.1.10`、`192.168.1.10:8765`、`pixelbox-abcd.local`,或 mDNS 实例名称(模糊匹配)。

## 典型工作流

```bash
pixelbox create my-clock
cd my-clock
npm install            # 安装 TypeScript,启用类型检查(pnpm 用户: pnpm install)
pixelbox dev           # 自动发现设备;保存文件即热更新,终端实时看日志
```

## 模板的 d.ts 引用策略

`pixelbox create` 会按 SDK 的安装场景写入 tsconfig 的类型引用路径:

- **包管理器安装场景**(SDK 位于 node_modules 内,npm/pnpm 均可):写入
  `node_modules/@pixelbox/sdk/types/pixelbox.d.ts`,并把 `@pixelbox/sdk` 写进模板
  devDependencies,`npm install`(或 `pnpm install`)后路径即成立
  (pnpm 符号链接布局下 tsc 沿链接可解析);
- **仓库源码场景**(直接运行 `sdk/dist/cli.js`):写入指向仓库内
  `sdk/types/pixelbox.d.ts` 的相对路径(基于真实路径计算,规避符号链接偏差),
  devDependencies 用 `file:` 引用本地 SDK。

## 作为库使用(DevdClient)

```ts
import { DevdClient, discoverDevices, buildApp, collectPushFiles } from '@pixelbox/sdk';

// 1. 发现设备
const devices = await discoverDevices(3000);

// 2. 连接 devd(ws://<ip>:8765/devd)
const client = await DevdClient.connect(devices[0].ip);
console.log(await client.hello()); // {name, model, fw, app, ...}

// 3. 构建并热更新推送
const result = await buildApp('/path/to/app');
await client.pushApp(result.manifest, collectPushFiles(result), (p) => {
  console.log(p.phase, p.sentBytes, p.totalBytes);
});

// 4. 日志与远程执行
const off = client.onEvent((event, data) => console.log(event, data));
await client.subscribeLogs();
console.log(await client.evalJs('px.system.memory()'));
off();
client.close();
```

## devd 协议摘要

传输为 `ws://<device-ip>:8765/devd` 文本帧 JSON:请求 `{id, method, params}`,
响应 `{id, result}` 或 `{id, error:{code, message}}`,设备主动事件 `{event, data}`
(`log` / `app.state`)。方法与字段详见 `docs/architecture.md` §5,本包
`src/protocol.ts` 提供了对应的 TypeScript 类型与常量。

## 开发本包

```bash
pnpm install          # 仓库根执行(pnpm workspace)
pnpm run build        # tsc → dist/(CLI 入口 dist/cli.js,库入口 dist/index.js)
pnpm run typecheck    # 仅类型检查
```
