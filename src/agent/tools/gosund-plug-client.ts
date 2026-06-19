/**
 * Gosund / MiHome 插座 miio 协议客户端（TypeScript 版）
 *
 * 协议说明（与 demos/gosund-plug-control-demo.js 一致）：
 *   header(32B): magic(2) + length(2) + unknown(4) + did(4) + stamp(4) + md5(16)
 *   payload    : AES-128-CBC(PKCS7, key/iv 由 token 派生)
 *   header[16:] 在最后被 md5(整包) 替换
 *
 * 设备型号：cuco.plug.cp5d，使用 MIOT get_properties / set_properties。
 */

import * as crypto from 'crypto';
import * as dgram from 'dgram';
import {
  discoverIpByMac,
  getCachedIpByMac,
  invalidateCacheForMac,
} from './gosund-plug-discovery';

const MIIO_PORT = 54321;
const HELLO_PACKET = Buffer.from(
  '21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

export const SWITCH_SIID_BY_DID: Readonly<Record<string, number>> = Object.freeze({
  master: 2,
  state: 2,
  s4: 3,
  s3: 4,
  s2: 5,
  s1: 6,
  usb: 7,
});

export type GosundDid = keyof typeof SWITCH_SIID_BY_DID;

const TOKEN_RE = /^[0-9a-fA-F]{32}$/;

function md5(buf: Buffer): Buffer {
  return crypto.createHash('md5').update(buf).digest();
}

function deriveKeyIv(token: Buffer): { key: Buffer; iv: Buffer } {
  const key = md5(token);
  const iv = md5(Buffer.concat([key, token]));
  return { key, iv };
}

function aesEncrypt(token: Buffer, plaintext: Buffer): Buffer {
  const { key, iv } = deriveKeyIv(token);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecrypt(token: Buffer, ciphertext: Buffer): Buffer {
  const { key, iv } = deriveKeyIv(token);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildPacket(stamp: number, token: Buffer, plaindata: Buffer, did: number): Buffer {
  const payload = aesEncrypt(token, plaindata);
  const length = payload.length + 32;

  const header = Buffer.alloc(32);
  header.writeUInt8(0x21, 0);
  header.writeUInt8(0x31, 1);
  header.writeUInt16BE(length, 2);
  header.writeUInt32BE(0, 4); // unknown
  header.writeUInt32BE(did >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  // 先用 token 占位，参与 md5 校验
  token.copy(header, 16, 0, 16);

  const packet = Buffer.concat([header, payload]);
  const checksum = md5(packet);
  checksum.copy(packet, 16, 0, 16);
  return packet;
}

function parsePacket(token: Buffer, raw: Buffer): { did: number; stamp: number; plaintext: Buffer } {
  if (raw.length < 32) {
    throw new Error(`Invalid miio packet length: ${raw.length}`);
  }
  const header = raw.subarray(0, 32);
  const did = header.readUInt32BE(8);
  const stamp = header.readUInt32BE(12);
  if (raw.length === 32) {
    return { did, stamp, plaintext: Buffer.alloc(0) };
  }
  const plaintext = aesDecrypt(token, raw.subarray(32));
  return { did, stamp, plaintext };
}

export interface MiioSessionOptions {
  timeoutMs?: number;
}

export class MiioSession {
  readonly ip: string;
  readonly token: Buffer;
  readonly timeoutMs: number;
  did = 0;
  stamp = 0;
  private socket: dgram.Socket | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(ip: string, token: Buffer, options: MiioSessionOptions = {}) {
    if (!Buffer.isBuffer(token) || token.length !== 16) {
      throw new Error('token must be a 16-byte Buffer');
    }
    this.ip = ip;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket) return;
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {
      // 错误由具体请求侧捕获
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      sock.once('error', onError);
      sock.bind(0, () => {
        sock.removeListener('error', onError);
        resolve();
      });
    });
    this.socket = sock;
  }

  private sendRaw(packet: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const sock = this.socket;
      if (!sock) {
        reject(new Error('socket not ready'));
        return;
      }
      const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (rinfo.address !== this.ip) return;
        clearTimeout(timer);
        sock.removeListener('message', onMessage);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        sock.removeListener('message', onMessage);
        reject(new Error(`miio request timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      sock.on('message', onMessage);
      sock.send(packet, 0, packet.length, MIIO_PORT, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          sock.removeListener('message', onMessage);
          reject(err);
        }
      });
    });
  }

  private async handshake(): Promise<void> {
    await this.ensureSocket();
    const reply = await this.sendRaw(HELLO_PACKET);
    const header = reply.subarray(0, 32);
    this.did = header.readUInt32BE(8);
    this.stamp = header.readUInt32BE(12);
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.handshake();
    }
    return this.readyPromise;
  }

  async send(plain: Buffer | string): Promise<Buffer> {
    await this.ready();
    this.stamp = (this.stamp + 1) >>> 0;
    const data = Buffer.isBuffer(plain) ? plain : Buffer.from(plain, 'utf8');
    const packet = buildPacket(this.stamp, this.token, data, this.did);
    const reply = await this.sendRaw(packet);
    const { plaintext } = parsePacket(this.token, reply);
    const nul = plaintext.indexOf(0);
    return nul >= 0 ? plaintext.subarray(0, nul) : plaintext;
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

export interface GosundPlugOptions {
  timeoutMs?: number;
}

export class GosundPlug {
  readonly ip: string;
  private readonly session: MiioSession;

  constructor(ip: string, tokenHex: string, options: GosundPlugOptions = {}) {
    if (!TOKEN_RE.test(tokenHex)) {
      throw new Error('token must be a 32-char hex string');
    }
    this.ip = ip;
    this.session = new MiioSession(ip, Buffer.from(tokenHex, 'hex'), options);
  }

  static siidOf(did: string): number {
    if (!(did in SWITCH_SIID_BY_DID)) {
      throw new Error(
        `Unknown did "${did}". Allowed: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}`,
      );
    }
    return SWITCH_SIID_BY_DID[did];
  }

  static allowedDids(): string[] {
    return Object.keys(SWITCH_SIID_BY_DID);
  }

  private async miot(method: 'get_properties' | 'set_properties', params: unknown): Promise<any> {
    const payload = JSON.stringify({ id: 1, method, params });
    const replyBuf = await this.session.send(payload);
    const text = replyBuf.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from device: ${text}`);
    }
  }

  async status(did: string = 'master'): Promise<boolean> {
    const siid = GosundPlug.siidOf(did);
    const resp = await this.miot('get_properties', [{ did, siid, piid: 1 }]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read ${did}: ${JSON.stringify(resp)}`);
    }
    return Boolean(result.value);
  }

  async set(did: string, value: boolean): Promise<void> {
    const siid = GosundPlug.siidOf(did);
    const resp = await this.miot('set_properties', [
      { did, siid, piid: 1, value: Boolean(value) },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set ${did}: ${JSON.stringify(resp)}`);
    }
  }

  on(did: string = 'master'): Promise<void> {
    return this.set(did, true);
  }

  off(did: string = 'master'): Promise<void> {
    return this.set(did, false);
  }

  async toggle(did: string = 'master'): Promise<boolean> {
    const cur = await this.status(did);
    await this.set(did, !cur);
    return !cur;
  }

  /** 一次性读取所有插孔状态。 */
  async statusAll(): Promise<Record<string, boolean>> {
    const dids = ['master', 's1', 's2', 's3', 's4', 'usb'];
    const params = dids.map((did) => ({ did, siid: GosundPlug.siidOf(did), piid: 1 }));
    const resp = await this.miot('get_properties', params);
    const out: Record<string, boolean> = {};
    for (const item of resp?.result ?? []) {
      if (item?.code === 0 && typeof item.did === 'string') {
        out[item.did] = Boolean(item.value);
      }
    }
    return out;
  }

  close(): void {
    this.session.close();
  }
}

