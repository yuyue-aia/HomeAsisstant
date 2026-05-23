import { randomUUID } from 'node:crypto';
import { tts } from 'tencentcloud-sdk-nodejs-tts';
import type { AppConfig } from '../config/env';
import { logger } from '../common/logger';

const TtsClient = tts.v20190823.Client;

export interface SynthesizeOptions {
  text: string;
  sessionId?: string;
  voiceType?: number;
  speed?: number;
  sampleRate?: number;
  codec?: 'mp3' | 'wav' | 'pcm';
}

export interface SynthesizeResult {
  audio: Buffer;
  codec: 'mp3' | 'wav' | 'pcm';
  sampleRate: number;
  sessionId: string;
}

export class TencentTtsClient {
  private readonly config: AppConfig;
  private readonly client: InstanceType<typeof TtsClient>;

  constructor(config: AppConfig) {
    if (!config.tencentSecretId || !config.tencentSecretKey) {
      throw new Error('Tencent Cloud credentials are required for TTS');
    }
    this.config = config;
    this.client = new TtsClient({
      credential: {
        secretId: config.tencentSecretId,
        secretKey: config.tencentSecretKey,
      },
      region: config.ttsRegion,
      profile: {
        httpProfile: {
          endpoint: 'tts.tencentcloudapi.com',
          reqTimeout: 30,
        },
      },
    });
  }

  /**
   * 把短文本合成为音频。注意 TextToVoice 单次最多 150 个汉字。
   */
  async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
    const sessionId = options.sessionId ?? randomUUID();
    const codec = options.codec ?? this.config.ttsCodec;
    const sampleRate = options.sampleRate ?? this.config.ttsSampleRate;
    const voiceType = options.voiceType ?? this.config.ttsVoiceType;
    const speed = options.speed ?? this.config.ttsSpeed;

    logger.info('tts.synthesize.start', {
      sessionId,
      voiceType,
      sampleRate,
      codec,
      length: options.text.length,
    });

    const response = await this.client.TextToVoice({
      Text: options.text,
      SessionId: sessionId,
      VoiceType: voiceType,
      Codec: codec,
      SampleRate: sampleRate,
      Speed: speed,
    });

    if (!response.Audio) {
      throw new Error('TTS response missing Audio');
    }

    const audio = Buffer.from(response.Audio, 'base64');

    logger.info('tts.synthesize.end', {
      sessionId,
      audioBytes: audio.byteLength,
    });

    return { audio, codec, sampleRate, sessionId };
  }

  /**
   * 把长文本按标点切句后逐段合成。
   */
  async synthesizeLongText(
    text: string,
    options: Omit<SynthesizeOptions, 'text'> = {},
  ): Promise<SynthesizeResult[]> {
    const segments = splitForTts(text);
    const results: SynthesizeResult[] = [];
    for (const segment of segments) {
      const result = await this.synthesize({ ...options, text: segment });
      results.push(result);
    }
    return results;
  }
}

/**
 * 简单按标点分句。单段最多 120 个字符，避免超过 TTS 限制。
 */
export function splitForTts(text: string, maxLen = 120): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const segments: string[] = [];
  const punctuation = /[。！？!?；;\n]/;
  const speakableText = /[A-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/;
  const pushSegment = (value: string) => {
    const segment = value.trim();
    if (segment && speakableText.test(segment)) {
      segments.push(segment);
    }
  };

  let buffer = '';
  for (const ch of normalized) {
    buffer += ch;
    if (punctuation.test(ch) && buffer.length >= 8) {
      pushSegment(buffer);
      buffer = '';
    } else if (buffer.length >= maxLen) {
      pushSegment(buffer);
      buffer = '';
    }
  }
  pushSegment(buffer);
  return segments;
}

