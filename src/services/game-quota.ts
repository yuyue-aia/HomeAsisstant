/**
 * 小朋友游戏时间配额服务。
 *
 * 职责：
 *   - 维护每个孩子按"自然天"独立计数的配额（usedMinutes / remainingMinutes）。
 *   - 维护全局唯一的 activeSession（一个时刻只能有一个孩子在玩）。
 *   - 通过 JSON 文件持久化，进程重启后可恢复。
 *
 * 不负责：
 *   - 实际通断电（那是 GosundPlug 的事）。
 *   - 定时器调度（那是 GameSessionTimer 的事）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../common/logger';

export type ChildKey = 'yuxiao' | 'yuyue';

export interface ChildProfile {
  key: ChildKey;
  label: string;
  aliases: string[];
}

export const CHILDREN: readonly ChildProfile[] = Object.freeze([
  { key: 'yuxiao', label: '余晓', aliases: ['余晓', '小晓', '晓晓', '晓哥'] },
  { key: 'yuyue', label: '余跃', aliases: ['余跃', '小跃', '跃跃', '跃哥'] },
]);

export function isChildKey(value: unknown): value is ChildKey {
  return typeof value === 'string' && CHILDREN.some((c) => c.key === value);
}

export function getChildProfile(key: ChildKey): ChildProfile {
  const p = CHILDREN.find((c) => c.key === key);
  if (!p) throw new Error(`Unknown child: ${key}`);
  return p;
}

/** 把 alias / label 解析成 ChildKey；找不到返回 null */
export function resolveChildKey(input: string | null | undefined): ChildKey | null {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;
  if (isChildKey(text)) return text;
  for (const c of CHILDREN) {
    if (c.label === text || c.aliases.includes(text)) return c.key;
  }
  return null;
}

export interface ActiveSession {
  child: ChildKey;
  /** ISO datetime */
  startedAt: string;
  plannedMinutes: number;
  /** ISO datetime，= startedAt + plannedMinutes */
  endsAt: string;
  plugDid: string;
}

export interface QuotaSnapshot {
  child: ChildKey;
  date: string; // YYYY-MM-DD（本地时区）
  dailyQuotaMin: number;
  usedMinutes: number;
  remainingMinutes: number;
  allowedToday: boolean;
}

interface PersistedUserQuota {
  date: string;
  usedMinutes: number;
}

interface PersistedState {
  version: 1;
  users: Partial<Record<ChildKey, PersistedUserQuota>>;
  activeSession: ActiveSession | null;
}

export interface GameQuotaConfig {
  /** 周末单人单日配额（分钟），默认 120 */
  dailyQuotaMin: number;
  /** 允许玩游戏的星期（0=周日, 6=周六），默认 [0, 6] */
  allowedWeekdays: number[];
  /** 单次申请上限（分钟），默认 120 */
  maxSingleSessionMin: number;
  /** 单次申请下限（分钟），默认 10 */
  minSingleSessionMin: number;
  /** 持久化文件路径 */
  file: string;
}

function parseWeekdays(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return items.length > 0 ? Array.from(new Set(items)) : fallback;
}

function parseInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadGameQuotaConfig(): GameQuotaConfig {
  return {
    dailyQuotaMin: parseInt(process.env.GAME_DAILY_QUOTA_MINUTES, 120),
    allowedWeekdays: parseWeekdays(process.env.GAME_ALLOWED_WEEKDAYS, [0, 6]),
    maxSingleSessionMin: parseInt(process.env.GAME_MAX_SINGLE_SESSION_MINUTES, 120),
    minSingleSessionMin: parseInt(process.env.GAME_MIN_SINGLE_SESSION_MINUTES, 10),
    file: resolve(process.env.GAME_QUOTA_FILE || '.runtime/game-quota.json'),
  };
}

