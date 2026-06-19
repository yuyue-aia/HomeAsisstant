/**
 * 通过 MAC 地址定位 Gosund / 米家插板的当前 IP。
 *
 * 思路：
 *  1) 优先使用缓存的 IP（缓存文件 + 内存）；
 *  2) 命中后由调用方直接连接；连接失败再调用 discoverIpByMac() 重新发现；
 *  3) 发现流程：
 *     a) 向 255.255.255.255:54321 和 192.168.0.255:54321 发 MiIO Hello 广播
 *        （部分路由器禁广播包到子网，加 192.168.x.255 提高命中率）
 *     b) 收集所有响应的源 IP（这些都是米家协议设备）
 *     c) 对这些 IP 调用 system arp 命令查 MAC，匹配目标 MAC 即返回
 *
 * 注意：MAC 不会变，IP 可能因 DHCP 续约而变化，因此把 MAC 作为权威标识。
 */

import * as dgram from 'dgram';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

const MIIO_PORT = 54321;
const HELLO_PACKET = Buffer.from(
  '21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

const CACHE_FILE = path.resolve(process.cwd(), '.runtime/gosund-plug-ip.json');

/** 标准化 MAC：小写，冒号分隔，单字节补 0。 */
export function normalizeMac(mac: string): string {
  return mac
    .trim()
    .toLowerCase()
    .split(/[:\-]/)
    .map((part) => part.padStart(2, '0'))
    .join(':');
}

interface IpCache {
  mac: string;
  ip: string;
  updatedAt: number;
}

let memoryCache: IpCache | null = null;

async function readCache(): Promise<IpCache | null> {
  if (memoryCache) return memoryCache;
  try {
    const text = await fs.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(text) as IpCache;
    if (parsed && parsed.mac && parsed.ip) {
      memoryCache = parsed;
      return parsed;
    }
  } catch {
    /* 不存在或解析失败都视为无缓存 */
  }
  return null;
}

async function writeCache(mac: string, ip: string): Promise<void> {
  const cache: IpCache = { mac: normalizeMac(mac), ip, updatedAt: Date.now() };
  memoryCache = cache;
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* 缓存写失败不致命 */
  }
}

/** 读取目标 MAC 对应的缓存 IP（不主动发现）。 */
export async function getCachedIpByMac(mac: string): Promise<string | null> {
  const target = normalizeMac(mac);
  const cache = await readCache();
  if (cache && cache.mac === target) return cache.ip;
  return null;
}

/** 收集广播响应的 IP 列表。 */
function collectMiioPeers(timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolve) => {
    const peers = new Set<string>();
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      resolve(Array.from(peers));
    }, timeoutMs);

    sock.on('message', (msg, rinfo) => {
      if (msg.length >= 4 && msg.subarray(0, 4).toString('hex') === '21310020') {
        peers.add(rinfo.address);
      }
    });
    sock.on('error', () => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* noop */ }
      resolve(Array.from(peers));
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send(HELLO_PACKET, MIIO_PORT, '255.255.255.255');
        sock.send(HELLO_PACKET, MIIO_PORT, '192.168.0.255');
      } catch {
        /* 发送失败由 timeout 兜底 */
      }
    });
  });
}

/** 调用系统 arp 拿某个 IP 的 MAC（macOS / Linux 通用语法）。 */
async function arpLookup(ip: string): Promise<string | null> {
  try {
    // 注意：macOS 的 `arp -an <ip>` 会报错，需用 `arp -n <ip>`；Linux 也支持。
    const { stdout } = await execAsync(`arp -n ${ip}`);
    // 形如：? (192.168.0.12) at 0:50:79:f1:47:59 on en0 ifscope [ethernet]
    const match = stdout.match(/at\s+([0-9a-fA-F:]{11,17})\s/);
    if (!match) return null;
    return normalizeMac(match[1]);
  } catch {
    return null;
  }
}

/**
 * 主流程：广播发现米家设备 → 按 MAC 匹配 → 命中后写缓存。
 *
 * @returns 找到的 IP；找不到返回 null。
 */
export async function discoverIpByMac(targetMac: string): Promise<string | null> {
  const target = normalizeMac(targetMac);
  const peers = await collectMiioPeers();
  // MiIO 收到的回包在 OS 层已解析 ARP，但用户态还要再去查 arp 表，
  // 偶尔 arp 命令会落在 peer 收到响应之前。再各 ping 一次，确保 arp 表有条目。
  await Promise.all(
    peers.map((ip) =>
      execAsync(`ping -c 1 -W 500 ${ip}`).catch(() => null),
    ),
  );
  for (const ip of peers) {
    const mac = await arpLookup(ip);
    if (mac && mac === target) {
      await writeCache(target, ip);
      return ip;
    }
  }
  return null;
}

/**
 * 解析 IP：先用 cache，其次 fallback 到 envIp。如调用方连接失败，
 * 应再调一次 discoverIpByMac() 重新发现。
 */
export async function resolvePlugIp(
  mac: string | undefined,
  envIp: string | undefined,
): Promise<string | undefined> {
  if (mac) {
    const cached = await getCachedIpByMac(mac);
    if (cached) return cached;
  }
  return envIp;
}

/** 在某个连接失败后调用：清缓存（仅当 mac 匹配）。 */
export async function invalidateCacheForMac(mac: string): Promise<void> {
  const cache = await readCache();
  if (cache && cache.mac === normalizeMac(mac)) {
    memoryCache = null;
    try { await fs.unlink(CACHE_FILE); } catch { /* noop */ }
  }
}
