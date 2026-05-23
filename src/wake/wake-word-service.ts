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

  constructor(options: WakeWordServiceOptions) {
    super();
    this.config = options.config;
    this.cooldownMs = options.cooldownMs ?? 1500;

    const kwsConfig = this.buildSherpaConfig(!!options.debug);
    this.kws = new sherpaOnnx.KeywordSpotter(kwsConfig);
    this.stream = this.kws.createStream();

    logger.info('wake.ready', {
      modelDir: this.config.kwsModelDir,
      keywords: this.config.kwsKeywordsFile,
    });
  }

  /** 接受 16k 16bit PCM */
  acceptPcm16(pcm: Buffer): void {
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
        this.emit('wake', event);
        this.stream = this.kws.createStream();
        return;
      }
    }
  }

  /** 重置流，例如外部状态机切换状态时 */
  reset(): void {
    this.stream = this.kws.createStream();
    this.lastWakeAt = 0;
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
