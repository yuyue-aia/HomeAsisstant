import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from '../config/env';
import { logger } from '../common/logger';

// sherpa-onnx-node 没有 d.ts，按运行期 require 引入。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpaOnnx = require('sherpa-onnx-node');

export interface WakeEvent {
  keyword: string;
  at: number;
}

export interface WakeWordServiceOptions {
  config: AppConfig;
  /** 唤醒后多少毫秒内忽略重复触发，默认 1500ms */
  cooldownMs?: number;
  /** sherpa-onnx 调试日志开关 */
  debug?: boolean;
  /**
   * 麦克风诊断：每秒打印一次 RMS 音量（dBFS），并把最近 N 秒 PCM 滚动存成 wav。
   * 通过 env WAKE_DIAG=1 打开；存盘目录由 WAKE_DIAG_DIR 控制（默认 .runtime/wake-diag）。
   */
  diagnose?: boolean;
  diagnoseDir?: string;
  /** 滚动窗口秒数（默认 15s），过短不够听，过长占内存 */
  diagnoseWindowSec?: number;
}

const SAMPLE_RATE = 16000;

/**
 * 本地中文唤醒词服务，基于 sherpa-onnx KeywordSpotter。
 *
 * 使用方式：
 *   const wake = new WakeWordService({ config });
 *   wake.on('wake', e => ...);
 *   wake.acceptPcm16(buffer);  // 持续投喂 16k 16bit 单声道 PCM
 */
export class WakeWordService extends EventEmitter {
  private readonly config: AppConfig;
  private readonly cooldownMs: number;
  private readonly kws: any;
  private stream: any;
  private lastWakeAt = 0;

  // ===== 诊断字段 =====
  private readonly diagnose: boolean;
  private readonly diagnoseDir: string;
  private readonly diagnoseWindowBytes: number;
  /** 滚动窗口里的 16bit PCM（小端） */
  private diagBuffer: Buffer = Buffer.alloc(0);
  /** 1 秒内累计的 RMS 计算用：sum(x^2) 与样本数 */
  private diagSumSq = 0;
  private diagSampleCount = 0;
  private diagLastReportAt = 0;

  constructor(options: WakeWordServiceOptions) {
    super();
    this.config = options.config;
    this.cooldownMs = options.cooldownMs ?? 1500;

    const kwsConfig = this.buildSherpaConfig(!!options.debug);
    this.kws = new sherpaOnnx.KeywordSpotter(kwsConfig);
    this.stream = this.kws.createStream();
    this.primeStream();

    const diagEnv = (process.env.WAKE_DIAG ?? '').toLowerCase();
    this.diagnose = options.diagnose ?? (diagEnv === '1' || diagEnv === 'true');
    this.diagnoseDir = path.resolve(
      options.diagnoseDir ?? process.env.WAKE_DIAG_DIR ?? '.runtime/wake-diag',
    );
    const windowSec = options.diagnoseWindowSec
      ?? Number.parseInt(process.env.WAKE_DIAG_WINDOW_SEC ?? '15', 10);
    this.diagnoseWindowBytes = Math.max(3, windowSec) * SAMPLE_RATE * 2; // 16bit mono

    if (this.diagnose) {
      try {
        fs.mkdirSync(this.diagnoseDir, { recursive: true });
      } catch (err) {
        logger.warn('wake.diag.mkdir_failed', { dir: this.diagnoseDir, error: (err as Error).message });
      }
      logger.info('wake.diag.enabled', {
        diagnoseDir: this.diagnoseDir,
        windowBytes: this.diagnoseWindowBytes,
        windowSec,
      });
    }

    logger.info('wake.ready', {
      modelDir: this.config.kwsModelDir,
      keywords: this.config.kwsKeywordsFile,
    });
  }

  /** 接受 16k 16bit PCM */
  acceptPcm16(pcm: Buffer): void {
    if (this.diagnose) this.feedDiagnose(pcm);
    const samples = pcm16ToFloat32(pcm);
    this.acceptSamples(samples);
  }

