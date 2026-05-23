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
import { executeWebSearch, webSearchTool } from './tools/web-search.tool';
import { readFileTool, writeFileTool } from './tools/file-system.tool';
import type { RunVoiceAgentInput, RunVoiceAgentOutput, VoiceAgentContext } from './types';

const DEFAULT_INSTRUCTIONS = `
你是家庭智能语音助手。
回答要简短、自然，适合语音播报。
如果用户只是聊天或询问信息，直接简洁回答。
只要用户明确说"联网/搜索/查一下/实时/最新/天气/新闻"等需要外部实时信息的意图，必须先调用 web_search，再基于搜索结果回答；不要直接声称无法联网。
如果用户输入里已经带有"系统已执行 web_search"的搜索结果，直接基于这些结果回答，不要重复搜索，除非结果明显不足。
如果需要读取或写入工作区文件，调用 read_file/write_file。
如果用户要求控制设备，优先调用工具，不要编造执行结果。
对家里 Gosund/小米插线板（总开关、s1~s4、USB）的开/关/查询，调用 control_gosund_plug。
注意：s1 插孔已专门用于 Switch 游戏机，不要用 control_gosund_plug 直接开关 s1，统一走 control_game_console。
对各房间空调（客厅/主卧/奶奶房间/余跃房间/余晓房间）的开/关/查询，调用 control_air_conditioner。
对小朋友（余晓 yuxiao / 余跃 yuyue）玩 Switch 游戏机的需求，调用 control_game_console：
- 听到"我想玩游戏""打开游戏机"时：先 action="status" 查询当前配额与是否有人在玩；
- 启动需要明确的 child 与 minutes，缺一个就追问"是余晓还是余跃""你想玩多久"；
- 主动停止用 action="stop_game"；
- 工具返回的 message 字段已是面向小朋友的措辞，可直接播报；不要编造剩余时间；
- 工具返回 reason=not_weekend / no_quota / session_in_progress 时，态度温和、说明原因，不要责备。
高风险操作必须二次确认。
`.trim();

const ONLINE_INTENT_PATTERN = /(联网|搜索|搜一下|搜一搜|查一下|查查|实时|最新|天气|新闻)/;

function stripSearchIntent(text: string): string {
  return text
    .replace(/联网搜索/g, '')
    .replace(/联网查一下/g, '')
    .replace(/搜索一下/g, '')
    .replace(/搜一下/g, '')
    .replace(/查一下/g, '')
    .replace(/[。！？!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || text.trim();
}

function formatWebSearchContext(search: Awaited<ReturnType<typeof executeWebSearch>>): string {
  if (!search.results.length) {
    return `系统已执行 web_search。查询：${search.query}\n结果：${search.message ?? '无结果'}`;
  }

  const results = search.results
    .slice(0, 5)
    .map((item, index) => {
      const snippet = item.snippet.length > 240 ? `${item.snippet.slice(0, 240)}…` : item.snippet;
      return `${index + 1}. ${item.title}\n   URL: ${item.url}\n   摘要: ${snippet}`;
    })
    .join('\n');

  return `系统已执行 web_search。查询：${search.query}\n搜索服务：${search.provider}\n结果：\n${results}`;
}

async function attachForcedWebSearchIfNeeded(userText: string): Promise<string> {
  if (!ONLINE_INTENT_PATTERN.test(userText)) return userText;

  const query = stripSearchIntent(userText);
  const search = await executeWebSearch({ query, maxResults: 5 });
  return `${userText}\n\n${formatWebSearchContext(search)}\n\n请基于以上联网搜索结果，用简短自然的中文回答。`;
}

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

    const agentInput = await attachForcedWebSearchIfNeeded(input.text);
    const turnInput: AgentInputItem[] = [
      ...this.history,
      { role: 'user', content: agentInput },
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
    logger.info('agent.runStream.start', {
      sessionId: input.sessionId,
      textLength: input.text.length,
      model: this.config.openaiAgentModel,
      historyBefore: this.history.length,
    });

    const agentInput = await attachForcedWebSearchIfNeeded(input.text);
    const turnInput: AgentInputItem[] = [
      ...this.history,
      { role: 'user', content: agentInput },
    ];

    const stream = await this.runner.run(this.agent, turnInput, {
      context: this.buildContext(input),
      maxTurns: 500,
      stream: true,
    });

    let collected = '';
    let deltaCount = 0;
    try {
      for await (const event of stream) {
        if (
          event.type === 'raw_model_stream_event' &&
          (event.data as { type?: string }).type === 'output_text_delta'
        ) {
          const delta = (event.data as { delta?: string }).delta ?? '';
          if (delta) {
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
   * 串行化持久化：用 historyWriteChain 保证多次 run 的写入按顺序落盘，
   * 避免后一次写入被前一次覆盖。写入采用 tmp + rename 原子替换。
   */
  private scheduleHistoryFlush(): void {
    const snapshot = this.history;
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
