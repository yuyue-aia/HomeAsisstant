/**
 * Langfuse Tracer for OpenAI Agents JS SDK
 * --------------------------------------------------
 * 把 @openai/agents 的 Trace / Span 转成 OpenTelemetry Span，
 * 通过 OTLP HTTP exporter 上报到 Langfuse 自托管或云端实例。
 *
 * 设计要点：
 *   1. SDK 的 Trace == 一次顶层"工作流"，对应一个 OTel root span（也是 Langfuse trace）。
 *   2. SDK 的每个 Span（agent/function/generation/...）对应一个 OTel child span。
 *   3. 父子关系由 SDK 的 parentId 维护；这里维护一张 spanId -> OTel SpanContext 的表。
 *   4. 关键属性用 OpenTelemetry GenAI semantic conventions（gen_ai.*），
 *      Langfuse 会识别为 LLM observation。
 *   5. 全程异步、非阻塞；进程退出前请调用 shutdown() flush 队列。
 *
 * 参考：
 *   - https://openai.github.io/openai-agents-js/guides/tracing/
 *   - https://langfuse.com/integrations/native/opentelemetry
 *   - GenAI semconv: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import {
  context as otelContext,
  trace as otelTrace,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span as OTelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import type { TracingProcessor, Span as AgentSpan, SpanData, Trace as AgentTrace } from '@openai/agents';

import { logger } from '../../common/logger';

export interface LangfuseTracerOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  serviceName?: string;
  serviceVersion?: string;
  /** 调试输出（含 OTel 内部错误） */
  debug?: boolean;
}

/**
 * 从环境变量构造 Langfuse OTel processor。返回 undefined 表示未配置或配置不全。
 * 调用方应在拿到 processor 后通过 @openai/agents 的 addTraceProcessor 注册。
 */
export function createLangfuseTracerFromEnv(): LangfuseTracingProcessor | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();

  if (!publicKey || !secretKey || !baseUrl) return undefined;

  return new LangfuseTracingProcessor({
    publicKey,
    secretKey,
    baseUrl,
    serviceName: process.env.LANGFUSE_SERVICE_NAME?.trim() || 'home-voice-agent',
    serviceVersion: process.env.LANGFUSE_SERVICE_VERSION?.trim(),
    debug: process.env.LANGFUSE_DEBUG === '1',
  });
}

export class LangfuseTracingProcessor implements TracingProcessor {
  private readonly tracer: Tracer;
  private readonly provider: BasicTracerProvider;
  private readonly options: LangfuseTracerOptions;

  /** SDK traceId -> { rootSpan, ctx } */
  private readonly traceMap = new Map<string, { rootSpan: OTelSpan; ctx: Context }>();
  /** SDK spanId -> { span, ctx } */
  private readonly spanMap = new Map<string, { span: OTelSpan; ctx: Context }>();
  /** SDK traceId -> 最后一段 assistant 文本（用于回写 trace.output） */
  private readonly lastOutputByTrace = new Map<string, string>();

