import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';

type LogMeta = Record<string, unknown>;

/**
 * 文件日志：
 * - 结构化 JSON 行写入 logs/app-YYYY-MM-DD.log，按本地日期分割。
 * - 不再写入 stdout，避免和"对话内容"混在控制台。
 *
 * 控制台输出（[wake]/[asr-final]/[agent]/[state] 等）由 voice-service.ts 自行处理。
 *
 * 目录可通过 LOG_DIR 环境变量覆盖，默认 ./logs（相对于启动 cwd）。
 */
const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs');

let currentDay = '';
let currentStream: WriteStream | undefined;

function ensureStream(): WriteStream {
  const day = formatDay(new Date());
  if (day === currentDay && currentStream && !currentStream.destroyed) {
    return currentStream;
  }
  // 切换到新一天 → 关旧的，开新的
  if (currentStream) {
    try { currentStream.end(); } catch { /* ignore */ }
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `app-${day}.log`);
  currentStream = createWriteStream(file, { flags: 'a' });
  currentStream.on('error', (err) => {
    // 写日志失败不能再调 logger，否则递归；fallback 到 stderr。
    process.stderr.write(`[logger] write error: ${(err as Error).message}\n`);
  });
  currentDay = day;
  return currentStream;
}

function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function log(level: string, message: string, meta?: LogMeta): void {
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  const line = JSON.stringify(payload) + '\n';
  try {
    ensureStream().write(line);
  } catch (err) {
    process.stderr.write(`[logger] ${(err as Error).message}\n`);
  }
}

export const logger = {
  info(message: string, meta?: LogMeta) {
    log('info', message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    log('warn', message, meta);
  },
  error(message: string, meta?: LogMeta) {
    log('error', message, meta);
  },
};
