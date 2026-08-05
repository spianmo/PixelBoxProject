/**
 * @pixelbox/sdk — 库入口
 *
 * 除 CLI 外,模拟器 IDE 与第三方工具可直接复用:
 *   - DevdClient:devd 协议客户端(热更新推送 / 日志订阅 / 远程 eval)
 *   - discoverDevices:mDNS 设备发现
 *   - buildApp / collectPushFiles:esbuild 应用构建
 *   - createApp:应用模板生成
 *   - loadManifest / validateManifest:pixelbox.json 校验
 */
export { DevdClient, DevdError } from './devd';
export type { DevdClientOptions, DevdEventHandler, PushFile, PushProgress } from './devd';

export { discoverDevices, parseDirectTarget } from './discovery';
export type { DeviceTarget, DiscoveredDevice } from './discovery';

export { buildApp, collectPushFiles } from './build';
export type { BuildFile, BuildOptions, BuildResult } from './build';

export { loadManifest, validateManifest } from './manifest';

export { createApp } from './create';
export type { CreateOptions, CreateResult } from './create';

export { sdkRoot, sdkTypesPath, sdkVersion } from './pkg';

export {
  DEVD_DEFAULT_PORT,
  DEVD_WS_PATH,
  MDNS_SERVICE_TYPE,
  PUSH_CHUNK_SIZE,
} from './protocol';
export type {
  DevdAppState,
  DevdAppStateData,
  DevdEventFrame,
  DevdHelloResult,
  DevdLogData,
  DevdLogLevel,
  DevdRequestFrame,
  DevdResultFrame,
  PixelboxManifest,
  PushFileEntry,
} from './protocol';
