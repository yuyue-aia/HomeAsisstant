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
    // ffmpeg 8 的 ffplay 移除了 -ac，改用 -ch_layout。
    pcmArgs: (rate, ch, f) => [
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-f',
      's16le',
      '-ar',
      String(rate),
      '-ch_layout',
      ch === 1 ? 'mono' : ch === 2 ? 'stereo' : `${ch}c`,
      f,
    ],
  },
  {
    bin: 'afplay',
    args: (f) => [f],
    supports: ['mp3', 'wav', 'pcm'],
    // afplay 不识别 raw PCM，写文件前由调用方把 PCM 包成 WAV，这里照 wav 文件名播放即可
    pcmArgs: (_rate, _ch, f) => [f],
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
// Local sound effects
// ============================================================

export function createToneWavBuffer(options: {
  frequency?: number;
  durationMs?: number;
  sampleRate?: number;
  volume?: number;
} = {}): Buffer {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const frequency = options.frequency ?? 880;
  const durationMs = options.durationMs ?? 180;
  const volume = options.volume ?? 0.25;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.min(Math.floor(sampleRate * 0.02), Math.floor(sampleCount / 2));
  for (let i = 0; i < sampleCount; i += 1) {
    const fadeIn = fadeSamples > 0 ? Math.min(1, i / fadeSamples) : 1;
    const fadeOut = fadeSamples > 0 ? Math.min(1, (sampleCount - i - 1) / fadeSamples) : 1;
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * volume * envelope;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buffer;
}

// ============================================================
// Speaker
// ============================================================

/** 把 16bit PCM 包成最小 WAV（44 字节头），让只支持 wav 的播放器（afplay）也能放 */
function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** 播放一段音频缓冲（mp3/wav/pcm），返回 Promise，播放完成才 resolve */
export async function playAudioBuffer(
  audio: Buffer,
  codec: 'mp3' | 'wav' | 'pcm',
  options: { sampleRate?: number; channels?: number } = {},
): Promise<void> {
  const tpl = pickPlayer(codec);
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? CHANNELS;

  // afplay 不支持 raw PCM：包成 WAV 文件再播
  const needWavWrap = codec === 'pcm' && tpl.bin === 'afplay';
  const ext = needWavWrap ? 'wav' : codec === 'pcm' ? 'raw' : codec;
  const tmpFile = path.join(tmpdir(), `home-voice-${randomUUID()}.${ext}`);
  const payload = needWavWrap ? wrapPcmAsWav(audio, sampleRate, channels) : audio;
  await writeFile(tmpFile, payload);

  const args =
    codec === 'pcm' && !needWavWrap && tpl.pcmArgs
      ? tpl.pcmArgs(sampleRate, channels, tmpFile)
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

// ============================================================
// 流式 PCM 播放器：起一个 ffplay/aplay 子进程，把 PCM 块往 stdin 喂。
// 用于流式 TTS 链路：ws 收到第一块 PCM 立刻播放，不等整段。
// ============================================================

interface StreamingPcmPlayerTemplate {
  bin: string;
  args: (rate: number, channels: number) => string[];
}

/** 优先 ffplay（pipe:0 读 raw pcm），其次 aplay（Linux/树莓派） */
const STREAMING_PCM_PLAYERS: StreamingPcmPlayerTemplate[] = [
  {
    bin: 'ffplay',
    // 注意：ffmpeg 8+ 的 ffplay 移除了 -ac，声道改用 -ch_layout（mono/stereo/...）。
    // 同时 ffplay 6/7/8 都支持 -ar；为保持向后兼容老版本，这里用 -ch_layout，
    // 老版本 ffplay 也支持该选项（5.x+ 已有）。
    args: (rate, ch) => [
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-f',
      's16le',
      '-ar',
      String(rate),
      '-ch_layout',
      ch === 1 ? 'mono' : ch === 2 ? 'stereo' : `${ch}c`,
      '-i',
      'pipe:0',
    ],
  },
  {
    bin: 'aplay',
    // aplay 默认从 stdin 读
    args: (rate, ch) => ['-q', '-f', 'S16_LE', '-r', String(rate), '-c', String(ch)],
  },
];

export interface StreamingPcmPlayer {
  /** 把一块 PCM 数据写入播放器（push 模式，不阻塞） */
  push(chunk: Buffer): void;
  /** 通知播放器没有更多数据了，等播放完毕（resolve）或失败（reject） */
  end(): Promise<void>;
  /** 立即终止（停说时） */
  abort(): void;
}

export function createStreamingPcmPlayer(opts: {
  sampleRate?: number;
  channels?: number;
} = {}): StreamingPcmPlayer {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const channels = opts.channels ?? CHANNELS;

  // 选播放器：优先 ffplay（最稳，跨平台），fallback aplay
  let tpl: StreamingPcmPlayerTemplate | null = null;
  for (const t of STREAMING_PCM_PLAYERS) {
    if (commandExists(t.bin)) {
      tpl = t;
      break;
    }
  }
  if (!tpl) {
    throw new Error(
      '流式 PCM 播放需要 ffplay（推荐）或 aplay。请安装 ffmpeg：brew install ffmpeg / apt install ffmpeg',
    );
  }

  const child = spawn(tpl.bin, tpl.args(sampleRate, channels), {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += d.toString('utf8');
  });

  let exitPromise = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`streaming player ${tpl!.bin} exit ${code}: ${stderr.trim()}`));
    });
  });

  let aborted = false;

  return {
    push(chunk: Buffer) {
      if (aborted) return;
      // stdin 写入失败说明子进程已退出，直接忽略——end()/abort() 会处理 promise
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) return;
      try {
        stdin.write(chunk);
      } catch {
        /* ignore */
      }
    },
    end() {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      return exitPromise;
    },
    abort() {
      aborted = true;
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // abort 后不再等子进程退出码（防止 reject）
      exitPromise = Promise.resolve();
    },
  };
}
