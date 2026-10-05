import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/prelude_system_net.js', import.meta.url), 'utf8');
function fixture() {
  const calls = [], events = [], timers = new Map(), timeoutTimers = new Map(), exitHandlers = new Set();
  let id = 0, timer = 0, timeout = 0, startError = false, pollError = false, timerError = false, timeoutError = false, cancelError = false;
  const native = {systemNet:{
    start(...args) { calls.push(['start', ...args]); if (startError) throw new Error('start error'); return ++id; },
    poll() { if (pollError) throw new Error('poll error'); return events.shift() || null; },
    cancel(value) { calls.push(['cancel', value]); if (cancelError) throw new Error('cancel error'); },
    shutdown() { calls.push(['shutdown']); },
    temperature() { calls.push(['temperature']); return 42.25; }
  }};
  const context = {native, px:{system:{kept:true}}, exitHandlers,
    setInterval(callback, delay) { assert.equal(delay, 25); if (timerError) throw new Error('timer full'); timers.set(++timer, callback); return timer; },
    clearInterval(value) { timers.delete(value); },
    setTimeout(callback, delay) { assert.equal(delay, 16000); if (timeoutError) throw new Error('timeout full'); timeoutTimers.set(++timeout, callback); return timeout; },
    clearTimeout(value) { timeoutTimers.delete(value); }
  };
  vm.runInNewContext(source, context);
  return {api:context.px.system, calls, events, timers, timeoutTimers,
    pump() { for (const callback of [...timers.values()]) callback(); },
    fireTimeout() {
      const pending = [...timeoutTimers.entries()];
      for (const [value, callback] of pending) {
        /* 运行时的一次性timer在回调前出队，避免同一个超时重复触发。 */
        if (timeoutTimers.delete(value)) callback();
      }
    },
    exit() { for (const callback of exitHandlers) callback(); },
    failStart() { startError = true; }, failPoll() { pollError = true; }, failTimer() { timerError = true; }, failTimeout() { timeoutError = true; }, failCancel() { cancelError = true; }
  };
}
{
  const f = fixture(); assert(f.api.kept); assert.equal(f.timers.size, 0);
  assert.equal(f.api.temperature(), 42.25);
  let done = false; const first = f.api.ntpSync().then(value => { done = true; return value; });
  const second = f.api.ntpSync('time.test'); const failed = assert.rejects(second, /ETIMEDOUT/);
  assert.equal(f.timers.size, 1); assert.equal(f.timeoutTimers.size, 2); assert.equal(done, false);
  assert.deepEqual(f.calls.slice(1), [['start', undefined, 15000], ['start', 'time.test', 15000]]);
  f.events.push({id:777,error:0}, {id:1,error:0}, {id:2,error:-110,code:'ETIMEDOUT'});
  f.pump(); assert.equal(await first, undefined); await failed;
  assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
  const third = f.api.ntpSync(null); assert.equal(f.timers.size, 1); assert.equal(f.timeoutTimers.size, 1);
  f.events.push({id:3,error:0}); f.pump(); await third; assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
}
{
  const f = fixture();
  const promise = f.api.ntpSync('stalled.test');
  assert.equal(f.timers.size, 1); assert.equal(f.timeoutTimers.size, 1);
  f.fireTimeout();
  await assert.rejects(promise, /ETIMEDOUT: NTP synchronization/);
  assert.deepEqual(f.calls.slice(1), [['cancel', 1]]);
  /* 超时只先拒绝JS Promise；pending要等迟到的native取消事件消费后才移除。 */
  assert.equal(f.timers.size, 1); assert.equal(f.timeoutTimers.size, 0);
  f.events.push({id:1,error:-125,code:'ECANCELED'});
  f.pump();
  assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
}
{
  const f = fixture(); f.failCancel(); const promise = f.api.ntpSync('closed.test');
  f.fireTimeout(); await assert.rejects(promise, /ETIMEDOUT: NTP synchronization/);
  assert.deepEqual(f.calls.slice(1), [['cancel', 1]]);
  assert.equal(f.timers.size, 0, '取消异常后不保留轮询timer');
}
{
  const f = fixture(); f.failStart(); await assert.rejects(f.api.ntpSync('bad'), /start error/);
  assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
}
{
  const f = fixture(); f.failTimer(); await assert.rejects(f.api.ntpSync(), /timer full/);
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
}
{
  const f = fixture(); f.failTimeout(); const promise = f.api.ntpSync();
  await assert.rejects(promise, /timeout full/);
  assert.deepEqual(f.calls.slice(1), [['cancel', 1]]);
  assert.equal(f.timers.size, 1, 'timer创建失败后仍轮询native取消事件');
  f.events.push({id:1,error:-125,code:'ECANCELED'}); f.pump();
  assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
}
{
  const f = fixture(), first = f.api.ntpSync(), second = f.api.ntpSync();
  const failures = [assert.rejects(first, /poll error/), assert.rejects(second, /poll error/)];
  f.failPoll(); f.pump(); await Promise.all(failures);
  assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0); assert.equal(f.calls.filter(x => x[0] === 'shutdown').length, 1);
  await assert.rejects(f.api.ntpSync(), /ECANCELED/); assert.throws(() => f.api.temperature(), /ECANCELED/);
  f.exit(); assert.equal(f.calls.filter(x => x[0] === 'shutdown').length, 1);
}
{
  const f = fixture(), promise = f.api.ntpSync(); const failure = assert.rejects(promise, /ECANCELED/);
  f.exit(); f.exit(); await failure; assert.equal(f.timers.size, 0); assert.equal(f.timeoutTimers.size, 0);
  f.events.push({id:1,error:0}); f.pump();
  assert.equal(f.calls.filter(x => x[0] === 'shutdown').length, 1);
  await assert.rejects(f.api.ntpSync(), /ECANCELED/);
}
console.log('system prelude通过：Promise<void>、默认15秒、并发与空闲timer、创建失败、poll异常、退出取消与迟到事件');
