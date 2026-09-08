import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const component = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'pixelbox-streaming-'));
const json = join(process.env.IDF_PATH || join(homedir(), 'esp/esp-idf'), 'components/json/cJSON');
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
run('cc', ['-fsanitize=undefined', '-g', '-Wno-deprecated-declarations', '-c', join(json, 'cJSON.c'), '-o', join(build, 'cjson.o')]);
run('c++', ['-std=c++17', '-fsanitize=undefined', '-g', '-Wall', '-Wextra', '-Werror',
    '-I' + join(component, 'src'), '-I' + resolve(component, '../hal_net/include'), '-I' + json,
    join(component, 'tests/speech_protocol_test.cpp'), join(build, 'cjson.o'), '-o', join(build, 'test')]);
run(join(build, 'test'), []);
const websocket = readFileSync(resolve(component, '../bindings_net/src/mod_websocket.cpp'), 'utf8');
const begin = websocket.indexOf('static bool ws_submit_work(');
const end = websocket.indexOf('\n/**', begin);
if (begin < 0 || end < 0) throw new Error('WebSocket worker function was not found');
writeFileSync(join(build, 'websocket_queue.inc'), websocket.slice(begin, end));
run('c++', ['-std=c++17', '-fsanitize=undefined', '-g', '-Wall', '-Wextra', '-Werror', '-pthread',
    '-I' + build, join(component, 'tests/websocket_queue_test.cpp'), '-o', join(build, 'queue-test')]);
run(join(build, 'queue-test'), []);
const engine = readFileSync(join(component, 'src/speech_engine.cpp'), 'utf8');
const eventStart = engine.indexOf('    static void event(');
const eventEnd = engine.indexOf('    bool start(', eventStart);
if (eventStart < 0 || eventEnd < 0) throw new Error('Speech WebSocket event handler was not found');
writeFileSync(join(build, 'speech_socket_event.inc'), engine.slice(eventStart, eventEnd));
run('c++', ['-std=c++17', '-fsanitize=undefined', '-g', '-Wall', '-Wextra', '-Werror',
    '-I' + build, '-I' + join(component, 'src'), '-I' + resolve(component, '../hal_net/include'), '-I' + json,
    join(component, 'tests/speech_socket_event_test.cpp'), join(build, 'cjson.o'), '-o', join(build, 'event-test')]);
run(join(build, 'event-test'), []);
