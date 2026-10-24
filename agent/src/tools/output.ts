import type { AgentLimits } from '../config.ts';
import { DEFAULT_LIMITS } from '../config.ts';

/** 输出截断策略：头 200 行 + 尾 50 行，总量 ≤ 8KB（与 docs/agent-design.md 第 4 节一致） */
export interface OutputLimits {
  headLines: number;
  tailLines: number;
  maxBytes: number;
}

export interface LineTruncation {
  text: string;
  truncated: boolean;
  totalLines: number;
}

export interface FormattedOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
  totalStdoutLines: number;
  totalStderrLines: number;
  totalBytes: number;
}

export function resolveOutputLimits(limits?: Partial<AgentLimits>): OutputLimits {
  return {
    headLines: limits?.outputHeadLines ?? DEFAULT_LIMITS.outputHeadLines,
    tailLines: limits?.outputTailLines ?? DEFAULT_LIMITS.outputTailLines,
    maxBytes: limits?.outputMaxBytes ?? DEFAULT_LIMITS.outputMaxBytes,
  };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行数截断：超过 head+tail 时插入「已省略 N 行」标记 */
export function truncateLines(raw: string, headLines: number, tailLines: number): LineTruncation {
  const lines = splitLines(String(raw ?? ''));
  const totalLines = lines.length;
  const head = Math.max(0, headLines);
  const tail = Math.max(0, tailLines);
  if (totalLines <= head + tail) {
    return { text: lines.join('\n'), truncated: false, totalLines };
  }
  const keptHead = lines.slice(0, head);
  const keptTail = tail > 0 ? lines.slice(totalLines - tail) : [];
  const omitted = totalLines - keptHead.length - keptTail.length;
  const marker = '…（已省略 ' + omitted + ' 行）…';
  return { text: [...keptHead, marker, ...keptTail].join('\n'), truncated: true, totalLines };
}

/** 字节截断：保留头 70% + 尾 30%，中间用标记衔接（按 UTF-8 字节算，避免中文被腰斩） */
export function clipTextToBytes(raw: string, maxBytes: number): LineTruncation {
  const text = String(raw ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text, truncated: false, totalLines: splitLines(text).length };
  }
  const marker = '\n…（输出超过 ' + Math.round(maxBytes / 1024) + 'KB 上限，已截断）…\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.floor(budget * 0.7);
  const tailBudget = budget - headBudget;
  const head = buffer.subarray(0, headBudget).toString('utf8');
  const tail = tailBudget > 0 ? buffer.subarray(buffer.length - tailBudget).toString('utf8') : '';
  return { text: head + marker + tail, truncated: true, totalLines: splitLines(text).length };
}

/**
 * 把一次命令的 stdout/stderr 压成给模型看的形态：
 * 先按行截断（头 200/尾 50），再保证两路合计 ≤ 8KB。
 */
export function formatCommandOutput(
  stdout: string,
  stderr: string,
  limits: OutputLimits,
): FormattedOutput {
  const out = truncateLines(stdout, limits.headLines, limits.tailLines);
  const err = truncateLines(stderr, limits.headLines, limits.tailLines);
  let stdoutText = out.text;
  let stderrText = err.text;
  let truncated = out.truncated || err.truncated;

  const totalBytes = () => Buffer.byteLength(stdoutText, 'utf8') + Buffer.byteLength(stderrText, 'utf8');
  if (totalBytes() > limits.maxBytes) {
    // stderr 通常更重要，但 stdout 是主体：有 stderr 时按 7:3 分预算，否则全给 stdout
    const hasStderr = stderrText.length > 0;
    const stdoutBudget = hasStderr ? Math.floor(limits.maxBytes * 0.7) : limits.maxBytes;
    const stderrBudget = hasStderr ? limits.maxBytes - stdoutBudget : 0;
    const clippedOut = clipTextToBytes(stdoutText, stdoutBudget);
    const clippedErr = hasStderr ? clipTextToBytes(stderrText, stderrBudget) : { text: stderrText, truncated: false };
    stdoutText = clippedOut.text;
    stderrText = clippedErr.text;
    truncated = true;
  }

  return {
    stdout: stdoutText,
    stderr: stderrText,
    truncated,
    totalStdoutLines: out.totalLines,
    totalStderrLines: err.totalLines,
    totalBytes: totalBytes(),
  };
}
