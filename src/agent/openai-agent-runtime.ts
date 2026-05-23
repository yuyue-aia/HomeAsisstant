import { Agent, OpenAIProvider, Runner, setOpenAIAPI, setTracingDisabled } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../config/env';
import { logger } from '../common/logger';
import { controlDeviceTool } from './tools/home-assistant.tool';
import { controlGosundPlugTool } from './tools/gosund-plug.tool';
import { controlAirConditionerTool } from './tools/air-conditioner.tool';
import { controlGameConsoleTool } from './tools/game-console.tool';
import { getCurrentTimeTool } from './tools/get-current-time.tool';
import { webSearchTool } from './tools/web-search.tool';
import { readFileTool, writeFileTool } from './tools/file-system.tool';
import type { RunVoiceAgentInput, RunVoiceAgentOutput, VoiceAgentContext } from './types';

const DEFAULT_INSTRUCTIONS = `
你是家里的语音助手"小语"。所有回答都会被 TTS 朗读。

【输出格式】
- 一律纯文本中文，不要 Markdown、列表符号、表格、代码块、URL、emoji。
- 一句到三句话讲完，越短越好；不要复述用户的问题。
- 数字按中文说法念（"二十三度"而非"23°C"）。

【工具使用】
- 凡是控制设备、查询设备状态、查时间、读写文件、联网搜索，一律调工具，不要凭印象回答。
- web_search 可以用来进行联网搜索。
- 高风险动作（关总闸、批量关空调、删除文件等）先用一句话向用户确认再执行。

【设备分工】
- Gosund/小米插线板（总开关、s2~s4、USB）→ control_gosund_plug
- 各房间空调（客厅/主卧/奶奶房间/余跃房间/余晓房间）→ control_air_conditioner
- 小朋友玩 Switch（s1 插孔，不要走 control_gosund_plug）→ control_game_console
  · 听到"想玩游戏/打开游戏机"先 action="status"；
  · 启动需要 child 与 minutes，缺哪个问哪个；主动停止用 action="stop_game"；
  · 工具返回的 message 已是面向小朋友的措辞，可直接播报，不要编造剩余时间；
  · 不论是谁，只能使用余跃/余晓的游戏时间，才能开启游戏机；
  · 工具返回 not_weekend / no_quota / session_in_progress 时，温和说明原因，不责备。
`.trim();

export class OpenAIAgentRuntime {
  private readonly config: AppConfig;
  private readonly agent: Agent<VoiceAgentContext>;
  private readonly runner: Runner;
  /**
   * 永久会话历史（多轮上下文）。
   * - 内存里以 result.history 为准（含 system / user / assistant / tool_call / tool_result）；
   * - 每轮 run 完成后异步写入 historyFile，进程重启后从该文件恢复；
   * - 通过 OPENAI_AGENT_HISTORY_MAX 控制条数上限，避免文件无限增长。
   */
  private history: AgentInputItem[] = [];
  private readonly historyFile: string;
  private readonly historyMaxItems: number;
  private historyWriteChain: Promise<void> = Promise.resolve();