/**
 * 创建一个对操作进行"按 MAC 重新发现 IP"包装的 GosundPlug 代理。
 *
 * 行为：
 *  - 优先使用 cachedIp（来自 .runtime cache）→ 否则 fallbackIp（.env GOSUND_PLUG_IP）
 *  - 若任一操作（status/on/off/toggle/statusAll）抛 timeout / network 异常，
 *    会自动调用 discoverIpByMac() 找当前 IP 后重试一次
 *  - 重发现成功后会写回 cache，下次直接命中
 *
 * 调用方仍然要在最后调用 .close() 释放 socket（与原 GosundPlug 一致）。
 */
export interface ResolvableGosundPlugOptions {
  mac?: string;
  fallbackIp?: string;
  token: string;
  timeoutMs?: number;
}

export class ResolvableGosundPlug {
  private readonly mac?: string;
  private readonly fallbackIp?: string;
  private readonly token: string;
  private readonly timeoutMs?: number;
  private current: GosundPlug | null = null;
  private currentIp: string | null = null;

  constructor(opts: ResolvableGosundPlugOptions) {
    this.mac = opts.mac;
    this.fallbackIp = opts.fallbackIp;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
  }

  private async resolveIp(): Promise<string | null> {
    if (this.mac) {
      const cached = await getCachedIpByMac(this.mac);
      if (cached) return cached;
    }
    return this.fallbackIp ?? null;
  }

  private async ensurePlug(): Promise<GosundPlug> {
    if (this.current) return this.current;
    const ip = await this.resolveIp();
    if (!ip) throw new Error('plug_ip_unresolved');
    this.current = new GosundPlug(ip, this.token, { timeoutMs: this.timeoutMs });
    this.currentIp = ip;
    return this.current;
  }

  private dropPlug(): void {
    if (this.current) {
      try { this.current.close(); } catch { /* noop */ }
    }
    this.current = null;
    this.currentIp = null;
  }

  /** 网络错误才需要重试；token 错 / 业务错不重试。 */
  private isTransient(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return /timeout|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ECONNREFUSED|EAGAIN|ENETDOWN/i.test(msg);
  }

  private async withRetry<T>(fn: (plug: GosundPlug) => Promise<T>): Promise<T> {
    try {
      const plug = await this.ensurePlug();
      return await fn(plug);
    } catch (err) {
      if (!this.mac || !this.isTransient(err)) throw err;
      // 失败：让 cache 失效，重新广播发现
      this.dropPlug();
      await invalidateCacheForMac(this.mac);
      const newIp = await discoverIpByMac(this.mac);
      if (!newIp) throw new Error(`plug_offline (mac=${this.mac})`);
      this.current = new GosundPlug(newIp, this.token, { timeoutMs: this.timeoutMs });
      this.currentIp = newIp;
      return await fn(this.current);
    }
  }

  status(did: string = 'master'): Promise<boolean> {
    return this.withRetry((p) => p.status(did));
  }
  on(did: string = 'master'): Promise<void> {
    return this.withRetry((p) => p.on(did));
  }
  off(did: string = 'master'): Promise<void> {
    return this.withRetry((p) => p.off(did));
  }
  toggle(did: string = 'master'): Promise<boolean> {
    return this.withRetry((p) => p.toggle(did));
  }
  statusAll(): Promise<Record<string, boolean>> {
    return this.withRetry((p) => p.statusAll());
  }

  /** 当前实际使用的 IP（调试日志用）。 */
  getCurrentIp(): string | null {
    return this.currentIp;
  }

  close(): void {
    this.dropPlug();
  }
}
