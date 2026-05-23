/**
 * 单实例游戏会话定时器。
 *
 * 给一个 endsAt + 提醒分钟数列表，会在合适的时刻触发回调；
 * 不关心断电/配额，纯调度。
 */

import { logger } from '../common/logger';
import type { ChildKey } from './game-quota';

export interface StartOptions {
  child: ChildKey;
  /** 计划结束时间 */
  endsAt: Date;
  /** 到期前几秒提醒，默认 [300, 60]（即 5 分钟 / 1 分钟） */
  reminderSeconds?: number[];
  /** 提醒回调；secondsLeft 是触发时距离 endsAt 还有多少秒 */
  onReminder: (secondsLeft: number) => void | Promise<void>;
  /** 到期回调；通常需要在内部完成断电 + 配额结算 */
  onExpired: () => void | Promise<void>;
}

interface InternalTimer {
  child: ChildKey;
  endsAt: number;
  timers: NodeJS.Timeout[];
}

export class GameSessionTimer {
  private cur: InternalTimer | null = null;

  start(opts: StartOptions): void {
    this.cancel();

    const reminders = (opts.reminderSeconds ?? [300, 60])
      .filter((s) => s > 0)
      .sort((a, b) => b - a); // 大→小依次触发

    const endsAtMs = opts.endsAt.getTime();
    const now = Date.now();
    const timers: NodeJS.Timeout[] = [];

    for (const s of reminders) {
      const triggerAt = endsAtMs - s * 1000;
      const delay = triggerAt - now;
      if (delay <= 0) continue; // 错过了就跳过

      const t = setTimeout(() => {
        Promise.resolve(opts.onReminder(s)).catch((error) => {
          logger.warn('game-timer.reminder_failed', {
            child: opts.child,
            secondsLeft: s,
            error: (error as Error).message,
          });
        });
      }, delay);
      // 不阻止进程退出
      if (typeof t.unref === 'function') t.unref();
      timers.push(t);
    }

    const expireDelay = Math.max(0, endsAtMs - now);
    const expireTimer = setTimeout(() => {
      Promise.resolve(opts.onExpired())
        .catch((error) => {
          logger.error('game-timer.expired_failed', {
            child: opts.child,
            error: (error as Error).message,
          });
        })
        .finally(() => {
          if (this.cur && this.cur.endsAt === endsAtMs) {
            this.cur = null;
          }
        });
    }, expireDelay);
    if (typeof expireTimer.unref === 'function') expireTimer.unref();
    timers.push(expireTimer);

    this.cur = { child: opts.child, endsAt: endsAtMs, timers };

    logger.info('game-timer.started', {
      child: opts.child,
      endsAt: opts.endsAt.toISOString(),
      reminders,
      delaysSec: timers.map((_, i) =>
        i < reminders.length
          ? Math.round((endsAtMs - reminders[i] * 1000 - now) / 1000)
          : Math.round(expireDelay / 1000),
      ),
    });
  }

  cancel(): void {
    if (!this.cur) return;
    for (const t of this.cur.timers) clearTimeout(t);
    logger.info('game-timer.cancelled', { child: this.cur.child });
    this.cur = null;
  }

  isRunning(): boolean {
    return this.cur !== null;
  }

  getCurrent(): { child: ChildKey; endsAt: Date } | null {
    if (!this.cur) return null;
    return { child: this.cur.child, endsAt: new Date(this.cur.endsAt) };
  }
}
