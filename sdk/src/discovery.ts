/**
 * mDNS 设备发现(bonjour-service)
 * 设备端 devd 广播 `_pixelbox._tcp`,TXT 携带 model / fw / app
 */
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';
import { isIP, isIPv4 } from 'node:net';
import { DEVD_DEFAULT_PORT, MDNS_SERVICE_TYPE } from './protocol';

/** 发现到的设备 */
export interface DiscoveredDevice {
  /** mDNS 实例名(devd hello 的 name 一致) */
  name: string;
  /** 主机名,如 pixelbox-abcd.local */
  host: string;
  /** 首选 IPv4 地址 */
  ip: string;
  /** devd 端口 */
  port: number;
  /** TXT 记录: model / fw / app */
  txt: Record<string, string>;
}

/** 连接目标(host 可为 IP 或 .local 主机名) */
export interface DeviceTarget {
  host: string;
  port: number;
  /** 用于展示的名称 */
  name: string;
}

/** 从 mDNS 服务记录中挑选首选地址:IPv4 且非链路本地优先 */
function pickAddress(service: Service): string | null {
  const addresses: string[] = Array.isArray(service.addresses) ? service.addresses : [];
  const v4 = addresses.filter((a) => isIPv4(a));
  const preferred = v4.find((a) => !a.startsWith('169.254.')) ?? v4[0];
  if (preferred) {
    return preferred;
  }
  if (addresses.length > 0 && addresses[0]) {
    return addresses[0];
  }
  return typeof service.host === 'string' && service.host !== '' ? service.host : null;
}

/**
 * 发现局域网内所有 PixelBox 设备(收集 timeoutMs 后返回)
 */
export function discoverDevices(timeoutMs = 3000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map<string, DiscoveredDevice>();
    const browser = bonjour.find({ type: MDNS_SERVICE_TYPE, protocol: 'tcp' });

    browser.on('up', (service: Service) => {
      const ip = pickAddress(service);
      if (!ip) {
        return;
      }
      const txt: Record<string, string> = {};
      const rawTxt = (service.txt ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawTxt)) {
        txt[key] = typeof value === 'string' ? value : String(value);
      }
      const device: DiscoveredDevice = {
        name: service.name,
        host: typeof service.host === 'string' ? service.host : ip,
        ip,
        port: service.port ?? DEVD_DEFAULT_PORT,
        txt,
      };
      found.set(`${device.name}|${device.ip}|${device.port}`, device);
    });

    setTimeout(() => {
      try {
        browser.stop();
        bonjour.destroy();
      } catch {
        /* 忽略销毁异常 */
      }
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}

/**
 * 解析 --device 参数中的直连地址:
 *   - "192.168.1.10"            → ip + 默认端口
 *   - "192.168.1.10:9000"       → ip + 指定端口
 *   - "pixelbox-abcd.local"     → mDNS 主机名 + 默认端口
 * 非直连地址(设备名称)返回 null,由调用方走 mDNS 匹配。
 */
export function parseDirectTarget(device: string): DeviceTarget | null {
  const m = /^(.+):(\d{1,5})$/.exec(device);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    const host = m[1];
    const port = Number(m[2]);
    if (port > 0 && port < 65536 && (isIP(host) !== 0 || host.endsWith('.local'))) {
      return { host, port, name: host };
    }
  }
  if (isIP(device) !== 0 || device.endsWith('.local')) {
    return { host: device, port: DEVD_DEFAULT_PORT, name: device };
  }
  return null;
}
