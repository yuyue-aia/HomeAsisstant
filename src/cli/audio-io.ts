import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import NodeMicrophone from 'node-microphone';
import { logger } from '../common/logger';

/**
 * 跨平台音频 IO：
 *   - 录音：基于 node-microphone（封装 macOS/Win 的 sox-rec、Linux 的 arecord）
 *   - 播放：通过命令行播放器（ffplay/afplay/mpg123/aplay）
 * 这样不引入 native 编译依赖，树莓派 / mac / linux 都好部署。
 */

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;

interface PlayerTemplate {
  bin: string;
  args: (file: string) => string[];
  supports: ReadonlyArray<'mp3' | 'wav' | 'pcm'>;
  pcmArgs?: (rate: number, channels: number, file: string) => string[];
}

const PLAYER_TEMPLATES: PlayerTemplate[] = [
  {
    bin: 'ffplay',
    args: (f) => ['-loglevel', 'error', '-nodisp', '-autoexit', f],
    supports: ['mp3', 'wav', 'pcm'],
    pcmArgs: (rate, ch, f) => [
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-f',
      's16le',
      '-ar',
      String(rate),
      '-ac',
      String(ch),
      f,
    ],
  },
  {
    bin: 'afplay',
    args: (f) => [f],
    supports: ['mp3', 'wav'],
  },
  {
    bin: 'mpg123',
    args: (f) => ['-q', f],
    supports: ['mp3'],
  },
  {
    bin: 'aplay',
    args: (f) => ['-q', f],
    supports: ['wav'],
    pcmArgs: (rate, ch, f) => [
      '-q',
      '-f',
      'S16_LE',
      '-r',
      String(rate),
      '-c',
      String(ch),
      f,
    ],
  },
];

function commandExists(bin: string): boolean {
  if (bin.includes('/')) return existsSync(bin);
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, bin))) return true;
  }
  return false;
}

function pickPlayer(codec: 'mp3' | 'wav' | 'pcm'): PlayerTemplate {
  const override = process.env.AUDIO_PLAY_CMD?.trim();
  if (override) {
    const [bin, ...rest] = override.split(/\s+/);
    return {
      bin,
      args: (f) => [...rest, f],
      supports: ['mp3', 'wav', 'pcm'],
      pcmArgs: (_r, _c, f) => [...rest, f],
    };
  }
  for (const tpl of PLAYER_TEMPLATES) {
    if (tpl.supports.includes(codec) && commandExists(tpl.bin)) return tpl;
  }
  throw new Error(
    `未找到可播放 ${codec} 的工具。建议安装 ffmpeg（提供 ffplay）或 mpg123；macOS 自带 afplay。也可设置 AUDIO_PLAY_CMD 自定义。`,
  );
}

// ============================================================
// Microphone（基于 node-microphone）
// ============================================================

export interface MicrophoneOptions {
  sampleRate?: number;
  channels?: number;
  /** PCM 帧切分尺寸，默认 3200 字节 ≈ 100ms@16k mono 16bit */
  frameBytes?: number;
  /** 指定输入设备名，留空使用系统默认 */
  device?: string;
}

export class Microphone extends EventEmitter {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly frameBytes: number;
  private readonly device?: string;
  private mic?: NodeMicrophone;
  private buffer: Buffer = Buffer.alloc(0);
  private stopped = false;

  constructor(opts: MicrophoneOptions = {}) {
    super();
    this.sampleRate = opts.sampleRate ?? SAMPLE_RATE;
    this.channels = opts.channels ?? CHANNELS;
    this.frameBytes = opts.frameBytes ?? 3200;
    this.device = opts.device;
  }

  start(): void {
    if (this.mic) return;
    this.stopped = false;

    // node-microphone 在 macOS 用 rec（sox），Linux 用 arecord，Windows 用 sox。
    const mic = new NodeMicrophone({
      rate: this.sampleRate,
      channels: this.channels,
      bitwidth: 16,
      encoding: 'signed-integer',
      device: this.device,
    });
    this.mic = mic;

    logger.info('mic.start', {
      sampleRate: this.sampleRate,
      channels: this.channels,
      device: this.device,
    });

    let stream: NodeJS.ReadableStream;
    try {
      const result = mic.startRecording();
      if (!result) {
        throw new Error('node-microphone.startRecording() returned undefined');
      }
      stream = result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit('error', this.wrapStartError(e));
      return;
    }

    stream.on('data', (chunk: Buffer) => this.handleChunk(chunk));

    mic.on('error', (err: Error) => {
      this.emit('error', this.wrapStartError(err));
    });
    mic.on('info', (info: Buffer) => {
      const text = info.toString().trim();
      if (text) logger.info('mic.info', { text });
    });
    mic.on('close', (code: number | null, signal: string | null) => {
      if (this.stopped) return;
      this.emit(
        'error',
        new Error(`microphone process exited unexpectedly (code=${code}, signal=${signal})`),
      );
    });
  }

  private wrapStartError(err: Error): Error {
    // 常见原因：sox/arecord 不存在
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Error(
        [
          '麦克风采集失败：未找到底层录音命令。请安装：',
          '  • macOS:  brew install sox',
          '  • Debian: sudo apt install sox    # 或 alsa-utils（提供 arecord）',
          '  • Windows: 下载 sox 并加入 PATH',
          `原始错误：${err.message}`,
        ].join('\n'),
      );
    }
    return err;
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= this.frameBytes) {
      const frame = this.buffer.subarray(0, this.frameBytes);
      this.buffer = this.buffer.subarray(this.frameBytes);
      this.emit('frame', Buffer.from(frame));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.mic) {
      try {
        this.mic.stopRecording();
      } catch {
        /* ignore */
      }
      this.mic = undefined;
    }
    this.buffer = Buffer.alloc(0);
  }
}

// ============================================================
// Speaker
// ============================================================

/** 播放一段音频缓冲（mp3/wav/pcm），返回 Promise，播放完成才 resolve */
export async function playAudioBuffer(
  audio: Buffer,
  codec: 'mp3' | 'wav' | 'pcm',
  options: { sampleRate?: number; channels?: number } = {},
): Promise<void> {
  const tpl = pickPlayer(codec);
  const ext = codec === 'pcm' ? 'raw' : codec;
  const tmpFile = path.join(tmpdir(), `home-voice-${randomUUID()}.${ext}`);
  await writeFile(tmpFile, audio);

  const args =
    codec === 'pcm' && tpl.pcmArgs
      ? tpl.pcmArgs(options.sampleRate ?? SAMPLE_RATE, options.channels ?? CHANNELS, tmpFile)
      : tpl.args(tmpFile);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(tpl.bin, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`player ${tpl.bin} exited with code ${code}`));
    });
  }).finally(async () => {
    try {
      await unlink(tmpFile);
    } catch {
      /* ignore */
    }
  });
}
