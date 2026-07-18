/**
 * 极简 HTTP 工具集：请求体解析、JSON 响应、cookie 解析、静态文件托管。
 * 全部基于 node:http，零第三方依赖。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';

const MAX_BODY_BYTES = 64 * 1024; // 请求体上限 64KB，防滥用

/** 读取并 JSON 解析请求体；超限或非法直接 reject。 */
export function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolvePromise({} as T);
        return;
      }
      try {
        resolvePromise(JSON.parse(raw) as T);
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** 解析 Cookie 头为 map。 */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res: ServerResponse, name: string, token: string, maxAgeSec: number): void {
  // 仅局域网 http 部署时 Secure 会导致浏览器不发 cookie，这里按环境决定是否加 Secure。
  const secure = (process.env.WEB_COOKIE_SECURE || '').toLowerCase() === 'true';
  const attrs = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

export function clearSessionCookie(res: ServerResponse, name: string): void {
  res.setHeader('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** 从 req 提取客户端 IP（信任反代时读 x-forwarded-for 的第一个）。 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * 托管 rootDir 下的静态文件。做了路径穿越防护（normalize + 前缀校验）。
 * 命中目录时回退到 index.html（SPA）。返回 true 表示已处理。
 */
export function serveStatic(
  res: ServerResponse,
  rootDir: string,
  urlPath: string,
  fallbackToIndex = true,
): boolean {
  const root = resolve(rootDir);
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = normalize(resolve(root, `.${rel}`));

  // 路径穿越防护：目标必须仍在 root 下
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return true;
  }

  let filePath = target;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (fallbackToIndex && existsSync(resolve(root, 'index.html'))) {
      filePath = resolve(root, 'index.html');
    } else {
      return false;
    }
  }

  const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' });
  createReadStream(filePath).pipe(res);
  return true;
}
