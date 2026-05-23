import { loadConfig, requireOpenAIConfig, requireTencentConfig } from '../config/env';
import { logger } from '../common/logger';
import { DialogSession, type TtsAudioEvent } from '../dialog/dialog-session';
import { readKeywordDisplays } from '../wake/wake-word-service';
import { Microphone, playAudioBuffer } from './audio-io';

/**
 * 命令行常驻语音服务：
 *   - 用本机麦克风采 16kHz/16bit PCM，喂给 DialogSession
 *   - 接收 DialogSession 的 tts 事件，调用本机扬声器播放
 *   - 唤醒/ASR/思考/说话状态都打印到 stdout（结构化 JSON 日志）
 */
export class VoiceService {
  private readonly session: DialogSession;
  private readonly mic: Microphone;
  private readonly wakeKeyword: string;
  /** TTS 顺序播放队列；保证多段音频不重叠 */
  private playChain: Promise<void> = Promise.resolve();
  private pendingPlaybackCount = 0;
  private ttsSynthesisDone = false;
  private outputPlaying = false;
  private stopped = false;

  constructor() {
    const config = loadConfig();
    requireOpenAIConfig(config);
    requireTencentConfig(config);

    this.session = new DialogSession({ config });
    this.mic = new Microphone();
    this.wakeKeyword = readKeywordDisplays(config.kwsKeywordsFile)[0] || '唤醒词';

    this.bindSessionEvents();
  }

  private bindSessionEvents(): void {
    this.session.on('state', ({ state, prev }) => {
      // 顶层一行可读日志，方便 tail -f 直接看
      console.log(`[state] ${prev} → ${state}`);
    });
    this.session.on('wake', ({ keyword }) => {
      console.log(`[wake] keyword="${keyword}"，我在，请说指令…`);
    });
    this.session.on('asr', (e: { type: string; text?: string; full?: string }) => {
      if (e.type === 'partial') {
        process.stdout.write(`\r[asr-partial] ${e.text ?? ''}     `);
      } else if (e.type === 'final') {
        process.stdout.write('\n');
        console.log(`[asr-final]   ${e.text ?? ''}`);
      } else if (e.type === 'final-complete') {
        console.log(`[asr-complete] ${e.text ?? ''}`);
      }
    });
    this.session.on('agent', ({ text }) => {
      console.log(`[agent] ${text}`);
    });
    this.session.on('tts', (event: TtsAudioEvent) => {
      // 不阻塞 dialog-session 的 emit；按到达顺序串行播放。
      // 播放期间丢弃麦克风输入，避免扬声器回放污染下一轮唤醒检测。
      if (event.index === 0) {
        this.ttsSynthesisDone = false;
      }
      this.pendingPlaybackCount += 1;
      this.outputPlaying = true;
      this.playChain = this.playChain
        .catch(() => undefined)
        .then(async () => {
          try {
            await playAudioBuffer(event.audio, event.codec, {
              sampleRate: event.sampleRate,
              channels: 1,
            });
          } catch (error) {
            logger.error('voice.play.error', { error: (error as Error).message });
          } finally {
            this.pendingPlaybackCount = Math.max(0, this.pendingPlaybackCount - 1);
            this.maybeCompletePlayback();
          }
        });
    });
    this.session.on('tts-end', () => {
      this.ttsSynthesisDone = true;
      this.maybeCompletePlayback();
    });
    this.session.on('error', (error: Error) => {
      logger.error('voice.session.error', { error: error.message });
    });
  }

  private maybeCompletePlayback(): void {
    if (!this.outputPlaying || !this.ttsSynthesisDone || this.pendingPlaybackCount !== 0) return;

    this.ttsSynthesisDone = false;
    this.outputPlaying = false;
    if (this.stopped) return;

    this.session.notifyPlaybackComplete();
    if (this.session.getState() === 'listening') {
      console.log('[followup] 可以继续说，不需要唤醒词；8 秒无输入将结束。');
    } else if (this.session.getState() === 'idle') {
      console.log(`[ready] 请再次说唤醒词："${this.wakeKeyword}"`);
    }
  }

  private async playWakeAck(): Promise<void> {
    // 已废弃：唤醒应答现在由 DialogSession 通过 TTS 事件下发"在的"。
  }

  start(): void {
    this.mic.on('frame', (pcm: Buffer) => {
      if (this.outputPlaying) return;
      this.session.acceptPcm16(pcm);
    });
    this.mic.on('error', (err: Error) => {
      logger.error('voice.mic.error', { error: err.message });
      // 麦克风挂了整个服务无法工作，直接退出由进程管理器/守护层重启
      this.stop();
      process.exit(2);
    });
    this.mic.start();

    console.log(`Home Voice Assistant 已启动，请说唤醒词："${this.wakeKeyword}"`);
    console.log('Ctrl+C 退出，或运行 `npm run stop` 关闭后台进程。');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.mic.stop();
    this.session.dispose();
    // 等当前正在播放的最后一段播完，避免截断
    await this.playChain.catch(() => undefined);
  }

  /** 诊断：把麦克风滚动窗口存成 wav，返回路径。需启用 WAKE_DIAG=1 */
  dumpWakeDiag(label = 'manual'): string | null {
    return this.session.dumpWakeDiag(label);
  }
}
