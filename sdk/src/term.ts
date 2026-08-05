/**
 * 终端彩色输出工具(CLI 专用)
 */
import pc from 'picocolors';
import type { DevdAppStateData, DevdLogData } from './protocol';
import type { DiscoveredDevice } from './discovery';

/** 统一的状态输出 */
export const term = {
  info(msg: string): void {
    console.log(`${pc.cyan('>')} ${msg}`);
  },
  ok(msg: string): void {
    console.log(`${pc.green('+')} ${msg}`);
  },
  warn(msg: string): void {
    console.log(`${pc.yellow('!')} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${pc.red('x')} ${msg}`);
  },
  dim(msg: string): void {
    console.log(pc.dim(msg));
  },
};

/** 字节数人类可读格式化 */
export function fmtBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function pad2(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 日志时间戳格式化:Unix 毫秒 → 本地时钟;开机毫秒 → +秒 */
function fmtLogTs(ts: number): string {
  if (ts > 1e12) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad2(d.getMilliseconds(), 3)}`;
  }
  return `+${(ts / 1000).toFixed(3)}s`;
}

/**
 * 把设备主动事件格式化为一行彩色文本;未知事件降级为 JSON 摘要
 */
export function formatDeviceEvent(event: string, data: unknown): string {
  if (event === 'log') {
    const d = (data ?? {}) as Partial<DevdLogData>;
    const level = typeof d.level === 'string' ? d.level : 'info';
    const tag = typeof d.tag === 'string' ? d.tag : '';
    const msg = typeof d.msg === 'string' ? d.msg : JSON.stringify(data);
    const time = fmtLogTs(typeof d.ts === 'number' ? d.ts : Date.now());
    const levelText = level.toUpperCase().padEnd(5);
    let colored: string;
    switch (level) {
      case 'error':
        colored = pc.red(levelText);
        break;
      case 'warn':
        colored = pc.yellow(levelText);
        break;
      case 'debug':
        colored = pc.gray(levelText);
        break;
      default:
        colored = pc.green(levelText);
        break;
    }
    return `${pc.dim(time)} ${colored} ${pc.cyan(tag)} ${msg}`;
  }

  if (event === 'app.state') {
    const d = (data ?? {}) as Partial<DevdAppStateData>;
    const state = typeof d.state === 'string' ? d.state : 'unknown';
    const stateLabels: Record<string, string> = {
      running: '运行中',
      stopped: '已停止',
      updating: '更新中',
      crashed: '已崩溃',
    };
    const label = stateLabels[state] ?? state;
    const line = `应用状态: ${label}${d.error ? ` (${d.error})` : ''}`;
    return state === 'crashed' ? pc.red(line) : pc.magenta(line);
  }

  return pc.dim(`[事件 ${event}] ${JSON.stringify(data)}`);
}

/** 打印设备列表表格 */
export function printDeviceTable(devices: DiscoveredDevice[]): void {
  console.log(pc.bold('  编号  名称                      IP               端口   型号 / 固件 / 应用'));
  devices.forEach((d, i) => {
    const meta = [d.txt['model'], d.txt['fw'], d.txt['app']].filter(Boolean).join(' / ');
    console.log(
      `  ${String(i + 1).padEnd(5)} ${d.name.padEnd(25)} ${d.ip.padEnd(16)} ${String(d.port).padEnd(6)} ${pc.dim(meta)}`,
    );
  });
}
