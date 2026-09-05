import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/bindings_speech.cpp', import.meta.url), 'utf8');
const prelude = source.match(/R"JS\(([\s\S]*?)\)JS"/)[1];
let wakeOptions;
let recognizeOptions;
let woke = 0;
let errors = 0;
let levels = 0;
let finishRecognize;
const speech = {
    configure() {}, cancel() {}, speak() { return Promise.resolve(); },
    recognize(options) { recognizeOptions = options; return new Promise((resolve) => { finishRecognize = resolve; }); },
    wakeword: { start(options) { wakeOptions = options; return Promise.resolve(); }, stop() {} },
};
runInNewContext(prelude, { px: { speech } });
await speech.wakeword.start({ onWake() { woke++; }, onError() { errors++; } });
const oldWake = wakeOptions;
speech.wakeword.stop();
oldWake.onWake(); oldWake.onError('late');
assert.equal(woke, 0); assert.equal(errors, 0);
await speech.wakeword.start({ onWake() { woke++; }, onError() { errors++; } });
wakeOptions.onWake(); assert.equal(woke, 1);
const recognizing = speech.recognize({ onLevel() { levels++; } });
recognizeOptions.onLevel(50); assert.equal(levels, 1);
speech.cancel(); recognizeOptions.onLevel(50); assert.equal(levels, 1);
finishRecognize('上一账号的识别');
await assert.rejects(recognizing, /取消/);
const speaking = speech.speak('上一账号的回答');
speech.cancel();
await assert.rejects(speaking, /取消/);
await speech.wakeword.start({ onWake() { woke++; } });
const beforeAccount = wakeOptions;
speech.configure({ region: 'eastasia', key: 'new-account' });
beforeAccount.onWake(); assert.equal(woke, 1);
console.log('speech prelude: stop/cancel/configure discard stale wake/error/level callbacks');
