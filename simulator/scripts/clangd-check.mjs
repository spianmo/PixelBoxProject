#!/usr/bin/env node
/**
 * clangd LSP 协议冒烟(无 GUI,纯 Node)
 *
 * 验证 main/clangd.ts 的全部协议假设在真实 clangd + 真实固件工程上成立:
 *   1. 解析 clangd(PATH → /usr/bin/clangd;与 resolveClangd 的自动链一致)
 *   2. 以与 ClangdSession 相同的参数拉起 clangd
 *      (--compile-commands-dir=<smoke>/build + --query-driver=~/.espressif/…)
 *   3. stdio LSP 分帧收发:initialize → initialized → didOpen(main.c 末尾
 *      追加探针函数,函数体内含前缀 'esp_')→ 等首次 publishDiagnostics
 *      (AST 构建完成的信号;过早请求会落入 identifier fallback 模式)
 *      → textDocument/completion
 *   4. 断言补全列表非空,且含以 'esp_' 开头的条目(ESP-IDF 头文件被真实解析)
 *   5. 断言 hover 返回 esp_ 函数的 doc(悬停查看文档链路),以及
 *      textDocument/definition 从「esp_ 函数调用处 / #include 行」解析到
 *      工作区之外的真实存在的 IDF 头文件(⌘+点击跳头文件链路的 LSP 腿)
 *
 * 用法:cd simulator && pnpm run check:clangd
 * 前置:/tmp/pb-fw-smoke/smoke 已构建(缺失打印 SKIP 退出 0,CI 机器友好)
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SMOKE_ROOT = '/tmp/pb-fw-smoke/smoke'
const MAIN_C = join(SMOKE_ROOT, 'main', 'main.c')
const OVERALL_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 60_000 // 首次解析 ESP-IDF 头文件较慢,给足余量

function skip(reason) {
  console.log(`[clangd-check] SKIP:${reason}`)
  process.exit(0)
}

// ---- 1. 解析 clangd(与 main/clangd.ts resolveClangd 的自动链一致,无设置层) ----
function resolveClangd() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['clangd'], {
    encoding: 'utf8'
  })
  const found = which.status === 0 ? which.stdout.split('\n')[0]?.trim() : ''
  if (found && existsSync(found)) return found
  return existsSync('/usr/bin/clangd') ? '/usr/bin/clangd' : null
}

const clangdPath = resolveClangd()
if (!clangdPath) skip('未找到 clangd(PATH 或 /usr/bin/clangd)')
if (!existsSync(join(SMOKE_ROOT, 'build', 'compile_commands.json'))) {
  skip(`缺少 ${SMOKE_ROOT}/build/compile_commands.json(先构建 smoke 固件工程)`)
}
if (!existsSync(MAIN_C)) skip(`缺少 ${MAIN_C}`)

console.log(`[clangd-check] clangd = ${clangdPath}`)

// ---- 2. 与 ClangdSession 相同的参数拉起 ----
const proc = spawn(
  clangdPath,
  [
    '--background-index',
    '--compile-commands-dir=' + join(SMOKE_ROOT, 'build'),
    '--query-driver=' + join(homedir(), '.espressif', 'tools', '**', 'bin', '*'),
    '--log=error',
    '--pch-storage=memory',
    '--limit-results=80'
  ],
  { stdio: ['pipe', 'pipe', 'pipe'], cwd: SMOKE_ROOT }
)
proc.stderr.on('data', () => undefined)

// ---- 3. 最小 LSP 客户端(Content-Length 分帧 + id 跟踪),镜像 ClangdSession ----
let buffer = Buffer.alloc(0)
let nextId = 1
const pending = new Map()
/**
 * main.c 的首次 publishDiagnostics(didOpen 后 AST 构建完成的信号)。
 * 必须按 uri 过滤:工程存在 .clangd 时,clangd 会先为配置文件本身发布一条
 * (空)诊断,误当就绪信号会让补全撞上未就绪的 AST(识别符回退,仅 2 项)
 */
let resolveFirstDiagnostics
const firstDiagnostics = new Promise((res) => {
  resolveFirstDiagnostics = res
})

proc.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const m = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    const total = headerEnd + 4 + len
    if (buffer.length < total) return
    const body = buffer.subarray(headerEnd + 4, total).toString('utf8')
    buffer = buffer.subarray(total)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'lsp error'))
        else p.resolve(msg.result)
      }
    } else if (
      msg.method === 'textDocument/publishDiagnostics' &&
      msg.params?.uri === 'file://' + MAIN_C
    ) {
      resolveFirstDiagnostics(msg.params)
    } else if (typeof msg.method === 'string' && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: null }) // 服务器请求统一回空
    }
  }
})

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
  proc.stdin.write(body)
}

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`请求超时:${method}`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function fail(message) {
  console.error(`[clangd-check] ✗ ${message}`)
  console.log('[clangd-check] FAIL')
  proc.kill()
  process.exit(1)
}

const overallTimer = setTimeout(() => fail(`总超时(${OVERALL_TIMEOUT_MS}ms)`), OVERALL_TIMEOUT_MS)

