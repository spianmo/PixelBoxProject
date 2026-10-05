import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/prelude.js', import.meta.url), 'utf8');
const start = source.indexOf('    flush(knownClean = false) {');
const end = source.indexOf('    frameStats()', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const calls = [], screen = {
    _pixels: new Uint32Array(24), _dirty: null,
    _changedRows: new Uint16Array(12), _dirtyBlocks: new Uint32Array(6)
  };
  let failure = false;
  const native = { width: 6, flush(...args) {
    calls.push(args);
    if (failure) throw new Error('display failed');
  } };
  screen.flush = vm.runInNewContext(`({${source.slice(start, end)}}).flush`,
    { screen, native, unsupported() { throw new Error('unsupported'); } });
  return { screen, calls, fail(value) { failure = value; } };
}

test('自动未绘图帧只传内部clean标志，手动flush仍扫描全屏', () => {
  const { screen, calls } = fixture();
  screen.flush(true);
  assert.deepEqual(calls[0], [screen._pixels, 0, 0, 0, 0, true]);
  screen.flush();
  assert.deepEqual(calls[1], [screen._pixels]);
  screen.flush(1);
  assert.deepEqual(calls[2], [screen._pixels]);
});

test('有脏区时自动与手动都提交脏区，失败保留区域供下一帧重试', () => {
  const value = fixture(), { screen, calls } = value;
  const dirty = { x: 1, y: 2, right: 4, bottom: 4 };
  screen._dirty = dirty; value.fail(true);
  assert.throws(() => screen.flush(true), /display failed/);
  assert.equal(screen._dirty, dirty);
  assert.deepEqual(calls[0], [screen._pixels, 1, 2, 3, 2, false, screen._changedRows, screen._dirtyBlocks]);
  value.fail(false); screen.flush(true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(screen._dirty, null);
});

test('调度器明确传递自动帧标志', () => {
  const from = source.indexOf('    onFrame(callback) {');
  const to = source.indexOf('    setFps(value)', from);
  let callback, clean, time = 0;
  const context = { native: { width: 6 }, fps: 30,
    g: { performance: { now: () => time } },
    screen: { flush(value) { clean = value; } },
    setTimeout(fn) { callback = fn; return 1; }, clearTimeout() {} };
  const onFrame = vm.runInNewContext(`({${source.slice(from, to)}}).onFrame`, context);
  onFrame(() => {}); time = 34; callback();
  assert.equal(clean, true);
});
