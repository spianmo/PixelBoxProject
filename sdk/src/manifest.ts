/**
 * pixelbox.json(应用 manifest)读取与校验
 * 字段定义见 docs/architecture.md §6
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PixelboxManifest } from './protocol';

/** 校验并规范化 manifest 对象(entry 缺省补 "main.js") */
export function validateManifest(raw: unknown): PixelboxManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('pixelbox.json 必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  const requireString = (key: 'id' | 'name' | 'version'): string => {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`pixelbox.json 缺少必填字符串字段 "${key}"`);
    }
    return v.trim();
  };

  const id = requireString('id');
  const name = requireString('name');
  const version = requireString('version');
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new Error(`pixelbox.json 的 version 必须是 semver 格式(当前: "${version}")`);
  }

  let entry = 'main.js';
  if (obj.entry !== undefined) {
    if (typeof obj.entry !== 'string' || obj.entry.trim() === '') {
      throw new Error('pixelbox.json 的 entry 必须是非空字符串');
    }
    entry = obj.entry.trim();
  }
  if (!entry.endsWith('.js')) {
    throw new Error(`pixelbox.json 的 entry 必须是 .js 文件(当前: "${entry}")`);
  }

  let assets: string[] | undefined;
  if (obj.assets !== undefined) {
    if (!Array.isArray(obj.assets) || obj.assets.some((a) => typeof a !== 'string')) {
      throw new Error('pixelbox.json 的 assets 必须是字符串数组');
    }
    assets = obj.assets as string[];
  }

  let minFirmware: string | undefined;
  if (obj.minFirmware !== undefined) {
    if (typeof obj.minFirmware !== 'string') {
      throw new Error('pixelbox.json 的 minFirmware 必须是字符串');
    }
    minFirmware = obj.minFirmware;
  }

  const manifest: PixelboxManifest = { id, name, version, entry };
  if (assets !== undefined) {
    manifest.assets = assets;
  }
  if (minFirmware !== undefined) {
    manifest.minFirmware = minFirmware;
  }
  return manifest;
}

/** 从项目目录读取 pixelbox.json */
export function loadManifest(projectDir: string): PixelboxManifest {
  const file = path.join(projectDir, 'pixelbox.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `未找到 ${file};请在应用根目录执行命令,或先用 "pixelbox create <目录>" 创建应用`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`pixelbox.json 解析失败: ${msg}`);
  }
  return validateManifest(raw);
}
