/**
 * 音乐 service 的领域类型。
 *
 * 字段命名与 ncm-cli 返回原结构有意拉开距离：
 *   - 命名按"我们要用什么"取，不按"上游叫什么"取；
 *   - 把上游脱敏字段（artists）与真实字段（fullArtists）的差异在 service 边界吸收掉，
 *     上层只看到 artists 数组（来自 fullArtists[].name）。
 */

/** 播放器对单首歌只认 encryptedId + originalId 这对组合（见 F1/F10）。 */
export interface Track {
  /** 32 位 hex，API/调用 song.like/play 时必传 */
  encryptedId: string;
  /** 数字 ID，play 命令必传 */
  originalId: number;
  /** 歌名，如"稻香" */
  name: string;
  /** 真实艺人名数组，来自上游 fullArtists[].name（不是 artists！） */
  artists: string[];
  /** 专辑名，可空 */
  album?: string;
  /** 时长（毫秒），上游 duration 字段单位ms */
  durationMs: number;
  /** 封面 url，可空 */
  coverUrl?: string;
  /** 是否需要会员/付费/试听限制——上游三件套合并 */
  vipOnly: boolean;
}

export interface Playlist {
  encryptedId: string;
  originalId: number;
  name: string;
  /** 上游 trackCount */
  trackCount: number;
  /** 创建者昵称，可空 */
  creator?: string;
}

/**
 * 播放器实时状态。注意 volume 字段——ncm-cli `state` 命令的 volume 永远是 null（F9），
 * 这里仍然保留，但实际填充由 MusicService 用自己缓存的 currentVolume 写入。
 */
export interface PlayerState {
  status: 'playing' | 'paused' | 'stopped';
  /** 形如 "稻香 - 周杰伦-" */
  title?: string;
  positionSec?: number;
  durationSec?: number;
  /** 形如 "0:25 / 3:03"，直接来自 ncm-cli */
  progress?: string;
  currentIndex?: number;
  queueLength?: number;
  /** 由 MusicService 注入（不是从 state 命令拿的） */
  volume?: number;
}

/**
 * 业务侧的错误原因码。所有 ncm-cli 报错最终都映射到这几个 reason，
 * Tool 层把它转成 `{ ok:false, reason, message }` 透传给 LLM，由 SKILL.md 决定播报。
 */
export type MusicErrorReason =
  | 'not_found' // 搜不到 / 过滤完没结果
  | 'vip_only' // 用户选的歌是 VIP / 付费
  | 'auth_required' // ncm-cli 未登录
  | 'player_not_started' // play 后 state 轮询超时仍非 playing
  | 'unknown_current_track' // like/unlike 时拿不到当前曲 encryptedId
  | 'invalid_args' // 调用参数缺失
  | 'network_error' // ncm-cli 返回 code != 200 / success false
  | 'parse_error' // stdout 不是预期 JSON
  | 'spawn_failed'; // ncm-cli 二进制不在 PATH / exec 失败

export class MusicError extends Error {
  constructor(
    readonly reason: MusicErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'MusicError';
  }
}
