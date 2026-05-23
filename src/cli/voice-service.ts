import { loadConfig, requireOpenAIConfig, requireTencentConfig } from '../config/env';
import { logger } from '../common/logger';
import { DialogSession, type TtsAudioEvent } from '../dialog/dialog-session';
import { readKeywordDisplays } from '../wake/wake-word-service';
import { Microphone, playAudioBuffer } from './audio-io';

/**
 * 命令行常驻语音服务：
 *   - 用本机麦克风采 16kHz/16bit PCM，喂给 DialogSession
 *   - 接收 DialogSession 的 tts 事件，调用本机扬声器播放
 *   - 控制台仅输出"对话内容"（带本地时间戳的人类可读行）；
 *     结构化日志由 logger 写入 logs/app-YYYY-MM-DD.log。
 */

/** 给控制台对话行打上本地时间戳：HH:mm:ss */
function ts(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function say(line: string): void {
  console.log(`[${ts()}] ${line}`);
}

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
      // 状态机迁移属于内部事件，写入文件日志即可，不污染控制台对话流。
      logger.info('dialog.state.transition', { prev, next: state });
      // 仅在进入 idle 时给一行控制台提示，方便肉眼判断"一轮对话结束"。
      if (state === 'idle' && prev !== 'idle') {
        say(`[空闲] 等待唤醒词："${this.wakeKeyword}"`);
      }
    });
    this.session.on('wake', ({ keyword }) => {
      say(`[唤醒] ${keyword}，我在，请说指令…`);
    });
    this.session.on('asr', (e: { type: string; text?: string; full?: string }) => {
      // 只在 final 时输出一行用户说的话；partial / final-complete 仅写文件日志。
      if (e.type === 'final') {
        say(`[用户] ${e.text ?? ''}`);
      } else {
        logger.info('dialog.asr.event', { type: e.type, text: e.text });
      }
    });
    this.session.on('agent', ({ text }) => {
      say(`[小鱼] ${text}`);
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

    // 子进程（afplay/ffplay/mpg123）退出 ≠ 扬声器真正播完：OS audio buffer 里
    // 还有 100~500ms 的残音。如果立刻 notifyPlaybackComplete()，会出现
    // "话刚说到尾音就进 idle"，长回答最后一句的最后一两个字被吞。
    // 这里加一个固定 400ms 的兜底延迟，等 OS 音频 buffer 排空。
    // 期间如果上层又 emit 了新的 tts（极少见），重置回 outputPlaying=true 跳过此次。
    setTimeout(() => {
      if (this.stopped) return;
      // 期间又有新 tts 排进来，让新一轮 maybeCompletePlayback 决策
      if (this.outputPlaying || this.pendingPlaybackCount > 0) return;
      this.session.notifyPlaybackComplete();
    }, 400);
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

    say(`Home Voice Assistant 已启动，请说唤醒词："${this.wakeKeyword}"`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.mic.stop();
    this.session.dispose();
    // 等当前正在播放的最后一段播完，避免截断
    await this.playChain.catch(() => undefined);
    // flush 上报 trace（如果开启了 Langfuse）
    await this.session.shutdownTracing().catch(() => undefined);
  }

  /** 诊断：把麦克风滚动窗口存成 wav，返回路径。需启用 WAKE_DIAG=1 */
  dumpWakeDiag(label = 'manual'): string | null {
    return this.session.dumpWakeDiag(label);
  }
}
