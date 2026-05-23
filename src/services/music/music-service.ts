/**
 * MusicService（单例）
 *
 * 职责：
 *   - 把 NcmCli 的"原始 CLI 调用"包装成对外的强类型业务方法
 *   - 在 ncm-cli 之上加业务规则：过滤可播性、artist 模糊匹配、play 起播验证、currentTrack 缓存
 *   - 维护 ncm-cli 不返回的本地状态：当前音量、duck 前的音量 / 是否在播
 *   - 不感知 LLM / Tool / Skill；不直接订阅 DialogSession（那是 DuckController 的事）
 *
 * 设计要点（与 reminder-service 同构）：
 *   - 单例（getMusicService）
 *   - 副作用只在 service 里发生，tool 是无状态薄壳
 *   - 错误用 MusicError，统一 reason
 */

import { logger } from '../../common/logger';
import {
  NcmCli,
  isTrackPlayable,
  rawSongToTrack,
  type RawSongRecord,
} from './ncm-cli';
import {
  MusicError,
  type Playlist,
  type PlayerState,
  type Track,
} from './types';

/** play 后轮询 state 的总等待 ≈ STATE_POLL_INTERVAL_MS × STATE_POLL_MAX_TRIES。 */
const STATE_POLL_INTERVAL_MS = 500;
const STATE_POLL_MAX_TRIES = 6; // 3 秒

/** 默认初始音量（service 启动时主动 set 一次） */
const DEFAULT_VOLUME = 70;

export class MusicService {
  private readonly cli: NcmCli;

  /** 当前曲缓存：play_track / play_playlist 时记下；用于 like/unlike/heart_mode 拿 encryptedId（解决 F9 痛点） */
  private currentTrack: Track | null = null;

  /** ncm-cli `state` 不返回音量（F9），我们自己缓存 */
  private currentVolume: number = DEFAULT_VOLUME;

  /** duck 前的"用户主动音量"（暂未启用音量 duck，保留字段为未来扩展） */
  private lastUserVolume: number = DEFAULT_VOLUME;

  /** duck 时记下"是否在播"，duckResume 时判断要不要 resume */
  private duckWasPlaying = false;
  private ducked = false;

  /**
   * 最近一次 search 命中的 Track 缓存（按 encryptedId 索引）。
   * 解决：tool 层只从 LLM 拿到 ID，没法重建完整 Track；如果用 fakeTrack 回填
   * currentTrack，会导致 nowPlaying / control.ok 日志里 title/artists 全空。
   *
   * 容量 LRU：默认 64。每次新一轮 searchTracks 都会 append（不清空，跨 query 也能命中）。
   */
  private trackCache = new Map<string, Track>();
  private static readonly TRACK_CACHE_MAX = 64;

  /** 登录态缓存：init 时探测一次；非登录态下内容类调用直接抛 auth_required */
  private loggedIn = false;
  /** init() 的 promise，幂等：多次调用共享同一个 promise */
  private initPromise: Promise<void> | null = null;

  constructor(bin?: string) {
    this.cli = new NcmCli(bin);
  }

  /**
   * 启动初始化：探测登录态、把默认音量同步给播放器。
   * 失败时不抛——音乐能力进入 degraded，让控制类（pause/stop）还能 noop。
   *
   * 幂等：多处调用共享同一个 promise，避免 checkLogin 跑多次。
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      this.loggedIn = await this.cli.checkLogin();
      if (!this.loggedIn) {
        logger.warn('music.init.not_logged_in');
        return;
      }
      // 音量在 mpv daemon 首次起来后才生效；这里只是设个目标值，
      // 真正生效在第一次 play 之后 ncm-cli 内部 setVolume 时一并应用。
      try {
        await this.cli.setVolume(this.currentVolume);
      } catch (error) {
        logger.warn('music.init.setVolume_failed', {
          error: (error as Error).message,
        });
      }
      logger.info('music.init.ready', { volume: this.currentVolume });
    } catch (error) {
      logger.error('music.init.failed', { error: (error as Error).message });
    }
  }

  // ──────────────────────── 查询 ────────────────────────

  /**
   * 搜单曲，做完三件事再返回：
   *   1. 过滤 visible=false（F7）
   *   2. 过滤付费/VIP（F11）
   *   3. 当指定 artist 时，按 fullArtists 模糊匹配优先；找不到精确匹配则返回过滤后的全集
   *
   * 返回数组（不只取首条），让 Tool 层可以决定怎么传给 LLM。
   * 找不到任何可播结果时返回空数组（不抛错），由调用方决定如何处理。
   */
  async searchTracks(
    query: string,
    userInput: string,
    artist?: string,
  ): Promise<Track[]> {
    this.requireAuth();
    const raws = await this.cli.searchSongRaw(query, userInput);
    const playable = raws.filter(isTrackPlayable);
    const ranked = artist ? this.rankByArtist(playable, artist) : playable;
    const tracks = ranked.map(rawSongToTrack);
    this.cacheTracks(tracks);
    return tracks;
  }

