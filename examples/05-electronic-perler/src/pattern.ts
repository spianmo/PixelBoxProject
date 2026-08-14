export const MIN_GRID_SIZE = 8;
export const MAX_GRID_SIZE = 64;
export const MAX_BEAD_COUNT = 4096;
export const MAX_PALETTE_SIZE = 24;
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_DIMENSION = 8192;
export const MAX_MUSIC_URL_LENGTH = 1024;
/** ESP-IDF NVS 键名上限为 15 字节。 */
export const PATTERN_STORAGE_KEY = 'perler.pattern';
export const MODE_STORAGE_KEY = 'perler.mode';
export const MEDIA_STORAGE_KEY = 'perler.media';

export type DisplayMode = 'pattern' | 'image' | 'gif';

export interface MediaCrop {
  x: number;
  y: number;
  size: number;
}

export interface PerlerMedia {
  v: 1;
  kind: 'image' | 'gif';
  slot: 0 | 1;
  size: number;
  width: number;
  height: number;
  removeBackground: boolean;
  backgroundThreshold: number;
  crop: MediaCrop | null;
}

export interface BeadPattern {
  v: 1;
  cols: number;
  rows: number;
  palette: string[];
  /** 每个字符是一个 base36 色板索引，`.` 表示空豆位。 */
  pixels: string;
}

/** 校验设备要主动拉取的网络音频地址。 */
export function parseMusicUrl(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('音乐请求必须是 JSON 对象');
  }
  const value = (raw as Record<string, unknown>).url;
  if (typeof value !== 'string') return fail('MP3 地址必须是字符串');
  const url = value.trim();
  if (url.length === 0) return fail('请填写 MP3 地址');
  if (url.length > MAX_MUSIC_URL_LENGTH) return fail(`MP3 地址不能超过 ${MAX_MUSIC_URL_LENGTH} 个字符`);
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return fail('MP3 地址必须使用 http:// 或 https://');
  return url;
}

/** 校验文件媒体元数据，实际文件长度会在 commit 时再次核对。 */
export function parseMediaPayload(raw: unknown, slot?: 0 | 1): PerlerMedia {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('媒体信息必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return fail('不支持的媒体版本');
  if (obj.kind !== 'image' && obj.kind !== 'gif') return fail('媒体类型必须是 image 或 gif');
  if (!Number.isInteger(obj.size) || (obj.size as number) <= 0 || (obj.size as number) > MAX_MEDIA_BYTES) {
    return fail(`媒体文件必须在 1-${MAX_MEDIA_BYTES} 字节之间`);
  }
  if (!Number.isInteger(obj.width) || (obj.width as number) <= 0 || (obj.width as number) > MAX_MEDIA_DIMENSION ||
      !Number.isInteger(obj.height) || (obj.height as number) <= 0 || (obj.height as number) > MAX_MEDIA_DIMENSION) {
    return fail(`媒体宽高必须是 1-${MAX_MEDIA_DIMENSION} 的整数`);
  }
  const resolvedSlot = slot ?? obj.slot;
  if (resolvedSlot !== 0 && resolvedSlot !== 1) return fail('媒体存储槽无效');
  const removeBackground = obj.removeBackground === undefined ? false : obj.removeBackground;
  if (typeof removeBackground !== 'boolean') return fail('去背景标记必须是布尔值');
  const backgroundThreshold = obj.backgroundThreshold === undefined ? 44 : obj.backgroundThreshold;
  if (!Number.isInteger(backgroundThreshold) ||
      (backgroundThreshold as number) < 0 || (backgroundThreshold as number) > 255) {
    return fail('背景容差必须是 0-255 的整数');
  }
  let crop: MediaCrop | null = null;
  if (obj.crop !== undefined && obj.crop !== null) {
    if (typeof obj.crop !== 'object' || Array.isArray(obj.crop)) return fail('媒体裁剪信息无效');
    const cropObj = obj.crop as Record<string, unknown>;
    const x = cropObj.x;
    const y = cropObj.y;
    const size = cropObj.size;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 ||
        typeof y !== 'number' || !Number.isFinite(y) || y < 0 ||
        typeof size !== 'number' || !Number.isFinite(size) || size <= 0 ||
        x + size > (obj.width as number) + 0.001 || y + size > (obj.height as number) + 0.001) {
      return fail('媒体裁剪区域超出原图范围');
    }
    crop = { x, y, size };
  }
  return {
    v: 1,
    kind: obj.kind,
    slot: resolvedSlot,
    size: obj.size as number,
    width: obj.width as number,
    height: obj.height as number,
    removeBackground,
    backgroundThreshold: backgroundThreshold as number,
    crop,
  };
}

export function parseDisplayMode(raw: unknown): DisplayMode {
  if (raw === 'pattern' || raw === 'image' || raw === 'gif') return raw;
  return fail('显示模式无效');
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * 校验浏览器上传的紧凑网格，避免畸形数据进入 NVS 或屏幕绘制循环。
 */
export function parsePatternPayload(raw: unknown): BeadPattern {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('图案必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return fail('不支持的图案版本');
  if (!Number.isInteger(obj.cols) || !Number.isInteger(obj.rows)) {
    return fail('网格尺寸必须是整数');
  }

  const cols = obj.cols as number;
  const rows = obj.rows as number;
  if (cols < MIN_GRID_SIZE || cols > MAX_GRID_SIZE || rows < MIN_GRID_SIZE || rows > MAX_GRID_SIZE) {
    return fail(`网格尺寸必须在 ${MIN_GRID_SIZE}-${MAX_GRID_SIZE} 之间`);
  }
  if (cols * rows > MAX_BEAD_COUNT) return fail('图案豆数超出上限');

  if (!Array.isArray(obj.palette) || obj.palette.length === 0 || obj.palette.length > MAX_PALETTE_SIZE) {
    return fail(`色板必须包含 1-${MAX_PALETTE_SIZE} 种颜色`);
  }
  const palette = obj.palette.map((color) => {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return fail('色板颜色必须是 #RRGGBB');
    }
    return color.toUpperCase();
  });

  if (typeof obj.pixels !== 'string' || obj.pixels.length !== cols * rows) {
    return fail('像素数据长度与网格尺寸不匹配');
  }
  // 全部用 charCodeAt + 算术判定,不分配单字符字符串、不跑正则。
  // 真机实测 (64x64 = 4096 豆位, ESP32-S3 240MHz):
  //   charAt + /^[0-9a-z]$/ + parseInt = 2713ms  ← 曾是启动卡 3 秒的全部原因
  //   正则提到循环外                    = 2141ms
  //   本实现                            =   56ms
  // 设备上单次 RegExp.test 要 190us、charAt 要 16us,4096 次就是秒级,
  // 因此这条校验必须避开一切按豆位的分配与正则调用。
  const beads = obj.pixels;
  const paletteSize = palette.length;
  for (let i = 0; i < beads.length; i++) {
    const code = beads.charCodeAt(i);
    if (code === 46) continue; // '.' 空豆位
    // 等价于 /^[0-9a-z]$/ + parseInt(symbol, 36):'0'-'9' → 0-9,'a'-'z' → 10-35
    const paletteIndex =
      code >= 48 && code <= 57 ? code - 48 : code >= 97 && code <= 122 ? code - 87 : -1;
    if (paletteIndex < 0) return fail(`第 ${i + 1} 个豆位编码非法`);
    if (paletteIndex >= paletteSize) return fail(`第 ${i + 1} 个豆位超出色板范围`);
  }

  return { v: 1, cols, rows, palette, pixels: obj.pixels };
}

export function colorFromHex(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
