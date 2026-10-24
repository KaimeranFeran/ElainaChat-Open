import { AGENT_ERROR, fail, ok, type ToolResult } from '../errors.ts';
import type { FetchLike } from './types.ts';
import { checkString } from './types.ts';

/**
 * web_fetch（设计文档第 4 节）：
 * - 仅 http/https；file/ftp/data 等协议直接拒绝
 * - 超时 20s、响应体 ≤ 2MB
 * - 仅接受 text/html 与 text/plain；剥标签后转纯文本给模型
 * - fetch 可注入，测试离线可跑
 */

export const WEB_FETCH_TIMEOUT_MS = 20000;
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_CHARS = 20000;

export interface WebFetchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebFetchToolOptions extends WebFetchOptions {}

const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'text/plain']);
const BLOCK_TAGS = 'p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd|form|fieldset|figure|figcaption|address|aside|nav|main|details|summary|hr';
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

export function decodeEntities(text: string): string {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** HTML → 纯文本：去脚本/样式/注释、块级标签转换行、剥标签、解实体、压空白 */
export function htmlToText(html: string): string {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<\bscript\b[^>]*\/?>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(new RegExp('</?(' + BLOCK_TAGS + ')\\b[^>]*>', 'gi'), '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line, index, all) => !(line === '' && (index === 0 || all[index - 1] === '')));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html ?? ''));
  if (!match) return '';
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
}

function parseUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: '缺少 url 参数' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'URL 格式不合法：' + text };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'web_fetch 只允许 http/https URL，收到：' + url.protocol };
  }
  return { ok: true, url };
}

function charsetOf(contentType: string): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return match ? match[1].trim().toLowerCase() : null;
}

function decodeBody(buffer: Buffer, charset: string | null): string {
  const tryDecode = (label: string): string | null => {
    try {
      return new TextDecoder(label, { fatal: false }).decode(buffer);
    } catch {
      return null;
    }
  };
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    const declared = tryDecode(charset);
    if (declared !== null && !declared.includes('\uFFFD')) return declared;
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const gbk = tryDecode('gb18030');
  return gbk !== null && !gbk.includes('\uFFFD') ? gbk : utf8;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean; bytes: number }> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= maxBytes) return { buffer, truncated: false, bytes: buffer.length };
    return { buffer: buffer.subarray(0, maxBytes), truncated: true, bytes: buffer.length };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (chunks.reduce((sum, item) => sum + item.length, 0) < maxBytes) {
        const remaining = maxBytes - chunks.reduce((sum, item) => sum + item.length, 0);
        chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      } else {
        truncated = true;
      }
      if (total > maxBytes) truncated = true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已读完 */
    }
  }
  return { buffer: Buffer.concat(chunks), truncated, bytes: total };
}

/** web_fetch 工具实现 */
export async function webFetchTool(args: Record<string, unknown>, options: WebFetchToolOptions = {}): Promise<ToolResult> {
  const urlCheck = checkString(args, 'url', { required: true, maxLength: 4000 });
  if (!urlCheck.ok) return fail(AGENT_ERROR.TOOL_FAILED, urlCheck.message);
  const parsed = parseUrl(urlCheck.value as string);
  if (!parsed.ok) return fail(AGENT_ERROR.TOOL_DENIED, parsed.message, { denied: true });

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail(AGENT_ERROR.TOOL_FAILED, '当前运行环境没有 fetch，无法抓取网页。');

  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const maxChars = options.maxChars ?? WEB_FETCH_MAX_CHARS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetchImpl(parsed.url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'user-agent': 'Mozilla/5.0 (compatible; ElainaChat-Agent/0.1; +web_fetch)',
      },
      signal: controller.signal,
    });

    const contentTypeHeader = String(response.headers.get('content-type') ?? '');
    const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(mime)) {
      return fail(AGENT_ERROR.TOOL_FAILED, 'web_fetch 只接受 text/html 或 text/plain，服务器返回的是：' + (mime || '(未知 content-type)'), {
        data: { url: response.url || parsed.url.toString(), status: response.status, contentType: contentTypeHeader },
      });
    }
    if (!response.ok) {
      return fail(AGENT_ERROR.TOOL_FAILED, '抓取失败：HTTP ' + response.status, {
        retryable: response.status >= 500,
        data: { url: response.url || parsed.url.toString(), status: response.status, contentType: contentTypeHeader },
      });
    }

    const { buffer, truncated: byteTruncated, bytes } = await readBodyCapped(response, maxBytes);
    const html = decodeBody(buffer, charsetOf(contentTypeHeader));
    const title = mime === 'text/html' ? extractTitle(html) : '';
    let text = mime === 'text/html' ? htmlToText(html) : html.trim();
    let charTruncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n…（正文超过 ' + maxChars + ' 字符，已截断）…';
      charTruncated = true;
    }
    const truncated = byteTruncated || charTruncated;

    return ok(
      {
        url: response.url || parsed.url.toString(),
        requestedUrl: parsed.url.toString(),
        status: response.status,
        contentType: contentTypeHeader,
        title,
        text,
        chars: text.length,
        bytes,
        truncated,
      },
      truncated ? '网页内容较大，已截断（上限 ' + Math.round(maxBytes / 1024) + 'KB / ' + maxChars + ' 字符）' : '',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      return fail(AGENT_ERROR.TOOL_TIMEOUT, 'web_fetch 超时（' + timeoutMs + 'ms）：' + parsed.url.toString(), { retryable: true });
    }
    return fail(AGENT_ERROR.TOOL_FAILED, '抓取失败：' + message, {
      retryable: true,
      data: { url: parsed.url.toString() },
    });
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}