  async searchPlaylists(query: string, userInput: string): Promise<Playlist[]> {
    this.requireAuth();
    return this.cli.searchPlaylist(query, userInput);
  }

  // ──────────────────────── 播放 ────────────────────────

  /**
   * 播单曲。
   * 起播流程：playSong → 轮询 state 最多 STATE_POLL_MAX_TRIES 次
   *   - 任一轮 state.status === 'playing' && state.title 存在 → 成功
   *   - 全部轮空 → 抛 player_not_started
   *
   * 成功后回填 currentTrack，用于后续 like/unlike/heart_mode。
   */
  async playTrack(track: Track): Promise<PlayerState> {
    if (track.vipOnly) {
      throw new MusicError('vip_only', '这首是会员或付费歌，没法直接播');
    }
    await this.cli.playSong(track.encryptedId, track.originalId);
    const state = await this.waitForPlaying();
    this.currentTrack = track;
    logger.info('music.play.track', {
      name: track.name,
      artists: track.artists,
      queueLength: state.queueLength,
    });
    return this.withCachedVolume(state);
  }

  /**
   * 播歌单：一次入队整张，由 ncm-cli 自动起播第一首（F10）。
   * currentTrack 在歌单模式下"无法准确知道当前是哪首"——所以播完直接置空，
   * 由 nowPlaying 用 state.title 兜底；like/unlike 此时返回 unknown_current_track（设计 F9）。
   */
  async playPlaylist(playlist: Playlist): Promise<PlayerState> {
    await this.cli.playPlaylist(playlist.encryptedId, playlist.originalId);
    const state = await this.waitForPlaying();
    this.currentTrack = null; // 歌单模式下不缓存（无法精准跟踪 next/prev 后的 ID）
    logger.info('music.play.playlist', {
      name: playlist.name,
      queueLength: state.queueLength,
    });
    return this.withCachedVolume(state);
  }

  /**
   * 每日推荐：拿到列表 → 过滤可播 → 取首条调 playTrack。
   * 简单粗暴：不入队所有 30 首（ncm-cli 没有 play --tracks <list> 的子命令），
   * 听完用户再说"下一首"我们 search/play 一次即可。
   */
  async playDailyRecommend(userInput: string): Promise<PlayerState> {
    this.requireAuth();
    const raws = await this.cli.dailyRecommendRaw(userInput);
    const playable = raws.filter(isTrackPlayable);
    if (!playable.length) {
      throw new MusicError('not_found', '今天的推荐里没有能直接播的');
    }
    const track = rawSongToTrack(playable[0]);
    return this.playTrack(track);
  }

  /**
   * 心动模式：必须有 currentTrack 作为种子。
   * 拿到推荐列表后取首条播；后续要切歌就靠 next。
   */
  async playHeartMode(userInput: string): Promise<PlayerState> {
    this.requireAuth();
    if (!this.currentTrack) {
      throw new MusicError(
        'unknown_current_track',
        '心动模式得有种子歌，先听一首再切心动',
      );
    }
    const raws = await this.cli.heartbeatRaw(this.currentTrack.encryptedId, userInput);
    const playable = raws.filter(isTrackPlayable);
    if (!playable.length) {
      throw new MusicError('not_found', '心动模式没拿到能播的推荐');
    }
    const track = rawSongToTrack(playable[0]);
    return this.playTrack(track);
  }

  // ──────────────────────── 控制 ────────────────────────

  async pause(): Promise<void> {
    await this.cli.pause();
  }

  async resume(): Promise<void> {
    await this.cli.resume();
  }

  async stop(): Promise<void> {
    await this.cli.stop();
    this.currentTrack = null;
  }

  async next(): Promise<void> {
    await this.cli.next();
    // next 之后 ncm-cli 切到队列里下一首，但我们没办法知道它的 encryptedId（F9）。
    // 清掉缓存，让 like/unlike 走 unknown_current_track 兜底。
    this.currentTrack = null;
  }

