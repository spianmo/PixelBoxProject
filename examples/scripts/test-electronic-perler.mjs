#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const examplesRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appModule = await import(
  pathToFileURL(join(examplesRoot, '05-electronic-perler', 'assets', 'app.js')).href
);

const patternBundle = await build({
  entryPoints: [join(examplesRoot, '05-electronic-perler', 'src', 'pattern.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const patternModule = await import(
  `data:text/javascript;base64,${Buffer.from(patternBundle.outputFiles[0].text).toString('base64')}`
);

const imagesBundle = await build({
  entryPoints: [join(
    examplesRoot,
    '..',
    'simulator',
    'src',
    'renderer',
    'src',
    'device-sim',
    'sandbox',
    'runtime',
    'images.ts',
  )],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const imagesModule = await import(
  `data:text/javascript;base64,${Buffer.from(imagesBundle.outputFiles[0].text).toString('base64')}`
);

function loadAnimationPrelude() {
  const callbacks = new Set();
  const frames = Array.from({ length: 3 }, () => ({ dispose() {} }));
  const screen = {
    __isCanvas: () => true,
    __loadGifFrames: () => ({ frames, delays: [10, 10, 10] }),
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    drawImage() {},
  };
  const source = readFileSync(join(
    examplesRoot,
    '..',
    'firmware',
    'components',
    'bindings_screen',
    'src',
    'prelude_screen.js',
  ), 'utf8');
  runInNewContext(source, { px: { screen }, console, Set, TypeError, Error });
  return {
    screen,
    tick(dt = 10) {
      for (const callback of [...callbacks]) callback(dt);
    },
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[OK] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    throw error;
  }
}

test('精确颜色映射到固定拼豆色板', () => {
  assert.equal(appModule.nearestColorIndex(200, 77, 77), 6);
});

test('量化结果遵守颜色数量与网格长度', () => {
  const rgba = new Uint8ClampedArray([
    200, 77, 77, 255, 61, 111, 170, 255,
    200, 77, 77, 255, 61, 111, 170, 255,
  ]);
  const result = appModule.quantizeRgba(rgba, 2, 2, {
    maxColors: 2,
    removeBackground: false,
  });
  assert.equal(result.pixels.length, 4);
  assert.equal(result.palette.length, 2);
  assert.deepEqual(new Set(result.palette), new Set(['#C84D4D', '#3D6FAA']));
});

test('四角同色背景被编码为空豆位', () => {
  const rgba = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < 9; i++) rgba.set([255, 255, 255, 255], i * 4);
  rgba.set([29, 34, 32, 255], 4 * 4);
  const result = appModule.quantizeRgba(rgba, 3, 3, {
    maxColors: 4,
    removeBackground: true,
    backgroundThreshold: 20,
  });
  assert.equal(result.pixels, '....0....');
});

test('智能去背景只清除与边界连通的区域', () => {
  const width = 5;
  const height = 5;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([255, 255, 255, 255], i * 4);
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 3; x++) {
      if (x === 1 || x === 3 || y === 1 || y === 3) rgba.set([29, 34, 32, 255], (y * width + x) * 4);
    }
  }
  const output = appModule.applyExteriorTransparency(rgba, width, height, 20);
  assert.equal(output[3], 0, '外部白色背景应透明');
  assert.equal(output[(2 * width + 2) * 4 + 3], 255, '封闭轮廓内的白色应保留');
});

test('智能去背景保留非背景像素的原 Alpha', () => {
  const rgba = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < 9; i++) rgba.set([255, 255, 255, 255], i * 4);
  rgba.set([200, 77, 77, 128], 4 * 4);
  const output = appModule.applyExteriorTransparency(rgba, 3, 3, 20);
  assert.equal(output[4 * 4 + 3], 128);
});

test('全空图案仍保留协议要求的占位色板', () => {
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  const result = appModule.quantizeRgba(rgba, 2, 2, { removeBackground: true });
  assert.equal(result.pixels, '....');
  assert.equal(result.palette.length, 1);
});

test('像素图案使用黑底方块渲染且不依赖圆弧 API', () => {
  const rectangles = [];
  const context = {
    fillStyle: '',
    fillRect(x, y, width, height) {
      rectangles.push({ color: this.fillStyle, x, y, width, height });
    },
  };
  appModule.drawPixelPattern(context, {
    v: 1,
    cols: 2,
    rows: 2,
    palette: ['#C84D4D'],
    pixels: '0...',
  }, 40);
  assert.deepEqual(rectangles, [
    { color: '#000000', x: 0, y: 0, width: 40, height: 40 },
    { color: '#C84D4D', x: 0, y: 0, width: 20, height: 20 },
  ]);
});

test('原图按比例完整显示且不裁切', () => {
  assert.deepEqual(appModule.containRect(100, 200, 640, 640), {
    x: 160,
    y: 0,
    width: 320,
    height: 640,
  });
});

test('设备端协议接受合法 8x8 图案并规范化颜色', () => {
  const result = patternModule.parsePatternPayload({
    v: 1,
    cols: 8,
    rows: 8,
    palette: ['#c84d4d'],
    pixels: '0'.repeat(64),
  });
  assert.equal(result.palette[0], '#C84D4D');
  assert.equal(result.pixels.length, 64);
});

test('持久化键不超过 ESP-IDF NVS 的 15 字节限制', () => {
  assert.ok(Buffer.byteLength(patternModule.PATTERN_STORAGE_KEY, 'utf8') <= 15);
  assert.ok(Buffer.byteLength(patternModule.MODE_STORAGE_KEY, 'utf8') <= 15);
  assert.ok(Buffer.byteLength(patternModule.MEDIA_STORAGE_KEY, 'utf8') <= 15);
});

test('音乐协议接受 HTTP(S) MP3 地址并清理首尾空白', () => {
  assert.equal(
    patternModule.parseMusicUrl({ url: '  https://media.example.com/music.mp3?token=abc  ' }),
    'https://media.example.com/music.mp3?token=abc',
  );
  assert.equal(patternModule.parseMusicUrl({ url: 'http://192.168.1.8/song.mp3' }), 'http://192.168.1.8/song.mp3');
});

test('音乐协议拒绝空地址、非 HTTP(S) 协议和超长地址', () => {
  assert.throws(() => patternModule.parseMusicUrl({ url: '' }), /请填写/);
  assert.throws(() => patternModule.parseMusicUrl({ url: 'ftp://example.com/music.mp3' }), /http:\/\//);
  assert.throws(() => patternModule.parseMusicUrl({ url: 'https://example.com/a b.mp3' }), /http:\/\//);
  assert.throws(
    () => patternModule.parseMusicUrl({ url: `https://example.com/${'a'.repeat(1024)}` }),
    /不能超过 1024/,
  );
});

test('媒体协议接受 2 MiB 上限内的 GIF', () => {
  const result = patternModule.parseMediaPayload({
    v: 1,
    kind: 'gif',
    slot: 1,
    size: patternModule.MAX_MEDIA_BYTES,
    width: 320,
    height: 240,
    removeBackground: true,
    backgroundThreshold: 52,
    crop: { x: 40.5, y: 0, size: 240 },
  });
  assert.equal(result.kind, 'gif');
  assert.equal(result.slot, 1);
  assert.equal(result.removeBackground, true);
  assert.equal(result.backgroundThreshold, 52);
  assert.deepEqual(result.crop, { x: 40.5, y: 0, size: 240 });
});

test('旧媒体元数据兼容默认去背景选项', () => {
  const result = patternModule.parseMediaPayload({
    v: 1,
    kind: 'gif',
    slot: 0,
    size: 128,
    width: 16,
    height: 16,
  });
  assert.equal(result.removeBackground, false);
  assert.equal(result.backgroundThreshold, 44);
  assert.equal(result.crop, null);
});

test('GIF 媒体协议拒绝非布尔去背景标记和越界容差', () => {
  const base = { v: 1, kind: 'gif', slot: 0, size: 128, width: 16, height: 16 };
  assert.throws(
    () => patternModule.parseMediaPayload({ ...base, removeBackground: 'yes' }),
    /布尔值/,
  );
  assert.throws(
    () => patternModule.parseMediaPayload({ ...base, backgroundThreshold: 256 }),
    /0-255/,
  );
});

test('GIF 媒体协议拒绝超出原帧的方形裁剪区', () => {
  assert.throws(
    () => patternModule.parseMediaPayload({
      v: 1,
      kind: 'gif',
      slot: 0,
      size: 128,
      width: 320,
      height: 240,
      crop: { x: 100, y: 0, size: 240 },
    }),
    /超出原图范围/,
  );
});

test('GIF 按原始顺序从末帧回到首帧继续循环', () => {
  const runtime = loadAnimationPrelude();
  const animation = runtime.screen.loadGif(new Uint8Array());
  animation.play();
  const sequence = [animation.currentFrame];
  for (let i = 0; i < 3; i++) {
    runtime.tick();
    sequence.push(animation.currentFrame);
  }
  assert.deepEqual(sequence, [0, 1, 2, 0]);
  animation.dispose();
});

test('GIF 仅把 RGBA 完全相同的首尾帧视为重复帧', () => {
  const first = new Uint8ClampedArray([12, 34, 56, 255, 78, 90, 12, 128]);
  const same = new Uint8ClampedArray(first);
  const different = new Uint8ClampedArray(first);
  different[7] = 127;
  assert.equal(imagesModule.gifFramePixelsEqual(first, same), true);
  assert.equal(imagesModule.gifFramePixelsEqual(first, different), false);
  assert.equal(imagesModule.gifFramePixelsEqual(first, same.subarray(0, 4)), false);
});

test('媒体协议拒绝超过 2 MiB 的文件', () => {
  assert.throws(
    () => patternModule.parseMediaPayload({
      v: 1,
      kind: 'image',
      slot: 0,
      size: patternModule.MAX_MEDIA_BYTES + 1,
      width: 368,
      height: 448,
    }),
    /1-2097152/,
  );
});

test('媒体协议拒绝越界尺寸和未知类型', () => {
  assert.throws(
    () => patternModule.parseMediaPayload({
      v: 1,
      kind: 'video',
      slot: 0,
      size: 128,
      width: 368,
      height: 448,
    }),
    /image 或 gif/,
  );
  assert.throws(
    () => patternModule.parseMediaPayload({
      v: 1,
      kind: 'image',
      slot: 0,
      size: 128,
      width: patternModule.MAX_MEDIA_DIMENSION + 1,
      height: 448,
    }),
    /1-8192/,
  );
});

test('设备端协议拒绝越界色板索引', () => {
  assert.throws(
    () => patternModule.parsePatternPayload({
      v: 1,
      cols: 8,
      rows: 8,
      palette: ['#C84D4D'],
      pixels: `1${'0'.repeat(63)}`,
    }),
    /超出色板范围/,
  );
});

test('设备端协议拒绝非法豆位编码', () => {
  // 编码判定是 charCodeAt 算术 (等价旧的 /^[0-9a-z]$/),大写与符号都必须挡住:
  // parseInt('A', 36) 本身是 10,少了这道判定就会被当成合法色板索引放行。
  for (const bad of ['A', '!', ' ', 'ä']) {
    assert.throws(
      () => patternModule.parsePatternPayload({
        v: 1,
        cols: 8,
        rows: 8,
        palette: ['#C84D4D'],
        pixels: `${bad}${'0'.repeat(63)}`,
      }),
      /编码非法/,
      `字符 ${JSON.stringify(bad)} 应被拒绝`,
    );
  }
});

test('设备端协议接受 64x64 的最高像素密度', () => {
  const result = patternModule.parsePatternPayload({
    v: 1,
    cols: 64,
    rows: 64,
    palette: ['#C84D4D'],
    pixels: '0'.repeat(4096),
  });
  assert.equal(result.pixels.length, 4096);
});

test('设备端协议拒绝超过 64x64 的网格', () => {
  assert.throws(
    () => patternModule.parsePatternPayload({
      v: 1,
      cols: 65,
      rows: 64,
      palette: ['#C84D4D'],
      pixels: '0'.repeat(4160),
    }),
    /8-64/,
  );
});

console.log(`\n电子拼豆单元测试通过: ${passed} 项`);
