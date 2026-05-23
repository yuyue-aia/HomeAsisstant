import { tool } from '@openai/agents';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../common/logger';
import type { VoiceAgentContext } from '../types';

const webSearchParameters = z.object({
  query: z.string().min(1).describe('Search query.'),
  maxResults: z.number().int().min(1).max(10).optional().describe('Maximum results to return. Default 5.'),
});

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResponse = {
  ok: boolean;
  query: string;
  provider: string;
  results: WebSearchResult[];
  message?: string;
};

const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ');
}

function cleanText(text: string): string {
  return decodeHtml(text).replace(/\s+/g, ' ').trim();
}

function addResult(results: WebSearchResult[], seen: Set<string>, title: string, url: string, snippet: string): void {
  const normalizedUrl = decodeHtml(url).trim();
  if (!normalizedUrl || seen.has(normalizedUrl)) return;
  seen.add(normalizedUrl);
  results.push({
    title: cleanText(title || normalizedUrl),
    url: normalizedUrl,
    snippet: cleanText(snippet),
  });
}

// ============================================================
// 腾讯云 SearchPro（搜狗内核）
// 文档: https://cloud.tencent.com/document/product/1806/121811
// 签名: TC3-HMAC-SHA256
// ============================================================

function buildSogouTc3Headers(secretId: string, secretKey: string, payloadStr: string): Record<string, string> {
  const service = 'wsa';
  const host = 'wsa.tencentcloudapi.com';
  const action = 'SearchPro';
  const version = '2025-05-08';
  const algorithm = 'TC3-HMAC-SHA256';

  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const ct = 'application/json; charset=utf-8';
  const hashedRequestPayload = createHash('sha256').update(payloadStr, 'utf8').digest('hex');

  const canonicalHeaders = `content-type:${ct}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const secretDate = createHmac('sha256', `TC3${secretKey}`).update(date, 'utf8').digest();
  const secretService = createHmac('sha256', secretDate).update(service, 'utf8').digest();
  const secretSigning = createHmac('sha256', secretService).update('tc3_request', 'utf8').digest();
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    'Content-Type': ct,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
  };
}

async function searchSogou(query: string, limit: number, signal: AbortSignal): Promise<WebSearchResult[]> {
  const secretId = getEnv('TENCENTCLOUD_SECRET_ID');
  const secretKey = getEnv('TENCENTCLOUD_SECRET_KEY');
  if (!secretId || !secretKey) {
    throw new Error('Missing TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY');
  }

  // SearchPro 仅支持 Cnt = 10/20/30/40/50
  const validCounts = [10, 20, 30, 40, 50];
  const cnt = validCounts.reduce((best, n) => (Math.abs(n - limit) < Math.abs(best - limit) ? n : best), 10);

  const payload: Record<string, unknown> = { Query: query };
  if (cnt !== 10) payload.Cnt = cnt;

  const payloadStr = JSON.stringify(payload);
  const headers = buildSogouTc3Headers(secretId, secretKey, payloadStr);

  const response = await fetch('https://wsa.tencentcloudapi.com', {
    method: 'POST',
    headers,
    body: payloadStr,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Sogou HTTP ${response.status}`);
  }
  const data = asRecord(await response.json());
  const responseRecord = asRecord(data?.Response);
  const error = asRecord(responseRecord?.Error);
  if (error) {
    throw new Error(`Sogou API ${asString(error.Code)}: ${asString(error.Message)}`);
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const pageItem of asArray(responseRecord?.Pages)) {
    if (results.length >= limit) break;
    let page: Record<string, unknown> | undefined;
    if (typeof pageItem === 'string') {
      try {
        page = asRecord(JSON.parse(pageItem));
      } catch {
        continue;
      }
    } else {
      page = asRecord(pageItem);
    }
    if (!page) continue;
    addResult(results, seen, asString(page.title), asString(page.url), asString(page.passage) || asString(page.content));
  }
  return results;
}

export async function executeWebSearch(input: { query: string; maxResults?: number }): Promise<WebSearchResponse> {
  const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  logger.info('tool.web_search.start', { query: input.query, provider: 'sogou' });

  try {
    const results = await searchSogou(input.query, limit, controller.signal);
    if (results.length > 0) {
      logger.info('tool.web_search.ok', { query: input.query, provider: 'sogou', resultCount: results.length });
      return { ok: true, query: input.query, provider: 'sogou', results };
    }
    logger.info('tool.web_search.empty', { query: input.query, provider: 'sogou' });
    return {
      ok: true,
      query: input.query,
      provider: 'sogou',
      results: [],
      message: '没有找到可用搜索结果。',
    };
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('tool.web_search.exception', { query: input.query, error: message });
    return {
      ok: false,
      query: input.query,
      provider: 'sogou',
      results: [],
      message: `搜索失败：${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const webSearchTool = tool<typeof webSearchParameters, VoiceAgentContext, WebSearchResponse>({
  name: 'web_search',
  description:
    'Search the public web for current information. Use whenever the user asks to search online or asks for live/recent information.',
  parameters: webSearchParameters,
  async execute(input) {
    return executeWebSearch(input);
  },
});
