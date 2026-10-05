import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const prelude = readFileSync(new URL('../src/prelude.js', import.meta.url), 'utf8');
const start = prelude.indexOf('  const touchSubscribers = new Set();');
const end = prelude.indexOf('  /* @include prelude_power.js */', start);
assert.ok(start >= 0 && end > start);

function fixture(events) {
  let now = 0;
  let nextId = 1;
  let reads = 0;
  const timers = new Map();
  const context = {
    px: {},
    g: { performance: { now: () => now } },
    native: {
      touchAvailable: () => true,
      touchRead() { reads++; return events.shift() ?? null; }
    },
    unsupported() { throw new Error('unsupported'); },
    setInterval(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, next: now + delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); }
  };
  vm.runInNewContext(prelude.slice(start, end), context);
  return {
    input: context.px.input,
    get reads() { return reads; },
    get timers() { return timers; },
    advance(ms) {
      now += ms;
      for (const timer of timers.values()) {
        if (timer.next <= now) {
          timer.next = now + timer.delay;
          timer.callback();
        }
      }
    }
  };
}

test('触摸在首次 5ms 采样时投递，最后一个订阅者退订后停止读取', () => {
  const value = fixture([{ type: 'down', x: 10, y: 20 }]);
  const received = [];
  const unsubscribe = value.input.onTouch(event => received.push(event.type));
  assert.equal(value.reads, 0, '订阅不能同步调用回调');
  value.advance(4);
  assert.equal(value.reads, 0);
  value.advance(1);
  assert.deepEqual(received, ['down']);
  unsubscribe();
  assert.equal(value.timers.size, 0);
  value.advance(20);
  assert.equal(value.reads, 1);
});

test('触摸和手势共用采样定时器，退订其中一个不影响另一个', () => {
  const value = fixture([
    { type: 'down', x: 10, y: 20 },
    { type: 'up', x: 60, y: 20 }
  ]);
  const touches = [], gestures = [];
  const offTouch = value.input.onTouch(event => touches.push(event.type));
  const offGesture = value.input.onGesture(event => gestures.push(event.dir));
  assert.equal(value.timers.size, 1);
  value.advance(5);
  offTouch();
  assert.equal(value.timers.size, 1);
  value.advance(5);
  assert.deepEqual(touches, ['down']);
  assert.deepEqual(gestures, ['right']);
  offGesture();
  assert.equal(value.timers.size, 0);
});

test('慢触摸回调不改变滑动手势的采样时间和回调顺序', () => {
  const value = fixture([
    { type: 'down', x: 10, y: 20 },
    { type: 'up', x: 60, y: 20 }
  ]);
  const calls = [];
  value.input.onTouch(event => {
    calls.push(event.type);
    if (event.type === 'up') value.advance(900);
  });
  value.input.onGesture(event => calls.push(event.dir));
  value.advance(5);
  value.advance(5);
  assert.deepEqual(calls, ['down', 'up', 'right']);
});
