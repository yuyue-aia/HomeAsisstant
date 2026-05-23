import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env';
import { logger } from '../common/logger';
import { WakeWordService } from '../wake/wake-word-service';
import { TencentAsrClient, type AsrResult } from '../asr/tencent-asr-client';
import { TencentTtsClient, splitForTts, StreamingSentenceSplitter } from '../tts/tencent-tts-client';
import { OpenAIAgentRuntime } from '../agent/openai-agent-runtime';
import { getGameConsoleController } from '../services/game-console-controller';
import { getReminderService } from '../services/reminder-service';

export type DialogState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'followup_wait';

type ListeningMode = 'wake' | 'followup';

export interface DialogSessionOptions {
  config: AppConfig;
  /** 唤醒后最长录音时长，默认 12s 自动结束 */
  maxRecordingMs?: number;
  /** 连续对话追问等待时长，默认 8s 自动结束 */
  followupTimeoutMs?: number;
  /** 单次唤醒后最多连续对话轮数，默认 5 轮 */
  maxConversationTurns?: number;
  /** ASR 静默多久后自动结束本轮，默认 1500ms（基于 ASR final 事件触发） */
  silenceTimeoutMs?: number;
}

export interface AgentTextEvent {
  text: string;
}

export interface TtsAudioEvent {
  index: number;
  total: number;
  segmentText: string;
  audio: Buffer;
  codec: 'mp3' | 'wav' | 'pcm';
  sampleRate: number;
}

/**
 * 单连接的对话会话状态机：
 *
 *   idle --(唤醒)--> listening --(ASR final)--> thinking --(Agent done)--> speaking --(播放完成)--> followup_wait/listening --(超时)--> idle
 *
 * 上层（网关）只需要持续向 `acceptPcm16()` 投喂 16k 16bit 单声道 PCM，
 * 监听 'state' / 'wake' / 'asr' / 'agent' / 'tts' / 'error' 事件即可。
 */
export class DialogSession extends EventEmitter {
  readonly sessionId: string;
  private readonly config: AppConfig;
  private readonly maxRecordingMs: number;
  private readonly followupTimeoutMs: number;
  private readonly maxConversationTurns: number;
  private readonly silenceTimeoutMs: number;

  private readonly wake: WakeWordService;
  private readonly tts: TencentTtsClient;
  private readonly agent: OpenAIAgentRuntime;
  private asr?: TencentAsrClient;

  /** 唤醒后立即播报的固定语（"在的"），预合成缓存，避免每次都走网络。 */
  private wakeAckTts?: TtsAudioEvent;
  private wakeAckPrewarmPromise?: Promise<void>;
  private static readonly WAKE_ACK_TEXT = '在的';

  private state: DialogState = 'idle';
  private listeningMode: ListeningMode = 'wake';
  private conversationTurns = 0;
  private endConversationAfterSpeaking = false;
  private recordingStartedAt = 0;
  private recordingTimer?: NodeJS.Timeout;
  private partialBuffer = '';
  private finalBuffer = '';
  /** 主动播报缓冲：当对话不在可中断状态时暂存，转 idle/followup_wait 后立即播。 */
  private pendingAnnouncements: string[] = [];