  constructor(options: LangfuseTracerOptions) {
    this.options = options;

    const endpoint = options.baseUrl.replace(/\/+$/, '') + '/api/public/otel/v1/traces';
    const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');

    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: {
        Authorization: `Basic ${auth}`,
        'x-langfuse-ingestion-version': '4',
      },
    });

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName || 'home-voice-agent',
      ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
    });

    this.provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter, {
        // 家用语音助手 trace 频次很低，缩短批量延迟，让 UI 更快看到
        scheduledDelayMillis: 1500,
        maxExportBatchSize: 64,
      })],
    });

    // 不调 register()，避免污染全局 OTel API。直接拿到 tracer 实例局部使用。
    this.tracer = this.provider.getTracer('openai-agents-js', '1.0.0');

    if (options.debug) {
      logger.info('langfuse.tracer.init', { endpoint, service: options.serviceName });
    }
  }

  // -----------------------------------------------------------------------
  //                            TracingProcessor 接口
  // -----------------------------------------------------------------------

  async onTraceStart(trace: AgentTrace): Promise<void> {
    try {
      const meta = trace.metadata || {};
      const userId = pickString(meta, 'user_id', 'userId');
      const sessionId = pickString(meta, 'session_id', 'sessionId') || trace.groupId;
      const input = pickString(meta, 'input');

      const attrs: Record<string, string | number | boolean> = {
        'agents.trace.id': trace.traceId,
        'langfuse.trace.name': trace.name || 'agent.workflow',
      };
      if (userId) {
        attrs['langfuse.user.id'] = userId;
        attrs['user.id'] = userId;
      }
      if (sessionId) {
        attrs['langfuse.session.id'] = sessionId;
        attrs['session.id'] = sessionId;
      }
      if (input) attrs['langfuse.trace.input'] = truncate(input);
      // 剩下的 metadata 字段进 langfuse.trace.metadata.*（可过滤）
      for (const [k, v] of Object.entries(meta)) {
        if (k === 'input' || k === 'user_id' || k === 'userId' || k === 'session_id' || k === 'sessionId') continue;
        attrs[`langfuse.trace.metadata.${k}`] =
          typeof v === 'string' ? v : safeJson(v);
      }

      const rootSpan = this.tracer.startSpan(trace.name || 'agent.workflow', {
        kind: SpanKind.INTERNAL,
        attributes: attrs,
      });
      const ctx = otelTrace.setSpan(otelContext.active(), rootSpan);
      this.traceMap.set(trace.traceId, { rootSpan, ctx });
    } catch (err) {
      this.warn('onTraceStart failed', err);
    }
  }

  async onTraceEnd(trace: AgentTrace): Promise<void> {
    try {
      const entry = this.traceMap.get(trace.traceId);
      if (!entry) return;
      const finalText = this.lastOutputByTrace.get(trace.traceId);
      if (finalText) {
        entry.rootSpan.setAttribute('langfuse.trace.output', truncate(finalText));
      }
      entry.rootSpan.end();
      this.traceMap.delete(trace.traceId);
      this.lastOutputByTrace.delete(trace.traceId);
    } catch (err) {
      this.warn('onTraceEnd failed', err);
    }
  }

  async onSpanStart(span: AgentSpan<SpanData>): Promise<void> {
    try {
      const parentCtx = this.resolveParentContext(span);
      const data = span.spanData;
      const otelSpan = this.tracer.startSpan(
        spanName(data),
        {
          kind: SpanKind.INTERNAL,
          attributes: buildStartAttributes(data),
          startTime: parseTime(span.startedAt) ?? undefined,
        },
        parentCtx,
      );
      const ctx = otelTrace.setSpan(parentCtx, otelSpan);
      this.spanMap.set(span.spanId, { span: otelSpan, ctx });
    } catch (err) {
      this.warn('onSpanStart failed', err);
    }
  }

  async onSpanEnd(span: AgentSpan<SpanData>): Promise<void> {
    try {
      const entry = this.spanMap.get(span.spanId);
      if (!entry) return;

      // 结束前把 end 阶段才有的字段（input/output/usage 等）补齐
      applyEndAttributes(entry.span, span.spanData);

      // 抽出最后一段 assistant text，留给 trace.output
      const finalText = extractAssistantText(span.spanData);
      if (finalText) this.lastOutputByTrace.set(span.traceId, finalText);

      const error = span.error;
      if (error) {
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        entry.span.recordException({ name: 'AgentSpanError', message: error.message });
        if (error.data) {
          entry.span.setAttribute('error.data', safeJson(error.data));
        }
      }

      const endTime = parseTime(span.endedAt);
      entry.span.end(endTime ?? undefined);
      this.spanMap.delete(span.spanId);
    } catch (err) {
      this.warn('onSpanEnd failed', err);
    }
  }

  async shutdown(timeoutMs?: number): Promise<void> {
    try {
      // 兜底 end 未关闭的 span，避免 BatchSpanProcessor 丢失数据
      for (const [, v] of this.spanMap) v.span.end();
      this.spanMap.clear();
      for (const [, v] of this.traceMap) v.rootSpan.end();
      this.traceMap.clear();
      await this.provider.shutdown();
    } catch (err) {
      this.warn('shutdown failed', err);
    }
    void timeoutMs;
  }

  async forceFlush(): Promise<void> {
    try {
      await this.provider.forceFlush();
    } catch (err) {
      this.warn('forceFlush failed', err);
    }
  }

  // -----------------------------------------------------------------------
  //                                内部工具
  // -----------------------------------------------------------------------

  private resolveParentContext(span: AgentSpan<SpanData>): Context {
    const parentId = span.parentId;
    if (parentId) {
      const parent = this.spanMap.get(parentId);
      if (parent) return parent.ctx;
    }
    const trace = this.traceMap.get(span.traceId);
    if (trace) return trace.ctx;
    return otelContext.active();
  }

  private warn(msg: string, err: unknown): void {
    if (this.options.debug) {
      logger.warn(`langfuse.tracer.${msg}`, { error: (err as Error).message });
    }
  }
}

