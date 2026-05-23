/**
 * ReminderService（单例）
 *
 * 职责：
 *   - CRUD：create / list / cancel
 *   - 调度：用 setTimeout 维护一个 id → timer 表；解决 24.8 天上限用"中转 timer"
 *   - 持久化：JSON 文件，原子写（tmp + rename），写盘串行 chain
 *   - 启动恢复：进程重启时调用 recover()，把 active 的提醒重新挂上定时器
 *
 * 设计要点：
 *   - 与 GameConsoleController 同构：通过 setAnnouncer(fn) 注入主动播报回调，
 *     fn 一般指向 DialogSession.announce(text)，由 dialog 层处理"忙时排队 / 闲时播放"。
 *   - 时间解析交给 LLM：本服务只接 ISO 字符串，做严格校验。
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../common/logger';
import {
  formatHHmm,
  nextDailyFire,
  parseIso,
  validateFutureIso,
  fuzzyMatch,
} from './reminder-time';
import type {
  Reminder,
  ReminderFilePayload,
  ReminderId,
  ReminderRecurrence,
} from './reminder-types';

type Announcer = (text: string) => void | Promise<void>;

/** setTimeout 单次最大延迟（ms）：2^31-1 ≈ 24.85 天。留点余量取 23 天。 */
const SCHEDULE_CAP_MS = 23 * 24 * 3600 * 1000;

/** 启动 recover 时，错过多久内的提醒还允许补播。 */
const RECOVER_GRACE_MS = 5 * 60 * 1000;

/** 单条 text 上限，超过截断，避免播报念半天。 */
const MAX_TEXT_LEN = 80;

/** list 的默认返回上限（按 nextFireAt 升序）。 */
const DEFAULT_LIST_LIMIT = 10;

export interface CreateReminderInput {
  text: string;
  fireAtIso: string;
  recurrence?: ReminderRecurrence;
}

export interface CreateResult {
  ok: boolean;
  reason?: 'invalid_text' | 'invalid_time' | 'past_time' | 'invalid_recurrence';
  reminder?: Reminder;
  message: string;
}

export interface ListResult {
  ok: true;
  items: Reminder[];
  message: string;
}

export interface CancelResult {
  ok: boolean;
  reason?: 'not_found' | 'ambiguous' | 'invalid_query';
  cancelled?: Reminder;
  matches?: Reminder[];
  message: string;
}

export class ReminderService {
  private readonly storePath: string;
  private items: Reminder[] = [];
  private timers = new Map<ReminderId, NodeJS.Timeout>();
  private announcer: Announcer | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private recovered = false;

  constructor(storePath?: string) {
    this.storePath = resolve(
      storePath || process.env.REMINDER_STORE_PATH || '.runtime/reminders.json',
    );
    this.loadFromDisk();
  }

  // ---------------- public API ----------------

  setAnnouncer(fn: Announcer | null): void {
    this.announcer = fn;
  }

  create(input: CreateReminderInput): CreateResult {
    const text = (input.text || '').trim();
    if (!text) {
      return { ok: false, reason: 'invalid_text', message: '提醒内容不能为空。' };
    }
    const safeText = text.length > MAX_TEXT_LEN ? text.slice(0, MAX_TEXT_LEN) : text;
    if (safeText.length !== text.length) {
      logger.warn('reminder.create.text_truncated', {
        original: text.length,
        kept: safeText.length,
      });
    }

    const recurrence: ReminderRecurrence = input.recurrence ?? { kind: 'once' };

    const validated = validateFutureIso(input.fireAtIso);
    if (!validated.ok) {
      const reason = validated.reason === 'past' ? 'past_time' : 'invalid_time';
      const msg =
        reason === 'past_time'
          ? '这个时间已经过去了，要订哪一天？'
          : '提醒时间格式不对，再说一遍是几月几号几点？';
      return { ok: false, reason, message: msg };
    }
    const fireAt = validated.fireAt;

    // 校验 daily：HH:MM 必须能从 fireAtIso 推出（取本地时区时分），与传入的 atHHmm 一致
    if (recurrence.kind === 'daily') {
      const expected = formatHHmm(fireAt);
      if (recurrence.atHHmm !== expected) {
        // 以 fireAtIso 推出来的为准（更可信），同步覆写一下，避免上层 LLM 给错时分
        recurrence.atHHmm = expected;
      }
    }

    const reminder: Reminder = {
      id: randomUUID(),
      text: safeText,
      createdAtIso: new Date().toISOString(),
      nextFireAtIso: fireAt.toISOString(),
      recurrence,
      status: 'active',
    };

    this.items.push(reminder);
    this.persist();
    this.scheduleOne(reminder);

    logger.info('reminder.create', {
      id: reminder.id,
      text: reminder.text,
      nextFireAtIso: reminder.nextFireAtIso,
      kind: reminder.recurrence.kind,
    });

    return {
      ok: true,
      reminder,
      message: this.buildCreateMessage(reminder),
    };
  }