  constructor(options: DialogSessionOptions) {
    super();
    this.sessionId = randomUUID();
    this.config = options.config;
    this.maxRecordingMs = options.maxRecordingMs ?? 12_000;
    this.followupTimeoutMs = options.followupTimeoutMs ?? 8_000;
    this.maxConversationTurns = options.maxConversationTurns ?? 5;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 1500;

    this.wake = new WakeWordService({ config: this.config });
    this.tts = new TencentTtsClient(this.config);
    this.agent = new OpenAIAgentRuntime(this.config);

    this.wake.on('wake', (e) => this.handleWake(e.keyword));

    // 预热"在的"语音，避免首次唤醒时合成有延迟
    this.wakeAckPrewarmPromise = this.prewarmWakeAck().catch((error) => {
      logger.warn('dialog.wake_ack.prewarm_failed', { error: (error as Error).message });
    });

    // 把主动播报回调注入到游戏机控制器，让 5min/1min/到期提醒能走 TTS。
    // 多个 DialogSession 实例时以最后创建的为准（当前架构是单实例）。
    try {
      getGameConsoleController().setAnnouncer((text) => this.announce(text));
      // 启动恢复：进程崩溃后续上之前未完成的游戏会话
      void getGameConsoleController()
        .recoverActiveSession()
        .catch((error) => {
          logger.warn('dialog.game_console.recover_failed', {
            error: (error as Error).message,
          });
        });
    } catch (error) {
      logger.warn('dialog.game_console.bind_failed', {
        error: (error as Error).message,
      });
    }

    // 提醒服务：与 game-console 同构地接入主动播报 + 启动恢复。
    try {
      getReminderService().setAnnouncer((text) => this.announce(text));
      void getReminderService()
        .recover()
        .catch((error) => {
          logger.warn('dialog.reminder.recover_failed', {
            error: (error as Error).message,
          });
        });
    } catch (error) {
      logger.warn('dialog.reminder.bind_failed', {
        error: (error as Error).message,
      });
    }
  }

  private async prewarmWakeAck(): Promise<void> {
    const result = await this.tts.synthesize({
      text: DialogSession.WAKE_ACK_TEXT,
      sessionId: `${this.sessionId}:wake-ack`,
    });
    this.wakeAckTts = {
      index: 0,
      total: 1,
      segmentText: DialogSession.WAKE_ACK_TEXT,
      audio: result.audio,
      codec: result.codec,
      sampleRate: result.sampleRate,
    };
    logger.info('dialog.wake_ack.prewarmed', {
      sessionId: this.sessionId,
      audioBytes: result.audio.byteLength,
    });
  }

  getState(): DialogState {
    return this.state;
  }

  /** 诊断用：把唤醒服务的滚动 PCM 窗口落盘成 wav；需启用 WAKE_DIAG */
  dumpWakeDiag(label = 'manual'): string | null {
    return this.wake.dumpDiag(label);
  }

  /** 投喂 16k 16bit PCM。idle 时进唤醒检测，listening 时同时转发到 ASR */
  acceptPcm16(pcm: Buffer): void {
    if (this.state === 'idle') {
      this.wake.acceptPcm16(pcm);
      return;
    }
    if (this.state === 'listening' && this.asr) {
      this.asr.sendAudio(pcm);
    }
  }

  /** 主动结束本轮录音（用户点击停止或网关断开） */
  finishListening(): void {
    if (this.state !== 'listening') return;
    this.asr?.end();
  }

  /** 上层播放器播完所有 TTS 音频后调用，用于进入连续对话追问窗口。 */
  notifyPlaybackComplete(): void {
    if (this.state !== 'speaking') return;
    this.afterSpeakingComplete();
  }

  /**
   * 主动播报（外部模块通过此方法把一段文字交给会话播报）。
   *  - idle / followup_wait：立即播；
   *  - listening / thinking / speaking：缓存到 pendingAnnouncements，等回到可播状态时连播。
   */
  announce(text: string): void {
    const t = text?.trim();
    if (!t) return;
    if (this.state === 'idle' || this.state === 'followup_wait') {
      void this.flushAnnouncement(t);
    } else {
      this.pendingAnnouncements.push(t);
      logger.info('dialog.announce.queued', {
        sessionId: this.sessionId,
        state: this.state,
        pending: this.pendingAnnouncements.length,
      });
    }
  }

  private async flushAnnouncement(text: string): Promise<void> {
    // 把后续也排在队里的一起拼出来，一次播报，避免多次进入 speaking 状态。
    const queue = [text, ...this.pendingAnnouncements];
    this.pendingAnnouncements = [];

    // 进入 speaking 之前先把当前 listening 的 ASR 关掉，避免播报被自己听见
    if (this.asr) {
      this.asr.close();
      this.asr = undefined;
    }
    this.clearRecordingTimer();

    // 播报后行为：原本 idle 仍回 idle；原本 followup_wait 直接结束本轮对话。
    this.endConversationAfterSpeaking = true;
    await this.speakAndWaitForPlayback(queue.join(' '));
  }