// ===========================================================================
//                  Span 数据 -> OTel 属性映射
// ===========================================================================

function spanName(data: SpanData): string {
  switch (data.type) {
    case 'agent':
      return `agent.${data.name}`;
    case 'function':
      return `tool.${data.name}`;
    case 'generation':
      return data.model ? `llm.${data.model}` : 'llm.generation';
    case 'response':
      return 'llm.response';
    case 'handoff':
      return `handoff.${data.from_agent ?? '?'}->${data.to_agent ?? '?'}`;
    case 'custom':
      return data.name;
    case 'guardrail':
      return `guardrail.${data.name}`;
    case 'transcription':
      return 'asr';
    case 'speech':
      return 'tts';
    case 'speech_group':
      return 'tts.group';
    case 'mcp_tools':
      return `mcp.list_tools.${data.server ?? ''}`;
    default:
      return (data as { type?: string }).type ?? 'span';
  }
}

function buildStartAttributes(data: SpanData): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'agents.span.type': data.type,
    'langfuse.observation.type': mapObservationType(data.type),
  };
  switch (data.type) {
    case 'agent':
      attrs['agent.name'] = data.name;
      if (data.handoffs?.length) attrs['agent.handoffs'] = data.handoffs.join(',');
      if (data.tools?.length) attrs['agent.tools'] = data.tools.join(',');
      if (data.output_type) attrs['agent.output_type'] = data.output_type;
      break;
    case 'function':
      attrs['tool.name'] = data.name;
      break;
    case 'generation':
      if (data.model) {
        // 同时写 GenAI semconv 和 Langfuse 专用 key，两边 UI 都能识别
        attrs['gen_ai.system'] = 'openai';
        attrs['gen_ai.request.model'] = data.model;
        attrs['gen_ai.response.model'] = data.model;
        attrs['langfuse.observation.model.name'] = data.model;
      }
      if (data.model_config) {
        const cfg = data.model_config as Record<string, unknown>;
        if (typeof cfg.temperature === 'number') attrs['gen_ai.request.temperature'] = cfg.temperature;
        if (typeof cfg.top_p === 'number') attrs['gen_ai.request.top_p'] = cfg.top_p;
        if (typeof cfg.max_tokens === 'number') attrs['gen_ai.request.max_tokens'] = cfg.max_tokens;
        attrs['langfuse.observation.model.parameters'] = safeJson(cfg);
      }
      break;
    case 'handoff':
      if (data.from_agent) attrs['handoff.from'] = data.from_agent;
      if (data.to_agent) attrs['handoff.to'] = data.to_agent;
      break;
    case 'guardrail':
      attrs['guardrail.name'] = data.name;
      attrs['guardrail.triggered'] = data.triggered;
      break;
    case 'transcription':
      if (data.model) {
        attrs['gen_ai.request.model'] = data.model;
        attrs['langfuse.observation.model.name'] = data.model;
      }
      break;
    case 'speech':
      if (data.model) {
        attrs['gen_ai.request.model'] = data.model;
        attrs['langfuse.observation.model.name'] = data.model;
      }
      break;
    case 'mcp_tools':
      if (data.server) attrs['mcp.server'] = data.server;
      break;
  }
  return attrs;
}

/**
 * 把 OpenAI Agents span 类型映射到 Langfuse observation type
 *  - generation/response → "generation"（在 Langfuse UI 里显示为 LLM 调用）
 *  - 其它都是普通 "span"
 */
