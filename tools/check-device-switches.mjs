import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DevdClient } from '../sdk/dist/devd.js';
import { buildApp, collectPushFiles } from '../sdk/dist/build.js';

const host = process.argv[2] || '192.168.31.100';
const client = await DevdClient.connect(host);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    const boot = await client.subscribeLogs(Number.MAX_SAFE_INTEGER);
    const apps = [];
    for (const name of ['06-obeing-pixel', '07-obeing-harness'])
        apps.push(await buildApp(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), {}));
    for (const index of [1, 0, 1, 0, 1, 0]) {
        const app = apps[index];
        await client.pushApp(app.manifest, collectPushFiles(app));
        await pause(3000);
        const state = JSON.parse(await client.evalJs('JSON.stringify({uptime:performance.now(),memory:px.system.memory(),runtime:__pxRuntimeStats()})', 15000));
        const current = await client.subscribeLogs(Number.MAX_SAFE_INTEGER);
        assert.equal(current.boot, boot.boot, 'Device rebooted during application switch');
        assert.equal(state.runtime.executionTimeouts, 0);
        console.log(JSON.stringify({ app: app.manifest.id, boot: current.boot, ...state }));
    }
    console.log('Six full application switches passed without a device reboot; example6 restored.');
} finally { client.close(); }
