import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AppConfig } from '../config/env';
import { logger } from '../common/logger';

export interface AsrResult {
  voiceId: string;
  index: number;
  sliceType: 0 | 1 | 2;
  text: string;
  startTime: number;
  endTime: number;
}

export interface TencentAsrClientOptions {
  config: AppConfig;
  voiceId?: string;
}

interface AsrServerMessage {
  code: number;
  message: string;
  voice_id: string;
  message_id: string;
  final?: number;
  result?: {
    slice_type: 0 | 1 | 2;
    index: number;
    start_time: number;
    end_time: number;
    voice_text_str: string;
  };
}

/**
 * Tencent Cloud Realtime ASR WebSocket client.
 *
 * Events:
 *  - 'open'     ()                     连接已建立
 *  - 'partial'  (result: AsrResult)    slice_type=1 中间结果
 *  - 'final'    (result: AsrResult)    slice_type=2 一句话结束
 *  - 'end'      ()                     整个音频流识别结束
 *  - 'error'    (error: Error)
 *  - 'close'    (code, reason)
 */
export class TencentAsrClient extends EventEmitter {
  private readonly config: AppConfig;
  private readonly voiceId: string;
  private ws?: WebSocket;
  private connected = false;
  private endSent = false;

  constructor(options: TencentAsrClientOptions) {
    super();
    this.config = options.config;
    this.voiceId = options.voiceId ?? randomUUID();
  }

  getVoiceId(): string {
    return this.voiceId;
  }

  async connect(): Promise<void> {
    if (
      !this.config.tencentAppId ||
      !this.config.tencentSecretId ||
      !this.config.tencentSecretKey
    ) {
      throw new Error('Tencent Cloud credentials are required for ASR');
    }

    const url = this.buildWsUrl();
    this.ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onError = (error: Error) => {
        ws.removeListener('open', onOpen);
        reject(error);
      };
      const onOpen = () => {
        ws.removeListener('error', onError);
        this.connected = true;
        this.attachHandlers(ws);
        this.emit('open');
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || !this.connected || this.endSent) return;
    this.ws.send(pcm, { binary: true });
  }

  /**
   * 通知服务端音频上传完成，等待最终 final 消息后再断开。
   */
  end(): void {
    if (!this.ws || !this.connected || this.endSent) return;
    this.endSent = true;
    try {
      this.ws.send(JSON.stringify({ type: 'end' }));
    } catch (error) {
      logger.warn('asr.end.failed', { error: (error as Error).message });
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.connected = false;
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString('utf8');
      let payload: AsrServerMessage;
      try {
        payload = JSON.parse(text) as AsrServerMessage;
      } catch (error) {
        logger.warn('asr.message.parse_failed', { text });
        return;
      }

      if (payload.code !== 0) {
        const err = new Error(`ASR error ${payload.code}: ${payload.message}`);
        this.emit('error', err);
        return;
      }

      if (payload.result) {
        const result: AsrResult = {
          voiceId: payload.voice_id,
          index: payload.result.index,
          sliceType: payload.result.slice_type,
          text: payload.result.voice_text_str || '',
          startTime: payload.result.start_time,
          endTime: payload.result.end_time,
        };

        if (result.sliceType === 2) {
          this.emit('final', result);
        } else if (result.sliceType === 1) {
          this.emit('partial', result);
        }
      }

      if (payload.final === 1) {
        this.emit('end');
      }
    });

    ws.on('error', (error) => {
      this.emit('error', error);
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.emit('close', code, reason?.toString('utf8') ?? '');
    });
  }

  private buildWsUrl(): string {
    const appId = this.config.tencentAppId!;
    const secretId = this.config.tencentSecretId!;
    const secretKey = this.config.tencentSecretKey!;

    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = {
      engine_model_type: this.config.asrEngineModelType,
      expired: now + 24 * 60 * 60,
      needvad: 1,
      nonce: now,
      secretid: secretId,
      timestamp: now,
      voice_format: 1, // pcm
      voice_id: this.voiceId,
    };

    const queryString = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    const host = 'asr.cloud.tencent.com';
    const pathPrefix = `/asr/v2/${appId}`;
    const signOrigin = `${host}${pathPrefix}?${queryString}`;
    const signature = createHmac('sha1', secretKey).update(signOrigin).digest('base64');

    const url = `wss://${host}${pathPrefix}?${queryString}&signature=${encodeURIComponent(signature)}`;
    return url;
  }
}
