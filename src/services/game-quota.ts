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

/**
 * 玩家标识。历史上只有固定的余晓/余跃（ChildKey），现已泛化为通用字符串：
 * - 语音链路仍用内置的 'yuxiao' / 'yuyue'（见 CHILDREN）；
 * - Web 链路用各账号的 id 作为玩家 ID（谁登录就是谁）。
 * 二者共用同一台游戏机的配额与互斥逻辑，互不冲突。
 */
export type PlayerId = string;

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

/** 会话活动类型：玩游戏 or 看电视（共享同一份配额）。 */
export type ActivityType = 'game' | 'tv';

export interface ActiveSession {
  child: PlayerId;
  /** 玩家显示名（播报/展示用）。旧数据可能缺失，使用处以 child 兜底。 */
  label?: string;
  /** 本次活动：玩游戏 / 看电视。旧数据缺失时按 'game' 处理。 */
  activity?: ActivityType;
  /** ISO datetime */
  startedAt: string;
  plannedMinutes: number;
  /** ISO datetime，= startedAt + plannedMinutes */
  endsAt: string;
  /** 本次实际通电的接口集合（停止/到期时精确断电）。旧数据用 plugDid 兜底。 */
  plugDids?: string[];
  /** @deprecated 旧单接口字段，仅用于向后兼容读取。 */
  plugDid?: string;
  /** 测试模式：不操作真实插线板（test 账号专属）。 */
  testMode?: boolean;
}

export interface QuotaSnapshot {
  child: PlayerId;
  date: string; // YYYY-MM-DD（本地时区）
  dailyQuotaMin: number;
  /** 管理员当天临时加时（按自然日重置） */
  bonusMinutes: number;
  usedMinutes: number;
  remainingMinutes: number;
  allowedToday: boolean;
}

interface PersistedUserQuota {
  date: string;
  usedMinutes: number;
  /** 当天临时加时分钟数（管理员发放，跨天清零） */
  bonusMinutes?: number;
}

export type SessionEndReason = 'manual' | 'expired' | 'offline_expired';

export interface SessionHistoryRecord {
  id: string;
  playerId: PlayerId;
  label: string;
  activity: ActivityType;
  startedAt: string;
  endedAt: string;
  plannedMinutes: number;
  actualMinutes: number;
  endReason: SessionEndReason;
  powerOffOk: boolean;
}

interface PersistedState {
  version: 2;
  users: Partial<Record<PlayerId, PersistedUserQuota>>;
  activeSession: ActiveSession | null;
  history: SessionHistoryRecord[];
}

const MAX_HISTORY_RECORDS = 500;

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

function isSessionHistoryRecord(value: unknown): value is SessionHistoryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SessionHistoryRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.playerId === 'string' &&
    typeof record.label === 'string' &&
    (record.activity === 'game' || record.activity === 'tv') &&
    typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt)) &&
    typeof record.endedAt === 'string' && Number.isFinite(Date.parse(record.endedAt)) &&
    Number.isFinite(record.plannedMinutes) && (record.plannedMinutes as number) >= 0 &&
    Number.isFinite(record.actualMinutes) && (record.actualMinutes as number) >= 0 &&
    (record.endReason === 'manual' || record.endReason === 'expired' || record.endReason === 'offline_expired') &&
    typeof record.powerOffOk === 'boolean'
  );
}

export class GameQuotaService {
  private cfg: GameQuotaConfig;
  private state: PersistedState;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(cfg: GameQuotaConfig = loadGameQuotaConfig()) {
    this.cfg = cfg;
    this.state = this.loadFromDisk();
  }

  getConfig(): GameQuotaConfig {
    return this.cfg;
  }

