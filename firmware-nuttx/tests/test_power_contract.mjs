import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/prelude_power.js', import.meta.url), 'utf8');
const timers = new Map();
const subscriptions = [];
const events = [];
const exitHandlers = new Set();
const px = { input: {} };
let timerId = 0;
let available = true;
vm.runInNewContext(source, {
  px, exitHandlers,
  native: {
    buttonsAvailable: () => available,
    buttonsListen: enabled => subscriptions.push(enabled),
    buttonsPoll: () => events.splice(0)
  },
  unsupported: () => { throw new Error('ENOTSUP'); },
  setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; },
  clearInterval: id => timers.delete(id)
});

const received = [];
const stopA = px.input.onButton(event => received.push(['a', event]));
const stopB = px.input.onButton(event => received.push(['b', event]));
assert.deepEqual(subscriptions, [true]);
assert.equal(timers.size, 1);
events.push({id: 'boot', type: 'click'});
for (const callback of timers.values()) callback();
assert.equal(received.length, 2);
stopA();
assert.deepEqual(subscriptions, [true]);
stopB();
assert.deepEqual(subscriptions, [true, false]);
assert.equal(timers.size, 0);
px.input.onButton(() => {});
for (const cleanup of exitHandlers) cleanup();
assert.deepEqual(subscriptions, [true, false, true, false]);
assert.equal(timers.size, 0);
available = false;
assert.throws(() => px.input.onButton(() => {}), /ENOTSUP/);
assert.throws(() => px.input.onButton(1), /needs a function/);
assert.deepEqual(subscriptions, [true, false, true, false]);
console.log('power subscription contract passed');
