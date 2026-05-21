import { Agent, OpenAIProvider, Runner, setOpenAIAPI, setTracingDisabled } from '@openai/agents';
import { loadConfig, type AppConfig } from '../config/env';
import { logger } from '../common/logger';
import { controlDeviceTool } from './tools/home-assistant.tool';
import { getCurrentTimeTool } from './tools/get-current-time.tool';
import type { RunVoiceAgentInput, RunVoiceAgentOutput, VoiceAgentContext } from './types';

const DEFAULT_INSTRUCTIONS = `
你是家庭智能语音助手。
回答要简短、自然，适合语音播报。
如果用户只是聊天或询问信息，直接简洁回答。
如果用户要求控制设备，优先调用工具，不要编造执行结果。
高风险操作必须二次确认。
`.trim();

export class OpenAIAgentRuntime {
  private readonly config: AppConfig;
  private readonly agent: Agent<VoiceAgentContext>;
  private readonly runner: Runner;

  constructor(config: AppConfig = loadConfig()) {
    this.config = config;

    // 兼容第三方 OpenAI 协议网关（例如腾讯 TokenHub / DeepSeek）：
    // 1. 使用 Chat Completions API（多数三方网关不支持 Responses API）
    // 2. 通过 OpenAIProvider 注入自定义 baseURL 与 apiKey
    if (config.openaiBaseUrl) {
      setOpenAIAPI('chat_completions');
      // 第三方网关无法上报 trace，全局关闭以避免无意义的 401 噪声
      setTracingDisabled(true);
    }

    const modelProvider = new OpenAIProvider({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      useResponses: !config.openaiBaseUrl, // 第三方网关默认走 chat completions
    });

    this.runner = new Runner({
      modelProvider,
      tracingDisabled: true, // 第三方网关不支持上传 trace
    });

    this.agent = new Agent<VoiceAgentContext>({
      name: 'Home Voice Assistant',
      model: config.openaiAgentModel,
      instructions: DEFAULT_INSTRUCTIONS,
      tools: [controlDeviceTool, getCurrentTimeTool],
    });
  }

  async run(input: RunVoiceAgentInput): Promise<RunVoiceAgentOutput> {
    logger.info('agent.run.start', {
      sessionId: input.sessionId,
      textLength: input.text.length,
      model: this.config.openaiAgentModel,
      baseUrl: this.config.openaiBaseUrl,
    });

    const result = await this.runner.run(this.agent, input.text, {
      context: {
        sessionId: input.sessionId,
        userId: input.userId,
        homeAssistant: {
          baseUrl: this.config.homeAssistantBaseUrl,
          token: this.config.homeAssistantToken,
        },
      },
      maxTurns: 6,
    });

    const text = String(result.finalOutput ?? '').trim();

    logger.info('agent.run.end', {
      sessionId: input.sessionId,
      outputLength: text.length,
    });

    return { text };
  }
}

export async function runVoiceAgent(input: RunVoiceAgentInput): Promise<string> {
  const runtime = new OpenAIAgentRuntime();
  const output = await runtime.run(input);
  return output.text;
}
