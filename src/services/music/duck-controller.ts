/**
 * DuckController —— 把对话状态机和音乐播放器联动起来。
 *
 * 策略（mac mini 无 AEC，所以不做"音量 duck"，统一用 pause/resume）：
 *
 *   dialog state         音乐行为
 *   ─────────────────── ───────────────────────
 *   idle                 维持现状（resume 由前一态触发）
 *   listening            pause（避免污染 ASR）
 *   thinking             维持 pause
 *   speaking             维持 pause（TTS 与音乐共扬声器）
 *   followup_wait        resume（TTS 已停，等用户跟话期间可以放）
 *   idle 且前一态是 speaking  resume（TTS 自然结束回到 idle）
 *
 * 实现要点：
 *   - DialogSession 已经 emit('state', {state, prev})，直接订阅；
 *   - 调用全部走 service.duckPause/duckResume，service 自己保证幂等 + 记录 wasPlaying；
 *   - 失败不冒泡，duck 不应该影响对话主流程（service 内部也有 try/catch）。
 */

import type { EventEmitter } from 'node:events';
import { logger } from '../../common/logger';
import { getMusicService, type MusicService } from './music-service';

type DialogState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'followup_wait';

interface DialogStateEvent {
  state: DialogState;
  prev: DialogState;
}

/** 需要"压音乐"的对话态。 */
const DUCK_STATES: ReadonlySet<DialogState> = new Set(['listening', 'thinking', 'speaking']);

/** 可以"放音乐回来"的对话态。 */
const UNDUCK_STATES: ReadonlySet<DialogState> = new Set(['idle', 'followup_wait']);

export class DuckController {
  constructor(private readonly service: MusicService = getMusicService()) {}

  /**
   * 挂到一个 DialogSession（或任何 emit('state', {state, prev}) 的 EventEmitter）上。
   * 返回反挂函数，便于测试/热重载。
   */
  attach(session: EventEmitter): () => void {
    const handler = (event: DialogStateEvent): void => {
      this.handle(event.state, event.prev);
    };
    session.on('state', handler);
    logger.info('music.duck.attached');
    return () => {
      session.off('state', handler);
    };
  }

  private handle(next: DialogState, prev: DialogState): void {
    if (DUCK_STATES.has(next)) {
      // 进入需要压制的态：let service 自己决定要不要真 pause（用 state 探 playing）
      void this.service.duckPause();
      return;
    }
    if (UNDUCK_STATES.has(next)) {
      // 离开压制态：恢复
      void this.service.duckResume();
      return;
    }
    logger.warn('music.duck.unknown_state', { next, prev });
  }
}
