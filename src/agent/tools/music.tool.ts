/**
 * 音乐相关的两个 tool：
 *   - search_music：搜歌或搜歌单，返回精筛后的候选数组
 *   - control_music_player：播放/暂停/继续/切歌/音量/红心/取消红心/now_playing/每日推荐/心动模式
 *
 * 设计原则：
 *   - tool 不持有状态，所有副作用都在 MusicService（与 reminder.tool 同构）
 *   - 错误归一：service 抛 MusicError → tool 转成 { ok:false, reason, message }
 *   - 入参中文 describe，方便 LLM 看懂；可选字段都用 nullable().optional()，
 *     兼容部分模型在第三方网关下不接受 "optional 但不允许 null" 的问题。
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import { getMusicService } from '../../services/music/music-service';
import { MusicError, type MusicErrorReason } from '../../services/music/types';
import type { VoiceAgentContext } from '../types';

// ──────────────────────── search_music ────────────────────────

const searchParams = z.object({
  query: z
    .string()
    .describe(
      '搜索关键词：可以是歌名、歌单名、风格词或场景词。例：稻香、轻音乐、雨天钢琴',
    ),
  artist: z
    .string()
    .nullable()
    .optional()
    .describe(
      '当用户明确说了歌手名时填，否则留空（留空时不要乱猜）。例："周杰伦的稻香"→ artist="周杰伦"',
    ),
  type: z
    .enum(['track', 'playlist'])
    .nullable()
    .optional()
    .describe('track=搜单曲；playlist=搜歌单（默认 track）'),
  user_input: z
    .string()
    .describe('用户的原话（开放平台审计要求，必填）'),
});

interface SearchTrackItem {
  encrypted_id: string;
  original_id: number;
  name: string;
  artists: string[];
}

interface SearchPlaylistItem {
  encrypted_id: string;
  original_id: number;
  name: string;
  track_count: number;
  creator?: string;
}

type SearchMusicResult = {
  ok: boolean;
  type: 'track' | 'playlist';
  items?: SearchTrackItem[] | SearchPlaylistItem[];
  reason?: MusicErrorReason;
  message: string;
};

export const searchMusicTool = tool<typeof searchParams, VoiceAgentContext, SearchMusicResult>({
  name: 'search_music',
  description:
    '搜索网易云音乐的歌曲或歌单。返回的 items 已经过可播性 / 付费 / artist 精确匹配过滤，直接取首条即可。不要在用户没说艺人名时强行填 artist。',
  parameters: searchParams,
  async execute({ query, artist, type, user_input }) {
    const svc = getMusicService();
    await svc.init();
    const searchType: 'track' | 'playlist' = type ?? 'track';
    logger.info('tool.music.search.call', {
      query,
      artist: artist ?? null,
      type: searchType,
      user_input,
    });
    try {
      if (searchType === 'track') {
        const tracks = await svc.searchTracks(
          query,
          user_input,
          artist?.trim() || undefined,
        );
        if (!tracks.length) {
          logger.info('tool.music.search.empty', { query, artist, type: searchType });
          return {
            ok: false,
            type: searchType,
            reason: 'not_found',
            message: '没找到能播的版本',
            items: [],
          };
        }
        const items: SearchTrackItem[] = tracks.slice(0, 8).map((t) => ({
          encrypted_id: t.encryptedId,
          original_id: t.originalId,
          name: t.name,
          artists: t.artists,
        }));
        logger.info('tool.music.search.track', {
          query,
          artist,
          count: tracks.length,
          pickName: items[0]?.name,
          pickEncryptedId: items[0]?.encrypted_id,
          // 把前 3 候选都打出来，方便事后排查"LLM 是不是选了非原版"
          candidates: items.slice(0, 3).map((it) => ({
            name: it.name,
            artists: it.artists,
            encrypted_id: it.encrypted_id,
          })),
        });
        return {
          ok: true,
          type: searchType,
          items,
          message: `找到 ${items.length} 首候选，下一步必须立刻调 control_music_player(action='play_track', encrypted_id, original_id) 起播 items[0]，不要只回文本`,
        };
      }

      const playlists = await svc.searchPlaylists(query, user_input);
      if (!playlists.length) {
        logger.info('tool.music.search.empty', { query, type: searchType });
        return {
          ok: false,
          type: searchType,
          reason: 'not_found',
          message: '没找到对应的歌单',
          items: [],
        };
      }
      const items: SearchPlaylistItem[] = playlists.slice(0, 5).map((p) => ({
        encrypted_id: p.encryptedId,
        original_id: p.originalId,
        name: p.name,
        track_count: p.trackCount,
        creator: p.creator,
      }));
      logger.info('tool.music.search.playlist', {
        query,
        count: playlists.length,
        pickName: items[0]?.name,
        pickEncryptedId: items[0]?.encrypted_id,
      });
      return {
        ok: true,
        type: searchType,
        items,
        message: `找到 ${items.length} 个歌单，下一步必须立刻调 control_music_player(action='play_playlist', encrypted_id, original_id) 起播 items[0]，不要只回文本`,
      };
    } catch (error) {
      return toolErrorResult<SearchMusicResult>(error, {
        type: searchType,
        message: '搜索失败',
      });
    }
  },
});

// ──────────────────────── control_music_player ────────────────────────

const controlParams = z.object({
  action: z
    .enum([
      'play_track',
      'play_playlist',
      'daily_recommend',
      'heart_mode',
      'pause',
      'resume',
      'stop',
      'next',
      'prev',
      'set_volume',
      'like',
      'unlike',
      'now_playing',
    ])
    .describe('音乐控制动作'),
  encrypted_id: z
    .string()
    .nullable()
    .optional()
    .describe('歌曲/歌单的加密 ID，play_track / play_playlist 必填'),
  original_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('歌曲/歌单的数字 ID，play_track / play_playlist 必填'),
  volume_level: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe('音量值，0-100；set_volume 必填'),
  user_input: z
    .string()
    .nullable()
    .optional()
    .describe('用户原话；daily_recommend / heart_mode / like / unlike 时必填'),
});

type ControlMusicResult = {
  ok: boolean;
  action: string;
  reason?: MusicErrorReason | 'invalid_args';
  message: string;
  now_playing?: { title: string; artists?: string[] } | null;
  state?: {
    status: string;
    title?: string;
    progress?: string;
    queueLength?: number;
    volume?: number;
  };
};

export const controlMusicPlayerTool = tool<typeof controlParams, VoiceAgentContext, ControlMusicResult>({
  name: 'control_music_player',
  description:
    '控制网易云音乐播放器：起播单曲/歌单、每日推荐、心动模式、暂停/继续/停止、上一首/下一首、调音量、红心/取消红心、查询当前播放。所有副作用都在这一个工具里完成。',
  parameters: controlParams,
  async execute({ action, encrypted_id, original_id, volume_level, user_input }) {
    const svc = getMusicService();
    await svc.init();

    logger.info('tool.music.control.call', {
      action,
      encrypted_id: encrypted_id ?? null,
      original_id: original_id ?? null,
      volume_level: volume_level ?? null,
      user_input: user_input ?? null,
    });

    try {
      switch (action) {
        case 'play_track': {
          if (!encrypted_id || original_id == null) {
            return invalidArgs(action, '播单曲需要 encrypted_id + original_id');
          }
          // 优先从 search 缓存里反查完整 Track（含 name/artists/vipOnly），
          // 这样 service.currentTrack 才是真实曲目，nowPlaying / like / 日志才不会是空。
          // 命中不上才退回 fakeTrack（极端情况：LLM 用了不在缓存里的 ID）。
          const cached = svc.getCachedTrack(encrypted_id);
          const trackToPlay = cached ?? {
            encryptedId: encrypted_id,
            originalId: original_id,
            name: '',
            artists: [],
            durationMs: 0,
            vipOnly: false,
          };
          logger.info('tool.music.control.play_track.resolve', {
            encrypted_id,
            from: cached ? 'cache' : 'fake',
            name: trackToPlay.name,
            artists: trackToPlay.artists,
          });
          const state = await svc.playTrack(trackToPlay);
          const np = await svc.nowPlaying();
          logger.info('tool.music.control.ok', {
            action,
            title: np?.title,
            artists: np?.artists,
            status: state.status,
          });
          return {
            ok: true,
            action,
            message: `正在播放${np?.title ? '：' + np.title : ''}`,
            now_playing: np,
            state: pickState(state),
          };
        }

        case 'play_playlist': {
          if (!encrypted_id || original_id == null) {
            return invalidArgs(action, '播歌单需要 encrypted_id + original_id');
          }
          const fakePlaylist = {
            encryptedId: encrypted_id,
            originalId: original_id,
            name: '',
            trackCount: 0,
          };
          const state = await svc.playPlaylist(fakePlaylist);
          const np = await svc.nowPlaying();
          logger.info('tool.music.control.ok', {
            action,
            title: np?.title,
            artists: np?.artists,
            queueLength: state.queueLength,
            status: state.status,
          });
          return {
            ok: true,
            action,
            message: `歌单开始播放${np?.title ? '：' + np.title : ''}`,
            now_playing: np,
            state: pickState(state),
          };
        }

        case 'daily_recommend': {
          if (!user_input) {
            return invalidArgs(action, 'daily_recommend 需要 user_input');
          }
          const state = await svc.playDailyRecommend(user_input);
          const np = await svc.nowPlaying();
          logger.info('tool.music.control.ok', {
            action,
            title: np?.title,
            queueLength: state.queueLength,
            status: state.status,
          });
          return {
            ok: true,
            action,
            message: `每日推荐${np?.title ? '：' + np.title : ''}`,
            now_playing: np,
            state: pickState(state),
          };
        }

        case 'heart_mode': {
          if (!user_input) {
            return invalidArgs(action, 'heart_mode 需要 user_input');
          }
          const state = await svc.playHeartMode(user_input);
          const np = await svc.nowPlaying();
          logger.info('tool.music.control.ok', {
            action,
            title: np?.title,
            queueLength: state.queueLength,
            status: state.status,
          });
          return {
            ok: true,
            action,
            message: `心动模式${np?.title ? '：' + np.title : ''}`,
            now_playing: np,
            state: pickState(state),
          };
        }

        case 'pause':
          await svc.pause();
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已暂停' };

        case 'resume':
          await svc.resume();
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已继续' };

        case 'stop':
          await svc.stop();
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已停止' };

        case 'next':
          await svc.next();
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已切到下一首' };

        case 'prev':
          await svc.prev();
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已切到上一首' };

        case 'set_volume': {
          if (volume_level == null) {
            return invalidArgs(action, 'set_volume 需要 volume_level');
          }
          await svc.setVolume(volume_level);
          logger.info('tool.music.control.ok', { action, volume_level });
          return { ok: true, action, message: `音量已设为 ${volume_level}` };
        }

        case 'like': {
          if (!user_input) {
            return invalidArgs(action, 'like 需要 user_input');
          }
          await svc.like(user_input);
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已收藏' };
        }

        case 'unlike': {
          if (!user_input) {
            return invalidArgs(action, 'unlike 需要 user_input');
          }
          await svc.unlike(user_input);
          logger.info('tool.music.control.ok', { action });
          return { ok: true, action, message: '已取消收藏' };
        }

        case 'now_playing': {
          const np = await svc.nowPlaying();
          logger.info('tool.music.control.ok', {
            action,
            title: np?.title ?? null,
          });
          if (!np) {
            return { ok: true, action, message: '当前没有播放', now_playing: null };
          }
          return {
            ok: true,
            action,
            message: `正在放：${np.title}`,
            now_playing: np,
          };
        }

        default:
          return invalidArgs(action, `未知 action: ${action as string}`);
      }
    } catch (error) {
      return toolErrorResult<ControlMusicResult>(error, { action, message: '操作失败' });
    }
  },
});

// ──────────────────────── helpers ────────────────────────

function pickState(state: {
  status: string;
  title?: string;
  progress?: string;
  queueLength?: number;
  volume?: number;
}): ControlMusicResult['state'] {
  return {
    status: state.status,
    title: state.title,
    progress: state.progress,
    queueLength: state.queueLength,
    volume: state.volume,
  };
}

function invalidArgs(action: string, message: string): ControlMusicResult {
  logger.warn('tool.music.invalid_args', { action, message });
  return { ok: false, action, reason: 'invalid_args', message };
}

/**
 * 统一的 MusicError → tool result 映射。
 * - MusicError → 透传 reason + 友好 message
 * - 其它 Error → 兜底成 network_error
 */
function toolErrorResult<R extends { ok: boolean; reason?: MusicErrorReason | 'invalid_args'; message: string }>(
  error: unknown,
  base: Omit<R, 'ok' | 'reason'>,
): R {
  if (error instanceof MusicError) {
    logger.info('tool.music.error', { reason: error.reason, message: error.message });
    return { ...(base as object), ok: false, reason: error.reason, message: error.message } as R;
  }
  const msg = (error as Error).message ?? String(error);
  logger.error('tool.music.exception', { error: msg });
  return {
    ...(base as object),
    ok: false,
    reason: 'network_error',
    message: msg,
  } as R;
}
