/**
 * SDK 自身包信息工具:定位包根目录 / 读取版本号 / 定位 d.ts 契约文件
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** SDK 包根目录(编译产物位于 <root>/dist,故取 __dirname 上一级) */
export function sdkRoot(): string {
  return path.resolve(__dirname, '..');
}

/** 读取 SDK 自身 package.json 的版本号 */
export function sdkVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(sdkRoot(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 设备 API 契约文件(唯一事实源)的绝对路径 */
export function sdkTypesPath(): string {
  return path.join(sdkRoot(), 'types', 'pixelbox.d.ts');
}
