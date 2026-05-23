#!/usr/bin/env node
/**
 * Node.js port of demos/gosund-plug-control-demo.py
 *
 * - 实现了小米 MiHome miio 二进制协议（hello 握手 + AES-CBC + MD5 校验）
 * - 封装了 GosundPlug 类，支持 MIOT get_properties / set_properties
 * - 提供 CLI: status / on / off / toggle，并支持 --did 控制具体插孔
 *
 * 运行示例：
 *   node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <32-hex> status
 *   node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <32-hex> --did s1 on
 *   node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <32-hex> --did usb toggle
 *
 * 也可以用环境变量 GOSUND_PLUG_IP / GOSUND_PLUG_TOKEN 代替 --ip / --token。
 */

'use strict';

const crypto = require('crypto');
const dgram = require('dgram');

const MIIO_PORT = 54321;
const HELLO_PACKET = Buffer.from(
  '21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

const SWITCH_SIID_BY_DID = {
  master: 2,
  state: 2,
  s4: 3,
  s3: 4,
  s2: 5,
  s1: 6,
  usb: 7,
};

const TOKEN_RE = /^[0-9a-fA-F]{32}$/;

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

function deriveKeyIv(token) {
  const key = md5(token);
  const iv = md5(Buffer.concat([key, token]));
  return { key, iv };
}

function aesEncrypt(token, plaintext) {
  const { key, iv } = deriveKeyIv(token);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecrypt(token, ciphertext) {
  const { key, iv } = deriveKeyIv(token);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 构造一个加密的 miio 数据包：
 *   header(32 字节): magic(2) + length(2) + unknown(4) + did(4) + stamp(4) + md5(16)
 *   payload: AES-CBC(plain)
 *   header[16:32] 在最后被替换为 md5(整包，含 token 占位)
 */
function buildPacket(stamp, token, plaindata, did) {
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

function parsePacket(token, raw) {
  const header = raw.subarray(0, 32);
  const length = header.readUInt16BE(2);
  const did = header.readUInt32BE(8);
  const stamp = header.readUInt32BE(12);

  if (raw.length < 32) {
    throw new Error(`Invalid miio packet length: ${raw.length}`);
  }
  if (raw.length === 32) {
    // hello 响应没有 payload
    return { did, stamp, length, plaintext: Buffer.alloc(0) };
  }
  const plaintext = aesDecrypt(token, raw.subarray(32));
  return { did, stamp, length, plaintext };
}

class MiioSession {
  /**
   * @param {string} ip
   * @param {Buffer} token  16 字节
   * @param {{ timeoutMs?: number }} [options]
   */
  constructor(ip, token, options = {}) {
    if (!Buffer.isBuffer(token) || token.length !== 16) {
      throw new Error('token must be a 16-byte Buffer');
    }
    this.ip = ip;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.did = 0;
    this.stamp = 0;
    this.socket = null;
    this._ready = null;
  }

  async _ensureSocket() {
    if (this.socket) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('udp error:', err);
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.socket.once('error', onError);
      this.socket.bind(0, () => {
        this.socket.removeListener('error', onError);
        resolve();
      });
    });
  }

  /**
   * 发送一帧并等待响应（一来一回）
   * @param {Buffer} packet
   * @returns {Promise<Buffer>} 原始 UDP 响应
   */
  _sendRaw(packet) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onMessage = (msg, rinfo) => {
        if (rinfo.address !== this.ip) return;
        clearTimeout(timer);
        this.socket.removeListener('message', onMessage);
        resolve(msg);
      };
      this.socket.on('message', onMessage);

      timer = setTimeout(() => {
        this.socket.removeListener('message', onMessage);
        reject(new Error(`miio request timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.socket.send(packet, 0, packet.length, MIIO_PORT, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          this.socket.removeListener('message', onMessage);
          reject(err);
        }
      });
    });
  }

  async handshake() {
    await this._ensureSocket();
    const reply = await this._sendRaw(HELLO_PACKET);
    const header = reply.subarray(0, 32);
    this.did = header.readUInt32BE(8);
    this.stamp = header.readUInt32BE(12);
  }

  async ready() {
    if (!this._ready) {
      this._ready = this.handshake();
    }
    return this._ready;
  }

  /**
   * 发送一段明文 JSON 字节，返回明文响应字节
   * @param {Buffer|string} plainData
   * @returns {Promise<Buffer>}
   */
  async send(plainData) {
    await this.ready();
    this.stamp = (this.stamp + 1) >>> 0;
    const data = Buffer.isBuffer(plainData)
      ? plainData
      : Buffer.from(String(plainData), 'utf8');
    const packet = buildPacket(this.stamp, this.token, data, this.did);
    const reply = await this._sendRaw(packet);
    const { plaintext } = parsePacket(this.token, reply);
    // 协议返回会按 PKCS7 padding 解出尾部 \0；按 NUL 截断后再返回
    const nul = plaintext.indexOf(0);
    return nul >= 0 ? plaintext.subarray(0, nul) : plaintext;
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

class GosundPlug {
  /**
   * @param {string} ip
   * @param {string} tokenHex 32 位十六进制
   */
  constructor(ip, tokenHex) {
    if (!TOKEN_RE.test(tokenHex)) {
      throw new Error('token must be a 32-char hex string');
    }
    this.session = new MiioSession(ip, Buffer.from(tokenHex, 'hex'));
  }

  async _miot(method, params) {
    const payload = JSON.stringify({ id: 1, method, params });
    const replyBuf = await this.session.send(payload);
    const text = replyBuf.toString('utf8');
    let response;
    try {
      response = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON from device: ${text}`);
    }
    return response;
  }

  static siidOf(did) {
    if (!(did in SWITCH_SIID_BY_DID)) {
      throw new Error(
        `Unknown did "${did}". Allowed: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}`,
      );
    }
    return SWITCH_SIID_BY_DID[did];
  }

  async status(did = 'master') {
    const siid = GosundPlug.siidOf(did);
    const resp = await this._miot('get_properties', [
      { did, siid, piid: 1 },
    ]);
    const result = resp.result && resp.result[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read ${did}: ${JSON.stringify(resp)}`);
    }
    return Boolean(result.value);
  }

  async set(did, value) {
    const siid = GosundPlug.siidOf(did);
    const resp = await this._miot('set_properties', [
      { did, siid, piid: 1, value: Boolean(value) },
    ]);
    const result = resp.result && resp.result[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set ${did}: ${JSON.stringify(resp)}`);
    }
  }

  on(did = 'master') {
    return this.set(did, true);
  }

  off(did = 'master') {
    return this.set(did, false);
  }

  async toggle(did = 'master') {
    const cur = await this.status(did);
    await this.set(did, !cur);
    return !cur;
  }

  close() {
    this.session.close();
  }
}

// ---------------- CLI ----------------

function parseArgs(argv) {
  const args = {
    action: null,
    ip: process.env.GOSUND_PLUG_IP || null,
    token: process.env.GOSUND_PLUG_TOKEN || null,
    did: 'master',
  };

  const actions = new Set(['status', 'on', 'off', 'toggle']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      i += 1;
      return v;
    };

    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--ip') {
      args.ip = next();
    } else if (a.startsWith('--ip=')) {
      args.ip = a.slice('--ip='.length);
    } else if (a === '--token') {
      args.token = next();
    } else if (a.startsWith('--token=')) {
      args.token = a.slice('--token='.length);
    } else if (a === '--did' || a === '-did') {
      args.did = next();
    } else if (a.startsWith('--did=')) {
      args.did = a.slice('--did='.length);
    } else if (actions.has(a)) {
      args.action = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!args.action) {
    throw new Error('Missing action. Choose one of: status, on, off, toggle');
  }
  if (!(args.did in SWITCH_SIID_BY_DID)) {
    throw new Error(
      `Invalid --did "${args.did}". Allowed: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}`,
    );
  }
  return args;
}

function printHelp() {
  const text = `Usage: node demos/gosund-plug-control-demo.js [options] <status|on|off|toggle>

Options:
  --ip <ip>          Plug LAN IP (or env GOSUND_PLUG_IP)
  --token <hex>      32-char MiHome device token (or env GOSUND_PLUG_TOKEN)
  --did <name>       Switch to control. One of: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}
                     master/state = main switch, s1-s4 = outlets, usb = USB
  -h, --help         Show this help

Examples:
  node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <hex> status
  node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <hex> --did s1 on
  node demos/gosund-plug-control-demo.js --ip 192.168.0.27 --token <hex> --did usb toggle
`;
  process.stdout.write(text);
}

function requireConfig(args) {
  if (!args.ip) throw new Error('Missing plug IP. Pass --ip or set GOSUND_PLUG_IP.');
  if (!args.token) throw new Error('Missing token. Pass --token or set GOSUND_PLUG_TOKEN.');
  if (!TOKEN_RE.test(args.token)) {
    throw new Error('Invalid token: expected a 32-character hex string.');
  }
  return { ip: args.ip, token: args.token.toLowerCase(), did: args.did };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n`);
    printHelp();
    process.exit(2);
  }

  let config;
  try {
    config = requireConfig(args);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }

  const plug = new GosundPlug(config.ip, config.token);
  try {
    const { did } = config;
    if (args.action === 'status') {
      const on = await plug.status(did);
      console.log(`${did}: ${on ? 'on' : 'off'}`);
    } else if (args.action === 'on') {
      await plug.on(did);
      console.log(`${did}: switched on`);
    } else if (args.action === 'off') {
      await plug.off(did);
      console.log(`${did}: switched off`);
    } else if (args.action === 'toggle') {
      const next = await plug.toggle(did);
      console.log(`${did}: switched ${next ? 'on' : 'off'}`);
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    plug.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { GosundPlug, MiioSession, SWITCH_SIID_BY_DID };
