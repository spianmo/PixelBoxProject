import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const component = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'pixelbox-wake-'));
const engine = readFileSync(join(component, 'src/speech_engine.cpp'), 'utf8');
const begin = engine.indexOf('    const char* configure_wake(');
const end = engine.indexOf('    const char* load()', begin);
if (begin < 0 || end < 0) throw new Error('Wake registration method was not found');
writeFileSync(join(build, 'wake_registration.inc'), engine.slice(begin, end));
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
run('c++', ['-std=c++17', '-fsanitize=undefined', '-g', '-Wall', '-Wextra', '-Werror',
    '-I' + build, '-I' + join(component, 'src'),
    join(component, 'tests/wake_registration_test.cpp'), '-o', join(build, 'test')]);
run(join(build, 'test'), []);
