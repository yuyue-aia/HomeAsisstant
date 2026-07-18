/**
 * 游戏机控制器（单例）：
 *   - 把 GameQuotaService / GameSessionTimer / GosundPlug(s1) 组装到一起
 *   - 同时给 Agent 工具与启动恢复钩子使用
 *
 * 通过 setAnnouncer 注入主动播报回调（DialogSession.announce），
 * 没有注入时退化为 logger 输出，保证模块解耦。
 */

import { logger } from '../common/logger';
import { ResolvableGosundPlug, SWITCH_SIID_BY_DID } from '../agent/tools/gosund-plug-client';
import {
  ActiveSession,
  ActivityType,
  CHILDREN,
  GameQuotaService,
  getChildProfile,
  loadGameQuotaConfig,
  PlayerId,
  resolveChildKey,
} from './game-quota';
import { GameSessionTimer } from './game-session-timer';

/**
 * 播报类型：
 *  - 'start'    开始会话
 *  - 'reminder' 倒计时提醒（Web 前端已由 speakRemain 独立播报，无需再转发，避免重复）
 *  - 'expired'  到期/异常提示
 */
export type AnnounceKind = 'start' | 'reminder' | 'expired';
type Announcer = (text: string, kind: AnnounceKind) => void | Promise<void>;