  /** 销毁会话，释放资源 */
  dispose(): void {
    this.clearRecordingTimer();
    this.asr?.close();
    this.removeAllListeners();
  }

  /** 退出前 flush trace（Langfuse / OTel BatchProcessor）。 */
  async shutdownTracing(): Promise<void> {
    await this.agent.shutdown();
  }

  // ============================================================
  //                       state transitions
  // ============================================================

  private setState(next: DialogState, meta?: Record<string, unknown>): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    logger.info('dialog.state', { sessionId: this.sessionId, prev, next, ...meta });
    this.emit('state', { state: next, prev });

    // 进入可中断状态时，flush 缓存的主动播报
    if ((next === 'idle' || next === 'followup_wait') && this.pendingAnnouncements.length > 0) {
      const queued = this.pendingAnnouncements.join(' ');
      this.pendingAnnouncements = [];
      // 异步触发，避免在状态切换里嵌套 setState
      setImmediate(() => {
        void this.flushAnnouncement(queued);
      });
    }
  }

  private async handleWake(keyword: string): Promise<void> {
    if (this.state !== 'idle') return;
    this.conversationTurns = 0;
    this.endConversationAfterSpeaking = false;
    this.emit('wake', { keyword });

    // 唤醒后立即用本地缓存的 TTS 应答"在的"，跳过 agent，零延迟。
    this.emitWakeAck();

    await this.startListening('wake');
  }

  private emitWakeAck(): void {
    const ack = this.wakeAckTts;
    if (!ack) {
      // 预热还没完成（首次启动极短窗口）：异步等到好了再播，避免阻塞 listening
      void this.wakeAckPrewarmPromise?.then(() => {
        if (this.wakeAckTts) {
          this.emit('tts', this.wakeAckTts);
          this.emit('tts-end', { hasAudio: true });
        }
      });
      return;
    }
    this.emit('tts', ack);
    // 唤醒应答只有一段，立即标记 TTS 流结束，
    // 让上层播放器在播完后能正确解除麦克风静音。
    this.emit('tts-end', { hasAudio: true });
  }

  private async startListening(mode: ListeningMode): Promise<void> {
    this.listeningMode = mode;
    this.setState('listening', { mode });
    this.partialBuffer = '';
    this.finalBuffer = '';
    this.recordingStartedAt = Date.now();

    try {
      this.asr = new TencentAsrClient({ config: this.config });
      this.asr.on('partial', (r: AsrResult) => {
        this.partialBuffer = r.text;
        this.emit('asr', { type: 'partial', text: r.text });
      });
      this.asr.on('final', (r: AsrResult) => {
        if (r.text) {
          this.finalBuffer = (this.finalBuffer ? this.finalBuffer + ' ' : '') + r.text;
        }
        this.emit('asr', { type: 'final', text: r.text, full: this.finalBuffer });

        // 收到 final 后再等一小段，若期间没有新的 partial/final 即视为说完
        this.armSilenceTimer();
      });
      this.asr.on('end', () => this.handleAsrEnd());
      this.asr.on('error', (error: Error) => {
        this.emit('error', error);
        this.resetToIdle();
      });

      await this.asr.connect();
    } catch (error) {
      this.emit('error', error as Error);
      this.resetToIdle();
      return;
    }

    // 录音保护超时；追问模式更短，避免长时间占用 ASR。
    this.clearRecordingTimer();
    const timeoutMs = mode === 'followup' ? this.followupTimeoutMs : this.maxRecordingMs;
    this.recordingTimer = setTimeout(() => {
      logger.info('dialog.recording.max_timeout', { sessionId: this.sessionId, mode });
      this.asr?.end();
    }, timeoutMs);
  }

  private armSilenceTimer(): void {
    this.clearRecordingTimer();
    this.recordingTimer = setTimeout(() => {
      this.asr?.end();
    }, this.silenceTimeoutMs);
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer);
      this.recordingTimer = undefined;
    }
  }

  private async handleAsrEnd(): Promise<void> {
    this.clearRecordingTimer();
    const text = (this.finalBuffer || this.partialBuffer).trim();
    this.asr?.close();
    this.asr = undefined;

    if (!text) {
      logger.info('dialog.asr.empty', { sessionId: this.sessionId, mode: this.listeningMode });
      this.endConversation();
      return;
    }

    if (isExitPhrase(text)) {
      this.endConversationAfterSpeaking = true;
      await this.speakAndWaitForPlayback('好的，有需要再叫我。');
      return;
    }

    await this.runAgentAndSpeak(text);
  }

  private async runAgentAndSpeak(userText: string): Promise<void> {
    this.setState('thinking', { userText });
    this.emit('asr', { type: 'final-complete', text: userText });

    // 进入 speaking 状态：流式期间也要让上层（voice-service）静音麦克风。
    // 注意 setState 的 idempotent 守卫——thinking → speaking 第一次 setState 时切。
    let speakingStarted = false;
    let segmentIndex = 0;
    const splitter = new StreamingSentenceSplitter();
    /** 串行 TTS 队列：保证多段合成按顺序 emit，避免乱序播放 */
    let ttsChain: Promise<void> = Promise.resolve();
    let hasAudio = false;
    let firstSegmentTime = 0;

    const flushSegment = (segment: string): void => {
      if (!segment) return;
      if (!speakingStarted) {
        speakingStarted = true;
        this.setState('speaking');
      }
      const idx = segmentIndex;
      segmentIndex += 1;

      ttsChain = ttsChain
        .catch(() => undefined)
        .then(async () => {
          try {
            // 默认走 REST 一次性接口（稳定）。如果在 env 里打开 TTS_STREAMING=true，
            // 改走 WebSocket 流式接口，首包更快——但需要在腾讯云控制台开通"实时语音合成"。
            let audio: Buffer;
            let codec: 'mp3' | 'wav' | 'pcm';
            let sampleRate: number;
            if (this.config.ttsStreaming) {
              const handle = this.tts.synthesizeStream({
                text: segment,
                sessionId: this.sessionId,
                codec: 'pcm',
              });
              const collected = await handle.collect();
              audio = collected.audio;
              codec = collected.meta.codec;
              sampleRate = collected.meta.sampleRate;
            } else {
              const result = await this.tts.synthesize({
                text: segment,
                sessionId: this.sessionId,
              });
              audio = result.audio;
              codec = result.codec;
              sampleRate = result.sampleRate;
            }
            if (idx === 0) {
              firstSegmentTime = Date.now();
            }
            const event: TtsAudioEvent = {
              index: idx,
              total: -1, // 流式期间未知，最后 tts-end 时再告诉上层
              segmentText: segment,
              audio,
              codec,
              sampleRate,
            };
            hasAudio = true;
            this.emit('tts', event);
          } catch (error) {
            logger.error('dialog.tts.error', {
              error: (error as Error).message,
              segment,
            });
            this.emit('error', error as Error);
          }
        });
    };

    let answer = '';
    const startedAt = Date.now();
    try {
      const result = await this.agent.runStream(
        { sessionId: this.sessionId, text: userText },
        (delta) => {
          // 流式收到 token 增量，丢给切句器；满一句就立即送 TTS 合成
          for (const segment of splitter.push(delta)) {
            flushSegment(segment);
          }
        },
      );
      answer = (result.text || '').trim();

      // 流结束：把残余 buffer 作为最后一句吐出
      for (const segment of splitter.end()) {
        flushSegment(segment);
      }

      // 兜底：如果整轮 LLM 一个 delta 都没有（比如纯 tool call 链路），
      // 退化到非流式整段 TTS，保证能播报。
      if (segmentIndex === 0 && answer) {
        for (const segment of splitForTts(answer)) {
          flushSegment(segment);
        }
      }

      if (!answer && segmentIndex === 0) {
        answer = '抱歉，我没有想到答案。';
        for (const segment of splitForTts(answer)) {
          flushSegment(segment);
        }
      }
    } catch (error) {
      logger.error('dialog.agent.error', { error: (error as Error).message });
      const fallback = '抱歉，我刚才走神了，请再说一次。';
      for (const segment of splitForTts(fallback)) {
        flushSegment(segment);
      }
      answer = fallback;
      this.emit('error', error as Error);
    }

    // 等所有 TTS 段全部 emit 完
    await ttsChain.catch(() => undefined);

    // 没有任何可播报片段（极端情况）：跳过 speaking
    if (!speakingStarted) {
      this.emit('agent', { text: answer } satisfies AgentTextEvent);
      this.conversationTurns += 1;
      this.emit('tts-end', { hasAudio: false });
      this.afterSpeakingComplete();
      return;
    }

    this.emit('agent', { text: answer } satisfies AgentTextEvent);
    this.conversationTurns += 1;

    logger.info('dialog.runStream.timing', {
      sessionId: this.sessionId,
      totalMs: Date.now() - startedAt,
      firstSegmentMs: firstSegmentTime ? firstSegmentTime - startedAt : -1,
      segments: segmentIndex,
    });

    this.emit('tts-end', { hasAudio });
    // 注意：tts-end 后 voice-service 会在播放队列空时调用 notifyPlaybackComplete，
    // 这里不需要主动调用 afterSpeakingComplete。
  }

  private async speakAndWaitForPlayback(text: string): Promise<void> {
    const hasAudio = await this.speak(text);
    if (!hasAudio) {
      this.afterSpeakingComplete();
    }
  }

  private async speak(text: string): Promise<boolean> {
    this.setState('speaking');
    const segments = splitForTts(text);
    if (segments.length === 0) {
      this.emit('tts-end', { hasAudio: false });
      return false;
    }

    let hasAudio = false;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      try {
        const result = await this.tts.synthesize({
          text: segment,
          sessionId: this.sessionId,
        });
        const event: TtsAudioEvent = {
          index: i,
          total: segments.length,
          segmentText: segment,
          audio: result.audio,
          codec: result.codec,
          sampleRate: result.sampleRate,
        };
        hasAudio = true;
        this.emit('tts', event);
      } catch (error) {
        logger.error('dialog.tts.error', { error: (error as Error).message });
        this.emit('error', error as Error);
        break;
      }
    }
    this.emit('tts-end', { hasAudio });
    return hasAudio;
  }

  private afterSpeakingComplete(): void {
    if (this.endConversationAfterSpeaking || this.conversationTurns >= this.maxConversationTurns) {
      this.endConversation();
      return;
    }

    this.setState('followup_wait', {
      timeoutMs: this.followupTimeoutMs,
      turn: this.conversationTurns,
      maxTurns: this.maxConversationTurns,
    });
    void this.startListening('followup');
  }

  private endConversation(): void {
    this.conversationTurns = 0;
    this.endConversationAfterSpeaking = false;
    this.resetToIdle();
  }

  private resetToIdle(): void {
    this.clearRecordingTimer();
    if (this.asr) {
      this.asr.close();
      this.asr = undefined;
    }
    this.wake.reset();
    this.listeningMode = 'wake';
    this.partialBuffer = '';
    this.finalBuffer = '';
    this.setState('idle');
  }
}

function isExitPhrase(text: string): boolean {
  const normalized = text.replace(/[\s。！？!?，,；;\.]/g, '');
  return ['不用了', '结束', '退出', '先这样', '没事了', '停止对话'].some((phrase) =>
    normalized.includes(phrase),
  );
}
