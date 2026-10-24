import { AGENT_ERROR, fail, ok, type ToolResult } from '../errors.ts';
import type { FetchLike } from './types.ts';
import { checkNumber, checkString } from './types.ts';

/**
 * web_search（设计文档第 4、9 节）：
 * - provider：tavily / brave / 自定义 HTTP（JSONPath 简化为启发式路径发现）
 * - 未配置 Key（自定义 provider 未配置 URL）时 isAvailable() 为 false，
 *   工具层据此不把 web_search 暴露给模型
 * - fetch 可注入，测试离线可跑
 */

export type SearchProvider = 'tavily' | 'brave' | 'custom';

export interface SearchConfig {
  provider: SearchProvider;
  apiKey?: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResults?: number;
}

export interface WebSearchToolOptions {
  search?: SearchConfig | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15000;
const SNIPPET_MAX_CHARS = 600;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** 当前搜索配置是否可用（web_search 是否暴露给模型的唯一开关） */
export function isSearchAvailable(config?: SearchConfig | null): boolean {
  if (!config || typeof config !== 'object') return false;
  const provider = config.provider;
  if (provider === 'tavily' || provider === 'brave') return clean(config.apiKey).length > 0;
  if (provider === 'custom') {
    const url = clean(config.url);
    if (!url) return false;
    try {
      const parsed = new URL(url.replace(/\{(query|q|count|apiKey|api_key)\}/g, 'x'));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return false;
}

export function searchUnavailableReason(config?: SearchConfig | null): string {
  if (!config) return '未配置搜索服务';
  if (config.provider === 'tavily' || config.provider === 'brave') return '未填写 ' + config.provider + ' API Key';
  if (config.provider === 'custom') return '未填写自定义搜索地址（或地址不是 http/https）';
  return '未知搜索服务：' + String((config as { provider?: unknown }).provider);
}

function withTimeout(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

interface JsonResponse {
  status: number;
  json: unknown;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonResponse> {
  const wrapped = withTimeout(timeoutMs, signal);
  try {
    const response = await fetchImpl(url, { ...init, signal: wrapped.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + (text ? '：' + text.slice(0, 200) : ''));
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('搜索服务返回的不是 JSON');
    }
    return { status: response.status, json };
  } finally {
    wrapped.dispose();
  }
}

function toSnippet(value: unknown): string {
  const text = clean(value);
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) + '…' : text;
}

function mapRecord(record: unknown): SearchResult | null {
  if (!record || typeof record !== 'object') return null;
  const item = record as Record<string, unknown>;
  const url = clean(item.url) || clean(item.link) || clean(item.href) || clean(item.sourceUrl);
  const title = clean(item.title) || clean(item.name) || clean(item.headline);
  const snippet = toSnippet(item.snippet) || toSnippet(item.description) || toSnippet(item.content) || toSnippet(item.summary) || toSnippet(item.text);
  if (!url && !title) return null;
  return { title: title || url, url, snippet };
}

interface ArrayCandidate {
  path: string;
  results: SearchResult[];
}

function collectArrayCandidates(node: unknown, path: string, out: ArrayCandidate[], depth: number): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const results: SearchResult[] = [];
    for (const item of node) {
      const mapped = mapRecord(item);
      if (mapped) results.push(mapped);
    }
    if (results.length > 0) out.push({ path, results });
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collectArrayCandidates(value, path ? path + '.' + key : key, out, depth + 1);
  }
}

/** 自定义 provider 的「JSONPath」：优先 results/items/data 命名，其次取最像结果列表的数组 */
export function extractCustomResults(payload: unknown): SearchResult[] {
  const candidates: ArrayCandidate[] = [];
  if (Array.isArray(payload)) {
    collectArrayCandidates(payload, '', candidates, 0);
  } else {
    collectArrayCandidates(payload, '', candidates, 0);
  }
  if (candidates.length === 0) return [];
  const preferred = candidates.find((candidate) => /(results|items|data|webpages|hits|list)$/i.test(candidate.path));
  const chosen = preferred ?? candidates.sort((a, b) => b.results.length - a.results.length)[0];
  return chosen.results;
}

async function searchTavily(query: string, config: SearchConfig, limit: number, options: WebSearchOptions): Promise<SearchResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  const response = await requestJson(
    fetchImpl,
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + clean(config.apiKey),
      },
      body: JSON.stringify({ api_key: clean(config.apiKey), query, max_results: limit, search_depth: 'basic', include_answer: false }),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const payload = response.json as { results?: unknown[] } | null;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map((item) => mapRecord(item)).filter((item): item is SearchResult => item !== null);
}

async function searchBrave(query: string, config: SearchConfig, limit: number, options: WebSearchOptions): Promise<SearchResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const response = await requestJson(
    fetchImpl,
    url.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-subscription-token': clean(config.apiKey),
      },
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const payload = response.json as { web?: { results?: unknown[] } } | null;
  const results = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  return results.map((item) => mapRecord(item)).filter((item): item is SearchResult => item !== null);
}