  list(opts?: { onlyActive?: boolean; limit?: number }): ListResult {
    const onlyActive = opts?.onlyActive ?? true;
    const limit = Math.max(1, opts?.limit ?? DEFAULT_LIST_LIMIT);

    const all = onlyActive
      ? this.items.filter((r) => r.status === 'active')
      : this.items.slice();
    all.sort(
      (a, b) =>
        new Date(a.nextFireAtIso).getTime() - new Date(b.nextFireAtIso).getTime(),
    );
    const items = all.slice(0, limit);

    let message: string;
    if (items.length === 0) {
      message = '现在没有提醒事项。';
    } else {
      // 只告诉 LLM 有几条；具体每条的时间/内容通过 items 字段给出，
      // 由 LLM 结合当前时间自己组织成自然口语（如"明天下午四点送余跃去打球"）。
      message = `当前有 ${items.length} 条提醒，详见 items 字段，请用自然中文按顺序念给用户。`;
    }
    return { ok: true, items, message };
  }

  /**
   * 按 id（精确）或 query（模糊）取消提醒。
   *  - 精确匹配 id → 直接取消；
   *  - 模糊匹配 query：
   *      0 条 → not_found；
   *      1 条 → 取消；
   *      ≥2 条 → ambiguous，把候选返回让 LLM 反问。
   */
  cancel(input: { id?: string | null; query?: string | null }): CancelResult {
    const active = this.items.filter((r) => r.status === 'active');

    if (input.id) {
      const found = active.find((r) => r.id === input.id);
      if (!found) {
        return {
          ok: false,
          reason: 'not_found',
          message: '没有找到对应的提醒。',
        };
      }
      this.cancelInternal(found);
      return {
        ok: true,
        cancelled: found,
        message: `好的，已经取消"${found.text}"的提醒。`,
      };
    }

    const q = (input.query || '').trim();
    if (!q) {
      return {
        ok: false,
        reason: 'invalid_query',
        message: '要取消哪个提醒？告诉我关键词。',
      };
    }

    const matched = fuzzyMatch(active, q);
    if (matched.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
        message: `没有找到包含"${q}"的提醒。`,
      };
    }
    if (matched.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        matches: matched,
        message: `匹配到 ${matched.length} 条提醒，详见 matches 字段。请按时间和内容反问用户要取消哪一个。`,
      };
    }

    const target = matched[0];
    this.cancelInternal(target);
    return {
      ok: true,
      cancelled: target,
      message: `好的，已经取消"${target.text}"的提醒。`,
    };
  }

  /**
   * 进程启动后调用一次。处理三类情况：
   *   1. nextFireAt 在未来 → 重新挂定时器；
   *   2. 已过期但在 grace（5min）内 → 立即补播一次；
   *   3. 已过期超过 grace → once 标 missed；daily 推到下一次时刻并挂定时器。
   *
   * 幂等：多次调用只生效一次。
   */
  async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;

    const now = Date.now();
    let mutated = false;

    for (const r of this.items) {
      if (r.status !== 'active') continue;

      const next = parseIso(r.nextFireAtIso);
      if (!next) {
        logger.warn('reminder.recover.invalid_iso', {
          id: r.id,
          iso: r.nextFireAtIso,
        });
        r.status = 'missed';
        mutated = true;
        continue;
      }

      const diff = next.getTime() - now;
      if (diff > 0) {
        this.scheduleOne(r);
        continue;
      }

      // 已过期
      if (-diff <= RECOVER_GRACE_MS) {
        logger.info('reminder.recover.fire_late', {
          id: r.id,
          lateMs: -diff,
        });
        // 异步补播，不阻塞 recover
        void this.fire(r);
      } else if (r.recurrence.kind === 'once') {
        logger.warn('reminder.recover.missed', {
          id: r.id,
          text: r.text,
          shouldFireAt: r.nextFireAtIso,
          lateMs: -diff,
        });
        r.status = 'missed';
        mutated = true;
      } else {
        // daily 错过了，推进到下一次
        const upcoming = nextDailyFire(r.recurrence.atHHmm, new Date());
        if (upcoming) {
          r.nextFireAtIso = upcoming.toISOString();
          mutated = true;
          this.scheduleOne(r);
          logger.info('reminder.recover.daily_advanced', {
            id: r.id,
            next: r.nextFireAtIso,
          });
        } else {
          r.status = 'missed';
          mutated = true;
        }
      }
    }

    if (mutated) this.persist();
  }

  /** 仅用于诊断/测试。 */
  getCount(): { active: number; total: number; scheduled: number } {
    return {
      active: this.items.filter((r) => r.status === 'active').length,
      total: this.items.length,
      scheduled: this.timers.size,
    };
  }

  /** 仅用于测试：清掉所有定时器，避免 jest 卡住。 */
  shutdown(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------- internal ----------------

  private cancelInternal(r: Reminder): void {
    r.status = 'cancelled';
    const t = this.timers.get(r.id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(r.id);
    }
    this.persist();
    logger.info('reminder.cancel', { id: r.id, text: r.text });
  }

  private scheduleOne(r: Reminder): void {
    // 先清理可能存在的旧 timer（recover/重新挂定时器时会用到）
    const old = this.timers.get(r.id);
    if (old) clearTimeout(old);

    const ms = new Date(r.nextFireAtIso).getTime() - Date.now();
    if (ms <= 0) {
      void this.fire(r);
      return;
    }
    const delay = Math.min(ms, SCHEDULE_CAP_MS);
    const timer = setTimeout(() => {
      this.timers.delete(r.id);
      // 若是中转定时器（实际还没到点），再排下一段
      const remaining = new Date(r.nextFireAtIso).getTime() - Date.now();
      if (remaining > 0) {
        this.scheduleOne(r);
      } else {
        void this.fire(r);
      }
    }, delay);
    // Node 默认 setTimeout 持有事件循环引用；保留默认即可，让进程在仍有提醒时不退出
    this.timers.set(r.id, timer);
  }

  private async fire(r: Reminder): Promise<void> {
    // 防御：可能在挂起期间已被取消
    const cur = this.items.find((it) => it.id === r.id);
    if (!cur || cur.status !== 'active') {
      logger.info('reminder.fire.skipped_inactive', {
        id: r.id,
        status: cur?.status,
      });
      return;
    }

    const text = `提醒一下，${cur.text}。`;
    try {
      if (this.announcer) {
        await this.announcer(text);
      } else {
        logger.warn('reminder.fire.no_announcer', { id: cur.id, text });
      }
    } catch (error) {
      logger.warn('reminder.fire.announce_failed', {
        id: cur.id,
        error: (error as Error).message,
      });
    }

    cur.lastFiredAtIso = new Date().toISOString();
    logger.info('reminder.fire', {
      id: cur.id,
      text: cur.text,
      kind: cur.recurrence.kind,
    });

    if (cur.recurrence.kind === 'once') {
      cur.status = 'fired';
      this.timers.delete(cur.id);
    } else {
      // daily：推进到下一次合法时刻并重新挂定时器
      const upcoming = nextDailyFire(cur.recurrence.atHHmm, new Date());
      if (upcoming) {
        cur.nextFireAtIso = upcoming.toISOString();
        this.scheduleOne(cur);
      } else {
        cur.status = 'missed';
        logger.warn('reminder.fire.daily_advance_failed', {
          id: cur.id,
          atHHmm: cur.recurrence.atHHmm,
        });
      }
    }
    this.persist();
  }

  private buildCreateMessage(r: Reminder): string {
    // 只给"已创建成功"的语义提示，时间话术由 LLM 念。
    // LLM 根据返回的 reminder.nextFireAtIso + recurrence 自己组织：
    //   once  → "好的，明天下午四点提醒你送余跃去打球。"
    //   daily → "好的，每天早上七点会提醒你吃药。"
    if (r.recurrence.kind === 'daily') {
      return '已创建每日提醒，请用自然中文向用户确认时间和内容。';
    }
    return '已创建提醒，请用自然中文向用户确认时间和内容。';
  }

  // ---------------- persistence ----------------

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.storePath)) {
        logger.info('reminder.store.empty', { path: this.storePath });
        return;
      }
      const raw = readFileSync(this.storePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Partial<ReminderFilePayload>;
      if (!parsed || !Array.isArray(parsed.items)) {
        this.backupCorruptFile();
        return;
      }
      // 简单字段校验
      this.items = parsed.items.filter((it) => {
        if (!it || typeof it !== 'object') return false;
        if (!it.id || !it.text || !it.nextFireAtIso) return false;
        if (!it.recurrence || (it.recurrence.kind !== 'once' && it.recurrence.kind !== 'daily')) {
          return false;
        }
        return true;
      });
      logger.info('reminder.store.loaded', {
        path: this.storePath,
        items: this.items.length,
        active: this.items.filter((r) => r.status === 'active').length,
      });
    } catch (error) {
      logger.warn('reminder.store.load_failed', {
        path: this.storePath,
        error: (error as Error).message,
      });
      this.backupCorruptFile();
      this.items = [];
    }
  }

  private backupCorruptFile(): void {
    try {
      if (!existsSync(this.storePath)) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${this.storePath}.bad-${ts}.json`;
      renameSync(this.storePath, backup);
      logger.warn('reminder.store.backup_corrupt', { backup });
    } catch (error) {
      logger.warn('reminder.store.backup_failed', {
        error: (error as Error).message,
      });
    }
  }

  /** 串行排队写盘，避免后写覆盖前写。tmp + rename 原子替换。 */
  private persist(): void {
    const snapshot: ReminderFilePayload = {
      version: 1,
      items: this.items.slice(),
    };
    const file = this.storePath;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          mkdirSync(dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
          renameSync(tmp, file);
        } catch (error) {
          logger.warn('reminder.store.save_failed', {
            file,
            error: (error as Error).message,
          });
        }
      });
  }
}

// ---------------- singleton ----------------

let singleton: ReminderService | null = null;

export function getReminderService(): ReminderService {
  if (!singleton) singleton = new ReminderService();
  return singleton;
}

/** 仅用于测试。 */
export function _resetReminderServiceForTest(): void {
  singleton?.shutdown();
  singleton = null;
}
