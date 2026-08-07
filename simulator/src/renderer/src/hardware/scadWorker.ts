/**
 * OpenSCAD 编译 Web Worker(openscad-wasm-prebuilt,~11MB wasm 内嵌 JS)
 *
 * 协议(postMessage):
 *   入:{ seq, code, part, fnOverride? }  —— part: 'base' | 'lid' | 'all'
 *   出:{ seq, ok: true, stl: ArrayBuffer(transfer), logs: string[] }
 *      { seq, ok: false, error: string, logs: string[] }
 *
 * 实测约束(Node 侧标定,浏览器同源):
 * - wasm 实例 callMain 一次后不可复用(二次调用触发 emscripten abort)——
 *   每次编译新建实例(init ~60ms,可忽略)
 * - 语法/求值错误经 printErr 输出且 callMain 非零或 abort;错误后输出文件不存在
 * - --enable=manifold 提速 ~20%;$fn 主导耗时(模板 fn=16 ≈ 3.6s,fn=64 ≈ 19s),
 *   预览经 -D $fn=N 覆盖,导出用文件自带值
 */
import { createOpenSCAD } from 'openscad-wasm-prebuilt'

interface ScadRequest {
  seq: number
  code: string
  part: 'base' | 'lid' | 'all'
  /** 预览质量:覆盖文件 $fn;缺省用文件自带值(导出全质量) */
  fnOverride?: number
}

self.onmessage = async (ev: MessageEvent<ScadRequest>) => {
  const { seq, code, part, fnOverride } = ev.data
  const logs: string[] = []
  try {
    const inst = await createOpenSCAD({
      print: (l: string) => logs.push(l),
      printErr: (l: string) => logs.push(l)
    })
    const o = inst.getInstance()
    o.FS.writeFile('/in.scad', code)
    const args = [
      '/in.scad',
      '-o',
      '/out.stl',
      '--export-format=binstl',
      '--enable=manifold',
      '-D',
      `part="${part}"`
    ]
    if (fnOverride) args.push('-D', `$fn=${fnOverride}`)
    try {
      o.callMain(args)
    } catch {
      // emscripten 正常退出也以异常形态穿出 callMain;成败以输出文件为准
    }
    let stl: Uint8Array | null = null
    try {
      stl = o.FS.readFile('/out.stl', { encoding: 'binary' }) as Uint8Array
    } catch {
      stl = null
    }
    if (!stl || stl.length <= 84) {
      // 84 = 二进制 STL 最小长度(header+count);无输出 → 取日志里的错误行
      const errLine =
        logs.filter((l) => /error|warning.*ignor|abort/i.test(l)).slice(-3).join('\n') ||
        logs.slice(-3).join('\n') ||
        'scad:compileFailed'
      ;(self as unknown as Worker).postMessage({ seq, ok: false, error: errLine, logs })
      return
    }
    // 切出独立 ArrayBuffer 转移(emscripten FS 的 buffer 可能是共享大堆的视图)
    const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)
    ;(self as unknown as Worker).postMessage({ seq, ok: true, stl: buf, logs }, [buf])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs
    })
  }
}
