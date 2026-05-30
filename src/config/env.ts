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
  /** 是否走 WebSocket 流式 TTS（需在腾讯云控制台单独开通"实时语音合成"服务） */
  ttsStreaming: boolean;

  kwsModelDir: string;
  kwsKeywordsFile: string;

  homeAssistantBaseUrl?: string;
  homeAssistantToken?: string;

  /**
   * Skill 加载模式：
   * - 'eager'（默认）：启动时把所有 SKILL.md 正文一次性内联进 system prompt，
   *   省掉 LLM 调用 load_skill 的额外往返，语音对话首字延迟更低；
   * - 'lazy'：保留 load_skill 工具，由 LLM 按需读取 SKILL.md。token 占用更少，
   *   但每次匹配 skill 多一轮 LLM 推理。
   */
  agentSkillsLoadMode: 'eager' | 'lazy';

  /**
   * 凌晨自动给游戏机充电（默认开启）：
   * - 每天 startHHmm 通电、endHHmm 断电，本地时区；
   * - 静默执行，凌晨不走 TTS 播报，只写结构化日志；
   * - 插板未配置 / 时间窗口与小孩游戏会话冲突 → 自动跳过当次；
   * - 设置 AUTO_CHARGE_ENABLED=0|false|off 可整体关闭。
   */
  autoChargeEnabled: boolean;
  autoChargeStartHHmm: string;
  autoChargeEndHHmm: string;
  autoChargeStateFile: string;
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

/**
 * 解析 "HH:mm" 字符串。错误格式直接抛 —— 走"配置错误快失败"风格，
 * 避免线上把 "25:00" / "aa:bb" 静默吞掉。
 */
function parseHHmm(name: string, raw: string): string {
  const m = raw.trim().match(/^([0-2]\d):([0-5]\d)$/);
  if (!m) {
    throw new Error(`Invalid ${name}="${raw}", expected HH:mm`);
  }
  const h = Number(m[1]);
  if (h > 23) throw new Error(`Invalid ${name}="${raw}", hour must be 00-23`);
  return `${m[1]}:${m[2]}`;
}

/**
 * 解析"开关"型环境变量：未设置 → 默认值；显式设 `0|false|off|no` → false；其他 → true。
 * 仅识别 false 关键字，避免拼错时误关键功能（与 AGENT_SKILLS_LOAD_MODE 同一思路）。
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '' ) return fallback;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return true;
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
    ttsStreaming: (process.env.TTS_STREAMING ?? '').toLowerCase() === 'true',

    kwsModelDir: strEnv(
      'KWS_MODEL_DIR',
      'models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
    ),
    kwsKeywordsFile: strEnv('KWS_KEYWORDS_FILE', 'models/kws/keywords-caibao.txt'),

    homeAssistantBaseUrl: process.env.HOME_ASSISTANT_BASE_URL,
    homeAssistantToken: process.env.HOME_ASSISTANT_TOKEN,

    // 仅认 'lazy' 显式开关；其他值（含未设置/拼错）一律按默认 eager 走，避免线上无声降级。
    agentSkillsLoadMode:
      (process.env.AGENT_SKILLS_LOAD_MODE ?? '').toLowerCase() === 'lazy' ? 'lazy' : 'eager',

    autoChargeEnabled: boolEnv('AUTO_CHARGE_ENABLED', true),
    autoChargeStartHHmm: parseHHmm(
      'AUTO_CHARGE_START',
      strEnv('AUTO_CHARGE_START', '03:00'),
    ),
    autoChargeEndHHmm: parseHHmm(
      'AUTO_CHARGE_END',
      strEnv('AUTO_CHARGE_END', '05:00'),
    ),
    autoChargeStateFile: strEnv(
      'AUTO_CHARGE_STATE_FILE',
      '.runtime/auto-charge-state.json',
    ),
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
