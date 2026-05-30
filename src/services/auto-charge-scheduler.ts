/**
 * AutoChargeScheduler（单例）
 *
 * 每天 startHHmm 给游戏机插孔通电、endHHmm 断电，本地时区。背景任务，
 * 不走 LLM、不走 TTS——凌晨别吵醒人，只写结构化日志。
 *
 * 设计要点：
 *   - "on" 与 "off" 各自独立 setTimeout 调度（不依赖 on 触发后再排 off）；
 *     这样进程在 03:30 崩溃重启时，off 也能从持久化状态正确恢复。
 *   - 状态写 .runtime/auto-charge-state.json（tmp+rename 原子写、串行 chain），
 *     语义只记"上一次的 on/off 时刻"——避免重启后短时间内重复开机弄乱日志。
 *   - 设备访问全走 GameConsoleController.forcePowerOn/Off，不直接 new GosundPlug。
 *   - 与 ReminderService 同构地暴露 start() / recover() / shutdown()。
 *
 * 不做（明确拒绝域）：
 *   - ❌ 不引第三方 cron 库：一天 2 个 tick 没必要；
 *   - ❌ 不给 LLM 暴露工具：纯后台守护，越简单越好；
 *   - ❌ 不做电池电量监测：插板没这能力，固定 2 小时窗口够 Switch 一晚损耗；
 *   - ❌ 错过窗口超 grace 不再补操作：白天用户可能自己开过插板，不能误关。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../common/logger';
import type { AppConfig } from '../config/env';
import { loadConfig } from '../config/env';
import {
  GameConsoleController,
  getGameConsoleController,
} from './game-console-controller';

/** 启动 recover 时，若刚错过 endHHmm 不超过 10 分钟，立即补关一次。 */
const OFF_RECOVER_GRACE_MS = 10 * 60 * 1000;

/** 启动 recover 时，若已进入窗口但还没到 startHHmm 一段时间，仍按"刚崩重启"处理直接补开。 */
const ON_RECOVER_GRACE_MS = 30 * 60 * 1000;

/** off 失败后的重试次数与单次间隔——5 次 × 1 分钟，覆盖临时 wifi 抖动。 */
const OFF_RETRY_TIMES = 5;
const OFF_RETRY_INTERVAL_MS = 60 * 1000;

/** setTimeout 单次最大延迟（ms）：2^31-1 ≈ 24.85 天。本场景 24h 内一定能到，留作护栏。 */
const SCHEDULE_CAP_MS = 23 * 24 * 3600 * 1000;

type Action = 'on' | 'off';

interface PersistedState {
  version: 1;
  /** 上一次 on 实际触发的 ISO；启动时用来判断"窗口内是否已开过电"。 */
  lastOnIso?: string;
  /** 上一次 off 实际触发的 ISO；启动时用来判断"是否需要补关"。 */
  lastOffIso?: string;
  /** 最近一次状态码，仅用于排查；不参与任何决策。 */
  lastStatus?:
    | 'ok'
    | 'skipped_active_session'
    | 'power_on_failed'
    | 'power_off_failed';
}

interface SchedulerOptions {
  enabled: boolean;
  startHHmm: string;
  endHHmm: string;
  stateFile: string;
  controller: GameConsoleController;
}

function loadOptionsFromConfig(
  config: AppConfig,
  controller: GameConsoleController,
): SchedulerOptions {
  return {
    enabled: config.autoChargeEnabled,
    startHHmm: config.autoChargeStartHHmm,
    endHHmm: config.autoChargeEndHHmm,
    stateFile: resolve(config.autoChargeStateFile),
    controller,
  };
}

/** 解析 "HH:mm" 为 [hour, minute]；调用方保证已被 env.ts 校验过格式。 */
function splitHHmm(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(':').map(Number);
  return [h, m];
}

/**
 * 找"下一个本地时刻 HH:mm"对应的 Date：今天还没到就用今天，否则用明天。
 * 不依赖 UTC，纯按本机时区。
 */
