import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const build = process.argv[2] || resolve(root, 'build_speech');
const archive = readFileSync(resolve(build, 'srmodels/srmodels.bin'));
const header = readFileSync(resolve(build, 'esp-idf/bindings_speech/speech_model_hashes.hpp'), 'utf8');
const hashes = [...header.matchAll(/"([0-9a-f]{64})"/g)].map((match) => match[1]);
assert.equal(hashes.length, 4);
const files = ['mn7_index', 'mn7_data', 'vocab', '_MODEL_INFO_'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let offset = 4;
let checked = 0;
for (let i = 0; i < archive.readUInt32LE(0); i++) {
    const model = archive.subarray(offset, offset + 32).toString().split('\0')[0];
    const count = archive.readUInt32LE(offset + 32);
    offset += 36;
    for (let j = 0; j < count; j++, offset += 40) {
        const name = archive.subarray(offset, offset + 32).toString().split('\0')[0];
        const slot = files.indexOf(name);
        if (model !== 'mn7_cn' || slot < 0) continue;
        const start = archive.readUInt32LE(offset + 32), size = archive.readUInt32LE(offset + 36);
        const payload = archive.subarray(start, start + size);
        assert.equal(digest(payload), hashes[slot], name);
        assert.equal(digest(readFileSync(resolve(root, 'managed_components/espressif__esp-sr/model/multinet_model/mn7_cn', name))), hashes[slot]);
        const damaged = Buffer.from(payload);
        damaged[Math.floor(damaged.length / 2)] ^= 1;
        assert.notEqual(digest(damaged), hashes[slot]);
        assert.notEqual(digest(payload.subarray(0, payload.length - 1)), hashes[slot]);
        checked++;
    }
}
assert.equal(checked, 4);
console.log('speech model hashes: actual packed/source payloads match; bit corruption and truncation rejected');
