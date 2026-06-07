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
import {
  discoverSkills,
  loadAllSkillBodies,
  type SkillFull,
  type SkillMeta,
} from './skills/skill-loader';
import { buildSystemPrompt } from './system-prompt-builder';
import {
  createLangfuseTracerFromEnv,
  type LangfuseTracingProcessor,
} from './tracing/langfuse-tracer';
import type { RunVoiceAgentInput, RunVoiceAgentOutput, VoiceAgentContext } from './types';

/**
 * 通用基线 instructions 已迁出到 prompts/system.base.md；
 * 各领域规则在 skills/<name>/SKILL.md。
 *
 * 启动时按 config.agentSkillsLoadMode 决定 system prompt 的拼装方式：
 *  - eager：把所有 SKILL.md 正文直接拼进 system prompt，工具列表里不放 load_skill。
 *           少一轮 LLM round-trip，语音首字延迟低 1~2 秒。
 *  - lazy：仅注入 skill 清单（name + description），保留 load_skill 工具，
 *          由 LLM 按需调用读取正文。token 占用最少，但每次匹配 skill 多一轮推理。
 *
 * 不论哪种模式，最终 instructions 都是字节级稳定的（skill 排序固定、模板归一化），
 * 命中上游 prompt cache 后 prefill 几乎免费。
 */

export class OpenAIAgentRuntime {
  private readonly config: AppConfig;
  private readonly agent: Agent<VoiceAgentContext>;
  private readonly runner: Runner;
  /**
   * 永久会话历史（多轮上下文）。
   * - 内存里以 result.history 为准（含 system / user / assistant / tool_call / tool_result）；
   * - 每轮 run 完成后异步写入当天对应的 history 文件，进程重启后只从当天文件恢复；
   * - 历史按天分片存储（YYYY-MM-DD.json），加载时仅读当天分片，跨天自动失忆；
   * - 通过 OPENAI_AGENT_HISTORY_MAX 控制单日条数上限，避免文件无限增长；
   * - 通过 OPENAI_AGENT_HISTORY_MAX_AGE_MS 控制单条最大年龄（默认 1 小时），
   *   加载时过滤过期条目，避免重启后把几小时前的旧对话当上下文。
   *
   * 落盘格式（新）：[{ ts: number, item: AgentInputItem }, ...]
   * 兼容旧格式：[AgentInputItem, ...]（无 ts，按"刚刚发生"处理，下次落盘自动升级）。
   */
  private history: AgentInputItem[] = [];
  /** 与 this.history 等长的时间戳数组，下标对齐。 */
  private historyTs: number[] = [];
  private readonly historyDir: string;
  private readonly historyMaxItems: number;
  private readonly historyMaxAgeMs: number;
  private historyWriteChain: Promise<void> = Promise.resolve();
  private readonly langfuseTracer?: LangfuseTracingProcessor;
  /** 启动时一次性扫描的 skill 元数据列表（不含正文，正文按需 load_skill 加载）。 */
  private readonly skills: SkillMeta[];
  /** Eager 模式下启动时一次性读出的所有 SKILL.md 正文；lazy 模式为 undefined。 */
  private readonly skillsFull?: SkillFull[];
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
    // 默认 1 小时；设为 0 表示不按时间过滤。
    {
      const raw = process.env.OPENAI_AGENT_HISTORY_MAX_AGE_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      this.historyMaxAgeMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000;
    }
    this.history = this.loadHistoryFromDisk();
    this.skills = discoverSkills();
    // Eager 模式启动时一次性把 SKILL.md 正文全部读到内存：
    // - 省掉每轮 run 的磁盘 I/O；
    // - 锁定 prompt 的字节序列，避免运行中 SKILL.md 被改导致 cache 击穿。
    this.skillsFull =
      config.agentSkillsLoadMode === 'eager' ? loadAllSkillBodies(this.skills) : undefined;

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

    // 按加载模式拼装 system prompt 与工具列表：
    // - eager：load_skill 工具不注册（skill 正文已内联），少一轮 LLM round-trip；
    // - lazy：保留 load_skill，由 LLM 按需读取。
    const { instructions, fingerprint, bytes } = buildSystemPrompt({
      mode: config.agentSkillsLoadMode,
      skills: this.skills,
      skillsFull: this.skillsFull,
    });
    logger.info('agent.system_prompt.fingerprint', {
      mode: config.agentSkillsLoadMode,
      skillCount: this.skills.length,
      bytes,
      fingerprint, // 同一份配置/skills 多次启动应得到同一个 hash
    });

    const tools = [
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
      ...(config.agentSkillsLoadMode === 'lazy' ? [createLoadSkillTool(this.skills)] : []),
    ];