function buildCustomUrl(config: SearchConfig, query: string, limit: number): string {
  let template = clean(config.url);
  const hasQueryPlaceholder = /\{(query|q)\}/.test(template);
  const apiKey = clean(config.apiKey);
  template = template
    .replace(/\{(query|q)\}/g, encodeURIComponent(query))
    .replace(/\{count\}/g, String(limit))
    .replace(/\{(apiKey|api_key)\}/g, encodeURIComponent(apiKey));
  if (!hasQueryPlaceholder) {
    const url = new URL(template);
    url.searchParams.set('q', query);
    if (apiKey && !url.searchParams.has('api_key') && !url.searchParams.has('key')) url.searchParams.set('api_key', apiKey);
    return url.toString();
  }
  return template;
}

async function searchCustom(query: string, config: SearchConfig, limit: number, options: WebSearchOptions): Promise<SearchResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  const apiKey = clean(config.apiKey);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;
  const response = await requestJson(
    fetchImpl,
    buildCustomUrl(config, query, limit),
    { method: 'GET', headers },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return extractCustomResults(response.json);
}

async function performSearch(query: string, config: SearchConfig, limit: number, options: WebSearchOptions): Promise<SearchResult[]> {
  if (config.provider === 'tavily') return (await searchTavily(query, config, limit, options)).slice(0, limit);
  if (config.provider === 'brave') return (await searchBrave(query, config, limit, options)).slice(0, limit);
  if (config.provider === 'custom') return (await searchCustom(query, config, limit, options)).slice(0, limit);
  throw new Error('未知搜索服务：' + String((config as { provider?: unknown }).provider));
}

/** web_search 工具实现 */
export async function webSearchTool(args: Record<string, unknown>, options: WebSearchToolOptions): Promise<ToolResult> {
  const config = options.search;
  if (!isSearchAvailable(config)) {
    return fail(
      AGENT_ERROR.TOOL_FAILED,
      'web_search 不可用：' + searchUnavailableReason(config) + '。请在「设置 → Agent」里配置搜索服务与 Key。',
      { needs_user: true, denied: true },
    );
  }
  const queryCheck = checkString(args, 'query', { required: true, maxLength: 2000 });
  if (!queryCheck.ok) return fail(AGENT_ERROR.TOOL_FAILED, queryCheck.message);
  const maxResultsCheck = checkNumber(args, 'maxResults', { min: 1, max: 10, integer: true });
  if (!maxResultsCheck.ok) return fail(AGENT_ERROR.TOOL_FAILED, maxResultsCheck.message);
  const query = queryCheck.value as string;
  const limit = maxResultsCheck.value ?? 5;

  try {
    const results = await performSearch(query, config as SearchConfig, limit, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    return ok(
      { provider: (config as SearchConfig).provider, query, count: results.length, results },
      results.length === 0 ? '搜索没有返回结果' : '',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(AGENT_ERROR.TOOL_FAILED, '搜索失败：' + message, { retryable: true });
  }
}