/**
 * 流式句子切分器：
 * - 上层把 LLM 流式 token 通过 push() 持续喂入；
 * - 命中标点（。！？; ，:）或长度超阈值就立刻切出一句；
 * - end() 把残余 buffer 也作为最后一句吐出。
 *
 * 设计要点：
 * 1. **首句更激进**：第一句允许更短（>= MIN_FIRST_LEN）就切出来，让用户尽快听到声音；
 * 2. 后续句要求 >= MIN_LEN，避免"嗯""好"这种碎片化片段单独 TTS；
 * 3. 强分（buffer 超 maxLen）兜底，防止 LLM 一段话不带标点。
 *
 * 中文对话里的逗号（，,）也算切分点，因为口语化回答常用逗号代替句号。
 */
export interface StreamingSentenceSplitterOptions {
  /** 强切阈值，buffer 超过此长度即使没标点也切，默认 80 */
  maxLen?: number;
  /** 第一句最小长度（含标点），默认 6 */
  minFirstLen?: number;
  /** 后续句最小长度（含标点），默认 10 */
  minLen?: number;
}

export class StreamingSentenceSplitter {
  private buffer = '';
  private readonly maxLen: number;
  private readonly minFirstLen: number;
  private readonly minLen: number;
  private firstEmitted = false;
  /** 切分用的标点：句末优先级最高，逗号次之 */
  private static readonly STRONG = /[。！？!?；;\n]/;
  private static readonly WEAK = /[，,：:]/;
  private static readonly SPEAKABLE = /[A-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/;

  constructor(opts: StreamingSentenceSplitterOptions = {}) {
    this.maxLen = opts.maxLen ?? 80;
    this.minFirstLen = opts.minFirstLen ?? 3;
    this.minLen = opts.minLen ?? 10;
  }

  /** 喂入新增的 token，返回本次新切出的完整句子（可能 0~N 句） */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;

    const out: string[] = [];
    while (true) {
      const cut = this.findCutPoint();
      if (cut < 0) break;
      const chunk = this.buffer.slice(0, cut + 1);
      this.buffer = this.buffer.slice(cut + 1);
      const trimmed = chunk.trim();
      if (trimmed && StreamingSentenceSplitter.SPEAKABLE.test(trimmed)) {
        out.push(trimmed);
        this.firstEmitted = true;
      }
    }
    return out;
  }

  /** 流结束时调用，把剩余 buffer 作为最后一句吐出（如果可发音） */
  end(): string[] {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (trimmed && StreamingSentenceSplitter.SPEAKABLE.test(trimmed)) {
      return [trimmed];
    }
    return [];
  }

  /**
   * 在 buffer 中找一个合适的切分位置：
   * - 首句策略激进：强/弱标点都接受，让首字延迟尽量短
   * - 后续句优先强标点（句末），找不到再找弱标点（逗号）兜底
   * - 长度过阈值（maxLen）时硬切
   * 返回切分位置（包含该字符），找不到返回 -1。
   */
  private findCutPoint(): number {
    const buf = this.buffer;
    const isFirst = !this.firstEmitted;
    const minLen = isFirst ? this.minFirstLen : this.minLen;

    // 1) 首句：任何标点（强/弱）都切，越快越好
    if (isFirst) {
      for (let i = 0; i < buf.length; i += 1) {
        if (
          (StreamingSentenceSplitter.STRONG.test(buf[i]) ||
            StreamingSentenceSplitter.WEAK.test(buf[i])) &&
          i + 1 >= minLen
        ) {
          return i;
        }
      }
    } else {
      // 2) 非首句：先找强标点
      for (let i = 0; i < buf.length; i += 1) {
        if (StreamingSentenceSplitter.STRONG.test(buf[i]) && i + 1 >= minLen) {
          return i;
        }
      }
    }

    // 3) buffer 超长：找最近的弱标点，没有就硬切
    if (buf.length >= this.maxLen) {
      for (let i = Math.min(buf.length - 1, this.maxLen - 1); i >= minLen - 1; i -= 1) {
        if (StreamingSentenceSplitter.WEAK.test(buf[i])) {
          return i;
        }
      }
      return this.maxLen - 1;
    }

    return -1;
  }
}
