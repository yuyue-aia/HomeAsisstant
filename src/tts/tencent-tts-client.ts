import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
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

    // ModelType=1 表示使用大模型音色（含超自然 501xxx）。
    // 标准音色（1xxxxx）该字段忽略不影响，但 501xxx 必须带，否则报 InvalidParameterValue。
    const response = await this.client.TextToVoice({
      Text: options.text,
      SessionId: sessionId,
      VoiceType: voiceType,
      ModelType: 1,
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
   * 流式合成（WebSocket）：边合成边推 PCM 二进制块，比 REST 一次性接口首包延迟低 200~400ms。
   *
   * 注意事项：
   * 1. 强制 codec=pcm（mp3 流帧解码复杂，没必要）。上层用 PCM stdin 播放即可。
   * 2. AppId 是 SDK 接口里的 `region` 之外另一个字段——腾讯 TTS 私有协议要求整型，必须从 env 读。
   * 3. 一个 ws 连接对应一段文本（一次 SessionId）。final=1 后我们主动关闭。
   * 4. 单段文本 ≤ 600 汉字（远高于切句器 80 字阈值，足够用）。
   */
  synthesizeStream(options: SynthesizeOptions): TtsStreamingHandle {
    const codec: 'pcm' = 'pcm';
    const sampleRate = options.sampleRate ?? this.config.ttsSampleRate;
    const voiceType = options.voiceType ?? this.config.ttsVoiceType;
    const speed = options.speed ?? this.config.ttsSpeed;
    const sessionId = options.sessionId ?? randomUUID();

    if (!this.config.tencentAppId) {
      throw new Error('TTS streaming requires TENCENTCLOUD_APP_ID');
    }

    const url = this.buildStreamingUrl({
      appId: this.config.tencentAppId,
      secretId: this.config.tencentSecretId!,
      secretKey: this.config.tencentSecretKey!,
      sessionId,
      text: options.text,
      voiceType,
      sampleRate,
      codec,
      speed,
    });

    return new TtsStreamingHandle(url, {
      sessionId,
      sampleRate,
      codec,
      textLength: options.text.length,
    });
  }

  private buildStreamingUrl(params: {
    appId: string;
    secretId: string;
    secretKey: string;
    sessionId: string;
    text: string;
    voiceType: number;
    sampleRate: number;
    codec: 'pcm';
    speed: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    // 文档参数表里没列、但官方 Python SDK 默认会带的字段：
    //   - ModelType=1
    //   - EnableSubtitle=False（注意首字母大写）
    // 不带这两个会导致服务端 10003 鉴权失败。
    const fields: Record<string, string | number> = {
      Action: 'TextToStreamAudioWS',
      AppId: Number.parseInt(params.appId, 10),
      Codec: params.codec,
      EnableSubtitle: 'False',
      Expired: now + 24 * 60 * 60,
      ModelType: 1,
      SampleRate: params.sampleRate,
      SecretId: params.secretId,
      SessionId: params.sessionId,
      Speed: params.speed,
      Text: params.text,
      Timestamp: now,
      VoiceType: params.voiceType,
      Volume: 0,
    };

    const sortedKeys = Object.keys(fields).sort();
    const signSrc =
      'GETtts.cloud.tencent.com/stream_ws?' +
      sortedKeys.map((k) => `${k}=${fields[k]}`).join('&');
    const signature = createHmac('sha1', params.secretKey).update(signSrc).digest('base64');

    // 最终 URL 只对 Text 和 Signature 做 urlencode，其它参数（AppId/SecretId/数字等）保持原样。
    const finalQs = sortedKeys
      .map((k) => {
        const v = fields[k];
        if (k === 'Text') return `${k}=${encodeURIComponent(String(v))}`;
        return `${k}=${v}`;
      })
      .join('&');

    const url = `wss://tts.cloud.tencent.com/stream_ws?${finalQs}&Signature=${encodeURIComponent(signature)}`;
    return url;
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
    // 首句最小长度：避免 "哈哈，" / "好的，" 这种 3 字逗号片段独占一次 TTS 往返。
    // 8 字基本能保证首段是一个有信息量的短句。
    this.minFirstLen = opts.minFirstLen ?? 8;
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

    // 1) 首句：只切强标点（。！？；\n），避免逗号片段过短（如 "哈哈，"）；
    //    强标点找不到时，靠下面的 maxLen 兜底硬切，保证不会无限缓冲。
    if (isFirst) {
      for (let i = 0; i < buf.length; i += 1) {
        if (StreamingSentenceSplitter.STRONG.test(buf[i]) && i + 1 >= minLen) {
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

// ============================================================
// 流式合成 Handle：包装 WebSocket 生命周期 + 事件
// ============================================================

export interface TtsStreamingMeta {
  sessionId: string;
  sampleRate: number;
  codec: 'pcm';
  textLength: number;
}

/**
 * 一次流式合成的句柄。事件：
 *   - 'open'  : ws 握手成功（服务端返回 code:0），可以开始期待音频
 *   - 'audio' : (Buffer) 收到一块 PCM 数据
 *   - 'final' : 服务端 final=1，合成完毕
 *   - 'error' : 鉴权失败 / 网络断 / 服务端错误码
 *   - 'close' : ws 已关闭（无论正常/异常都会触发）
 *
 * 提供两种消费姿势：
 *   1. 事件订阅（适合管道到流式播放器）
 *   2. await handle.collect() —— 收齐返回完整 Buffer（兼容旧的 playAudioBuffer）
 */
export class TtsStreamingHandle extends EventEmitter {
  readonly meta: TtsStreamingMeta;
  private readonly ws: WebSocket;
  private opened = false;
  private finalized = false;
  private firstAudioAt = 0;
  private readonly startedAt = Date.now();

  constructor(url: string, meta: TtsStreamingMeta) {
    super();
    this.meta = meta;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('message', (data, isBinary) => this.handleMessage(data as Buffer, isBinary));
    this.ws.on('error', (err) => {
      logger.warn('tts.stream.ws_error', {
        sessionId: meta.sessionId,
        error: err.message,
      });
      this.emit('error', err);
    });
    this.ws.on('close', (code, reason) => {
      logger.info('tts.stream.ws_closed', {
        sessionId: meta.sessionId,
        code,
        reason: reason?.toString('utf8') ?? '',
        finalized: this.finalized,
        firstAudioMs: this.firstAudioAt ? this.firstAudioAt - this.startedAt : -1,
        totalMs: Date.now() - this.startedAt,
      });
      if (!this.finalized) {
        this.emit(
          'error',
          new Error(`TTS ws closed before final (code=${code} reason=${reason?.toString('utf8') ?? ''})`),
        );
      }
      this.emit('close');
    });
  }

  private handleMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (!this.firstAudioAt) {
        this.firstAudioAt = Date.now();
        logger.info('tts.stream.first_audio', {
          sessionId: this.meta.sessionId,
          firstAudioMs: this.firstAudioAt - this.startedAt,
        });
      }
      this.emit('audio', data);
      return;
    }

    let payload: { code?: number; message?: string; final?: number };
    try {
      payload = JSON.parse(data.toString('utf8'));
    } catch {
      logger.warn('tts.stream.bad_json', { raw: data.toString('utf8').slice(0, 200) });
      return;
    }

    if (payload.code !== undefined && payload.code !== 0) {
      this.emit(
        'error',
        new Error(`TTS streaming error code=${payload.code} msg=${payload.message ?? ''}`),
      );
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (!this.opened) {
      this.opened = true;
      this.emit('open');
    }

    if (payload.final === 1) {
      this.finalized = true;
      this.emit('final');
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** 中途取消（停说时调用） */
  cancel(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 把所有音频块拼成完整 Buffer 返回——兼容旧的「整段播放」路径。
   * 流式 + 一次性两套都能用。
   */
  collect(): Promise<{ audio: Buffer; meta: TtsStreamingMeta }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.on('audio', (b: Buffer) => chunks.push(b));
      this.once('final', () => resolve({ audio: Buffer.concat(chunks), meta: this.meta }));
      this.once('error', reject);
    });
  }
}