  constructor(config: AppConfig = loadConfig()) {
    this.config = config;
    this.historyFile = resolve(
      process.env.OPENAI_AGENT_HISTORY_FILE || '.runtime/agent-history.json',
    );
    this.historyMaxItems = Math.max(
      0,
      Number(process.env.OPENAI_AGENT_HISTORY_MAX) || 200,
    );
    this.history = this.loadHistoryFromDisk();

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
      tools: [
        controlDeviceTool,
        controlGosundPlugTool,
        controlAirConditionerTool,
        controlGameConsoleTool,
        getCurrentTimeTool,
        webSearchTool,
        readFileTool,
        writeFileTool,
      ],
    });
  }

  async run(input: RunVoiceAgentInput): Promise<RunVoiceAgentOutput> {
    logger.info('agent.run.start', {
      sessionId: input.sessionId,
      textLength: input.text.length,
      model: this.config.openaiAgentModel,
      baseUrl: this.config.openaiBaseUrl,
      historyBefore: this.history.length,
    });

    const turnInput: AgentInputItem[] = [
      ...this.history,
      { role: 'user', content: input.text },
    ];

    const result = await this.runner.run(this.agent, turnInput, {
      context: this.buildContext(input),
      maxTurns: 500,
    });

    this.commitHistory(turnInput, result.history ?? []);
    const text = String(result.finalOutput ?? '').trim();

    logger.info('agent.run.end', {
      sessionId: input.sessionId,
      outputLength: text.length,
      historyItems: this.history.length,
    });

    return { text };
  }

  /**
   * 流式运行：边生成边把 token 增量通过 onTextDelta 抛给上层，
   * 让上层可以做"句级 TTS pipeline"（首字延迟从等整段降到等首句）。
   *
   * 注意：onTextDelta 收到的是 LLM 直接吐出的 final assistant text 增量；
   * tool_call 阶段的中间 token 不会进来（SDK 只在最终回答时发 output_text_delta）。
   */
  async runStream(
    input: RunVoiceAgentInput,
    onTextDelta: (delta: string) => void,
  ): Promise<RunVoiceAgentOutput> {
    const startedAt = Date.now();
    logger.info('agent.runStream.start', {
      sessionId: input.sessionId,
      textLength: input.text.length,
      model: this.config.openaiAgentModel,
      historyBefore: this.history.length,
    });

    const turnInput: AgentInputItem[] = [
      ...this.history,
      { role: 'user', content: input.text },
    ];

    const stream = await this.runner.run(this.agent, turnInput, {
      context: this.buildContext(input),
      maxTurns: 500,
      stream: true,
    });

    let collected = '';
    let deltaCount = 0;
    let firstDeltaAt = 0;
    try {
      for await (const event of stream) {
        if (
          event.type === 'raw_model_stream_event' &&
          (event.data as { type?: string }).type === 'output_text_delta'
        ) {
          const delta = (event.data as { delta?: string }).delta ?? '';
          if (delta) {
            if (!firstDeltaAt) firstDeltaAt = Date.now();
            collected += delta;
            deltaCount += 1;
            try {
              onTextDelta(delta);
            } catch (error) {
              logger.warn('agent.runStream.delta_callback_failed', {
                error: (error as Error).message,
              });
            }
          }
        }
      }
      // 等流彻底结束（包括 tool 调用、history 收敛等）
      await stream.completed;
    } catch (error) {
      logger.error('agent.runStream.error', {
        sessionId: input.sessionId,
        error: (error as Error).message,
      });
      throw error;
    }

    this.commitHistory(turnInput, stream.history ?? []);

    // finalOutput 比 collected 更可靠（含 SDK 内部清洗），优先使用
    const finalText = String(stream.finalOutput ?? collected ?? '').trim();

    logger.info('agent.runStream.end', {
      sessionId: input.sessionId,
      outputLength: finalText.length,
      deltaCount,
      firstDeltaMs: firstDeltaAt ? firstDeltaAt - startedAt : -1,
      historyItems: this.history.length,
    });

    return { text: finalText };
  }

  private buildContext(input: RunVoiceAgentInput): VoiceAgentContext {
    return {
      sessionId: input.sessionId,
      userId: input.userId,
      homeAssistant: {
        baseUrl: this.config.homeAssistantBaseUrl,
        token: this.config.homeAssistantToken,
      },
    };
  }

  private commitHistory(turnInput: AgentInputItem[], sdkHistory: AgentInputItem[]): void {
    // SDK 的 result.history = input + newItems。
    // chat_completions 模式 + 部分第三方网关下，SDK 仅返回本轮 newItems（不带 input），
    // 这里兜底拼接，保证多轮上下文不丢。
    if (sdkHistory.length >= turnInput.length) {
      this.history = sdkHistory;
    } else {
      this.history = [...turnInput, ...sdkHistory];
    }

    if (this.historyMaxItems > 0 && this.history.length > this.historyMaxItems) {
      this.history = this.history.slice(this.history.length - this.historyMaxItems);
    }

    this.scheduleHistoryFlush();
  }

  /** 返回当前累计的会话历史条数，便于上层观测/排查。 */
  getHistoryLength(): number {
    return this.history.length;
  }

  /** 仅在确有需要时手动清空历史（同时删除磁盘文件内容）。 */
  resetHistory(): void {
    this.history = [];
    this.scheduleHistoryFlush();
  }

  // ------------------------------------------------------------
  //                       persistence
  // ------------------------------------------------------------

  private loadHistoryFromDisk(): AgentInputItem[] {
    try {
      if (!existsSync(this.historyFile)) return [];
      const raw = readFileSync(this.historyFile, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      logger.info('agent.history.loaded', {
        file: this.historyFile,
        items: parsed.length,
      });
      return parsed as AgentInputItem[];
    } catch (error) {
      logger.warn('agent.history.load_failed', {
        file: this.historyFile,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * 落盘前过滤：只保留 system / user / assistant 的文本消息，
   * 剥掉 function_call / function_call_output（tool 调用与结果）。
   *
   * 原因：
   * 1. 历史按条数截断时，可能把 tool_call 与 tool_result 切散，重启后喂回 LLM 会 400；
   * 2. 第三方网关对 tool 历史格式宽容度不一；
   * 3. 工具调用结果（如 web_search 5 条）token 占用大，留着会持续放大上下文成本。
   *
   * 代价：进程重启后 LLM 不知道之前调过哪些工具，强连续场景（如刚启动的定时器）
   * 会失忆。可接受，因为多数家庭语音对话是独立轮次。
   */
  private filterHistoryForDisk(items: AgentInputItem[]): AgentInputItem[] {
    return items.filter((item) => {
      const role = (item as { role?: string }).role;
      return role === 'system' || role === 'user' || role === 'assistant';
    });
  }

  /**
   * 串行化持久化：用 historyWriteChain 保证多次 run 的写入按顺序落盘，
   * 避免后一次写入被前一次覆盖。写入采用 tmp + rename 原子替换。
   */
  private scheduleHistoryFlush(): void {
    const snapshot = this.filterHistoryForDisk(this.history);
    this.historyWriteChain = this.historyWriteChain
      .catch(() => undefined)
      .then(async () => {
        try {
          const dir = dirname(this.historyFile);
          mkdirSync(dir, { recursive: true });
          const tmp = `${this.historyFile}.tmp`;
          writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
          renameSync(tmp, this.historyFile);
        } catch (error) {
          logger.warn('agent.history.save_failed', {
            file: this.historyFile,
            error: (error as Error).message,
          });
        }
      });
  }
}

export async function runVoiceAgent(input: RunVoiceAgentInput): Promise<string> {
  const runtime = new OpenAIAgentRuntime();
  const output = await runtime.run(input);
  return output.text;
}
