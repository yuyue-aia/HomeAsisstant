import 'dotenv/config';

export interface AppConfig {
  openaiApiKey?: string;
  openaiAgentModel: string;
  openaiBaseUrl?: string;

  tencentAppId?: string;
  tencentSecretId?: string;
  tencentSecretKey?: string;

  asrEngineModelType: string;

  ttsRegion: string;
  ttsVoiceType: number;
  ttsSampleRate: number;
  ttsCodec: 'mp3' | 'wav' | 'pcm';
  ttsSpeed: number;

  kwsModelDir: string;
  kwsKeywordsFile: string;

  homeAssistantBaseUrl?: string;
  homeAssistantToken?: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw : fallback;
}

export function loadConfig(): AppConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiAgentModel: strEnv('OPENAI_AGENT_MODEL', 'gpt-4.1'),
    openaiBaseUrl: process.env.OPENAI_BASE_URL,

    tencentAppId: process.env.TENCENTCLOUD_APP_ID,
    tencentSecretId: process.env.TENCENTCLOUD_SECRET_ID,
    tencentSecretKey: process.env.TENCENTCLOUD_SECRET_KEY,

    asrEngineModelType: strEnv('ASR_ENGINE_MODEL_TYPE', '16k_zh'),

    ttsRegion: strEnv('TTS_REGION', 'ap-beijing'),
    ttsVoiceType: intEnv('TTS_VOICE_TYPE', 101001),
    ttsSampleRate: intEnv('TTS_SAMPLE_RATE', 16000),
    ttsCodec: (strEnv('TTS_CODEC', 'mp3') as AppConfig['ttsCodec']),
    ttsSpeed: intEnv('TTS_SPEED', 0),

    kwsModelDir: strEnv(
      'KWS_MODEL_DIR',
      'models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
    ),
    kwsKeywordsFile: strEnv('KWS_KEYWORDS_FILE', 'models/kws/keywords-xiaoyu.txt'),

    homeAssistantBaseUrl: process.env.HOME_ASSISTANT_BASE_URL,
    homeAssistantToken: process.env.HOME_ASSISTANT_TOKEN,
  };
}

export function requireOpenAIConfig(config: AppConfig): void {
  if (!config.openaiApiKey) {
    throw new Error('Missing OPENAI_API_KEY. Please set it in .env or your shell environment.');
  }
}

export function requireTencentConfig(config: AppConfig): void {
  if (!config.tencentAppId) {
    throw new Error('Missing TENCENTCLOUD_APP_ID');
  }
  if (!config.tencentSecretId) {
    throw new Error('Missing TENCENTCLOUD_SECRET_ID');
  }
  if (!config.tencentSecretKey) {
    throw new Error('Missing TENCENTCLOUD_SECRET_KEY');
  }
}
