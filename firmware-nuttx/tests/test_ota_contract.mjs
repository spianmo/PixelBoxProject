import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/prelude_ota.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const response = (body, status = 200) => ({status, json: () => Promise.resolve(body)});
const fixture = (version = '1.2.3', fetch = () => response({version: '2.0.0', url: 'https://firmware.invalid/update.bin'})) => {
  const calls = [], exits = new Set(); let infoCalls = 0;
  const apply = () => Promise.reject(new Error('ENOTSUP'));
  const px = {system: {info() { ++infoCalls; throw new Error('info probes hardware and must not be called'); }, otaApply: apply}};
  const context = vm.createContext({px, firmwareVersion: version, exitHandlers: exits, Error, SyntaxError,
    g: {fetch(url, options) { calls.push({url, options}); return fetch(url, options); }}});
  vm.runInContext(source + '\nglobalThis.otaState = () => ({active: otaActive, pending: otaPending.size});', context);
  return {px, calls, apply, state: context.otaState, get infoCalls() { return infoCalls; },
    exit() { for (const callback of exits) callback(); }};
};
const update = (version, notes) => ({version, url: 'https://firmware.invalid/update.bin', ...(notes === undefined ? {} : {notes})});
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, run) { await run(); ++passed; console.log('PASS ' + name); }

await test('缺少 URL 同步报错，显式参数保留原转换语义', async () => {
  const f = fixture();
  assert.throws(() => f.px.system.otaCheck(), {message: 'otaCheck(manifestUrl) 缺少 URL'});
  assert.equal(f.calls.length, 0);
  for (const [value, expected] of [[undefined, 'undefined'], [null, 'null'], [123, '123'],
    [{toString() { return 'http://manifest.invalid/check'; }}, 'http://manifest.invalid/check'],
    [{toString() { throw new Error('conversion failed'); }}, ''], [Symbol('manifest'), '']]) {
    await f.px.system.otaCheck(value);
    assert.equal(f.calls.at(-1).url, expected);
  }
  assert.equal(f.px.system.otaApply, f.apply);
  assert.equal(f.state().pending, 0);
});

await test('更新结果严格为 version/url/可选 notes，不带清单的其他属性', async () => {
  const f = fixture('1.2.3', () => response({...update('v2.0.0', '更新说明'), sha256: 'ignored', board: 'ignored'}));
  assert.deepEqual(plain(await f.px.system.otaCheck('https://manifest.invalid/check')), update('v2.0.0', '更新说明'));
  assert.equal(f.calls[0].options.timeoutMs, 10000);
  assert.deepEqual(Object.keys(f.calls[0].options), ['timeoutMs']);
});

await test('版本只读静态固件常量，查询不得通过 info 初始化 BLE 或其他硬件', async () => {
  for (const version of ['1.0.0', '3.0.0']) {
    const f = fixture(version);
    const result = await f.px.system.otaCheck('http://manifest.invalid');
    assert.equal(result !== null, version === '1.0.0');
    assert.equal(f.infoCalls, 0); assert.equal(f.px.system.otaApply, f.apply);
  }
});

await test('三段版本比较兼容前缀、缺段补零、前导零、后缀及第四段', async () => {
  const cases = [
    ['1.2.3', '1.2.3', false], ['V1.2.3', 'v1.2.3', false], ['1.2', '1.2.0', false],
    ['1.2.3', '1.2.3-rc.1', false], ['1.2.3', '1.2.3.999', false], ['1.2.3', '1.2.2', false],
    ['1.2.3', '1.2.4', true], ['1.2.3', '1.3', true], ['1.2.3', '2', true],
    ['1.2.3', 'v01.002.0004-alpha', true], ['1.2.3', 'V2.0.0+build.3', true],
    ['1.2.3', 'bad', false], ['1.2.3', ' 2.0.0', false], ['1.2.3', '1..4', false],
    ['0.0.1', '.1', true], ['10.0.0', '9.999.999', false], ['0', '0.0.1', true]
  ];
  for (const [current, version, newer] of cases) {
    const f = fixture(current, () => response(update(version)));
    const result = await f.px.system.otaCheck('http://manifest.invalid');
    assert.equal(result !== null, newer, current + ' -> ' + version);
    if (newer) assert.equal(result.version, version);
  }
});

await test('超大版本段按十进制精确比较，避免 C int 和 JS Number 溢出', async () => {
  for (const [current, next, newer] of [
    ['9007199254740992.0.0', '9007199254740993.0.0', true],
    ['999999999999999999999.0.0', '1000000000000000000000.0.0', true],
    ['999999999999999999999.2.3', '0999999999999999999999.2.3', false],
    ['999999999999999999999.0.0', '999999999999999999998.9.9', false]
  ]) {
    const f = fixture(current, () => response(update(next)));
    assert.equal((await f.px.system.otaCheck('http://manifest.invalid')) !== null, newer);
  }
});