/** 本地日期 YYYY-MM-DD（按运行时区），跨天判定用。 */
export function localDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class GameQuotaService {
  private readonly cfg: GameQuotaConfig;
  private state: PersistedState;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(cfg: GameQuotaConfig = loadGameQuotaConfig()) {
    this.cfg = cfg;
    this.state = this.loadFromDisk();
  }

  getConfig(): GameQuotaConfig {
    return this.cfg;
  }

  // ---------------- 公共能力 ----------------

  isAllowedToday(now: Date = new Date()): boolean {
    return this.cfg.allowedWeekdays.includes(now.getDay());
  }

  getSnapshot(child: ChildKey, now: Date = new Date()): QuotaSnapshot {
    const today = localDateString(now);
    const cur = this.state.users[child];
    const used = cur && cur.date === today ? cur.usedMinutes : 0;
    const daily = this.cfg.dailyQuotaMin;
    return {
      child,
      date: today,
      dailyQuotaMin: daily,
      usedMinutes: used,
      remainingMinutes: Math.max(0, daily - used),
      allowedToday: this.isAllowedToday(now),
    };
  }

  /** 扣减配额。minutes < 0 视为退还。返回最新剩余分钟数。 */
  consume(child: ChildKey, minutes: number, now: Date = new Date()): number {
    if (!Number.isFinite(minutes)) throw new Error(`Invalid minutes: ${minutes}`);
    const today = localDateString(now);
    const cur = this.state.users[child];
    let used = cur && cur.date === today ? cur.usedMinutes : 0;
    used = Math.max(0, used + Math.round(minutes));
    used = Math.min(used, this.cfg.dailyQuotaMin); // 不允许超过当日上限
    this.state.users[child] = { date: today, usedMinutes: used };
    this.scheduleFlush();
    return Math.max(0, this.cfg.dailyQuotaMin - used);
  }

  refund(child: ChildKey, minutes: number, now?: Date): number {
    return this.consume(child, -Math.abs(minutes), now);
  }

  // ---------------- ActiveSession ----------------

  getActiveSession(): ActiveSession | null {
    return this.state.activeSession;
  }

  setActiveSession(session: ActiveSession | null): void {
    this.state.activeSession = session;
    this.scheduleFlush();
  }

  // ---------------- 校验 ----------------

  /** 把 minutes 收敛到允许区间；非数字或越界给出 reason */
  validateMinutes(
    minutes: number,
  ): { ok: true; minutes: number } | { ok: false; reason: 'invalid_minutes'; min: number; max: number } {
    const m = Math.round(minutes);
    if (!Number.isFinite(m) || m <= 0) {
      return {
        ok: false,
        reason: 'invalid_minutes',
        min: this.cfg.minSingleSessionMin,
        max: this.cfg.maxSingleSessionMin,
      };
    }
    if (m < this.cfg.minSingleSessionMin || m > this.cfg.maxSingleSessionMin) {
      return {
        ok: false,
        reason: 'invalid_minutes',
        min: this.cfg.minSingleSessionMin,
        max: this.cfg.maxSingleSessionMin,
      };
    }
    return { ok: true, minutes: m };
  }

  // ---------------- 持久化 ----------------

  private emptyState(): PersistedState {
    return { version: 1, users: {}, activeSession: null };
  }

  private loadFromDisk(): PersistedState {
    try {
      if (!existsSync(this.cfg.file)) return this.emptyState();
      const raw = readFileSync(this.cfg.file, 'utf8');
      if (!raw.trim()) return this.emptyState();
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const state: PersistedState = {
        version: 1,
        users: parsed.users && typeof parsed.users === 'object' ? (parsed.users as PersistedState['users']) : {},
        activeSession: parsed.activeSession ?? null,
      };
      logger.info('game-quota.loaded', { file: this.cfg.file, hasActive: !!state.activeSession });
      return state;
    } catch (error) {
      logger.warn('game-quota.load_failed', {
        file: this.cfg.file,
        error: (error as Error).message,
      });
      return this.emptyState();
    }
  }

  private scheduleFlush(): void {
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      try {
        const dir = dirname(this.cfg.file);
        mkdirSync(dir, { recursive: true });
        const tmp = `${this.cfg.file}.tmp`;
        writeFileSync(tmp, snapshot, 'utf8');
        renameSync(tmp, this.cfg.file);
      } catch (error) {
        logger.warn('game-quota.save_failed', {
          file: this.cfg.file,
          error: (error as Error).message,
        });
      }
    });
  }
}
