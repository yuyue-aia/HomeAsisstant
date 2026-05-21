import { loadConfig, requireOpenAIConfig, requireTencentConfig } from '../config/env';
import { logger } from '../common/logger';
import { DialogSession, type TtsAudioEvent } from '../dialog/dialog-session';
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
  /** TTS 顺序播放队列；保证多段音频不重叠 */
  private playChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor() {
    const config = loadConfig();
    requireOpenAIConfig(config);
    requireTencentConfig(config);

    this.session = new DialogSession({ config });
    this.mic = new Microphone();

    this.bindSessionEvents();
  }

  private bindSessionEvents(): void {
    this.session.on('state', ({ state, prev }) => {
      // 顶层一行可读日志，方便 tail -f 直接看
      console.log(`[state] ${prev} → ${state}`);
    });
    this.session.on('wake', ({ keyword }) => {
      console.log(`[wake] keyword="${keyword}"，请说指令…`);
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
      // 不阻塞 dialog-session 的 emit；按到达顺序串行播放
      this.playChain = this.playChain
        .catch(() => undefined)
        .then(() =>
          playAudioBuffer(event.audio, event.codec, {
            sampleRate: event.sampleRate,
            channels: 1,
          }),
        )
        .catch((error) => {
          logger.error('voice.play.error', { error: (error as Error).message });
        });
    });
    this.session.on('error', (error: Error) => {
      logger.error('voice.session.error', { error: error.message });
    });
  }

  start(): void {
    this.mic.on('frame', (pcm: Buffer) => {
      this.session.acceptPcm16(pcm);
    });
    this.mic.on('error', (err: Error) => {
      logger.error('voice.mic.error', { error: err.message });
      // 麦克风挂了整个服务无法工作，直接退出由进程管理器/守护层重启
      this.stop();
      process.exit(2);
    });
    this.mic.start();

    console.log('Home Voice Assistant 已启动，请说唤醒词："小余小余"');
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
}
