/**
 * NcmCli —— @music163/ncm-cli 子进程的强类型封装。
 *
 * 这一层只负责"把 CLI 调通 + JSON 解析 + 错误归一"，业务规则（过滤可播、付费、艺人精确匹配）
 * 全在上层 MusicService 里。本文件不感知 LLM / Tool / Skill。
 *
 * 关键实测事实（详见 docs/music-skill-design.md 第 2 节）：
 *   F1  ncm-cli 已经处理 OAuth/签名/mpv daemon，我们不再自研；
 *   F2  play/pause/... fire-and-forget：stdout 可能为空，exitCode=0 也算成功，状态要 state 轮询；
 *   F4  search/recommend/song.like 等内容类必须传 --userInput（开放平台审计）；
 *   F5  播控类（play/pause/.../state）不要带 --userInput，否则会被拒；
 *   F6  上游脱敏：artists[] 是替身，fullArtists[] 才是真名；
 *   F12 返回两种 JSON：{success,message,...} 或 {code:200,data:...}。
 */

import { execFile } from 'node:child_process';
import { logger } from '../../common/logger';
import {
  MusicError,
  type MusicErrorReason,
  type Playlist,
  type PlayerState,
  type Track,
} from './types';

/** execFile 子进程默认超时（ms）。搜索/播放 5s 已经很宽松。 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 子进程 stdout 上限 1MB，远远够（每日推荐也就几十 KB）。 */
const MAX_BUFFER = 1024 * 1024;

/**
 * 上游单条 song 记录的最小字段子集（只列我们用到的，避免 any）。
 */
interface RawSongRecord {
  originalId: number;
  /** 加密 ID，32 位 hex */
  id: string;
  name: string;
  duration?: number; // ms
  artists?: Array<{ name?: string }>;
  fullArtists?: Array<{ name?: string }>;
  album?: { name?: string } | null;
  coverImgUrl?: string | null;
  visible?: boolean;
  /** VIP 判定四件套 */
  vipFlag?: boolean;
  vipPlayFlag?: boolean;
  payPlayFlag?: boolean;
  freeTrialPrivilege?: { cannotListenReason?: unknown } | null;
}

interface RawPlaylistRecord {
  originalId: number;
  id: string;
  name: string;
  trackCount?: number;
  creatorNickName?: string;
}

interface RawPlayerState {
  status?: string;
  title?: string;
  position?: number; // sec
  duration?: number; // sec
  progress?: string;
  currentIndex?: number;
  queueLength?: number;
  volume?: number | null;
}

