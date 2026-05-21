import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env';
import { logger } from '../common/logger';
import { WakeWordService } from '../wake/wake-word-service';
import { TencentAsrClient, type AsrResult } from '../asr/tencent-asr-client';
import { TencentTtsClient, splitForTts } from '../tts/tencent-tts-client';
import { OpenAIAgentRuntime } from '../agent/openai-agent-runtime';

export type DialogState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface DialogSessionOptions {
  config: AppConfig;
  /** 唤醒后最长录音时长，默认 12s 自动结束 */
  maxRecordingMs?: number;
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
 *   idle --(唤醒)--> listening --(ASR final)--> thinking --(Agent done)--> speaking --(TTS done)--> idle
 *
 * 上层（网关）只需要持续向 `acceptPcm16()` 投喂 16k 16bit 单声道 PCM，
 * 监听 'state' / 'wake' / 'asr' / 'agent' / 'tts' / 'error' 事件即可。
 */
export class DialogSession extends EventEmitter {
  readonly sessionId: string;
  private readonly config: AppConfig;
  private readonly maxRecordingMs: number;
  private readonly silenceTimeoutMs: number;

  private readonly wake: WakeWordService;
  private readonly tts: TencentTtsClient;
  private readonly agent: OpenAIAgentRuntime;
  private asr?: TencentAsrClient;

  private state: DialogState = 'idle';
  private recordingStartedAt = 0;
  private recordingTimer?: NodeJS.Timeout;
  private partialBuffer = '';
  private finalBuffer = '';

  constructor(options: DialogSessionOptions) {
    super();
    this.sessionId = randomUUID();
    this.config = options.config;
    this.maxRecordingMs = options.maxRecordingMs ?? 12_000;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 1500;

    this.wake = new WakeWordService({ config: this.config });
    this.tts = new TencentTtsClient(this.config);
    this.agent = new OpenAIAgentRuntime(this.config);

    this.wake.on('wake', (e) => this.handleWake(e.keyword));
  }

  getState(): DialogState {
    return this.state;
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

  /** 销毁会话，释放资源 */
  dispose(): void {
    this.clearRecordingTimer();
    this.asr?.close();
    this.removeAllListeners();
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
  }

  private async handleWake(keyword: string): Promise<void> {
    if (this.state !== 'idle') return;
    this.emit('wake', { keyword });
    await this.startListening();
  }

  private async startListening(): Promise<void> {
    this.setState('listening');
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

    // 录音保护超时
    this.clearRecordingTimer();
    this.recordingTimer = setTimeout(() => {
      logger.info('dialog.recording.max_timeout', { sessionId: this.sessionId });
      this.asr?.end();
    }, this.maxRecordingMs);
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
      logger.info('dialog.asr.empty', { sessionId: this.sessionId });
      this.resetToIdle();
      return;
    }

    await this.runAgentAndSpeak(text);
  }

  private async runAgentAndSpeak(userText: string): Promise<void> {
    this.setState('thinking', { userText });
    this.emit('asr', { type: 'final-complete', text: userText });

    let answer = '';
    try {
      const result = await this.agent.run({ sessionId: this.sessionId, text: userText });
      answer = result.text || '抱歉，我没有想到答案。';
    } catch (error) {
      logger.error('dialog.agent.error', { error: (error as Error).message });
      answer = '抱歉，我刚才走神了，请再说一次。';
      this.emit('error', error as Error);
    }

    this.emit('agent', { text: answer } satisfies AgentTextEvent);

    await this.speak(answer);
    this.resetToIdle();
  }

  private async speak(text: string): Promise<void> {
    this.setState('speaking');
    const segments = splitForTts(text);
    if (segments.length === 0) return;

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
        this.emit('tts', event);
      } catch (error) {
        logger.error('dialog.tts.error', { error: (error as Error).message });
        this.emit('error', error as Error);
        break;
      }
    }
  }

  private resetToIdle(): void {
    this.clearRecordingTimer();
    if (this.asr) {
      this.asr.close();
      this.asr = undefined;
    }
    this.wake.reset();
    this.partialBuffer = '';
    this.finalBuffer = '';
    this.setState('idle');
  }
}
