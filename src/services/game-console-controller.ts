/**
 * 游戏机控制器（单例）：
 *   - 把 GameQuotaService / GameSessionTimer / GosundPlug(s1) 组装到一起
 *   - 同时给 Agent 工具与启动恢复钩子使用
 *
 * 通过 setAnnouncer 注入主动播报回调（DialogSession.announce），
 * 没有注入时退化为 logger 输出，保证模块解耦。
 */

import { logger } from '../common/logger';
import { GosundPlug, SWITCH_SIID_BY_DID } from '../agent/tools/gosund-plug-client';
import {
  ActiveSession,
  CHILDREN,
  ChildKey,
  GameQuotaService,
  getChildProfile,
  loadGameQuotaConfig,
  resolveChildKey,
} from './game-quota';
import { GameSessionTimer } from './game-session-timer';

type Announcer = (text: string) => void | Promise<void>;

export interface GameConsoleConfig {
  plugIp?: string;
  plugToken?: string;
  /** 默认 's1'，可通过 GAME_CONSOLE_PLUG_DID 覆盖 */
  plugDid: string;
  /** 到期前提醒（秒），默认 [300, 60]（即 5 分钟 / 1 分钟） */
  reminderSeconds: number[];
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

function loadGameConsoleConfig(): GameConsoleConfig {
  const did = (process.env.GAME_CONSOLE_PLUG_DID || 's1').trim();
  if (!(did in SWITCH_SIID_BY_DID)) {
    throw new Error(
      `Invalid GAME_CONSOLE_PLUG_DID="${did}". Allowed: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}`,
    );
  }
  // 优先使用 GAME_REMINDER_SECONDS；兼容旧的 GAME_REMINDER_MINUTES（按 60 倍换算）
  let reminderSeconds: number[];
  if (process.env.GAME_REMINDER_SECONDS) {
    reminderSeconds = parseReminderSeconds(process.env.GAME_REMINDER_SECONDS, [300, 60]);
  } else if (process.env.GAME_REMINDER_MINUTES) {
    reminderSeconds = parseReminderSeconds(
      process.env.GAME_REMINDER_MINUTES.split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.floor(n) * 60)
        .join(','),
      [300, 60],
    );
  } else {
    reminderSeconds = [300, 60];
  }
  return {
    plugIp: process.env.GOSUND_PLUG_IP?.trim() || undefined,
    plugToken: process.env.GOSUND_PLUG_TOKEN?.trim() || undefined,
    plugDid: did,
    reminderSeconds,
  };
}

export type StartReason =
  | 'not_weekend'
  | 'no_quota'
  | 'session_in_progress'
  | 'plug_failed'
  | 'invalid_child'
  | 'invalid_minutes'
  | 'plug_not_configured';

export interface GameStartResult {
  ok: boolean;
  child?: ChildKey;
  reason?: StartReason;
  remainingMinutes?: number;
  plannedMinutes?: number;
  endsAtIso?: string;
  message: string;
}

export interface GameStopResult {
  ok: boolean;
  child?: ChildKey;
  actualMinutes?: number;
  remainingMinutes?: number;
  message: string;
}