export interface GameConsoleConfig {
  plugIp?: string;
  plugMac?: string;
  plugToken?: string;
  /** 凌晨自动充电针对的游戏机接口，默认 's4'，可通过 GAME_CONSOLE_PLUG_DID 覆盖 */
  plugDid: string;
  /** 玩游戏需要通电的接口集合，默认 ['s3','s4']（游戏机 S4 + 电视 S3 当显示器），GAME_PLUG_DIDS 覆盖 */
  gamePlugDids: string[];
  /** 看电视需要通电的接口集合，默认 ['s3']，TV_PLUG_DIDS 覆盖 */
  tvPlugDids: string[];
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

/** 解析逗号分隔的接口列表并逐个校验；非法接口直接抛（配置错误快失败）。 */
function parseDids(raw: string | undefined, fallback: string[], envName: string): string[] {
  const list = (raw ? raw.split(',') : fallback)
    .map((s) => s.trim())
    .filter(Boolean);
  const dids = Array.from(new Set(list));
  for (const d of dids) {
    if (!(d in SWITCH_SIID_BY_DID)) {
      throw new Error(`Invalid ${envName} did "${d}". Allowed: ${Object.keys(SWITCH_SIID_BY_DID).join(', ')}`);
    }
  }
  if (dids.length === 0) throw new Error(`${envName} must contain at least one did`);
  return dids;
}

function loadGameConsoleConfig(): GameConsoleConfig {
  const did = (process.env.GAME_CONSOLE_PLUG_DID || 's4').trim();
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
    plugMac: process.env.GOSUND_PLUG_MAC?.trim() || undefined,
    plugToken: process.env.GOSUND_PLUG_TOKEN?.trim() || undefined,
    plugDid: did,
    gamePlugDids: parseDids(process.env.GAME_PLUG_DIDS, ['s3', 's4'], 'GAME_PLUG_DIDS'),
    tvPlugDids: parseDids(process.env.TV_PLUG_DIDS, ['s3'], 'TV_PLUG_DIDS'),
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
  child?: PlayerId;
  label?: string;
  activity?: ActivityType;
  reason?: StartReason;
  remainingMinutes?: number;
  plannedMinutes?: number;
  endsAtIso?: string;
  message: string;
}

export interface GameStopResult {
  ok: boolean;
  child?: PlayerId;
  label?: string;
  activity?: ActivityType;
  actualMinutes?: number;
  remainingMinutes?: number;
  message: string;
}

export interface GameStatusResult {
  ok: true;
  allowedToday: boolean;
  weekday: number;
  quotas: Array<{
    child: PlayerId;
    label: string;
    dailyQuotaMin: number;
    bonusMinutes: number;
    usedMinutes: number;
    remainingMinutes: number;
  }>;
  active: null | {
    child: PlayerId;
    label: string;
    activity: ActivityType;
    startedAtIso: string;
    endsAtIso: string;
    remainingMinutes: number;
  };
  message: string;
}

/** 玩家档案：Web 用账号、语音用内置余晓/余跃。 */
export interface PlayerProfileLite {
  id: PlayerId;
  label: string;
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}点${mm}分`;
}

export class GameConsoleController {
  private cfg: GameConsoleConfig;
  private readonly quota: GameQuotaService;
  private readonly timer = new GameSessionTimer();
  private announcer: Announcer | null = null;

  constructor(cfg: GameConsoleConfig = loadGameConsoleConfig()) {
    this.cfg = cfg;
    this.quota = new GameQuotaService(loadGameQuotaConfig());
  }

  /**
   * 运行时热更新配置（Web 管理端保存后调用）。
   * - 配额类字段转交 GameQuotaService.updateConfig；
   * - reminderSeconds 直接更新（下一次 start 生效，不打断进行中的会话）。
   */
  applyRuntimeConfig(partial: {
    dailyQuotaMin?: number;
    allowedWeekdays?: number[];
    maxSingleSessionMin?: number;
    minSingleSessionMin?: number;
    reminderSeconds?: number[];
  }): void {
    this.quota.updateConfig({
      dailyQuotaMin: partial.dailyQuotaMin,
      allowedWeekdays: partial.allowedWeekdays,
      maxSingleSessionMin: partial.maxSingleSessionMin,
      minSingleSessionMin: partial.minSingleSessionMin,
    });
    if (Array.isArray(partial.reminderSeconds)) {
      const rs = partial.reminderSeconds
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (rs.length > 0) {
        this.cfg = { ...this.cfg, reminderSeconds: Array.from(new Set(rs)).sort((a, b) => b - a) };
      }
    }
    logger.info('game-console.config_applied', {
      dailyQuotaMin: this.quota.getConfig().dailyQuotaMin,
      allowedWeekdays: this.quota.getConfig().allowedWeekdays,
      reminderSeconds: this.cfg.reminderSeconds,
    });
  }

  /** 读取当前生效配置快照（Web 配置页回显用）。 */
  getRuntimeConfig(): {
    dailyQuotaMin: number;
    allowedWeekdays: number[];
    maxSingleSessionMin: number;
    minSingleSessionMin: number;
    reminderSeconds: number[];
    plugConfigured: boolean;
  } {
    const q = this.quota.getConfig();
    return {
      dailyQuotaMin: q.dailyQuotaMin,
      allowedWeekdays: q.allowedWeekdays,
      maxSingleSessionMin: q.maxSingleSessionMin,
      minSingleSessionMin: q.minSingleSessionMin,
      reminderSeconds: this.cfg.reminderSeconds,
      plugConfigured: this.isPlugConfigured(),
    };
  }

  /**
   * 管理员给指定玩家临时加时（正数加、负数收回），仅当天有效。
   * 返回加时后的剩余分钟数。
   */
  addBonus(
    playerId: string,
    minutes: number,
  ): { ok: true; remainingMinutes: number; bonusMinutes: number } | { ok: false; error: 'invalid_player' | 'invalid_minutes' } {
    const id = (playerId ?? '').toString().trim();
    if (!id) return { ok: false, error: 'invalid_player' };
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 1440) {
      return { ok: false, error: 'invalid_minutes' };
    }
    const remaining = this.quota.addBonus(id, m);
    const snap = this.quota.getSnapshot(id);
    logger.info('game-console.add_bonus', { player: id, minutes: m, bonus: snap.bonusMinutes, remaining });
    return { ok: true, remainingMinutes: remaining, bonusMinutes: snap.bonusMinutes };
  }

  /**
   * 管理员直接设定指定玩家今日总时间（总额）为具体分钟数（精确设置，非增量），仅当天有效。
   * 已用时间保持不变，返回设置后的总时间与剩余时间。
   */
  setTotal(
    playerId: string,
    minutes: number,
  ): { ok: true; totalMinutes: number; remainingMinutes: number; bonusMinutes: number } | { ok: false; error: 'invalid_player' | 'invalid_minutes' } {
    const id = (playerId ?? '').toString().trim();
    if (!id) return { ok: false, error: 'invalid_player' };
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 0 || m > 1440) {
      return { ok: false, error: 'invalid_minutes' };
    }
    const total = this.quota.setTotal(id, m);
    const snap = this.quota.getSnapshot(id);
    logger.info('game-console.set_total', { player: id, minutes: m, bonus: snap.bonusMinutes, total, remaining: snap.remainingMinutes });
    return { ok: true, totalMinutes: total, remainingMinutes: snap.remainingMinutes, bonusMinutes: snap.bonusMinutes };
  }

  setAnnouncer(fn: Announcer | null): void {
    this.announcer = fn;
  }

  private async announce(text: string, kind: AnnounceKind = 'start'): Promise<void> {
    if (this.announcer) {
      try {
        await this.announcer(text, kind);
        return;
      } catch (error) {
        logger.warn('game-console.announce_failed', {
          error: (error as Error).message,
          text,
        });
      }
    }
    logger.info('game-console.announce', { text, kind });
  }

  // ---------------- 设备 ----------------

  private getPlug(): ResolvableGosundPlug | null {
    if ((!this.cfg.plugIp && !this.cfg.plugMac) || !this.cfg.plugToken) return null;
    return new ResolvableGosundPlug({
      mac: this.cfg.plugMac,
      fallbackIp: this.cfg.plugIp,
      token: this.cfg.plugToken,
    });
  }

  private async powerOn(did: string): Promise<{ ok: boolean; error?: string }> {
    const plug = this.getPlug();
    if (!plug) return { ok: false, error: 'plug_not_configured' };
    try {
      await plug.on(did);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      plug.close();
    }
  }

  private async powerOff(did: string): Promise<{ ok: boolean; error?: string }> {
    const plug = this.getPlug();
    if (!plug) return { ok: false, error: 'plug_not_configured' };
    try {
      await plug.off(did);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      plug.close();
    }
  }

  /** 依次给多个接口通电；任一失败则回滚（关掉刚开的），保证不留"只开一半"。 */
  private async powerOnMany(dids: string[]): Promise<{ ok: boolean; error?: string }> {
    const done: string[] = [];
    for (const d of dids) {
      const r = await this.powerOn(d);
      if (!r.ok) {
        for (const x of done) {
          await this.powerOff(x).catch(() => undefined);
        }
        return { ok: false, error: r.error };
      }
      done.push(d);
    }
    return { ok: true };
  }

  /** 关闭多个接口；尽力而为，任一失败即视为整体失败并带回最后的错误。 */
  private async powerOffMany(dids: string[]): Promise<{ ok: boolean; error?: string }> {
    let ok = true;
    let lastError: string | undefined;
    for (const d of dids) {
      const r = await this.powerOff(d);
      if (!r.ok) {
        ok = false;
        lastError = r.error;
      }
    }
    return { ok, error: ok ? undefined : lastError };
  }

  /** 按活动类型取需要通电的接口集合。 */
  private plugDidsFor(activity: ActivityType): string[] {
    return activity === 'tv' ? this.cfg.tvPlugDids : this.cfg.gamePlugDids;
  }

  /**
   * 暴露给"非小孩游戏会话"的纯设备开关入口（如凌晨自动充电，只针对游戏机接口）。
   * 故意取名 force* 强调它绕过 quota / weekday / minutes / active session 校验。
   */
  async forcePowerOn(): Promise<{ ok: boolean; error?: string }> {
    return this.powerOn(this.cfg.plugDid);
  }

  async forcePowerOff(): Promise<{ ok: boolean; error?: string }> {
    return this.powerOff(this.cfg.plugDid);
  }

  /** 给外部判断"是否有进行中的小孩游戏会话"——避免凌晨充电时误抢。 */
  hasActiveSession(): boolean {
    return this.quota.getActiveSession() !== null;
  }

  /** 设备是否配置（IP/MAC + token 都给齐了）；scheduler 启动前用它探测，未配置就静默禁用。 */
  isPlugConfigured(): boolean {
    return !!((this.cfg.plugIp || this.cfg.plugMac) && this.cfg.plugToken);
  }

  /** 到期断电（多接口）；带 1 次重试。失败时尝试主动播报。 */
  private async powerOffOnExpire(dids: string[]): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const r = await this.powerOffMany(dids);
      if (r.ok) return true;
      logger.warn('game-console.power_off_failed', { attempt, error: r.error });
    }
    await this.announce('设备控制失败，请手动关闭电源。', 'expired');
    return false;
  }

  /** 取会话本次通电的接口集合；旧数据用 plugDid 兜底，再退回按 activity 推断。 */
  private sessionDids(session: ActiveSession): string[] {
    if (Array.isArray(session.plugDids) && session.plugDids.length > 0) return session.plugDids;
    if (session.plugDid) return [session.plugDid];
    return this.plugDidsFor(session.activity ?? 'game');
  }

  // ---------------- start / stop / status ----------------

  /**
   * 把原始入参解析为玩家 { id, label }。
   * - 命中内置余晓/余跃（含别名）→ 用内置 key 与显示名（语音链路）；
   * - 否则把入参当作通用玩家 ID（Web 账号 id），label 取 opts.label 或 id 本身。
   */
  private resolvePlayer(
    rawPlayer: string | null | undefined,
    label?: string,
  ): PlayerProfileLite | null {
    const raw = (rawPlayer ?? '').toString().trim();
    if (!raw) return null;
    const childKey = resolveChildKey(raw);
    if (childKey) {
      return { id: childKey, label: (label && label.trim()) || getChildProfile(childKey).label };
    }
    return { id: raw, label: (label && label.trim()) || raw };
  }

  async start(
    rawChild: string | null | undefined,
    rawMinutes: number,
    opts?: { label?: string; activity?: ActivityType; testMode?: boolean },
  ): Promise<GameStartResult> {
    const activity: ActivityType = opts?.activity === 'tv' ? 'tv' : 'game';
    const actWord = activity === 'tv' ? '看电视' : '玩游戏';
    // 1) 玩家校验
    const player = this.resolvePlayer(rawChild, opts?.label);
    if (!player) {
      return {
        ok: false,
        activity,
        reason: 'invalid_child',
        message: '我不知道是谁要玩，要先告诉我是谁。',
      };
    }
    const child = player.id;
    const profile = { key: child, label: player.label };

    // 2) weekday 校验
    const now = new Date();
    if (!this.quota.isAllowedToday(now)) {
      return {
        ok: false,
        child,
        activity,
        reason: 'not_weekend',
        message: `今天是${WEEKDAY_LABEL[now.getDay()]}，平时不能${actWord}哦。`,
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

    // 4) 配额校验（游戏与电视共享同一份配额）
    const snap = this.quota.getSnapshot(child, now);
    if (snap.remainingMinutes <= 0) {
      return {
        ok: false,
        child,
        activity,
        reason: 'no_quota',
        remainingMinutes: 0,
        message: `${profile.label}今天的时间已经用完了，明天再来吧。`,
      };
    }
    if (minutes > snap.remainingMinutes) {
      return {
        ok: false,
        child,
        activity,
        reason: 'no_quota',
        remainingMinutes: snap.remainingMinutes,
        message: `${profile.label}今天还剩 ${snap.remainingMinutes} 分钟，要用 ${snap.remainingMinutes} 分钟吗？`,
      };
    }

    // 5) 互斥校验（一台设备，同一时刻只允许一个会话）
    const active = this.quota.getActiveSession();
    if (active) {
      const otherLabel = active.label ?? active.child;
      const otherWord = (active.activity ?? 'game') === 'tv' ? '看电视' : '玩游戏';
      return {
        ok: false,
        child,
        activity,
        reason: 'session_in_progress',
        message: `${otherLabel}正在${otherWord}，等他用完再来吧。`,
      };
    }

    // 6) 通电（按活动决定接口：游戏 S3+S4，电视 S3）；测试账号跳过真实操作。
    const testMode = !!opts?.testMode;
    let dids: string[] = [];
    if (!testMode) {
      dids = this.plugDidsFor(activity);
      const power = await this.powerOnMany(dids);
      if (!power.ok) {
        const reason: StartReason =
          power.error === 'plug_not_configured' ? 'plug_not_configured' : 'plug_failed';
        return {
          ok: false,
          child,
          activity,
          reason,
          message:
            reason === 'plug_not_configured'
              ? '设备插板还没配置好，告诉爸爸帮你看一下。'
              : '设备打不开，可能插板没连上，请告诉爸爸帮你看一下。',
        };
      }
    }

    // 7) 写 active + 调度
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + minutes * 60_000);
    const session: ActiveSession = {
      child,
      label: player.label,
      activity,
      startedAt: startedAt.toISOString(),
      plannedMinutes: minutes,
      endsAt: endsAt.toISOString(),
      plugDids: dids,
      testMode,
    };
    this.quota.setActiveSession(session);
    this.scheduleTimers(session);

    logger.info('game-console.start', {
      child,
      label: player.label,
      activity,
      plugDids: dids,
      plannedMinutes: minutes,
      endsAt: session.endsAt,
    });

    const announceText = `${profile.label}，${actWord} ${minutes} 分钟，到 ${fmtTime(endsAt.toISOString())} 结束。`;
    this.announce(announceText, 'start').catch((err) => {
      logger.warn('game-console.start_announce_failed', { error: (err as Error).message });
    });

    return {
      ok: true,
      child,
      label: player.label,
      activity,
      plannedMinutes: minutes,
      remainingMinutes: snap.remainingMinutes,
      endsAtIso: session.endsAt,
      message: `好的，${profile.label}${actWord} ${minutes} 分钟，到 ${fmtTime(session.endsAt)}结束，结束前我会提醒你。`,
    };
  }

  /**
   * 停止当前会话。
   * @param rawChild 可选，用来校验"停的是不是同一个玩家"。支持内置别名或通用玩家 id。
   */
  async stop(rawChild: string | null | undefined): Promise<GameStopResult> {
    const active = this.quota.getActiveSession();
    if (!active) {
      return { ok: false, message: '现在没有人在用哦。' };
    }
    const activeLabel = active.label ?? active.child;
    const activity: ActivityType = active.activity ?? 'game';
    const actWord = activity === 'tv' ? '看电视' : '玩游戏';
    if (rawChild) {
      const resolved = this.resolvePlayer(rawChild);
      if (resolved && resolved.id !== active.child) {
        return {
          ok: false,
          child: active.child,
          label: activeLabel,
          activity,
          message: `现在在用的是${activeLabel}，不是你说的这个玩家。`,
        };
      }
    }

    const now = Date.now();
    const startedAtMs = new Date(active.startedAt).getTime();
    const planned = active.plannedMinutes;
    // 实际用了多少分钟（最少 1 分钟，向上取整；不超过计划时长）
    const actualMinutes = Math.min(planned, Math.max(1, Math.ceil((now - startedAtMs) / 60_000)));

    this.timer.cancel();
    let off: Awaited<ReturnType<typeof this.powerOffMany>>;
    if (active.testMode) {
      off = { ok: true };
    } else {
      off = await this.powerOffMany(this.sessionDids(active));
      if (!off.ok) {
        logger.warn('game-console.stop_power_off_failed', { error: off.error });
      }
    }

    const remaining = this.quota.finishSession(
      active,
      actualMinutes,
      'manual',
      off.ok,
      new Date(now),
    );

    return {
      ok: true,
      child: active.child,
      label: activeLabel,
      activity,
      actualMinutes,
      remainingMinutes: remaining,
      message: `已经关闭设备，${activeLabel}这次${actWord} ${actualMinutes} 分钟，今天还剩 ${remaining} 分钟。`,
    };
  }

  /** 语音链路状态：以内置余晓/余跃为玩家列表。 */
  status(): GameStatusResult {
    return this.buildStatus(CHILDREN.map((c) => ({ id: c.key, label: c.label })));
  }

  /** Web 链路状态：按传入的账号玩家列表汇总配额。 */
  statusForPlayers(players: PlayerProfileLite[]): GameStatusResult {
    return this.buildStatus(players);
  }

  private buildStatus(players: PlayerProfileLite[]): GameStatusResult {
    const now = new Date();
    const allowed = this.quota.isAllowedToday(now);
    const quotas = players.map((p) => {
      const s = this.quota.getSnapshot(p.id, now);
      return {
        child: p.id,
        label: p.label,
        dailyQuotaMin: s.dailyQuotaMin,
        bonusMinutes: s.bonusMinutes,
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
      const activeLabel =
        active.label ?? players.find((p) => p.id === active.child)?.label ?? active.child;
      const activity: ActivityType = active.activity ?? 'game';
      activeOut = {
        child: active.child,
        label: activeLabel,
        activity,
        startedAtIso: active.startedAt,
        endsAtIso: active.endsAt,
        remainingMinutes: remainMin,
      };
      activePart = `${activeLabel}正在${activity === 'tv' ? '看电视' : '玩游戏'}，还剩 ${remainMin} 分钟。`;
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
    const label = session.label ?? session.child;
    this.timer.start({
      child: session.child,
      endsAt: new Date(session.endsAt),
      reminderSeconds: this.cfg.reminderSeconds,
      onReminder: async (secondsLeft) => {
        const phrase =
          secondsLeft >= 60 && secondsLeft % 60 === 0
            ? `还有 ${secondsLeft / 60} 分钟`
            : `还有 ${secondsLeft} 秒`;
        await this.announce(`${label}，${phrase}就要关游戏机了。`, 'reminder');
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

    const label = session.label ?? session.child;
    let ok: boolean;
    if (session.testMode) {
      ok = true;
    } else {
      ok = await this.powerOffOnExpire(this.sessionDids(session));
    }
    const remaining = this.quota.finishSession(
      session,
      session.plannedMinutes,
      'expired',
      ok,
      new Date(session.endsAt),
    );

    logger.info('game-console.expired', {
      child: session.child,
      activity: session.activity ?? 'game',
      plannedMinutes: session.plannedMinutes,
      remaining,
      powerOff: ok,
    });

    if (ok) {
      await this.announce(
        `时间到了，已经关闭设备。${label}今天还剩 ${remaining} 分钟。`,
        'expired',
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
      let off: Awaited<ReturnType<typeof this.powerOffMany>>;
      if (active.testMode) {
        off = { ok: true };
      } else {
        off = await this.powerOffMany(this.sessionDids(active));
        if (!off.ok) {
          logger.warn('game-console.recover.power_off_failed', { error: off.error });
        }
      }
      this.quota.finishSession(
        active,
        active.plannedMinutes,
        'offline_expired',
        off.ok,
        new Date(active.endsAt),
      );
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
