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