export interface GameStatusResult {
  ok: true;
  allowedToday: boolean;
  weekday: number;
  quotas: Array<{
    child: ChildKey;
    label: string;
    dailyQuotaMin: number;
    usedMinutes: number;
    remainingMinutes: number;
  }>;
  active: null | {
    child: ChildKey;
    label: string;
    startedAtIso: string;
    endsAtIso: string;
    remainingMinutes: number;
  };
  message: string;
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}点${mm}分`;
}

export class GameConsoleController {
  private readonly cfg: GameConsoleConfig;
  private readonly quota: GameQuotaService;
  private readonly timer = new GameSessionTimer();
  private announcer: Announcer | null = null;

  constructor(cfg: GameConsoleConfig = loadGameConsoleConfig()) {
    this.cfg = cfg;
    this.quota = new GameQuotaService(loadGameQuotaConfig());
  }

  setAnnouncer(fn: Announcer | null): void {
    this.announcer = fn;
  }

  private async announce(text: string): Promise<void> {
    if (this.announcer) {
      try {
        await this.announcer(text);
        return;
      } catch (error) {
        logger.warn('game-console.announce_failed', {
          error: (error as Error).message,
          text,
        });
      }
    }
    logger.info('game-console.announce', { text });
  }

  // ---------------- 设备 ----------------

  private getPlug(): GosundPlug | null {
    if (!this.cfg.plugIp || !this.cfg.plugToken) return null;
    return new GosundPlug(this.cfg.plugIp, this.cfg.plugToken);
  }

  private async powerOn(): Promise<{ ok: boolean; error?: string }> {
    const plug = this.getPlug();
    if (!plug) return { ok: false, error: 'plug_not_configured' };
    try {
      await plug.on(this.cfg.plugDid);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      plug.close();
    }
  }

  private async powerOff(): Promise<{ ok: boolean; error?: string }> {
    const plug = this.getPlug();
    if (!plug) return { ok: false, error: 'plug_not_configured' };
    try {
      await plug.off(this.cfg.plugDid);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      plug.close();
    }
  }

  /** 到期断电；带 1 次重试。失败时尝试主动播报。 */
  private async powerOffOnExpire(): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const r = await this.powerOff();
      if (r.ok) return true;
      logger.warn('game-console.power_off_failed', { attempt, error: r.error });
    }
    await this.announce('游戏机控制失败，请手动关闭电源。');
    return false;
  }

  // ---------------- start / stop / status ----------------

  async start(rawChild: string | null | undefined, rawMinutes: number): Promise<GameStartResult> {
    // 1) child 校验
    const child = resolveChildKey(rawChild);
    if (!child) {
      return {
        ok: false,
        reason: 'invalid_child',
        message: '我不知道是谁要玩，要先告诉我是余晓还是余跃。',
      };
    }
    const profile = getChildProfile(child);

    // 2) weekday 校验
    const now = new Date();
    if (!this.quota.isAllowedToday(now)) {
      return {
        ok: false,
        child,
        reason: 'not_weekend',
        message: `今天是${WEEKDAY_LABEL[now.getDay()]}，平时不能玩游戏哦。`,
      };
    }

    // 3) minutes 校验
    const v = this.quota.validateMinutes(rawMinutes);
    if (!v.ok) {
      const msg =
        v.min <= 0
          ? `每次最多玩 ${v.max} 分钟，再说一遍想玩多久吧。`
          : `每次最少玩 ${v.min} 分钟，最多 ${v.max} 分钟，再说一遍想玩多久吧。`;
      return {
        ok: false,
        child,
        reason: 'invalid_minutes',
        message: msg,
      };
    }
    let minutes = v.minutes;

    // 4) 配额校验
    const snap = this.quota.getSnapshot(child, now);
    if (snap.remainingMinutes <= 0) {
      return {
        ok: false,
        child,
        reason: 'no_quota',
        remainingMinutes: 0,
        message: `${profile.label}今天的游戏时间已经用完了，明天再玩吧。`,
      };
    }
    if (minutes > snap.remainingMinutes) {
      return {
        ok: false,
        child,
        reason: 'no_quota',
        remainingMinutes: snap.remainingMinutes,
        message: `${profile.label}今天还剩 ${snap.remainingMinutes} 分钟，要玩 ${snap.remainingMinutes} 分钟吗？`,
      };
    }

    // 5) 互斥校验
    const active = this.quota.getActiveSession();
    if (active) {
      const otherProfile = getChildProfile(active.child);
      return {
        ok: false,
        child,
        reason: 'session_in_progress',
        message: `${otherProfile.label}正在玩游戏，等他玩完再来吧。`,
      };
    }

    // 6) 通电
    const power = await this.powerOn();
    if (!power.ok) {
      const reason: StartReason =
        power.error === 'plug_not_configured' ? 'plug_not_configured' : 'plug_failed';
      return {
        ok: false,
        child,
        reason,
        message:
          reason === 'plug_not_configured'
            ? '游戏机插板还没配置好，告诉爸爸帮你看一下。'
            : '游戏机打不开，可能插板没连上，请告诉爸爸帮你看一下。',
      };
    }

    // 7) 写 active + 调度
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + minutes * 60_000);
    const session: ActiveSession = {
      child,
      startedAt: startedAt.toISOString(),
      plannedMinutes: minutes,
      endsAt: endsAt.toISOString(),
      plugDid: this.cfg.plugDid,
    };
    this.quota.setActiveSession(session);
    this.scheduleTimers(session);

    logger.info('game-console.start', {
      child,
      plannedMinutes: minutes,
      endsAt: session.endsAt,
    });

    return {
      ok: true,
      child,
      plannedMinutes: minutes,
      remainingMinutes: snap.remainingMinutes,
      endsAtIso: session.endsAt,
      message: `好的，${profile.label}玩 ${minutes} 分钟，到 ${fmtTime(session.endsAt)}结束，结束前我会提醒你。`,
    };
  }

  async stop(rawChild: string | null | undefined): Promise<GameStopResult> {
    const active = this.quota.getActiveSession();
    if (!active) {
      return { ok: false, message: '现在没有人在玩游戏哦。' };
    }
    if (rawChild) {
      const c = resolveChildKey(rawChild);
      if (c && c !== active.child) {
        const cur = getChildProfile(active.child);
        return {
          ok: false,
          child: active.child,
          message: `现在在玩的是${cur.label}，不是你说的这个孩子。`,
        };
      }
    }

    const now = Date.now();
    const startedAtMs = new Date(active.startedAt).getTime();
    const planned = active.plannedMinutes;
    // 实际玩了多少分钟（最少 1 分钟，向上取整；不超过计划时长）
    const actualMinutes = Math.min(planned, Math.max(1, Math.ceil((now - startedAtMs) / 60_000)));

    this.timer.cancel();
    const off = await this.powerOff();
    if (!off.ok) {
      logger.warn('game-console.stop_power_off_failed', { error: off.error });
    }

    const remaining = this.quota.consume(active.child, actualMinutes);
    this.quota.setActiveSession(null);

    const profile = getChildProfile(active.child);
    return {
      ok: true,
      child: active.child,
      actualMinutes,
      remainingMinutes: remaining,
      message: `已经关闭游戏机，${profile.label}这次玩了 ${actualMinutes} 分钟，今天还剩 ${remaining} 分钟。`,
    };
  }

  status(): GameStatusResult {
    const now = new Date();
    const allowed = this.quota.isAllowedToday(now);
    const quotas = CHILDREN.map((c) => {
      const s = this.quota.getSnapshot(c.key, now);
      return {
        child: c.key,
        label: c.label,
        dailyQuotaMin: s.dailyQuotaMin,
        usedMinutes: s.usedMinutes,
        remainingMinutes: s.remainingMinutes,
      };
    });

    const active = this.quota.getActiveSession();
    let activeOut: GameStatusResult['active'] = null;
    let activePart = '';
    if (active) {
      const remainMs = new Date(active.endsAt).getTime() - now.getTime();
      const remainMin = Math.max(0, Math.ceil(remainMs / 60_000));
      const profile = getChildProfile(active.child);
      activeOut = {
        child: active.child,
        label: profile.label,
        startedAtIso: active.startedAt,
        endsAtIso: active.endsAt,
        remainingMinutes: remainMin,
      };
      activePart = `${profile.label}正在玩，还剩 ${remainMin} 分钟。`;
    }

    let message: string;
    if (!allowed) {
      message = `今天是${WEEKDAY_LABEL[now.getDay()]}，平时不能玩游戏。`;
    } else {
      const parts = quotas.map((q) => `${q.label}今天还剩 ${q.remainingMinutes} 分钟`);
      message = parts.join('，') + '。';
    }
    if (activePart) message = activePart + ' ' + message;

    return {
      ok: true,
      allowedToday: allowed,
      weekday: now.getDay(),
      quotas,
      active: activeOut,
      message,
    };
  }

  // ---------------- 内部：定时器调度 + 到期处理 ----------------

  private scheduleTimers(session: ActiveSession): void {
    const profile = getChildProfile(session.child);
    this.timer.start({
      child: session.child,
      endsAt: new Date(session.endsAt),
      reminderSeconds: this.cfg.reminderSeconds,
      onReminder: async (secondsLeft) => {
        const phrase =
          secondsLeft >= 60 && secondsLeft % 60 === 0
            ? `还有 ${secondsLeft / 60} 分钟`
            : `还有 ${secondsLeft} 秒`;
        await this.announce(`${profile.label}，${phrase}就要关游戏机了。`);
      },
      onExpired: async () => {
        await this.handleExpired(session);
      },
    });
  }

  private async handleExpired(session: ActiveSession): Promise<void> {
    // 防御：可能在到期前被 stop 提前结束了
    const cur = this.quota.getActiveSession();
    if (!cur || cur.startedAt !== session.startedAt) {
      logger.info('game-console.expire_skipped_no_active', { child: session.child });
      return;
    }

    const profile = getChildProfile(session.child);
    const ok = await this.powerOffOnExpire();
    const remaining = this.quota.consume(session.child, session.plannedMinutes);
    this.quota.setActiveSession(null);

    logger.info('game-console.expired', {
      child: session.child,
      plannedMinutes: session.plannedMinutes,
      remaining,
      powerOff: ok,
    });

    if (ok) {
      await this.announce(
        `时间到了，已经关闭游戏机。${profile.label}今天还剩 ${remaining} 分钟。`,
      );
    }
  }

  // ---------------- 启动恢复 ----------------

  /**
   * 进程启动时调用：
   *  - 若 activeSession 仍在窗口内 → 重新挂定时器；
   *  - 若已超时 → 立即断电、按 plannedMinutes 扣额、清空 active；
   */
  async recoverActiveSession(): Promise<void> {
    const active = this.quota.getActiveSession();
    if (!active) return;

    const now = Date.now();
    const endsAtMs = new Date(active.endsAt).getTime();
    if (Number.isNaN(endsAtMs)) {
      logger.warn('game-console.recover.invalid_endsAt', { endsAt: active.endsAt });
      this.quota.setActiveSession(null);
      return;
    }

    if (now < endsAtMs) {
      logger.info('game-console.recover.resume', {
        child: active.child,
        endsAt: active.endsAt,
        remainingSec: Math.round((endsAtMs - now) / 1000),
      });
      this.scheduleTimers(active);
    } else {
      logger.info('game-console.recover.expired_during_offline', {
        child: active.child,
        endsAt: active.endsAt,
      });
      const off = await this.powerOff();
      if (!off.ok) {
        logger.warn('game-console.recover.power_off_failed', { error: off.error });
      }
      this.quota.consume(active.child, active.plannedMinutes);
      this.quota.setActiveSession(null);
    }
  }

  /** 仅供测试 / 上层访问。 */
  getQuotaService(): GameQuotaService {
    return this.quota;
  }
  getTimer(): GameSessionTimer {
    return this.timer;
  }
}

// ---------------- 单例 ----------------

let singleton: GameConsoleController | null = null;

export function getGameConsoleController(): GameConsoleController {
  if (!singleton) singleton = new GameConsoleController();
  return singleton;
}

/** 仅测试用。 */
export function _resetGameConsoleControllerForTest(): void {
  singleton?.getTimer().cancel();
  singleton = null;
}