await test('字段采用原 opt_str_prop 转换，空 notes 省略', async () => {
  for (const notes of [undefined, null, '']) {
    const f = fixture('1.0.0', () => response(update('2.0.0', notes)));
    assert.deepEqual(plain(await f.px.system.otaCheck('http://manifest.invalid')), update('2.0.0'));
  }
  for (const [manifest, expected] of [
    [{version: 2, url: 123, notes: false}, {version: '2', url: '123', notes: 'false'}],
    [{version: '2.0.0', url: ['a', 'b'], notes: 0}, {version: '2.0.0', url: 'a,b', notes: '0'}]
  ]) {
    const f = fixture('1.0.0', () => response(manifest));
    assert.deepEqual(plain(await f.px.system.otaCheck('http://manifest.invalid')), expected);
  }
});

await test('无效根值及 version/url 缺失或空值均拒绝', async () => {
  for (const manifest of [null, true, 12, 'text', [], {}, {version: '2'}, {url: 'image'},
    {version: '', url: 'image'}, {version: null, url: 'image'}, {version: '2', url: null},
    {version: '2', url: ''}]) {
    const f = fixture('1.0.0', () => response(manifest));
    await assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), {message: 'manifest 缺少 version/url 字段'});
    assert.equal(f.state().pending, 0);
  }
});

await test('仅接受 HTTP 200，错误状态不解析 JSON', async () => {
  for (const status of [201, 204, 301, 304, 404, 500]) {
    let parsed = false;
    const f = fixture('1.0.0', () => ({status, json() { parsed = true; throw new Error('must not parse'); }}));
    await assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), {message: 'OTA manifest 获取失败: HTTP ' + status});
    assert.equal(parsed, false);
    assert.equal(f.state().pending, 0);
  }
});

await test('JSON 语法异常保持原异常；网络失败包含原错误原因', async () => {
  const syntax = new SyntaxError('bad manifest JSON');
  const malformed = fixture('1.0.0', () => ({status: 200, json() { return Promise.reject(syntax); }}));
  await assert.rejects(malformed.px.system.otaCheck('http://manifest.invalid'), error => error === syntax);
  for (const synchronous of [true, false]) {
    const f = fixture('1.0.0', () => {
      const error = new Error('ETIMEDOUT: HTTP request');
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    await assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), {message: 'OTA manifest 获取失败: ETIMEDOUT: HTTP request'});
    assert.equal(f.state().pending, 0);
  }
});

await test('并发查询乱序完成与单个失败彼此独立', async () => {
  const first = deferred(), second = deferred(), third = deferred();
  const tasks = [first, second, third];
  const f = fixture('1.0.0', () => tasks.shift().promise);
  const a = f.px.system.otaCheck('a'), b = f.px.system.otaCheck('b');
  const c = assert.rejects(f.px.system.otaCheck('c'), /network failed/);
  assert.equal(f.state().pending, 3);
  second.resolve(response(update('3.0.0')));
  third.reject(new Error('network failed'));
  assert.equal((await b).version, '3.0.0'); await c;
  assert.equal(f.state().pending, 1);
  first.resolve(response(update('2.0.0')));
  assert.equal((await a).version, '2.0.0'); assert.equal(f.state().pending, 0);
});

await test('应用退出取消所有查询；迟到响应不解析、不重复结算', async () => {
  const network = deferred(); let parsed = 0, rejected = 0, resolved = 0;
  const f = fixture('1.0.0', () => network.promise);
  const pending = f.px.system.otaCheck('http://manifest.invalid').then(() => { ++resolved; }, error => {
    ++rejected; assert.match(error.message, /ECANCELED: application exited/);
  });
  f.exit(); f.exit(); await pending;
  assert.equal(f.state().pending, 0); assert.equal(f.state().active, false);
  network.resolve({status: 200, json() { ++parsed; return update('2.0.0'); }});
  await flush(); assert.equal(parsed, 0); assert.equal(rejected, 1); assert.equal(resolved, 0);
  await assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), /ECANCELED: OTA context is closed/);
  assert.equal(f.calls.length, 1);
});

await test('JSON 已开始时退出也拒绝旧查询，迟到解析结果被丢弃', async () => {
  const body = deferred(); let parsing = false;
  const f = fixture('1.0.0', () => ({status: 200, json() { parsing = true; return body.promise; }}));
  const pending = assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), /ECANCELED/);
  await flush(); assert(parsing); f.exit(); await pending;
  body.resolve(update('2.0.0')); await flush(); assert.equal(f.state().pending, 0);
});

await test('退出后的网络拒绝被内部消费，不产生未处理 Promise', async () => {
  const network = deferred(), events = [];
  const onUnhandled = error => events.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const f = fixture('1.0.0', () => network.promise);
    const pending = assert.rejects(f.px.system.otaCheck('http://manifest.invalid'), /ECANCELED/);
    f.exit(); await pending; network.reject(new Error('late connection failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []); assert.equal(f.state().pending, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

console.log('OTA contract: ' + passed + ' passed');
