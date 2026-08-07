/**
 * CircuitWebWorker 单例管理(硬件设计 tsx → Circuit JSON)
 *
 * 硬性约束(设计文档 §1,实测确认):
 * - 渲染进程严禁 import '@tscircuit/eval' 包根或 '@tscircuit/core'
 *   (包根顶层拉 core → react-reconciler@0.32 在 React18 下 import 即崩);
 *   唯一安全入口是 '@tscircuit/eval/worker'(仅依赖 comlink)+
 *   '@tscircuit/eval/blob-url'(~14MB 自包含 worker,内置自己的 React)。
 * - blob-url 体积大 → 两者均走动态 import() 懒加载(首次评估时才拉取)。
 * - 离线保障:disableCdnLoading + partsEngineDisabled,不访问任何 CDN。
 * - eval 可能卡死:30s 超时;超时/异常后 kill() 并置空单例,下次调用自动重建。
 */
import type { AnyCircuitElement } from 'circuit-json'
import type { CircuitWebWorker } from '@tscircuit/eval/worker'

/** 单次评估超时(自动布线偶发卡死的兜底) */
const EVAL_TIMEOUT_MS = 30_000

/** 全局单例(Promise 形态:并发调用共享同一次创建) */
let workerPromise: Promise<CircuitWebWorker> | null = null

async function createWorker(): Promise<CircuitWebWorker> {
  // 懒加载:worker 封装(comlink)与 14MB blob-url 均在首次评估时才进内存
  const [{ createCircuitWebWorker }, blobUrlModule] = await Promise.all([
    import('@tscircuit/eval/worker'),
    import('@tscircuit/eval/blob-url')
  ])
  return createCircuitWebWorker({
    webWorkerBlobUrl: blobUrlModule.default,
    disableCdnLoading: true,
    projectConfig: { partsEngineDisabled: true }
  })
}

function getWorker(): Promise<CircuitWebWorker> {
  if (!workerPromise) {
    workerPromise = createWorker().catch((err) => {
      // 创建失败不留死单例,下次调用重试
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

/** 杀掉当前 worker 并重置单例(超时/评估异常后调用,下次评估自动重建) */
async function destroyWorker(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.kill()
  } catch {
    // worker 已死或从未建成,忽略
  }
}

/**
 * 以 fsMap(design/ 下相对路径 → 源码)评估 tscircuit 电路,返回 Circuit JSON。
 * 每次成功评估返回【新数组引用】(PCBViewer 依赖引用变化刷新)。
 * 超时或评估异常:销毁 worker 单例后抛错(超时错误码 'hardware:evalTimeout')。
 */
export async function evalTsxFsMap(
  fsMap: Record<string, string>,
  entry: string
): Promise<AnyCircuitElement[]> {
  const worker = await getWorker()
  let timer = 0
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error('hardware:evalTimeout')), EVAL_TIMEOUT_MS)
  })
  try {
    const circuitJson = await Promise.race([
      (async () => {
        // mainComponentPath(非 entrypoint):设计文件按约定默认导出电路组件;
        // entrypoint 语义要求文件内显式 circuit.add(...),与模板不符
        await worker.executeWithFsMap({ fsMap, mainComponentPath: entry })
        await worker.renderUntilSettled()
        return worker.getCircuitJson()
      })(),
      timeout
    ])
    // 新数组引用(comlink 返回的已是结构化克隆,再浅拷贝一层保证引用变化语义)
    return [...circuitJson]
  } catch (err) {
    // 超时/异常一律重建(卡死的 worker 无法复用;编译错误场景重建代价可接受)
    void destroyWorker()
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    window.clearTimeout(timer)
  }
}