// ---- 4. initialize → didOpen(追加 esp_ 探针)→ completion → 断言 ----
try {
  await request('initialize', {
    processId: process.pid,
    rootUri: 'file://' + SMOKE_ROOT,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        completion: {
          completionItem: {
            snippetSupport: false,
            documentationFormat: ['markdown', 'plaintext']
          }
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: {},
        declaration: {},
        publishDiagnostics: {}
      }
    }
  })
  notify('initialized', {})
  console.log('[clangd-check] ✓ initialize 握手完成')

  // main.c 末尾追加探针函数,体内一行 '  esp_' —— 在其后请求补全
  const original = readFileSync(MAIN_C, 'utf8')
  const base = original.replace(/\n?$/, '\n') // 保证末尾恰一个换行
  const probeLines = ['', 'void __pb_clangd_probe(void)', '{', '  esp_', '}', '']
  const text = base + probeLines.join('\n')
  // base 含 N 个换行 → 探针块首行(空行)为 0-based 第 N 行,'  esp_' 在其后第 3 行
  const probeLine = base.split('\n').length - 1 + 3
  const probeChar = 6 // '  esp_' 之后

  const uri = 'file://' + MAIN_C
  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'c', version: 1, text }
  })
  console.log(`[clangd-check] ✓ didOpen(探针位于 ${probeLine + 1} 行,前缀 esp_)`)

  // 等 AST 构建完成(首次诊断推送)再补全 —— 否则命中 identifier fallback,
  // 只会回显文件内已出现的标识符,无法证明 ESP-IDF 头文件被解析
  const diagStart = Date.now()
  const diags = await firstDiagnostics
  console.log(
    `[clangd-check] ✓ 首次 publishDiagnostics(${Date.now() - diagStart}ms,` +
      `${diags.diagnostics?.length ?? 0} 条诊断 —— AST 就绪)`
  )

  const completion = await request('textDocument/completion', {
    textDocument: { uri },
    position: { line: probeLine, character: probeChar }
  })

  const items = Array.isArray(completion) ? completion : (completion?.items ?? [])
  if (items.length === 0) fail('补全列表为空(compile_commands / query-driver 解析失败?)')
  const espItems = items.filter((it) =>
    String(it.filterText ?? it.insertText ?? it.label).startsWith('esp_')
  )
  console.log(
    `[clangd-check] ✓ 补全非空:共 ${items.length} 项,esp_ 前缀 ${espItems.length} 项` +
      `(如:${items.slice(0, 5).map((it) => it.label.trim()).join('、')})`
  )
  if (espItems.length === 0) fail("补全列表不含 'esp_' 前缀条目(ESP-IDF 头文件未被解析)")
  const documented = items.filter((it) => it.documentation).length
  console.log(`[clangd-check] ✓ 补全条目含 documentation:${documented} 项(联想查看函数 doc)`)

  // ---- 5. hover doc + 定义跳转(⌘+点击跳头文件链路的 LSP 腿) ----
  const textLines = text.split('\n')

  /** 在原文中定位一个 esp_ 函数调用(模板 main.c 恒有,如 esp_get_free_heap_size()) */
  const callRe = /\b(esp_\w+)\s*\(/
  const callLineIdx = textLines.findIndex((l) => callRe.test(l))
  if (callLineIdx < 0) fail('main.c 中未找到 esp_ 函数调用(冒烟工程模板变更?)')
  const callName = callRe.exec(textLines[callLineIdx])[1]
  const callChar = textLines[callLineIdx].indexOf(callName) + 2 // 名字中间,避开词边界歧义

  const hover = await request('textDocument/hover', {
    textDocument: { uri },
    position: { line: callLineIdx, character: callChar }
  })
  const hoverText =
    typeof hover?.contents === 'string' ? hover.contents : (hover?.contents?.value ?? '')
  if (!hoverText || hoverText.trim().length === 0) fail(`hover(${callName})返回空 contents`)
  console.log(
    `[clangd-check] ✓ hover(${callName})返回 doc(${hoverText.length} 字符,` +
      `首行:${hoverText.split('\n').find((l) => l.trim())?.trim().slice(0, 60)})`
  )

  /** definition 结果归一化(Location | Location[] | LocationLink[])→ 路径列表 */
  const defPaths = (defs) => {
    const arr = Array.isArray(defs) ? defs : defs ? [defs] : []
    return arr
      .map((d) => d.uri ?? d.targetUri)
      .filter((u) => typeof u === 'string' && u.startsWith('file://'))
      .map((u) => decodeURIComponent(u.slice('file://'.length)))
  }

  const defAtCall = defPaths(
    await request('textDocument/definition', {
      textDocument: { uri },
      position: { line: callLineIdx, character: callChar }
    })
  )
  if (defAtCall.length === 0) fail(`definition(${callName})无结果`)
  const external = defAtCall.find((p) => !p.startsWith(SMOKE_ROOT + '/') && existsSync(p))
  if (!external) fail(`definition(${callName})未解析到工作区外的真实文件:${defAtCall.join(', ')}`)
  console.log(`[clangd-check] ✓ definition(${callName})→ ${external}(工作区外,文件存在)`)

  // #include 行上的 definition:⌘+点击 include 打开对应头文件
  const incLineIdx = textLines.findIndex((l) => /^\s*#\s*include\s*[<"]/.test(l))
  if (incLineIdx < 0) fail('main.c 中未找到 #include 行')
  const defAtInclude = defPaths(
    await request('textDocument/definition', {
      textDocument: { uri },
      position: { line: incLineIdx, character: textLines[incLineIdx].indexOf('#') + 12 }
    })
  )
  const incTarget = defAtInclude.find((p) => existsSync(p))
  if (!incTarget) fail(`definition(#include 行)未解析到存在的头文件:${defAtInclude.join(', ')}`)
  console.log(`[clangd-check] ✓ definition(#include 行)→ ${incTarget}`)

  clearTimeout(overallTimer)
  console.log('[clangd-check] PASS')
  proc.kill()
  process.exit(0)
} catch (err) {
  fail(String(err?.message ?? err))
}
