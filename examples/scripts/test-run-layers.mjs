import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ entryPoints: [root + 'sdk/src/run-layers.ts'],
    bundle: true, write: false, format: 'esm', target: 'es2020' });
const { fillRunLayers, fillRectLayers } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=run-layers.bundle.js').toString('base64')}`);

let passed = 0;
const failures = [];
function test(name, run) {
    try { run(); passed++; }
    catch (error) { failures.push({ name, error }); }
}
const detach = value => structuredClone(value.buffer, { transfer: [value.buffer] });
const emptyBounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, dx: 0, dy: 0, pixels: 0 };
const methods = [
    { name: 'runs', draw: fillRunLayers, geometry: [2, 2, 2, 6, 2, 1, 3, 4, 2], stride: 3,
        values: { count: 1, step: 1, scale: 1, layers: null, padding: 1, left: 0, right: 8,
            clipTop: 0, clipBottom: 16, margin: 0, color: 0x123456 } },
    { name: 'rects', draw: fillRectLayers, geometry: [1, 2, 3, 2, 0x123456, 6, 4, 2, 3, 0x654321], stride: 5,
        values: { count: 1, step: 1, scale: 1, x: 0, y: 0, layers: null } },
];
function setup(method) {
    const calls = [], input = new Int32Array(method.geometry), layers = new Int32Array([-1, 0, 0x223344, 1, 1, 0x556677]);
    const target = { width: 16, height: 16, _pixels: new Uint32Array(256),
        fillRect(...args) { assert.equal(this, target, 'fillRect 的 this 必须保持原目标'); calls.push(args); } };
    return { calls, input, layers, target };
}
function rejectBeforeDrawing(method, state, options, ErrorType, message) {
    assert.throws(() => method.draw(state.target, state.input, options), ErrorType, message);
    assert.deepEqual(state.calls, [], '无效输入不能先绘制部分画面');
}