/** 标准化 `{success, message, ...}` 类响应 */
interface SuccessResponse {
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

/** 标准化 `{code, data, message}` 类响应 */
interface CodeResponse<T = unknown> {
  code?: number;
  data?: T;
  message?: string;
}

export class NcmCli {
  constructor(
    private readonly bin: string = 'ncm-cli',
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  // ──────────────────────── 内容类（需 userInput）────────────────────────

  /**
   * 搜单曲——返回 **raw 记录**，把 visible/vip/artist 等过滤决策权留给上层。
   * 调用方拿到后用 `isTrackPlayable(raw)` 过滤，再用 `rawSongToTrack(raw)` 映射成 Track。
   */
  async searchSongRaw(keyword: string, userInput: string): Promise<RawSongRecord[]> {
    const raw = await this.execCode<{ records?: RawSongRecord[] }>([
      'search',
      'song',
      '--keyword',
      keyword,
      '--userInput',
      userInput,
    ]);
    return raw.records ?? [];
  }

  async searchPlaylist(keyword: string, userInput: string): Promise<Playlist[]> {
    const raw = await this.execCode<{ records?: RawPlaylistRecord[] }>([
      'search',
      'playlist',
      '--keyword',
      keyword,
      '--userInput',
      userInput,
    ]);
    return (raw.records ?? []).map(toPlaylist);
  }

  /**
   * 每日推荐：上游返回的 `data` 直接就是 Track[]（不是包了 records 的对象）。
   * 同样返回 raw 让上层过滤。
   */
  async dailyRecommendRaw(userInput: string): Promise<RawSongRecord[]> {
    const raw = await this.execCode<RawSongRecord[]>([
      'recommend',
      'daily',
      '--userInput',
      userInput,
    ]);
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * 心动模式：种子是当前曲的 encryptedId（--songId），返回 Track[] 的 raw。
   */
  async heartbeatRaw(seedEncryptedId: string, userInput: string): Promise<RawSongRecord[]> {
    const raw = await this.execCode<RawSongRecord[] | { records?: RawSongRecord[] }>([
      'recommend',
      'heartbeat',
      '--songId',
      seedEncryptedId,
      '--userInput',
      userInput,
    ]);
    if (Array.isArray(raw)) return raw;
    return raw.records ?? [];
  }

  async like(encryptedId: string, userInput: string): Promise<void> {
    await this.execCode([
      'song',
      'like',
      '--encrypted-id',
      encryptedId,
      '--userInput',
      userInput,
    ]);
  }

  async unlike(encryptedId: string, userInput: string): Promise<void> {
    await this.execCode([
      'song',
      'dislike',
      '--encrypted-id',
      encryptedId,
      '--userInput',
      userInput,
    ]);
  }

  // ──────────────────────── 播控类（不带 userInput）────────────────────────

  async playSong(encryptedId: string, originalId: number): Promise<void> {
    await this.execSuccess([
      'play',
      '--song',
      '--encrypted-id',
      encryptedId,
      '--original-id',
      String(originalId),
    ]);
  }

  async playPlaylist(encryptedId: string, originalId: number): Promise<void> {
    await this.execSuccess([
      'play',
      '--playlist',
      '--encrypted-id',
      encryptedId,
      '--original-id',
      String(originalId),
    ]);
  }

  async pause(): Promise<void> {
    await this.execSuccess(['pause']);
  }

  async resume(): Promise<void> {
    await this.execSuccess(['resume']);
  }

  async stop(): Promise<void> {
    await this.execSuccess(['stop']);
  }

  async next(): Promise<void> {
    await this.execSuccess(['next']);
  }

  async prev(): Promise<void> {
    await this.execSuccess(['prev']);
  }

  async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await this.execSuccess(['volume', String(clamped)]);
  }

  async state(): Promise<PlayerState> {
    const resp = await this.exec<SuccessResponse & { state?: RawPlayerState }>(['state']);
    if (resp.success === false) {
      throw new MusicError('network_error', resp.message ?? 'state failed');
    }
    return toPlayerState(resp.state ?? {});
  }

  // ──────────────────────── 系统类 ────────────────────────

  async checkLogin(): Promise<boolean> {
    try {
      const resp = await this.exec<SuccessResponse>(['login', '--check']);
      return resp.success === true;
    } catch (error) {
      logger.warn('ncm-cli.login_check.exception', {
        error: (error as Error).message,
      });
      return false;
    }
  }

  // ──────────────────────── 内部 ────────────────────────

  /**
   * 跑命令并解析 stdout JSON。
   * 注意 stdout 可能为空——见 F2。空 stdout 不算错（仅 success 类调用接受），
   * 这里返回 `{}`，由上层的 execSuccess / execCode 分别决定语义。
   */
  private async exec<T>(args: string[]): Promise<T> {
    const fullArgs = [...args, '--output', 'json'];
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>(
        (resolveExec, rejectExec) => {
          execFile(
            this.bin,
            fullArgs,
            { timeout: this.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
            (error, so, se) => {
              if (error) {
                // execFile 在子进程非 0 退出时也会 error；用 `code` 区分。
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                  rejectExec(
                    new MusicError(
                      'spawn_failed',
                      `找不到 ncm-cli 二进制（PATH 里没有 \`${this.bin}\`），请先 \`npm i -g @music163/ncm-cli\``,
                    ),
                  );
                  return;
                }
                if (typeof code === 'string' && code === 'ETIMEDOUT') {
                  rejectExec(
                    new MusicError(
                      'network_error',
                      `ncm-cli ${args[0]} 超时（>${this.timeoutMs}ms）`,
                    ),
                  );
                  return;
                }
                // 退出码非 0：仍然把 stdout/stderr 透传给上层做最后判断（很多时候 stdout 里有 JSON 解释）
                stdout = so ?? '';
                stderr = se ?? '';
                exitCode = (error as { code?: number }).code ?? 1;
                resolveExec({ stdout, stderr });
                return;
              }
              resolveExec({ stdout: so ?? '', stderr: se ?? '' });
            },
          );
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      if (error instanceof MusicError) throw error;
      throw new MusicError(
        'spawn_failed',
        `ncm-cli ${args[0]} 启动失败：${(error as Error).message}`,
      );
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      // 空 stdout 在 success 类调用是合法的（F2）。返回空对象，让 execSuccess 判定。
      // 内容类调用的 execCode 会把空对象转成"网络异常"。
      if (exitCode !== 0) {
        logger.warn('ncm-cli.empty_stdout_nonzero_exit', {
          args,
          exitCode,
          stderr: stderr.slice(0, 500),
        });
      }
      return {} as T;
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      logger.error('ncm-cli.parse_error', {
        args,
        exitCode,
        stdoutHead: trimmed.slice(0, 400),
        stderrHead: stderr.slice(0, 400),
        error: (error as Error).message,
      });
      throw new MusicError(
        'parse_error',
        `ncm-cli ${args[0]} 返回不是 JSON：${trimmed.slice(0, 120)}`,
      );
    }
  }

  /**
   * 跑"播控类"命令（success 类响应）。空 stdout + exit 0 视为成功。
   */
  private async execSuccess(args: string[]): Promise<SuccessResponse> {
    const resp = await this.exec<SuccessResponse>(args);
    // 空对象（{}）= 空 stdout = 成功；显式 success:false 才算失败。
    if (resp.success === false) {
      throw new MusicError('network_error', resp.message ?? `ncm-cli ${args[0]} 失败`);
    }
    return resp;
  }

  /**
   * 跑"内容类"命令（code 类响应）。code != 200 一律映射成业务错误。
   * 401/未登录 → auth_required，其余 → network_error。
   */
  private async execCode<T>(args: string[]): Promise<T> {
    const resp = await this.exec<CodeResponse<T>>(args);
    if (!resp || resp.code == null) {
      throw new MusicError(
        'network_error',
        `ncm-cli ${args[0]} 返回为空（可能未登录或网络异常）`,
      );
    }
    if (resp.code !== 200) {
      const reason: MusicErrorReason =
        resp.code === 301 || resp.code === 401 ? 'auth_required' : 'network_error';
      throw new MusicError(reason, resp.message ?? `ncm-cli ${args[0]} code=${resp.code}`);
    }
    return (resp.data ?? ({} as T)) as T;
  }
}

// ──────────────────────── 映射器 ────────────────────────

/**
 * raw 上游记录 → 领域 Track。
 * 之所以拆出来 export，是让 MusicService 可以"过滤 + 映射"两步走，
 * 保留 raw 字段（visible / vip 标记）做精细过滤后再转成对外的 Track。
 */
export function rawSongToTrack(raw: RawSongRecord): Track {
  // F6：fullArtists 才是真名，artists 是脱敏替身
  const sourceArtists = raw.fullArtists?.length ? raw.fullArtists : raw.artists ?? [];
  const artists = sourceArtists
    .map((a) => (a?.name ?? '').trim())
    .filter((name): name is string => name.length > 0);

  const vipOnly =
    !!raw.vipFlag ||
    !!raw.vipPlayFlag ||
    !!raw.payPlayFlag ||
    raw.freeTrialPrivilege?.cannotListenReason != null;

  return {
    encryptedId: raw.id,
    originalId: raw.originalId,
    name: raw.name,
    artists,
    album: raw.album?.name ?? undefined,
    durationMs: raw.duration ?? 0,
    coverUrl: raw.coverImgUrl ?? undefined,
    vipOnly,
  };
}

/**
 * 与 rawSongToTrack 配套的"可播性"判定。
 * visible=false 是开放平台政策下架（F7）；vip 系列见 F11。
 */
export function isTrackPlayable(raw: RawSongRecord): boolean {
  if (raw.visible === false) return false;
  if (raw.vipFlag || raw.vipPlayFlag || raw.payPlayFlag) return false;
  if (raw.freeTrialPrivilege?.cannotListenReason != null) return false;
  return true;
}

/** 暴露原始记录给 MusicService 做精细过滤（artist 模糊匹配 / visible 过滤等） */
export type { RawSongRecord, RawPlaylistRecord };

function toPlaylist(raw: RawPlaylistRecord): Playlist {
  return {
    encryptedId: raw.id,
    originalId: raw.originalId,
    name: raw.name,
    trackCount: raw.trackCount ?? 0,
    creator: raw.creatorNickName,
  };
}

function toPlayerState(raw: RawPlayerState): PlayerState {
  let status: PlayerState['status'] = 'stopped';
  if (raw.status === 'playing') status = 'playing';
  else if (raw.status === 'paused') status = 'paused';

  return {
    status,
    title: raw.title || undefined,
    positionSec: typeof raw.position === 'number' ? raw.position : undefined,
    durationSec: typeof raw.duration === 'number' ? raw.duration : undefined,
    progress: raw.progress,
    currentIndex: raw.currentIndex,
    queueLength: raw.queueLength,
    volume: raw.volume ?? undefined,
  };
}
