import {
  Agent,
  OpenAIProvider,
  Runner,
  setOpenAIAPI,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
} from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig, type AppConfig } from '../config/env';
import { logger } from '../common/logger';
import { controlDeviceTool } from './tools/home-assistant.tool';
import { controlGosundPlugTool } from './tools/gosund-plug.tool';
import { controlAirConditionerTool } from './tools/air-conditioner.tool';
import { controlGameConsoleTool } from './tools/game-console.tool';
import { getCurrentTimeTool } from './tools/get-current-time.tool';
import { webSearchTool } from './tools/web-search.tool';
import { readFileTool, writeFileTool } from './tools/file-system.tool';
import { manageReminderTool } from './tools/reminder.tool';
import { searchMusicTool, controlMusicPlayerTool } from './tools/music.tool';
import { createLoadSkillTool } from './tools/load-skill.tool';
import { discoverSkills, buildSkillsPromptSection } from './skills/skill-loader';
import {
  createLangfuseTracerFromEnv,
  type LangfuseTracingProcessor,
} from './tracing/langfuse-tracer';
import type { RunVoiceAgentInput, RunVoiceAgentOutput, VoiceAgentContext } from './types';

/**
 * 通用基线 instructions：
 * 只保留全局口播规范 + 工具使用底线。
 * 各领域（游戏/空调/提醒/...）的具体规则放到 skills/<name>/SKILL.md，
 * LLM 看到 buildSkillsPromptSection 注入的清单后，按需调 load_skill 加载。
 */
const BASE_INSTRUCTIONS = `
你是家里的语音助手"小鱼"。所有回答都会被 TTS 朗读。

【输出格式】
- 一律纯文本中文，不要 Markdown、列表符号、表格、代码块、URL、emoji。
- 一句到三句话讲完，越短越好；不要复述用户的问题。
- 数字按中文说法念（"二十三度"而非"23°C"）。

【工具使用】
- 凡是控制设备、查询设备状态、查时间、读写文件、联网搜索，一律调工具，不要凭印象回答。
- 高风险动作（关总闸、批量关空调、删除文件等）先用一句话向用户确认再执行。
`.trim();

export class OpenAIAgentRuntime {
  private readonly config: AppConfig;
  private readonly agent: Agent<VoiceAgentContext>;
  private readonly runner: Runner;
  /**
   * 永久会话历史（多轮上下文）。
   * - 内存里以 result.history 为准（含 system / user / assistant / tool_call / tool_result）；
   * - 每轮 run 完成后异步写入当天对应的 history 文件，进程重启后只从当天文件恢复；
   * - 历史按天分片存储（YYYY-MM-DD.json），加载时仅读当天分片，跨天自动失忆；
   * - 通过 OPENAI_AGENT_HISTORY_MAX 控制单日条数上限，避免文件无限增长。
   */
  private history: AgentInputItem[] = [];
  private readonly historyDir: string;
  private readonly historyMaxItems: number;
  private historyWriteChain: Promise<void> = Promise.resolve();
  private readonly langfuseTracer?: LangfuseTracingProcessor;
  /** 启动时一次性扫描的 skill 元数据列表（不含正文，正文按需 load_skill 加载）。 */
  private readonly skills: ReturnType<typeof discoverSkills>;
  /** 多个 Runtime 实例共享同一份全局 trace processor 注册，只设一次。 */
  private static langfuseRegistered = false;

  constructor(config: AppConfig = loadConfig()) {
    this.config = config;
    this.historyDir = resolve(
      process.env.OPENAI_AGENT_HISTORY_DIR || '.runtime/agent-history',
    );
    this.historyMaxItems = Math.max(
      0,
      Number(process.env.OPENAI_AGENT_HISTORY_MAX) || 20,
    );
    this.history = this.loadHistoryFromDisk();
    this.skills = discoverSkills();

    // 兼容第三方 OpenAI 协议网关（例如腾讯 TokenHub / DeepSeek）：
    // 1. 使用 Chat Completions API（多数三方网关不支持 Responses API）
    // 2. 通过 OpenAIProvider 注入自定义 baseURL 与 apiKey
    if (config.openaiBaseUrl) {
      setOpenAIAPI('chat_completions');
    }

    // Langfuse 接入：
    //  - 配置齐全 → 用 setTraceProcessors 替换默认 OpenAI exporter（避免它去
    //    上报到 platform.openai.com 引发 401），把 trace 通过 OTLP 发到 Langfuse；
    //  - 未配置 → 退回原行为（第三方网关下整体关闭 trace，避免无意义噪声）。
    this.langfuseTracer = createLangfuseTracerFromEnv();
    const tracingEnabled = !!this.langfuseTracer;
    if (this.langfuseTracer && !OpenAIAgentRuntime.langfuseRegistered) {
      setTraceProcessors([this.langfuseTracer]);
      setTracingDisabled(false);
      OpenAIAgentRuntime.langfuseRegistered = true;
      logger.info('agent.tracing.langfuse_enabled', {
        baseUrl: process.env.LANGFUSE_BASE_URL,
      });
    } else if (!this.langfuseTracer && config.openaiBaseUrl) {
      setTracingDisabled(true);
    }

    const modelProvider = new OpenAIProvider({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      useResponses: !config.openaiBaseUrl, // 第三方网关默认走 chat completions
    });

    this.runner = new Runner({
      modelProvider,
      tracingDisabled: !tracingEnabled,
    });

    this.agent = new Agent<VoiceAgentContext>({
      name: 'Home Voice Assistant',
      model: config.openaiAgentModel,
      instructions: this.buildInstructions(),
      tools: [
        controlDeviceTool,
        controlGosundPlugTool,
        controlAirConditionerTool,
        controlGameConsoleTool,
        manageReminderTool,
        searchMusicTool,
        controlMusicPlayerTool,
        getCurrentTimeTool,
        webSearchTool,
        readFileTool,
        writeFileTool,
        createLoadSkillTool(this.skills),
      ],
    });
  }