  async prev(): Promise<void> {
    await this.cli.prev();
    this.currentTrack = null;
  }

  async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await this.cli.setVolume(clamped);
    this.currentVolume = clamped;
    if (!this.ducked) this.lastUserVolume = clamped;
  }

  /**
   * 红心当前曲。
   * 拿不到 encryptedId（歌单模式下 next 过、或一启动就 like）→ unknown_current_track。
   */
  async like(userInput: string): Promise<void> {
    this.requireAuth();
    if (!this.currentTrack) {
      throw new MusicError(
        'unknown_current_track',
        '不知道现在在播哪首，能再说一遍歌名吗',
      );
    }
    await this.cli.like(this.currentTrack.encryptedId, userInput);
  }

  async unlike(userInput: string): Promise<void> {
    this.requireAuth();
    if (!this.currentTrack) {
      throw new MusicError(
        'unknown_current_track',
        '不知道现在在播哪首，能再说一遍歌名吗',
      );
    }
    await this.cli.unlike(this.currentTrack.encryptedId, userInput);
  }

  // ──────────────────────── 状态 ────────────────────────

  /**
   * 当前在播曲信息（拼装本地缓存的 Track + 远端 state.title）。
   * - 若 currentTrack 缓存命中 → 用它（最准）
   * - 否则用 state.title 字符串（兜底，可能形如 "稻香 - 周杰伦-"）
   * - 完全没有 → 返回 null
   */
  async nowPlaying(): Promise<{ title: string; artists?: string[] } | null> {
    const state = await this.cli.state().catch(() => null);
    if (this.currentTrack) {
      return { title: this.currentTrack.name, artists: this.currentTrack.artists };
    }
    if (state?.title) {
      return { title: state.title };
    }
    return null;
  }

  /** 当前播放器状态（含本地缓存音量）。 */
  async getState(): Promise<PlayerState> {
    const state = await this.cli.state();
    return this.withCachedVolume(state);
  }

  // ──────────────────────── Duck ────────────────────────

  /**
   * 由 DuckController 在 listening/thinking/speaking 时调。
   * 策略：直接 pause（mac mini 无 AEC，30% duck 不够），记 wasPlaying。
   * 已 ducked 状态下重复调 → noop，避免覆盖 wasPlaying。
   */
  async duckPause(): Promise<void> {
    if (this.ducked) return;
    try {
      const state = await this.cli.state();
      this.duckWasPlaying = state.status === 'playing';
      if (this.duckWasPlaying) {
        await this.cli.pause();
      }
      this.ducked = true;
      logger.info('music.duck.pause', { wasPlaying: this.duckWasPlaying });
    } catch (error) {
      // duck 失败不应该影响对话主流程
      logger.warn('music.duck.pause_failed', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * 回到 idle/followup_wait 时由 DuckController 调。
   * 只在 ducked 且之前是 playing 的情况下 resume，其他情况尊重用户当时状态。
   */
  async duckResume(): Promise<void> {
    if (!this.ducked) return;
    try {
      if (this.duckWasPlaying) {
        await this.cli.resume();
      }
      logger.info('music.duck.resume', { wasPlaying: this.duckWasPlaying });
    } catch (error) {
      logger.warn('music.duck.resume_failed', {
        error: (error as Error).message,
      });
    } finally {
      this.ducked = false;
      this.duckWasPlaying = false;
    }
  }

  // ──────────────────────── 内部 ────────────────────────

  /**
   * 起播验证：解决 F2 fire-and-forget 问题。
   * 轮询 state 直到 status==='playing' 或超过 STATE_POLL_MAX_TRIES。
   */
  private async waitForPlaying(): Promise<PlayerState> {
    for (let i = 0; i < STATE_POLL_MAX_TRIES; i += 1) {
      await sleep(STATE_POLL_INTERVAL_MS);
      try {
        const state = await this.cli.state();
        if (state.status === 'playing' && state.title) {
          return state;
        }
      } catch (error) {
        // 某次 state 调用失败不致命，继续轮询
        logger.warn('music.waitForPlaying.state_failed', {
          tries: i + 1,
          error: (error as Error).message,
        });
      }
    }
    throw new MusicError(
      'player_not_started',
      '播放器没起来，超过 3 秒还没开始播',
    );
  }

  /**
   * 按 fullArtists 排序，把"用户指定艺人为主创"的版本排到最前。
   *
   * 之前用 `name.includes(needle)` 太宽松——网易云搜索结果里很多翻唱/混音版本
   * 第二/第三艺人挂了"周杰伦-"这种带尾噪连字符的脏数据，被错误判为"周杰伦原版"。
   * 实际播下来是 A-LNK 之类二创者的版本，与用户预期不符。
   *
   * 新策略——三档优先级（高→低）：
   *   1. exact   ：normalize 后任一 artist 完全等于 needle（最干净的命中）
   *   2. primary ：normalize 后首位 artist 包含 needle（多人合作版，但主创是他）
   *   3. include ：normalize 后任一 artist 包含 needle（二创/翻唱兜底）
   *   4. miss    ：完全不沾边
   *
   * normalize：去除尾部 / 首部的非字母数字汉字字符（连字符、点、空格等噪音）。
   */
  private rankByArtist(records: RawSongRecord[], artist: string): RawSongRecord[] {
    const needle = normalizeArtistName(artist);
    if (!needle) return records;

    const exact: RawSongRecord[] = [];
    const primary: RawSongRecord[] = [];
    const include: RawSongRecord[] = [];
    const miss: RawSongRecord[] = [];

    for (const r of records) {
      const names = (r.fullArtists?.length ? r.fullArtists : r.artists) ?? [];
      const normalized = names.map((a) => normalizeArtistName(a?.name ?? ''));
      if (normalized.some((n) => n === needle)) {
        exact.push(r);
      } else if (normalized[0] && normalized[0].includes(needle)) {
        primary.push(r);
      } else if (normalized.some((n) => n.includes(needle))) {
        include.push(r);
      } else {
        miss.push(r);
      }
    }
    return [...exact, ...primary, ...include, ...miss];
  }

  /** 把本地缓存的音量注入到从 ncm-cli 拿回的 state 里（F9）。 */
  private withCachedVolume(state: PlayerState): PlayerState {
    return { ...state, volume: this.currentVolume };
  }

  private requireAuth(): void {
    if (!this.loggedIn) {
      throw new MusicError(
        'auth_required',
        '网易云需要登录一下，请在终端执行 ncm-cli login',
      );
    }
  }

  // ──────────────────────── Track 缓存（search 命中后供 tool 反查） ────────────────────────

  /** 由 searchTracks 在返回前批量写入；用 LRU 控制容量。 */
  private cacheTracks(tracks: Track[]): void {
    for (const t of tracks) {
      // delete + set 实现 LRU：每次访问/写入都把它放到最末尾
      if (this.trackCache.has(t.encryptedId)) {
        this.trackCache.delete(t.encryptedId);
      }
      this.trackCache.set(t.encryptedId, t);
    }
    // 超容裁剪最旧的若干条
    while (this.trackCache.size > MusicService.TRACK_CACHE_MAX) {
      const oldestKey = this.trackCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.trackCache.delete(oldestKey);
    }
  }

  /**
   * 给 tool 层用：拿到 LLM 回传的 encrypted_id 后，从最近的 search 命中里反查完整 Track。
   * 命中后会把这条移到 LRU 末尾。
   */
  getCachedTrack(encryptedId: string): Track | null {
    const t = this.trackCache.get(encryptedId);
    if (!t) return null;
    // touch：移到末尾
    this.trackCache.delete(encryptedId);
    this.trackCache.set(encryptedId, t);
    return t;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 归一化艺人名用于匹配：
 *   - 转小写
 *   - 去除首尾的非字母 / 非数字 / 非汉字字符（"-", ".", " ", "·" 等连字符尾噪）
 *   - 中间的标点保留（不破坏 "A-LNK" 这种艺名本身）
 *
 * 例：" 周杰伦- "  -> "周杰伦"
 *     "Jay Chou."  -> "jay chou"
 *     "A-LNK"      -> "a-lnk"
 */
function normalizeArtistName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\u4e00-\u9fff]+/u, '')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+$/u, '');
}

// ──────────────────────── 单例 ────────────────────────

let singleton: MusicService | null = null;

/** 全局单例。首次调用同时启动 init（不 await，让初始化和外部调用并行）。 */
export function getMusicService(): MusicService {
  if (!singleton) {
    singleton = new MusicService();
    void singleton.init();
  }
  return singleton;
}

/** 测试 / 显式重置用（不在生产代码路径调）。 */
export function _resetMusicServiceForTests(): void {
  singleton = null;
}
