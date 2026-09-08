import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const component = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'pixelbox-tts-'));
const engine = readFileSync(join(component, 'src/speech_engine.cpp'), 'utf8');
function extract(start, end, name) {
    const begin = engine.indexOf(start);
    const finish = engine.indexOf(end, begin);
    if (begin < 0 || finish < 0) throw new Error(`Cannot find ${name}`);
    writeFileSync(join(build, name), engine.slice(begin, finish));
}
extract('struct Http {', '\nstd::string speech_timestamp()', 'tts_http.inc');
extract('struct TtsConnection {', '\nstruct Recording {', 'tts_connection.inc');
extract('void Engine::speak(', '\n}  // namespace speech', 'tts_speak.inc');
mkdirSync(join(build, 'freertos'));
mkdirSync(join(build, 'hal_common'));
writeFileSync(join(build, 'esp_heap_caps.h'), '#pragma once\n#include <cstdlib>\ninline void heap_caps_free(void* ptr) { std::free(ptr); }\n');
writeFileSync(join(build, 'esp_log.h'), '#pragma once\ninline void test_log(const char*, const char*, ...) {}\n#define ESP_LOGE(...) test_log(__VA_ARGS__)\n#define ESP_LOGI(...) test_log(__VA_ARGS__)\n#define ESP_LOGW(...) test_log(__VA_ARGS__)\n');
writeFileSync(join(build, 'freertos/FreeRTOS.h'), '#pragma once\n#include <cstdint>\n#define pdMS_TO_TICKS(value) (value)\n');
writeFileSync(join(build, 'freertos/task.h'), '#pragma once\nvoid vTaskDelay(unsigned ticks);\n');
writeFileSync(join(build, 'hal_common/px_alloc.h'), '#pragma once\n#include <cstdlib>\ninline void* px_alloc_prefer_psram(size_t size) { return std::malloc(size); }\n');
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
run('c++', ['-std=c++17', '-fsanitize=undefined', '-g', '-Wall', '-Wextra', '-Werror',
    '-I' + build, '-I' + resolve(component, '../hal_audio/include'),
    join(component, 'tests/tts_streaming_test.cpp'), resolve(component, '../hal_audio/src/audio_source.cpp'),
    '-o', join(build, 'test')]);
run(join(build, 'test'), []);