    this.agent = new Agent<VoiceAgentContext>({
      name: 'Home Voice Assistant',
      model: config.openaiAgentModel,
      instructions,
      tools,
    });
  }

  async run(input: RunVoiceAgentInput): Promise<RunVoiceAgentOutput> {
    this.pruneHistoryByAge();
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
    this.pruneHistoryByAge();
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
    const prevLen = this.history.length;
    if (sdkHistory.length >= turnInput.length) {
      this.history = sdkHistory;
    } else {
      this.history = [...turnInput, ...sdkHistory];
    }

    // 重建 historyTs：旧条目沿用原 ts（按下标对齐，仅前 prevLen 个），
    // 其余视为"本轮新增"，统一打 now。
    const now = Date.now();
    const nextTs: number[] = new Array(this.history.length);
    for (let i = 0; i < this.history.length; i += 1) {
      nextTs[i] = i < prevLen && this.historyTs[i] !== undefined ? this.historyTs[i] : now;
    }
    this.historyTs = nextTs;

    if (this.historyMaxItems > 0 && this.history.length > this.historyMaxItems) {
      const cut = this.history.length - this.historyMaxItems;
      this.history = this.history.slice(cut);
      this.historyTs = this.historyTs.slice(cut);
    }

    this.scheduleHistoryFlush();
  }

  /** 返回当前累计的会话历史条数，便于上层观测/排查。 */
  getHistoryLength(): number {
    return this.history.length;
  }

  /**
   * 按 historyMaxAgeMs 裁掉过老的内存历史（保持 history / historyTs 同步）。
   * 在每次 run 入口调用一次，确保长进程跑几小时后旧消息不会一直跟着喂给 LLM。
   * historyMaxAgeMs <= 0 时为关闭时间过滤，直接 no-op。
   */
  private pruneHistoryByAge(): void {
    if (this.historyMaxAgeMs <= 0) return;
    if (this.history.length === 0) return;
    const cutoff = Date.now() - this.historyMaxAgeMs;
    // ts 单调或近似单调（按写入顺序），找第一个未过期的下标即可。
    let firstKeep = 0;
    while (
      firstKeep < this.historyTs.length &&
      (this.historyTs[firstKeep] ?? 0) <= cutoff
    ) {
      firstKeep += 1;
    }
    if (firstKeep === 0) return;
    const dropped = firstKeep;
    this.history = this.history.slice(firstKeep);
    this.historyTs = this.historyTs.slice(firstKeep);
    logger.info('agent.history.pruned_by_age', {
      dropped,
      remaining: this.history.length,
      maxAgeMs: this.historyMaxAgeMs,
    });
  }

  /** 仅在确有需要时手动清空历史（同时删除磁盘文件内容）。 */
  resetHistory(): void {
    this.history = [];
    this.historyTs = [];
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

      // 兼容两种格式：
      //  新：[{ ts: number, item: AgentInputItem }, ...]
      //  旧：[AgentInputItem, ...]（无 ts，按 0 处理，即"远古"，会被时间过滤掉）
      const now = Date.now();
      const entries: Array<{ ts: number; item: AgentInputItem }> = parsed.map((entry) => {
        if (
          entry &&
          typeof entry === 'object' &&
          'item' in entry &&
          typeof (entry as { ts?: unknown }).ts === 'number'
        ) {
          return entry as { ts: number; item: AgentInputItem };
        }
        // 旧格式：没有时间戳，给 0，让 maxAge 过滤把它清掉（如果开启时间过滤）。
        return { ts: 0, item: entry as AgentInputItem };
      });

      // 1) 按时间过滤
      const ageFiltered =
        this.historyMaxAgeMs > 0
          ? entries.filter((e) => e.ts > 0 && now - e.ts <= this.historyMaxAgeMs)
          : entries;

      // 2) 按条数截断
      const sizeFiltered =
        this.historyMaxItems > 0 && ageFiltered.length > this.historyMaxItems
          ? ageFiltered.slice(ageFiltered.length - this.historyMaxItems)
          : ageFiltered;

      this.historyTs = sizeFiltered.map((e) => e.ts);
      const items = sizeFiltered.map((e) => e.item);

      logger.info('agent.history.loaded', {
        file,
        items: items.length,
        rawItems: parsed.length,
        droppedByAge: entries.length - ageFiltered.length,
        droppedBySize: ageFiltered.length - sizeFiltered.length,
        maxAgeMs: this.historyMaxAgeMs,
      });
      return items;
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
   *
   * 返回 [item, ts] 对，保持与 historyTs 的对齐关系。
   */
  private filterHistoryForDisk(
    items: AgentInputItem[],
    tsArr: number[],
  ): Array<{ ts: number; item: AgentInputItem }> {
    const out: Array<{ ts: number; item: AgentInputItem }> = [];
    for (let i = 0; i < items.length; i += 1) {
      const role = (items[i] as { role?: string }).role;
      if (role === 'system' || role === 'user' || role === 'assistant') {
        out.push({ ts: tsArr[i] ?? Date.now(), item: items[i] });
      }
    }
    return out;
  }

  /**
   * 串行化持久化：用 historyWriteChain 保证多次 run 的写入按顺序落盘，
   * 避免后一次写入被前一次覆盖。写入采用 tmp + rename 原子替换。
   *
   * 落盘到当天分片文件（YYYY-MM-DD.json），跨天后老文件保留在磁盘上不删除，
   * 但下次启动只读当天的——等价于"自动失忆"昨天的对话。
   *
   * 落盘格式：[{ ts, item }, ...]，便于下次启动按时间过滤超龄历史。
   */
  private scheduleHistoryFlush(): void {
    const snapshot = this.filterHistoryForDisk(this.history, this.historyTs);
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