// 所有 getter/valueOf 都可执行用户代码；任何底层缓冲被分离后均应在首次绘制前拒绝。
for (const method of methods) {
    for (const key of Object.keys(method.values)) for (const victim of ['input', 'layers', 'pixels']) {
        for (const throughValueOf of [false, true]) {
            if (key === 'layers' && throughValueOf) continue;
            test(`${method.name} options.${key} ${throughValueOf ? 'valueOf' : 'getter'} detach ${victim}`, () => {
                const state = setup(method), options = { layers: state.layers };
                const value = key === 'layers' ? state.layers : method.values[key];
                const run = () => { detach(victim === 'pixels' ? state.target._pixels : state[victim]); return value; };
                if (throughValueOf) options[key] = { valueOf: run };
                else Object.defineProperty(options, key, { get: run });
                rejectBeforeDrawing(method, state, options, TypeError);
            });
        }
    }
    for (const key of ['width', 'height', '_pixels', 'fillRect']) for (const victim of ['input', 'layers', 'pixels']) {
        for (const throughValueOf of [false, true]) {
            if (throughValueOf && key !== 'width' && key !== 'height') continue;
            test(`${method.name} target.${key} ${throughValueOf ? 'valueOf' : 'getter'} detach ${victim}`, () => {
                const state = setup(method), value = state.target[key], pixels = state.target._pixels;
                const run = () => { detach(victim === 'pixels' ? pixels : state[victim]); return value; };
                Object.defineProperty(state.target, key, { get: throughValueOf ? () => ({ valueOf: run }) : run });
                rejectBeforeDrawing(method, state, { layers: state.layers }, TypeError);
            });
        }
    }
    for (const victim of ['input', 'layers', 'pixels']) test(`${method.name} already detached ${victim}`, () => {
        const state = setup(method);
        detach(victim === 'pixels' ? state.target._pixels : state[victim]);
        rejectBeforeDrawing(method, state, { layers: state.layers }, TypeError);
    });

    test(`${method.name} getters/valueOf run once in contract order`, () => {
        const state = setup(method), trace = [], options = {};
        for (const key of ['width', 'height', '_pixels', 'fillRect']) {
            const value = state.target[key];
            Object.defineProperty(state.target, key, { get() {
                trace.push(`target.${key}`);
                return key === 'width' || key === 'height'
                    ? { valueOf() { trace.push(`target.${key}.valueOf`); return value; } } : value;
            } });
        }
        for (const key of Object.keys(method.values)) Object.defineProperty(options, key, { get() {
            trace.push(`options.${key}`);
            return key === 'layers' ? state.layers
                : { valueOf() { trace.push(`options.${key}.valueOf`); return method.values[key]; } };
        } });
        method.draw(state.target, state.input, options);
        assert.deepEqual(trace, ['target.width', 'target.width.valueOf', 'target.height', 'target.height.valueOf',
            'target._pixels', 'target.fillRect', ...Object.keys(method.values).flatMap(key =>
                key === 'layers' ? [`options.${key}`] : [`options.${key}`, `options.${key}.valueOf`])]);
        assert.ok(state.calls.length > 0);
    });
    for (const owner of ['target', 'options']) {
        const keys = owner === 'target' ? ['width', 'height', '_pixels', 'fillRect'] : Object.keys(method.values);
        for (const key of keys) test(`${method.name} ${owner}.${key} exception identity`, () => {
            const state = setup(method), marker = new Error('用户 getter 抛出的原始异常'), options = { layers: state.layers };
            Object.defineProperty(owner === 'target' ? state.target : options, key, { get() { throw marker; } });
            rejectBeforeDrawing(method, state, options, error => error === marker);
        });
        for (const key of keys.filter(key => owner === 'target' ? key === 'width' || key === 'height' : key !== 'layers')) {
            test(`${method.name} ${owner}.${key}.valueOf exception identity`, () => {
                const state = setup(method), marker = new Error('用户 valueOf 抛出的原始异常'), options = { layers: state.layers };
                (owner === 'target' ? state.target : options)[key] = { valueOf() { throw marker; } };
                rejectBeforeDrawing(method, state, options, error => error === marker);
            });
        }
    }

    // 已开始绘制后，回调分离/改写调用者的数组不能破坏本批快照或重新读取目标属性。
    for (const mutation of ['detach input', 'detach layers', 'detach both', 'overwrite']) {
        test(`${method.name} callback ${mutation} preserves snapshot`, () => {
            const expected = setup(method), actual = setup(method);
            const reference = method.draw(expected.target, expected.input, { layers: expected.layers, scale: 1.5 });
            const originalFill = actual.target.fillRect;
            actual.target.fillRect = function (...args) {
                originalFill.apply(this, args);
                if (actual.calls.length !== 1) return;
                if (mutation === 'overwrite') { actual.input.fill(0); actual.layers.fill(0); }
                else {
                    if (mutation === 'detach input' || mutation === 'detach both') detach(actual.input);
                    if (mutation === 'detach layers' || mutation === 'detach both') detach(actual.layers);
                }
                actual.target.width = 1; actual.target.height = 1;
                actual.target.fillRect = () => { throw new Error('绘制期间重新读取了 fillRect'); };
            };
            const result = method.draw(actual.target, actual.input, { layers: actual.layers, scale: 1.5 });
            assert.ok(expected.calls.length > 1, '必须覆盖首次回调之后的继续绘制');
            assert.deepEqual(actual.calls, expected.calls);
            assert.deepEqual(result, reference);
        });
    }

    for (const victim of ['input', 'layers']) test(`${method.name} overlapping ${victim}/pixels rejected`, () => {
        const state = setup(method), buffer = new ArrayBuffer(256);
        state.target._pixels = new Uint32Array(buffer, 16, 16);
        state[victim] = new Int32Array(buffer, 24, victim === 'input' ? method.stride : 3);
        state[victim].set(victim === 'input' ? method.geometry.slice(0, method.stride) : [1, 1, 0x123456]);
        rejectBeforeDrawing(method, state, { layers: state.layers }, RangeError);
    });
    test(`${method.name} disjoint views of same owner accepted`, () => {
        const state = setup(method), expected = setup(method), buffer = new ArrayBuffer(512);
        state.target._pixels = new Uint32Array(buffer, 16, 16);
        state.input = new Int32Array(buffer, 96, method.geometry.length); state.input.set(method.geometry);
        state.layers = new Int32Array(buffer, 192, expected.layers.length); state.layers.set(expected.layers);
        const result = method.draw(state.target, state.input, { layers: state.layers });
        const reference = method.draw(expected.target, expected.input, { layers: expected.layers });
        assert.deepEqual(state.calls, expected.calls); assert.deepEqual(result, reference);
        assert.deepEqual([...state.input], method.geometry); assert.deepEqual([...state.layers], [...expected.layers]);
    });
    test(`${method.name} geometry/layer overlap is safe when pixels are separate`, () => {
        const state = setup(method), expected = setup(method);
        state.layers = state.input.subarray(0, 3); expected.layers = new Int32Array(state.layers);
        const before = [...state.input], result = method.draw(state.target, state.input, { layers: state.layers });
        const reference = method.draw(expected.target, expected.input, { layers: expected.layers });
        assert.deepEqual(state.calls, expected.calls); assert.deepEqual(result, reference); assert.deepEqual([...state.input], before);
    });
    test(`${method.name} empty views do not alias pixels`, () => {
        const state = setup(method), empty = new Int32Array(state.target._pixels.buffer, 0, 0);
        const result = method.draw(state.target, empty, { layers: empty });
        assert.deepEqual(state.calls, []); assert.deepEqual(result, method.name === 'runs' ? emptyBounds : undefined);
    });
    test(`${method.name} null and undefined layers are empty`, () => {
        const expected = setup(method), reference = method.draw(expected.target, expected.input);
        for (const layers of [null, undefined, new Int32Array()]) {
            const state = setup(method), result = method.draw(state.target, state.input, { layers });
            assert.deepEqual(state.calls, expected.calls); assert.deepEqual(result, reference);
        }
    });
    test(`${method.name} input subview respects sentinels`, () => {
        const state = setup(method), expected = setup(method), buffer = new Int32Array(method.geometry.length + 2);
        buffer[0] = 123456; buffer[buffer.length - 1] = -654321; buffer.set(method.geometry, 1);
        state.input = buffer.subarray(1, -1);
        const before = [...buffer], result = method.draw(state.target, state.input, { layers: state.layers });
        const reference = method.draw(expected.target, expected.input, { layers: expected.layers });
        assert.deepEqual(state.calls, expected.calls); assert.deepEqual(result, reference); assert.deepEqual([...buffer], before);
    });
    test(`${method.name} empty live input draws nothing`, () => {
        const state = setup(method), result = method.draw(state.target, new Int32Array());
        assert.deepEqual(state.calls, []); assert.deepEqual(result, method.name === 'runs' ? emptyBounds : undefined);
    });
    for (const options of [null, 1, 'invalid']) test(`${method.name} invalid options ${options}`, () => {
        rejectBeforeDrawing(method, setup(method), options, TypeError);
    });
    for (const [key, values] of Object.entries({ count: [-1, .5, NaN, Infinity, 8193],
        step: [0, -1, NaN, Infinity, 2049], scale: [0, -1, NaN, Infinity, 1 / 4096, 2049] })) {
        for (const value of values) test(`${method.name} invalid ${key}=${value}`, () => {
            rejectBeforeDrawing(method, setup(method), { [key]: value }, RangeError);
        });
    }
    for (const value of [[], new Uint32Array(3), new Float64Array(3)]) test(`${method.name} invalid layers ${value.constructor.name}`, () => {
        rejectBeforeDrawing(method, setup(method), { layers: value }, TypeError);
    });
    for (const length of [1, 49, 51]) test(`${method.name} invalid layer length ${length}`, () => {
        rejectBeforeDrawing(method, setup(method), { layers: new Int32Array(length) }, RangeError);
    });
    for (const key of ['width', 'height']) for (const value of [0, -1, .5, NaN, Infinity, 2049]) {
        test(`${method.name} invalid target ${key}=${value}`, () => {
            const state = setup(method); state.target[key] = value;
            rejectBeforeDrawing(method, state, {}, RangeError);
        });
    }
    test(`${method.name} missing fillRect rejected`, () => {
        const state = setup(method); state.target.fillRect = undefined;
        rejectBeforeDrawing(method, state, {}, TypeError);
    });
}