function nextLocalTime(hhmm: string, now: Date = new Date()): Date {
  const [h, m] = splitHHmm(hhmm);
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/** 以 now 所在的"自然日"为锚，返回今天的 HH:mm；不做"过去/未来"判断。 */
function todayLocalTime(hhmm: string, now: Date = new Date()): Date {
  const [h, m] = splitHHmm(hhmm);
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  return t;
}

/** 本地日期 YYYY-MM-DD，用于判断 lastOnIso / lastOffIso 是不是今天发生的。 */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class AutoChargeScheduler {
  private readonly opts: SchedulerOptions;
  private state: PersistedState = { version: 1 };
  private timers = new Map<Action, NodeJS.Timeout>();
  private writeChain: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.loadState();
  }

  /**
   * 启动两条独立的"每日同时刻"定时链。幂等：多次调用只生效一次。
   * 当 enabled=false 或插板未配置时，写一行说明日志后直接返回。
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.opts.enabled) {
      logger.info('auto-charge.scheduler.disabled', { reason: 'config_disabled' });
      return;
    }
    if (!this.opts.controller.isPlugConfigured()) {
      logger.info('auto-charge.scheduler.disabled', { reason: 'plug_not_configured' });
      return;
    }

    this.scheduleNext('on');
    this.scheduleNext('off');

    logger.info('auto-charge.scheduler.start', {
      startHHmm: this.opts.startHHmm,
      endHHmm: this.opts.endHHmm,
      nextOnIso: nextLocalTime(this.opts.startHHmm).toISOString(),
      nextOffIso: nextLocalTime(this.opts.endHHmm).toISOString(),
    });
  }

  /**
   * 启动恢复：处理三种"非正常重启"位置——
   *   1. 在窗口内（startHHmm 已过、endHHmm 未到）：
   *        - 今天还没开过电 → 立即补开；
   *        - off 必然在未来，scheduleNext 自然会接上。
   *   2. 刚错过 endHHmm 不超过 grace（默认 10 min），且今天还没关过电 → 立即补关；
   *   3. 错过窗口已超 grace：仅写 warn，不主动操作设备（避免误关白天用户主动开的插板）。
   *
   * 必须在 start() 之后调用——start() 已挂好未来的定时器，本方法只补"过去那段"。
   */
  async recover(): Promise<void> {
    if (!this.opts.enabled || !this.opts.controller.isPlugConfigured()) return;

    const now = new Date();
    const today = localDateStr(now);
    const todayStart = todayLocalTime(this.opts.startHHmm, now);
    const todayEnd = todayLocalTime(this.opts.endHHmm, now);

    const inWindow = now >= todayStart && now < todayEnd;
    const justAfterEnd =
      now >= todayEnd && now.getTime() - todayEnd.getTime() <= OFF_RECOVER_GRACE_MS;

    const lastOnDay = this.state.lastOnIso ? localDateStr(new Date(this.state.lastOnIso)) : null;
    const lastOffDay = this.state.lastOffIso ? localDateStr(new Date(this.state.lastOffIso)) : null;

    if (inWindow) {
      // 窗口内：今天没开过电就立即补开；超过 ON_RECOVER_GRACE_MS 也仍然开，因为 off 还没到。
      if (lastOnDay !== today) {
        logger.info('auto-charge.recover.late_on', {
          lateMs: now.getTime() - todayStart.getTime(),
        });
        await this.fire('on');
      } else {
        logger.info('auto-charge.recover.in_window_already_on', {
          lastOnIso: this.state.lastOnIso,
        });
      }
      return;
    }

    if (justAfterEnd) {
      // 刚错过 off：今天还没关过电就立即补关
      if (lastOffDay !== today) {
        logger.info('auto-charge.recover.late_off', {
          lateMs: now.getTime() - todayEnd.getTime(),
        });
        await this.fire('off');
      } else {
        logger.info('auto-charge.recover.just_after_end_already_off', {
          lastOffIso: this.state.lastOffIso,
        });
      }
      return;
    }

    // 窗口外正常情况，或错过窗口已超 grace
    if (now > todayEnd) {
      logger.info('auto-charge.recover.missed_window', {
        lateMs: now.getTime() - todayEnd.getTime(),
      });
    } else {
      logger.info('auto-charge.recover.outside_window', {
        nextOnIso: nextLocalTime(this.opts.startHHmm).toISOString(),
      });
    }
  }

  /** 进程退出时调，幂等。clearTimeout 后允许事件循环顺利结束。 */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------- internal ----------------

  /** 排定下一个 action（on/off）的定时器；触发后自动排下一天的同 action。 */
  private scheduleNext(action: Action): void {
    if (this.stopped) return;

    const old = this.timers.get(action);
    if (old) clearTimeout(old);

    const target = nextLocalTime(action === 'on' ? this.opts.startHHmm : this.opts.endHHmm);
    const ms = target.getTime() - Date.now();
    const delay = Math.min(Math.max(0, ms), SCHEDULE_CAP_MS);

    const timer = setTimeout(() => {
      this.timers.delete(action);
      // 中转 timer：极少触发（24h < 23 天），但保留与 reminder-service 一致的护栏
      const remaining = target.getTime() - Date.now();
      if (remaining > 0) {
        this.scheduleNext(action);
        return;
      }
      void this.fire(action).finally(() => {
        if (!this.stopped) this.scheduleNext(action);
      });
    }, delay);

    this.timers.set(action, timer);
  }

  /**
   * 真正执行 on / off：
   *   - on：先看小孩是否还在玩（极少见，但可能是 quota 状态没清干净）→ 是则跳过本次；
   *   - off：不看 active session，凌晨 5 点该关就关；带最多 5 次 1 分钟间隔的重试。
   * 任一分支结束后写持久化状态（tmp+rename 原子）。
   */
  private async fire(action: Action): Promise<void> {
    if (this.stopped) return;
    const startedAt = new Date();

    if (action === 'on') {
      if (this.opts.controller.hasActiveSession()) {
        this.state.lastStatus = 'skipped_active_session';
        this.persist();
        logger.warn('auto-charge.skip.active_session', {
          at: startedAt.toISOString(),
        });
        return;
      }
      const r = await this.opts.controller.forcePowerOn();
      this.state.lastOnIso = startedAt.toISOString();
      this.state.lastStatus = r.ok ? 'ok' : 'power_on_failed';
      this.persist();
      logger.info('auto-charge.power_on', {
        ok: r.ok,
        error: r.error,
        at: startedAt.toISOString(),
      });
      return;
    }

    // action === 'off'：带重试
    let ok = false;
    let lastError: string | undefined;
    let attempts = 0;
    for (let i = 1; i <= OFF_RETRY_TIMES; i += 1) {
      attempts = i;
      const r = await this.opts.controller.forcePowerOff();
      if (r.ok) {
        ok = true;
        break;
      }
      lastError = r.error;
      logger.warn('auto-charge.power_off_attempt_failed', { attempt: i, error: r.error });
      if (i < OFF_RETRY_TIMES) {
        await sleep(OFF_RETRY_INTERVAL_MS);
        if (this.stopped) return;
      }
    }
    this.state.lastOffIso = new Date().toISOString();
    this.state.lastStatus = ok ? 'ok' : 'power_off_failed';
    this.persist();
    logger.info('auto-charge.power_off', {
      ok,
      attempts,
      error: ok ? undefined : lastError,
      at: this.state.lastOffIso,
    });
  }

  // ---------------- persistence ----------------

  private loadState(): void {
    try {
      if (!existsSync(this.opts.stateFile)) return;
      const raw = readFileSync(this.opts.stateFile, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (!parsed || parsed.version !== 1) {
        this.backupCorruptFile();
        return;
      }
      this.state = {
        version: 1,
        lastOnIso: parsed.lastOnIso,
        lastOffIso: parsed.lastOffIso,
        lastStatus: parsed.lastStatus,
      };
      logger.info('auto-charge.state.loaded', {
        path: this.opts.stateFile,
        lastOnIso: this.state.lastOnIso,
        lastOffIso: this.state.lastOffIso,
        lastStatus: this.state.lastStatus,
      });
    } catch (error) {
      logger.warn('auto-charge.state.load_failed', {
        path: this.opts.stateFile,
        error: (error as Error).message,
      });
      this.backupCorruptFile();
      this.state = { version: 1 };
    }
  }

  private backupCorruptFile(): void {
    try {
      if (!existsSync(this.opts.stateFile)) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${this.opts.stateFile}.bad-${ts}.json`;
      renameSync(this.opts.stateFile, backup);
      logger.warn('auto-charge.state.backup_corrupt', { backup });
    } catch (error) {
      logger.warn('auto-charge.state.backup_failed', {
        error: (error as Error).message,
      });
    }
  }

  /** 串行写盘 + tmp+rename 原子替换；与 reminder-service 同样的策略。 */
  private persist(): void {
    const snapshot: PersistedState = { ...this.state, version: 1 };
    const file = this.opts.stateFile;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          mkdirSync(dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
          renameSync(tmp, file);
        } catch (error) {
          logger.warn('auto-charge.state.save_failed', {
            file,
            error: (error as Error).message,
          });
        }
      });
  }

  // ---------------- 仅供测试 ----------------

  /** 测试用：观察当前定时器状态。 */
  _debugTimerCount(): number {
    return this.timers.size;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- 单例 ----------------

let singleton: AutoChargeScheduler | null = null;

export function getAutoChargeScheduler(): AutoChargeScheduler {
  if (!singleton) {
    const config = loadConfig();
    singleton = new AutoChargeScheduler(loadOptionsFromConfig(config, getGameConsoleController()));
  }
  return singleton;
}

/** 仅测试用。 */
export function _resetAutoChargeSchedulerForTest(): void {
  singleton?.shutdown();
  singleton = null;
}