function mapObservationType(t: SpanData['type']): string {
  switch (t) {
    case 'generation':
    case 'response':
      return 'generation';
    default:
      return 'span';
  }
}

/**
 * end 阶段才会有的 input/output/usage，必须在 onSpanEnd 时再写。
 * 同时写两套 key：
 *  - input.value / output.value：通用约定
 *  - langfuse.observation.input/output：Langfuse 专用，UI 一定显示
 */
function applyEndAttributes(span: OTelSpan, data: SpanData): void {
  switch (data.type) {
    case 'function':
      if (data.input) {
        const v = truncate(data.input);
        span.setAttribute('input.value', v);
        span.setAttribute('langfuse.observation.input', v);
      }
      if (data.output) {
        const v = truncate(data.output);
        span.setAttribute('output.value', v);
        span.setAttribute('langfuse.observation.output', v);
      }
      if (data.mcp_data) span.setAttribute('mcp.data', truncate(data.mcp_data));
      break;
    case 'generation': {
      if (data.input) {
        const v = truncate(safeJson(data.input));
        span.setAttribute('input.value', v);
        span.setAttribute('langfuse.observation.input', v);
      }
      if (data.output) {
        const v = truncate(safeJson(data.output));
        span.setAttribute('output.value', v);
        span.setAttribute('langfuse.observation.output', v);
      }

      // SDK 在 spanData.model / spanData.usage 上常常是空的——
      // 真正的 model 名和 token usage 藏在 output（ChatCompletion 响应体）里，
      // 这里反向提取一次，确保 Langfuse UI 上 model / token / cost 都能展示。
      const extracted = extractModelAndUsage(data.output);
      const modelName = data.model || extracted.model;
      if (modelName) {
        span.setAttribute('gen_ai.system', 'openai');
        span.setAttribute('gen_ai.request.model', modelName);
        span.setAttribute('gen_ai.response.model', modelName);
        span.setAttribute('langfuse.observation.model.name', modelName);
      }
      const usage = data.usage ?? extracted.usage;
      if (usage) {
        const inTok = pickNumber(usage, 'input_tokens', 'prompt_tokens');
        const outTok = pickNumber(usage, 'output_tokens', 'completion_tokens');
        const totalTok = pickNumber(usage, 'total_tokens');
        if (typeof inTok === 'number') span.setAttribute('gen_ai.usage.input_tokens', inTok);
        if (typeof outTok === 'number') span.setAttribute('gen_ai.usage.output_tokens', outTok);
        if (typeof totalTok === 'number') span.setAttribute('gen_ai.usage.total_tokens', totalTok);

        // Langfuse 用 usage_details 计算 token / cost。规范化成 input/output/total。
        const usageDetails: Record<string, number> = {};
        if (typeof inTok === 'number') usageDetails.input = inTok;
        if (typeof outTok === 'number') usageDetails.output = outTok;
        if (typeof totalTok === 'number') usageDetails.total = totalTok;
        // 附带厂商扩展字段（cached_tokens / reasoning_tokens 等）
        for (const [k, v] of Object.entries(usage)) {
          if (typeof v === 'number' && !(k in usageDetails) && k !== 'input_tokens' && k !== 'output_tokens' && k !== 'total_tokens' && k !== 'prompt_tokens' && k !== 'completion_tokens') {
            usageDetails[k] = v;
          }
        }
        if (Object.keys(usageDetails).length > 0) {
          span.setAttribute('langfuse.observation.usage_details', safeJson(usageDetails));
        }
      }
      break;
    }
    case 'response':
      if (data.response_id) span.setAttribute('llm.response.id', data.response_id);
      if (data._input) {
        const v = truncate(safeJson(data._input));
        span.setAttribute('input.value', v);
        span.setAttribute('langfuse.observation.input', v);
      }
      if (data._response) {
        const v = truncate(safeJson(data._response));
        span.setAttribute('output.value', v);
        span.setAttribute('langfuse.observation.output', v);
      }
      break;
    case 'transcription':
      if (data.input?.data) span.setAttribute('input.value', `<audio:${data.input.format} ${data.input.data.length}b>`);
      if (data.output) {
        span.setAttribute('output.value', truncate(data.output));
        span.setAttribute('langfuse.observation.output', truncate(data.output));
      }
      break;
    case 'speech':
      if (data.input) {
        span.setAttribute('input.value', truncate(data.input));
        span.setAttribute('langfuse.observation.input', truncate(data.input));
      }
      if (data.output?.data) span.setAttribute('output.value', `<audio:${data.output.format} ${data.output.data.length}b>`);
      break;
    case 'custom':
      span.setAttribute('custom.data', truncate(safeJson(data.data)));
      break;
    case 'mcp_tools':
      if (data.result) span.setAttribute('mcp.result', truncate(safeJson(data.result)));
      break;
    case 'guardrail':
      span.setAttribute('guardrail.triggered', data.triggered);
      break;
  }
}