  /**
   * 拼装基线 instructions + 当前已发现的 skill 清单。
   * skill 清单只有 name+description（每个 skill 一行），LLM 看到后按需 load_skill。
   */
  private buildInstructions(): string {
    const section = buildSkillsPromptSection(this.skills);
    if (!section) return BASE_INSTRUCTIONS;
    return `${BASE_INSTRUCTIONS}\n\n${section}`;
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

    const result = await withTrace(
      'voice.turn',
      async () =>
        this.runner.run(this.agent, turnInput, {
          context: this.buildContext(input),
          maxTurns: 500,
        }),
      {
        groupId: input.sessionId,
        metadata: this.buildTraceMetadata(input),
      },
    );

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

    const stream = await withTrace(
      'voice.turn',
      async () =>
        this.runner.run(this.agent, turnInput, {
          context: this.buildContext(input),
          maxTurns: 500,
          stream: true,
        }),
      {
        groupId: input.sessionId,
        metadata: { ...this.buildTraceMetadata(input), streaming: true },
      },
    );

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

  /**
   * 拼装传入 withTrace 的 metadata。
   * 字段命名遵循 Langfuse OTel 约定，processor 会把它们映射成
   * langfuse.trace.input / langfuse.user.id / langfuse.session.id。
   */
  private buildTraceMetadata(input: RunVoiceAgentInput): Record<string, unknown> {
    return {
      input: input.text,
      session_id: input.sessionId,
      ...(input.userId ? { user_id: input.userId } : {}),
      model: this.config.openaiAgentModel,
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

  /**
   * 进程退出前调用：把 BatchSpanProcessor 队列里残留的 trace 立即上报。
   * 不调的话最后一两轮对话的 trace 可能丢失（队列还没到批量延迟就被 SIGTERM）。
   */
  async shutdown(): Promise<void> {
    if (!this.langfuseTracer) return;
    try {
      await this.langfuseTracer.forceFlush();
      await this.langfuseTracer.shutdown();
    } catch (error) {
      logger.warn('agent.tracing.shutdown_failed', {
        error: (error as Error).message,
      });
    }
  }

  // ------------------------------------------------------------
  //                       persistence
  // ------------------------------------------------------------

  /** 当天 history 分片文件路径，按本地时区算 YYYY-MM-DD。 */
  private getTodayHistoryFile(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return join(this.historyDir, `${y}-${m}-${d}.json`);
  }

  private loadHistoryFromDisk(): AgentInputItem[] {
    const file = this.getTodayHistoryFile();
    try {
      if (!existsSync(file)) {
        logger.info('agent.history.loaded', {
          file,
          items: 0,
          reason: 'no_today_file',
        });
        return [];
      }
      const raw = readFileSync(file, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // 启动时也按 historyMaxItems 截断，避免历史文件意外膨胀导致首轮上下文爆掉。
      const truncated =
        this.historyMaxItems > 0 && parsed.length > this.historyMaxItems
          ? parsed.slice(parsed.length - this.historyMaxItems)
          : parsed;
      logger.info('agent.history.loaded', {
        file,
        items: truncated.length,
        rawItems: parsed.length,
        truncated: truncated.length !== parsed.length,
      });
      return truncated as AgentInputItem[];
    } catch (error) {
      logger.warn('agent.history.load_failed', {
        file,
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
   *
   * 落盘到当天分片文件（YYYY-MM-DD.json），跨天后老文件保留在磁盘上不删除，
   * 但下次启动只读当天的——等价于"自动失忆"昨天的对话。
   */
  private scheduleHistoryFlush(): void {
    const snapshot = this.filterHistoryForDisk(this.history);
    const file = this.getTodayHistoryFile();
    this.historyWriteChain = this.historyWriteChain
      .catch(() => undefined)
      .then(async () => {
        try {
          mkdirSync(this.historyDir, { recursive: true });
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
          renameSync(tmp, file);
        } catch (error) {
          logger.warn('agent.history.save_failed', {
            file,
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