  /**
   * 运行时热更新配额相关配置（Web 管理端保存后调用）。
   * 只覆盖传入的字段，持久化文件路径 `file` 不允许改。
   */
  updateConfig(partial: Partial<Omit<GameQuotaConfig, 'file'>>): GameQuotaConfig {
    const next: GameQuotaConfig = { ...this.cfg };
    if (Number.isFinite(partial.dailyQuotaMin) && (partial.dailyQuotaMin as number) >= 0) {
      next.dailyQuotaMin = Math.floor(partial.dailyQuotaMin as number);
    }
    if (Array.isArray(partial.allowedWeekdays)) {
      const wd = partial.allowedWeekdays
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      next.allowedWeekdays = Array.from(new Set(wd));
    }
    if (Number.isFinite(partial.maxSingleSessionMin) && (partial.maxSingleSessionMin as number) > 0) {
      next.maxSingleSessionMin = Math.floor(partial.maxSingleSessionMin as number);
    }
    if (Number.isFinite(partial.minSingleSessionMin) && (partial.minSingleSessionMin as number) > 0) {
      next.minSingleSessionMin = Math.floor(partial.minSingleSessionMin as number);
    }
    if (next.minSingleSessionMin > next.maxSingleSessionMin) {
      next.minSingleSessionMin = next.maxSingleSessionMin;
    }
    this.cfg = next;
    return next;
  }

  // ---------------- 公共能力 ----------------

  isAllowedToday(now: Date = new Date()): boolean {
    return this.cfg.allowedWeekdays.includes(now.getDay());
  }

  getSnapshot(child: PlayerId, now: Date = new Date()): QuotaSnapshot {
    const today = localDateString(now);
    const cur = this.state.users[child];
    const sameDay = !!(cur && cur.date === today);
    const used = sameDay ? cur!.usedMinutes : 0;
    const bonus = sameDay ? cur!.bonusMinutes ?? 0 : 0;
    const daily = this.cfg.dailyQuotaMin;
    const effective = daily + bonus; // 当日可用总额 = 基础配额 + 临时加时
    return {
      child,
      date: today,
      dailyQuotaMin: daily,
      bonusMinutes: bonus,
      usedMinutes: used,
      remainingMinutes: Math.max(0, effective - used),
      allowedToday: this.isAllowedToday(now),
    };
  }

  /** 扣减配额。minutes < 0 视为退还。返回最新剩余分钟数。 */
  consume(child: PlayerId, minutes: number, now: Date = new Date()): number {
    if (!Number.isFinite(minutes)) throw new Error(`Invalid minutes: ${minutes}`);
    const today = localDateString(now);
    const cur = this.state.users[child];
    const sameDay = !!(cur && cur.date === today);
    let used = sameDay ? cur!.usedMinutes : 0;
    const bonus = sameDay ? cur!.bonusMinutes ?? 0 : 0;
    const effective = this.cfg.dailyQuotaMin + bonus;
    used = Math.max(0, used + Math.round(minutes));
    used = Math.min(used, effective); // 不允许超过当日可用总额（含临时加时）
    this.state.users[child] = { date: today, usedMinutes: used, bonusMinutes: bonus };
    this.scheduleFlush();
    return Math.max(0, effective - used);
  }

  /**
   * 管理员临时加时（正数增加、负数收回），仅当天有效、跨天清零。
   * bonus 不会降到 0 以下。返回最新剩余分钟数。
   */
  addBonus(child: PlayerId, minutes: number, now: Date = new Date()): number {
    if (!Number.isFinite(minutes)) throw new Error(`Invalid minutes: ${minutes}`);
    const today = localDateString(now);
    const cur = this.state.users[child];
    const sameDay = !!(cur && cur.date === today);
    const used = sameDay ? cur!.usedMinutes : 0;
    let bonus = sameDay ? cur!.bonusMinutes ?? 0 : 0;
    bonus = Math.max(0, bonus + Math.round(minutes));
    this.state.users[child] = { date: today, usedMinutes: used, bonusMinutes: bonus };
    this.scheduleFlush();
    return Math.max(0, this.cfg.dailyQuotaMin + bonus - used);
  }