// 使用手算端点断言，固定四次 Math.round 的顺序以及 ToInt32 的可观察结果。
const rectCases = [
    { label: 'positive half', geometry: [1, 1, 1, 1, 0x123456], options: { scale: 1.5 }, expected: [[2, 2, 1, 1, 0x123456]] },
    { label: 'negative half', geometry: [-2, -2, 3, 3, -1], options: { scale: .5 }, expected: [[-1, -1, 2, 2, 0xffffff]] },
    { label: 'zero after endpoint rounding', geometry: [-1, -1, 1, 1, 7], options: { scale: .5 }, expected: [] },
    { label: 'fractional rectangle step', geometry: [-2, -1, 3, 2, 7], options: { step: .5, x: .5 }, expected: [[0, 0, 1, 1, 7]] },
    { label: 'Int32 coordinate wrap at half', geometry: [2147483647, 0, 1, 1, 7], options: { x: .5 }, expected: [[-2147483648, 0, 1, 1, 7]] },
    { label: 'large exact products', geometry: [2147483647, -2147483648, 1, 1, -1], options: { step: 2048, scale: 2048, x: .5, y: -.5 },
        expected: [[-4193280, -1024, 4194304, 4194304, 0xffffff]] },
    { label: 'nonpositive rectangles skipped', geometry: [0, 0, 0, 1, 7, 0, 0, 1, -1, 7], options: {}, expected: [] },
];
for (const entry of rectCases) test(`rects ${entry.label}`, () => {
    const state = setup(methods[1]); fillRectLayers(state.target, new Int32Array(entry.geometry), entry.options);
    assert.deepEqual(state.calls, entry.expected);
});
test('runs merged width exceeds signed Int32 without overflow', () => {
    const state = setup(methods[0]), input = new Int32Array([-2147483648, 0, 2147483647, 0, 0, 2147483647]);
    const before = [...input], result = fillRunLayers(state.target, input, { padding: 0, color: 0x123456 });
    assert.deepEqual(state.calls, [[0, 0, 16, 1, 0x123456]]);
    assert.deepEqual(result, { left: 0, top: 0, right: 16, bottom: 1, dx: 0, dy: 0, pixels: 4294967294 });
    assert.deepEqual([...input], before);
});
test('runs extreme merged width survives scaled clipping', () => {
    const state = setup(methods[0]), input = new Int32Array([-2147483648, 0, 2147483647, 0, 0, 2147483647]);
    const result = fillRunLayers(state.target, input, { step: 2048, scale: .5, padding: 0, color: -1 });
    assert.deepEqual(state.calls, [[0, 0, 16, 16, 0xffffff]]);
    assert.deepEqual(result, { left: 0, top: 0, right: 32, bottom: 32, dx: 0, dy: 0, pixels: 4294967294 });
});
for (const geometry of [[0, 0, 0], [0, 0, -1], [0, 1, 1, 0, 0, 1], [0, 0, 2, 1, 0, 1],
    [2147483646, 0, 2, 2147483647, 0, 1]]) test(`runs invalid order/width ${geometry}`, () => {
    const state = setup(methods[0]); state.input = new Int32Array(geometry);
    rejectBeforeDrawing(methods[0], state, {}, RangeError);
});
test('runs fractional step rejected', () => rejectBeforeDrawing(methods[0], setup(methods[0]), { step: .5 }, RangeError));
test('runs count ignores records beyond requested prefix', () => {
    const state = setup(methods[0]);
    const result = fillRunLayers(state.target, new Int32Array([0, 0, 1, 0, -1, -1]), { count: 1, padding: 0 });
    assert.deepEqual(state.calls, [[0, 0, 1, 1, 0xffffff]]); assert.equal(result.pixels, 1);
});
test('runs logical bounds remain precise when physical rectangle rounds to zero', () => {
    const state = setup(methods[0]), result = fillRunLayers(state.target, new Int32Array([0, 0, 1]), { scale: .25, padding: 0 });
    assert.deepEqual(state.calls, []);
    assert.deepEqual(result, { left: 0, top: 0, right: 1, bottom: 1, dx: 0, dy: 0, pixels: 1 });
});
test('runs accepts maximum 8192 records and merges without changing count', () => {
    const state = setup(methods[0]), input = new Int32Array(8192 * 3);
    for (let i = 0; i < 8192; i++) input.set([i * 2, 0, 1], i * 3);
    const result = fillRunLayers(state.target, input);
    assert.deepEqual(state.calls, [[0, 0, 16, 2, 0xffffff]]); assert.equal(result.pixels, 8192);
});
test('rects accepts 16 layers and draws their bodies last', () => {
    const state = setup(methods[1]), layers = new Int32Array(48);
    for (let i = 0; i < 16; i++) layers.set([i, -i, i + 1], i * 3);
    fillRectLayers(state.target, new Int32Array([0, 0, 1, 1, 0x123456]), { layers });
    assert.deepEqual(state.calls, [...Array.from({ length: 16 }, (_, i) => [i, i ? -i : 0, 1, 1, i + 1]), [0, 0, 1, 1, 0x123456]]);
});

for (const { name, error } of failures) console.error(`FAIL ${name}: ${error.message}`);
if (failures.length) {
    console.error(`${failures.length} 组失败，${passed} 组通过`);
    process.exitCode = 1;
} else console.log(`PASS ${passed} 组批量图层 helper 边界：分离缓冲、getter 顺序、回调快照、别名、半像素与 Int32 极值`);
