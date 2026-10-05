import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const prelude = readFileSync(new URL('../src/prelude.js', import.meta.url), 'utf8');
const start = prelude.indexOf('    onFrame(callback) {');
const end = prelude.indexOf('    setFps(value)', start);
assert.ok(start >= 0 && end > start, '真实 prelude 必须包含 onFrame');
const method = prelude.slice(start, end);

function scheduler({ tick = 10, draw = () => 0, flush = 0 } = {}) {
  let time = 0, nextId = 1, flushed = 0;
  const timers = new Map(), frames = [], deltas = [];
  const now = () => Math.floor((time + 1e-8) / tick) * tick;
  const context = {
    fps: 30, native: { width: 480 }, g: { performance: { now } },
    unsupported() { throw new Error('unsupported'); },
    screen: { _dirty: null, flush() { flushed++; time += flush; } },
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now() + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  // 提取真实方法，不复制调度算法；时钟与 sleep 对齐 NuttX 的 10ms tick。
  const onFrame = vm.runInNewContext(`({${method}}).onFrame`, context);
  const cancel = onFrame(dt => {
    frames.push(time); deltas.push(dt);
    const result = draw(frames.length, time, cancel);
    if (typeof result === 'number') time += result;
    return result;
  });
  function runUntil(limit) {
    let turns = 0;
    while (time < limit && timers.size) {
      assert.ok(++turns < 100000, '调度不能进入零延迟补帧循环');
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer.at > now()) {
        time += Math.ceil(Math.min(50, timer.at - now()) / tick) * tick;
        continue;
      }
      timers.delete(id);
      timer.callback();
    }
  }
  return { runUntil, cancel, frames, deltas, timers, context,
    get flushed() { return flushed; }, get time() { return time; } };
}

function steadyFps(value, start = 2000, end = 12000) {
  value.runUntil(end);
  return value.frames.filter(at => at >= start && at < end).length * 1000 / (end - start);
}

for (const work of [0, 20, 25, 30, 32, 33]) {
  test(`10ms tick、每帧总耗时 ${work}ms 时保持 30FPS`, () => {
    const value = scheduler({ draw: () => work });
    assert.ok(Math.abs(steadyFps(value) - 30) <= .2);
    assert.equal(value.flushed, value.frames.length);
    assert.ok(value.deltas.every(dt => dt >= 0));
  });
}

for (const tick of [1, 10]) {
  test(`${tick}ms tick、35ms 绘制不会降至半帧率`, () => {
    const value = scheduler({ tick, draw: () => 35 });
    const fps = steadyFps(value);
    assert.ok(fps >= 28 && fps <= 29, `实测 ${fps}FPS`);
  });
}

test('绘制与 flush 共同计入帧预算', () => {
  const value = scheduler({ draw: () => 20, flush: 12 });
  assert.ok(Math.abs(steadyFps(value) - 30) <= .2);
});

test('单帧超时后恢复 30FPS，零耗时帧不会无限追赶', () => {
  const value = scheduler({ draw: frame => frame === 30 ? 1000 : 0 });
  assert.ok(Math.abs(steadyFps(value, 3000, 13000) - 30) <= .2);
  const sameTime = new Map();
  for (const at of value.frames) sameTime.set(at, (sameTime.get(at) || 0) + 1);
  assert.ok(Math.max(...sameTime.values()) <= 2, '最多允许一次立即恢复帧');
});

test('连续超时绘制受实际耗时约束', () => {
  const value = scheduler({ draw: () => 120 });
  const fps = steadyFps(value);
  assert.ok(fps >= 8 && fps <= 9, `实测 ${fps}FPS`);
});

test('首帧前取消会移除 timer', () => {
  const value = scheduler();
  value.cancel(); value.cancel(); value.runUntil(1000);
  assert.equal(value.frames.length, 0);
  assert.equal(value.flushed, 0);
  assert.equal(value.timers.size, 0);
});

test('回调内取消不会安排下一帧', () => {
  const value = scheduler({ draw: (frame, at, cancel) => { cancel(); return 1000; } });
  value.runUntil(5000);
  assert.equal(value.frames.length, 1);
  assert.equal(value.flushed, 1);
  assert.equal(value.timers.size, 0);
});

test('回调返回 false 时跳过 framebuffer flush', () => {
  const value = scheduler({ draw: () => false });
  value.runUntil(1000);
  assert.ok(value.frames.length > 0);
  assert.equal(value.flushed, 0);
});

test('回调返回 false 但存在待重试脏区时仍 flush', () => {
  const value = scheduler({ draw: (frame) => {
    if (frame === 1) value.context.screen._dirty = { x: 0, y: 0, right: 1, bottom: 1 };
    return false;
  } });
  value.runUntil(1000);
  assert.ok(value.flushed > 0);
});

test('修改 fps 会改变后续周期', () => {
  const value = scheduler();
  value.runUntil(2000); value.context.fps = 20;
  assert.ok(Math.abs(steadyFps(value, 3000, 13000) - 20) <= .2);
});
