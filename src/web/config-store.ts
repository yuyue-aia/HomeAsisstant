/**
 * 游戏配置持久化覆盖层（Web 管理端的配置真源）。
 *
 * 读取优先级：文件（.runtime/game-config.json） > env 兜底 > 代码默认。
 * Web 管理端保存配置时写这份文件，并调用 controller.applyRuntimeConfig 即时生效；
 * 进程重启后由 web-server 启动流程重新 load 并 apply，保证与运行态一致。
 *
 * 只负责"存/取/校验"，不碰设备、不碰定时器。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../common/logger';
import { loadGameQuotaConfig } from '../services/game-quota';

export interface RuntimeGameConfig {
  /** 单人单日配额（分钟） */
  dailyQuotaMin: number;
  /** 允许玩游戏的星期（0=周日 … 6=周六） */
  allowedWeekdays: number[];
  /** 单次申请上限（分钟） */
  maxSingleSessionMin: number;
  /** 单次申请下限（分钟） */
  minSingleSessionMin: number;
  /** 到期前提醒的秒数列表（大→小） */
  reminderSeconds: number[];
}

interface PersistedConfig extends RuntimeGameConfig {
  version: 1;
  updatedAt: string;
}

function parseReminderSeconds(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const items = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  return items.length > 0 ? Array.from(new Set(items)).sort((a, b) => b - a) : fallback;
}

/** 从 env + 代码默认拼出初始配置（文件缺失时使用）。 */
function defaultsFromEnv(): RuntimeGameConfig {
  const q = loadGameQuotaConfig();
  return {
    dailyQuotaMin: q.dailyQuotaMin,
    allowedWeekdays: q.allowedWeekdays,
    maxSingleSessionMin: q.maxSingleSessionMin,
    minSingleSessionMin: q.minSingleSessionMin,
    reminderSeconds: parseReminderSeconds(process.env.GAME_REMINDER_SECONDS, [300, 60]),
  };
}

/**
 * 严格校验并规整一份（可能来自客户端的）配置。返回 { ok, value } 或 { ok:false, error }。
 * 边界都收敛而非静默丢弃：越界即报错，走"配置错误快失败"风格。
 */
export function validateConfig(
  input: unknown,
): { ok: true; value: RuntimeGameConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '配置格式不正确' };
  const o = input as Record<string, unknown>;

  const daily = Number(o.dailyQuotaMin);
  if (!Number.isFinite(daily) || daily < 5 || daily > 1440) {
    return { ok: false, error: '每日配额需在 5~1440 分钟之间' };
  }

  if (!Array.isArray(o.allowedWeekdays)) {
    return { ok: false, error: '可玩星期格式不正确' };
  }
  const weekdays = Array.from(
    new Set(
      o.allowedWeekdays
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    ),
  ).sort((a, b) => a - b);

  const maxSingle = Number(o.maxSingleSessionMin);
  if (!Number.isFinite(maxSingle) || maxSingle < 1 || maxSingle > 1440) {
    return { ok: false, error: '单次上限需在 1~1440 分钟之间' };
  }
  const minSingle = Number(o.minSingleSessionMin);
  if (!Number.isFinite(minSingle) || minSingle < 1 || minSingle > maxSingle) {
    return { ok: false, error: '单次下限需 ≥1 且不超过单次上限' };
  }

  if (!Array.isArray(o.reminderSeconds)) {
    return { ok: false, error: '提醒时间点格式不正确' };
  }
  const reminders = Array.from(
    new Set(
      o.reminderSeconds
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 3600),
    ),
  ).sort((a, b) => b - a);

  return {
    ok: true,
    value: {
      dailyQuotaMin: Math.floor(daily),
      allowedWeekdays: weekdays,
      maxSingleSessionMin: Math.floor(maxSingle),
      minSingleSessionMin: Math.floor(minSingle),
      reminderSeconds: reminders,
    },
  };
}

export class GameConfigStore {
  private readonly file: string;
  private cache: RuntimeGameConfig;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file = resolve(process.env.GAME_CONFIG_FILE || '.runtime/game-config.json')) {
    this.file = file;
    this.cache = this.loadFromDisk();
  }

  get(): RuntimeGameConfig {
    return { ...this.cache, allowedWeekdays: [...this.cache.allowedWeekdays], reminderSeconds: [...this.cache.reminderSeconds] };
  }

  /** 覆盖保存一份已校验的配置。 */
  save(value: RuntimeGameConfig): RuntimeGameConfig {
    this.cache = value;
    const snapshot: PersistedConfig = { version: 1, updatedAt: new Date().toISOString(), ...value };
    const json = JSON.stringify(snapshot, null, 2);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, json, 'utf8');
        renameSync(tmp, this.file);
      } catch (error) {
        logger.warn('game-config.save_failed', { file: this.file, error: (error as Error).message });
      }
    });
    return this.get();
  }

  private loadFromDisk(): RuntimeGameConfig {
    try {
      if (!existsSync(this.file)) {
        const seeded = defaultsFromEnv();
        this.persistSeed(seeded);
        return seeded;
      }
      const raw = readFileSync(this.file, 'utf8');
      if (!raw.trim()) return defaultsFromEnv();
      const parsed = validateConfig(JSON.parse(raw));
      if (!parsed.ok) {
        logger.warn('game-config.invalid_on_load', { error: parsed.error });
        return defaultsFromEnv();
      }
      logger.info('game-config.loaded', { file: this.file });
      return parsed.value;
    } catch (error) {
      logger.warn('game-config.load_failed', { file: this.file, error: (error as Error).message });
      return defaultsFromEnv();
    }
  }

  private persistSeed(value: RuntimeGameConfig): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const snapshot: PersistedConfig = { version: 1, updatedAt: new Date().toISOString(), ...value };
      writeFileSync(this.file, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {
      /* 首次落盘失败不致命，下次 save 再写 */
    }
  }
}