  /** 接受 16k float32 [-1,1] 采样 */
  acceptSamples(samples: Float32Array): void {
    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });

    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const keyword: string = this.kws.getResult(this.stream).keyword;
      const now = Date.now();
      if (keyword && now - this.lastWakeAt > this.cooldownMs) {
        this.lastWakeAt = now;
        const event: WakeEvent = { keyword, at: now };
        logger.info('wake.detected', { keyword });
        // 唤醒成功也存一份音频，方便对照训练
        if (this.diagnose) this.dumpRollingWav('detected');
        this.emit('wake', event);
        this.stream = this.kws.createStream();
        this.primeStream();
        return;
      }
    }
  }

  /** 重置流，例如外部状态机切换状态时 */
  reset(): void {
    this.stream = this.kws.createStream();
    this.primeStream();
    this.lastWakeAt = 0;
  }

  /**
   * 给新建的流喂一段低幅噪声做暖机：
   * 流式 zipformer KWS 是因果模型，需要积累上下文才能稳定打分。
   * 进程刚起来 / 唤醒后重建流时，上下文是空的，第一次喊唤醒词容易因为
   * 缓冲不够而漏检（远场更明显）。这里在创建流后立即喂 1.2s 极低幅高斯噪声
   * （-60dBFS 量级），让 zipformer 内部 cache 充满，避免"第一次唤不醒"。
   * 噪声而非纯静音，是为了避免某些特征前端对零向量做特殊处理。
   */
  private primeStream(): void {
    const durationSec = 1.2;
    const n = Math.floor(SAMPLE_RATE * durationSec);
    const samples = new Float32Array(n);
    // 简单的 LCG 伪随机，足够；幅度约 0.001 ≈ -60 dBFS
    let s = 0x12345678;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      samples[i] = ((s & 0xffff) / 0xffff - 0.5) * 0.002;
    }
    try {
      this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      // 把 prime 期间产生的"伪命中"全部消费掉（理论上不会有，但稳妥起见）
      while (this.kws.isReady(this.stream)) {
        this.kws.decode(this.stream);
        this.kws.getResult(this.stream);
      }
    } catch (err) {
      logger.warn('wake.prime_failed', { error: (err as Error).message });
    }
  }

  /**
   * 手动触发：把当前滚动窗口里的 PCM 落盘成 wav，并打印路径。
   * 用法：把 WakeWordService 暴露的 dumpDiag() 接到一个外部触发（如 SIGUSR2），
   * 或在没听到唤醒响应时手动调用。
   */
  dumpDiag(label = 'manual'): string | null {
    if (!this.diagnose) {
      logger.warn('wake.diag.disabled');
      return null;
    }
    return this.dumpRollingWav(label);
  }

  /** 读取当前 keywords 文件中所有显示名（@xxx），用于提示语 */
  getDisplayKeywords(): string[] {
    return readKeywordDisplays(path.resolve(this.config.kwsKeywordsFile));
  }

  /** 主唤醒词的显示名（取第一条），找不到时回退到给定值 */
  getPrimaryDisplay(fallback = '唤醒词'): string {
    const list = this.getDisplayKeywords();
    return list[0] || fallback;
  }

  // ============================================================
  // 诊断：滚动窗口 + RMS（dBFS）+ wav 存盘
  // ============================================================

  private feedDiagnose(pcm: Buffer): void {
    // 1) 滚动窗口（保留最近 N 秒）
    this.diagBuffer = this.diagBuffer.length === 0
      ? Buffer.from(pcm)
      : Buffer.concat([this.diagBuffer, pcm]);
    if (this.diagBuffer.length > this.diagnoseWindowBytes) {
      this.diagBuffer = this.diagBuffer.subarray(this.diagBuffer.length - this.diagnoseWindowBytes);
    }

    // 2) 累计 RMS
    const samples = pcm.length >> 1;
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const s = pcm.readInt16LE(i) / 32768;
      sumSq += s * s;
    }
    this.diagSumSq += sumSq;
    this.diagSampleCount += samples;

    // 3) 每 ~1s 打印一次音量
    const now = Date.now();
    if (this.diagLastReportAt === 0) this.diagLastReportAt = now;
    if (now - this.diagLastReportAt >= 1000 && this.diagSampleCount > 0) {
      const rms = Math.sqrt(this.diagSumSq / this.diagSampleCount);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
      // 直观可视化：12 格音量条
      const level = Math.max(0, Math.min(12, Math.round((dbfs + 60) / 5)));
      const bar = '█'.repeat(level) + '░'.repeat(12 - level);
      logger.info('wake.diag.level', {
        dbfs: Number(dbfs.toFixed(1)),
        bar,
        hint: dbfs < -55 ? 'silent_or_far' : dbfs < -35 ? 'normal_room' : 'loud',
      });
      this.diagSumSq = 0;
      this.diagSampleCount = 0;
      this.diagLastReportAt = now;
    }
  }

  /** 把当前滚动窗口落盘为 wav，返回路径 */
  private dumpRollingWav(label: string): string | null {
    if (this.diagBuffer.length === 0) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.diagnoseDir, `wake-${label}-${ts}.wav`);
    try {
      fs.mkdirSync(this.diagnoseDir, { recursive: true });
      fs.writeFileSync(file, buildWavFile(this.diagBuffer, SAMPLE_RATE, 1, 16));
      logger.info('wake.diag.dumped', { file, bytes: this.diagBuffer.length });
      return file;
    } catch (err) {
      logger.warn('wake.diag.dump_failed', { file, error: (err as Error).message });
      return null;
    }
  }

  private buildSherpaConfig(debug: boolean) {
    const modelDir = path.resolve(this.config.kwsModelDir);
    const config = {
      featConfig: {
        sampleRate: SAMPLE_RATE,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: path.join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          decoder: path.join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          joiner: path.join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
        },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: debug ? 1 : 0,
      },
      keywordsFile: path.resolve(this.config.kwsKeywordsFile),
    };

    mustExist(config.modelConfig.transducer.encoder, 'encoder');
    mustExist(config.modelConfig.transducer.decoder, 'decoder');
    mustExist(config.modelConfig.transducer.joiner, 'joiner');
    mustExist(config.modelConfig.tokens, 'tokens');
    mustExist(config.keywordsFile, 'keywords file');

    return config;
  }
}

function mustExist(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

export function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const samples = new Float32Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

/**
 * 解析 sherpa-onnx KWS keywords 文件中的显示名（@xxx）。
 *
 * 格式示例（每行一个 keyword）：
 *   c ài b āo c ài b āo :2.0 #0.45 @菜包菜包
 *
 * - 以 `@` 后的内容为展示名；
 * - 若没有 `@`，回退用整行（去掉 :boost / #threshold）作为名称。
 */
export function readKeywordDisplays(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const at = line.lastIndexOf('@');
        if (at >= 0) return line.slice(at + 1).trim();
        return line.replace(/\s*[:#].*$/, '').trim();
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 把 16bit PCM 拼成最简 WAV（RIFF）文件内容。
 * 仅供诊断使用，参数固定 mono/16bit。
 */
function buildWavFile(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