// ===========================================================================
//                                helpers
// ===========================================================================

const MAX_ATTR_LEN = 32_768; // OTLP 单个属性的实用上限，太长会被中转截断

function truncate(s: string): string {
  if (s.length <= MAX_ATTR_LEN) return s;
  return s.slice(0, MAX_ATTR_LEN) + `...<truncated ${s.length - MAX_ATTR_LEN} chars>`;
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parseTime(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function pickString(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * 从 generation.output（ChatCompletion 响应体或其数组）里提取 model 名和 usage。
 * 适配两种形态：
 *   - ChatCompletion 对象：{ model, usage, choices: [...] }
 *   - 包成数组：[{ model, usage, choices }]
 * 任一字段缺失则返回 undefined。
 */
function extractModelAndUsage(output: unknown): {
  model?: string;
  usage?: Record<string, number>;
} {
  if (!output) return {};
  const items = Array.isArray(output) ? output : [output];
  let model: string | undefined;
  let usage: Record<string, number> | undefined;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const obj = it as Record<string, unknown>;
    if (!model && typeof obj.model === 'string') model = obj.model;
    const u = obj.usage;
    if (!usage && u && typeof u === 'object') {
      const numericUsage: Record<string, number> = {};
      for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) numericUsage[k] = v;
      }
      if (Object.keys(numericUsage).length > 0) usage = numericUsage;
    }
    if (model && usage) break;
  }
  return { model, usage };
}

/**
 * 从 generation/response span 的 output 里抽出最后一段 assistant 文本，
 * 用于回写 trace.output 让 Langfuse trace 列表页直接显示最终回答。
 *
 * Chat Completions 风格 output 形如：
 *   [{ id, choices: [{ message: { role: 'assistant', content: '...' } }] }]
 * 也兼容 Responses API / 旧版的纯消息数组：
 *   [{ role: 'assistant', content: '...' }]
 */
function extractAssistantText(data: SpanData): string | undefined {
  if (data.type !== 'generation' && data.type !== 'response') return undefined;

  const candidates: unknown =
    data.type === 'generation' ? data.output : (data as { _response?: unknown })._response;
  if (!candidates) return undefined;

  const items = Array.isArray(candidates) ? candidates : [candidates];

  // 倒序遍历，取最后一条 assistant 文本
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') continue;

    // ChatCompletion: { choices: [{ message: {role, content} }] }
    const choices = item.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      for (let j = choices.length - 1; j >= 0; j--) {
        const ch = choices[j] as { message?: { role?: string; content?: unknown } } | undefined;
        const msg = ch?.message;
        if (msg && msg.role === 'assistant') {
          const t = stringifyContent(msg.content);
          if (t) return t;
        }
      }
    }

    // Plain message: { role: 'assistant', content: ... }
    const role = (item as { role?: string }).role;
    if (role === 'assistant') {
      const t = stringifyContent((item as { content?: unknown }).content);
      if (t) return t;
    }
  }
  return undefined;
}

function stringifyContent(c: unknown): string | undefined {
  if (typeof c === 'string') return c.trim() || undefined;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const p = part as { text?: unknown; type?: string };
        if (typeof p.text === 'string') parts.push(p.text);
      }
    }
    const joined = parts.join('').trim();
    return joined || undefined;
  }
  return undefined;
}