  /**
   * 管理员直接设定某玩家今日总时间（总额）为 target 分钟（精确设置，非增量）。
   * 保持已用时间 usedMinutes 不变，通过 bonus 使总额 == target：
   *   总额 = dailyQuotaMin + bonus，因此 bonus = target - daily（允许为负以支持低于基础配额）。
   * 仅当天有效、跨天重置。返回设置后的今日总时间（分钟）。
   */
  setTotal(child: PlayerId, targetMinutes: number, now: Date = new Date()): number {
    if (!Number.isFinite(targetMinutes)) throw new Error(`Invalid minutes: ${targetMinutes}`);
    const target = Math.max(0, Math.round(targetMinutes));
    const today = localDateString(now);
    const cur = this.state.users[child];
    const sameDay = !!(cur && cur.date === today);
    const used = sameDay ? cur!.usedMinutes : 0;
    const bonus = target - this.cfg.dailyQuotaMin;
    this.state.users[child] = { date: today, usedMinutes: used, bonusMinutes: bonus };
    this.scheduleFlush();
    return target;
  }

  refund(child: PlayerId, minutes: number, now?: Date): number {
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

  /** 一次性完成会话扣额、清空活动状态并写入历史记录。 */
  finishSession(
    session: ActiveSession,
    actualMinutes: number,
    endReason: SessionEndReason,
    powerOffOk: boolean,
    endedAt: Date = new Date(),
  ): number {
    if (this.state.activeSession?.startedAt !== session.startedAt) {
      return this.getSnapshot(session.child, endedAt).remainingMinutes;
    }
    const minutes = Math.max(0, Math.min(session.plannedMinutes, Math.round(actualMinutes)));
    const today = localDateString(endedAt);
    const cur = this.state.users[session.child];
    const sameDay = !!(cur && cur.date === today);
    const used = sameDay ? cur!.usedMinutes : 0;
    const bonus = sameDay ? cur!.bonusMinutes ?? 0 : 0;
    const effective = Math.max(0, this.cfg.dailyQuotaMin + bonus);
    const nextUsed = Math.min(effective, Math.max(0, used + minutes));
    this.state.users[session.child] = { date: today, usedMinutes: nextUsed, bonusMinutes: bonus };
    this.state.activeSession = null;

    const id = `${session.child}:${session.startedAt}`;
    if (!this.state.history.some((record) => record.id === id)) {
      this.state.history.unshift({
        id,
        playerId: session.child,
        label: session.label ?? session.child,
        activity: session.activity === 'tv' ? 'tv' : 'game',
        startedAt: session.startedAt,
        endedAt: endedAt.toISOString(),
        plannedMinutes: session.plannedMinutes,
        actualMinutes: minutes,
        endReason,
        powerOffOk,
      });
      this.state.history = this.state.history.slice(0, MAX_HISTORY_RECORDS);
    }
    this.scheduleFlush();
    return Math.max(0, effective - nextUsed);
  }

  listHistory(playerId?: PlayerId, limit = 50): SessionHistoryRecord[] {
    const count = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    const records = playerId
      ? this.state.history.filter((record) => record.playerId === playerId)
      : this.state.history;
    return records.slice(0, count).map((record) => ({ ...record }));
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
    return { version: 2, users: {}, activeSession: null, history: [] };
  }

  private loadFromDisk(): PersistedState {
    try {
      if (!existsSync(this.cfg.file)) return this.emptyState();
      const raw = readFileSync(this.cfg.file, 'utf8');
      if (!raw.trim()) return this.emptyState();
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const history = Array.isArray(parsed.history)
        ? parsed.history.filter(isSessionHistoryRecord).slice(0, MAX_HISTORY_RECORDS)
        : [];
      const state: PersistedState = {
        version: 2,
        users: parsed.users && typeof parsed.users === 'object' ? (parsed.users as PersistedState['users']) : {},
        activeSession: parsed.activeSession ?? null,
        history,
      };
      logger.info('game-quota.loaded', {
        file: this.cfg.file,
        hasActive: !!state.activeSession,
        historyCount: state.history.length,
      });
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
