import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

const result = await build({
  entryPoints: [new URL('./checks/imu-pose.entry.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false
})
runInNewContext(result.outputFiles[0].text, { require: createRequire(import.meta.url), console }, { timeout: 60_000 })
