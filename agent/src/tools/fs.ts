import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_ERROR, fail, ok, type ToolResult } from '../errors.ts';
import { resolveUserPath, toDisplayPath, type PathResolution } from './paths.ts';
import { checkBoolean, checkNumber, checkString } from './types.ts';

/**
 * fs 工具层（设计文档第 4 节）：
 * - 所有路径先经 paths.resolveUserPath 规范化，拒绝 ../ 穿越、设备路径与符号链接逃逸
 * - approval 档位下工作区外一律拒绝（needs_user），full 档位放开，由上层审批语义兜底
 * - 失败是数据：一律返回 ToolResult，不抛异常
 */

export interface FsToolOptions {
  workspace: string;
  access: 'approval' | 'full';
}

const READ_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX_ENTRIES = 200;
const LIST_MAX_DEPTH = 6;
const PATCH_MAX_BYTES = 2 * 1024 * 1024;

function denied(message: string, data?: unknown): ToolResult {
  return fail(AGENT_ERROR.TOOL_DENIED, message, { denied: true, needs_user: true, data });
}

function failed(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return fail(AGENT_ERROR.TOOL_FAILED, message, extra);
}

async function resolveForRead(options: FsToolOptions, input: string): Promise<PathResolution> {
  // full 档位：只读也可以越过工作区边界（用户已接受风险，审批不再按路径拦截）；
  // approval 档位保持拒绝，提示由 paths.ts 给出。
  return resolveUserPath(options.workspace, input, { allowOutside: options.access === 'full' });
}

/** 是否是「工作区外」被拒（paths.ts 的专用提示），用于区分设备路径/ADS 等其它拒绝 */
function isOutsideDenial(resolved: PathResolution): boolean {
  return !resolved.ok && resolved.code === 'TOOL_DENIED' && resolved.message.includes('路径超出允许的工作区');
}

async function resolveForWrite(options: FsToolOptions, input: string): Promise<PathResolution> {
  return resolveUserPath(options.workspace, input, { allowOutside: options.access === 'full' });
}

/**
 * approval 档位下写工作区外：设计契约是「请求审批后放行」，但当前 runtime 审批只到
 * 整工具粒度（needsApproval(call)/审批结论不携带路径），工具层拿不到「本路径已被放行」
 * 的结果，因此不能静默当普通错误：返回 needs_user，把限制和出路讲清楚。
 */
function outsideWriteHint(): string {
  return (
    '当前是 approval 档位，工作区外写入无法按路径放行：审批只能整工具允许，' +
    '即使用户点了允许，工具层也不会写工作区外。请改用工作区内的路径；' +
    '确需写工作区外时，请让用户在「设置 → Agent」切换到 full 档位。'
  );
}

/* ------------------------------- list_files ------------------------------- */

interface ListedEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
}

interface WalkState {
  entries: ListedEntry[];
  truncated: boolean;
}

async function walkDirectory(
  absoluteDir: string,
  root: string,
  state: WalkState,
  recursive: boolean,
  depth: number,
): Promise<void> {
  if (state.entries.length >= LIST_MAX_ENTRIES) {
    state.truncated = true;
    return;
  }
  let dirents;
  try {
    dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return;
    throw error;
  }
  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
  for (const dirent of dirents) {
    if (state.entries.length >= LIST_MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    if (dirent.name === '.git') continue;
    const absolute = path.join(absoluteDir, dirent.name);
    const display = toDisplayPath(root, absolute);
    if (dirent.isSymbolicLink()) {
      state.entries.push({ path: display, type: 'symlink' });
      continue; // 不跟随符号链接，避免逃逸与环
    }
    if (dirent.isDirectory()) {
      state.entries.push({ path: display + '/', type: 'dir' });
      if (recursive && depth < LIST_MAX_DEPTH) {
        await walkDirectory(absolute, root, state, recursive, depth + 1);
      }
      continue;
    }
    if (dirent.isFile()) {
      let size: number | undefined;
      try {
        size = (await fs.stat(absolute)).size;
      } catch {
        size = undefined;
      }
      state.entries.push({ path: display, type: 'file', size });
    }
  }
}

export async function listFilesTool(args: Record<string, unknown>, options: FsToolOptions): Promise<ToolResult> {
  const targetCheck = checkString(args, 'path', { required: false, maxLength: 4096, allowEmpty: true });
  if (!targetCheck.ok) return failed(targetCheck.message);
  const recursiveCheck = checkBoolean(args, 'recursive', false);
  if (!recursiveCheck.ok) return failed(recursiveCheck.message);

  const target = targetCheck.value ?? '.';
  const resolved = await resolveForRead(options, target);
  if (!resolved.ok) {
    return resolved.code === 'TOOL_DENIED' ? denied(resolved.message) : failed(resolved.message);
  }

  let stat;
  try {
    stat = await fs.stat(resolved.path);
  } catch {
    return failed('目录不存在或不可访问：' + target);
  }
  if (!stat.isDirectory()) {
    return failed('不是目录：' + target + '（读取文件内容请用 read_file）');
  }

  const state: WalkState = { entries: [], truncated: false };
  try {
    await walkDirectory(resolved.path, resolved.root, state, recursiveCheck.value, 0);
  } catch (error) {
    return failed('列目录失败：' + (error instanceof Error ? error.message : String(error)));
  }

  return ok(
    {
      path: toDisplayPath(resolved.root, resolved.path),
      outside: resolved.outside,
      entries: state.entries,
      count: state.entries.length,
      truncated: state.truncated,
    },
    state.truncated ? '条目超过 ' + LIST_MAX_ENTRIES + ' 个，已截断' : '',
  );
}

/* -------------------------------- read_file ------------------------------- */

/** 二进制探测：前 8KB 出现 NUL 就认为不是文本 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export async function readFileTool(args: Record<string, unknown>, options: FsToolOptions): Promise<ToolResult> {
  const targetCheck = checkString(args, 'path', { required: true, maxLength: 4096 });
  if (!targetCheck.ok) return failed(targetCheck.message);
  const fromCheck = checkNumber(args, 'from', { min: 1, max: 10_000_000, integer: true });
  if (!fromCheck.ok) return failed(fromCheck.message);
  const maxLinesCheck = checkNumber(args, 'maxLines', { min: 1, max: 2000, integer: true });
  if (!maxLinesCheck.ok) return failed(maxLinesCheck.message);

  const resolved = await resolveForRead(options, targetCheck.value as string);
  if (!resolved.ok) {
    return resolved.code === 'TOOL_DENIED' ? denied(resolved.message) : failed(resolved.message);
  }

  let stat;
  try {
    stat = await fs.stat(resolved.path);
  } catch {
    return failed('文件不存在：' + targetCheck.value);
  }
  if (stat.isDirectory()) return failed('是目录而不是文件：' + targetCheck.value + '（请用 list_files）');
  if (!stat.isFile()) return failed('不是普通文件：' + targetCheck.value);
  if (stat.size > READ_MAX_BYTES) {
    return failed(
      '文件过大（' + Math.round(stat.size / 1024 / 1024) + 'MB），超过 read_file 的 2MB 上限。请用 run_command 分段查看（如 Select-String / Get-Content -TotalCount）。',
    );
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolved.path);
  } catch (error) {
    return failed('读取失败：' + (error instanceof Error ? error.message : String(error)));
  }
  if (looksBinary(buffer)) return failed('看起来是二进制文件，拒绝按文本读取：' + targetCheck.value);

  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const allLines = text.length === 0 ? [] : text.replace(/\r\n?/g, '\n').split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  const totalLines = allLines.length;
  const from = fromCheck.value ?? 1;
  const maxLines = maxLinesCheck.value ?? 400;
  if (from > totalLines && totalLines > 0) {
    return failed('起始行 ' + from + ' 超出文件总行数 ' + totalLines + '。');
  }
  const startIndex = from - 1;
  const selected = allLines.slice(startIndex, startIndex + maxLines);
  const endLine = selected.length > 0 ? startIndex + selected.length : from - 1;
  const truncated = startIndex + selected.length < totalLines;

  return ok(
    {
      path: toDisplayPath(resolved.root, resolved.path),
      outside: resolved.outside,
      totalLines,
      from,
      to: endLine,
      text: selected.join('\n'),
      truncated,
    },
    truncated ? '文件共 ' + totalLines + ' 行，本次只返回 ' + from + '-' + endLine + ' 行' : '',
  );
}

/* -------------------------------- write_file ------------------------------ */

export async function writeFileTool(args: Record<string, unknown>, options: FsToolOptions): Promise<ToolResult> {
  const targetCheck = checkString(args, 'path', { required: true, maxLength: 4096 });
  if (!targetCheck.ok) return failed(targetCheck.message);
  const contentCheck = checkString(args, 'content', { required: true, maxLength: 5_000_000, allowEmpty: true });
  if (!contentCheck.ok) return failed(contentCheck.message);
  const createDirsCheck = checkBoolean(args, 'createDirs', true);
  if (!createDirsCheck.ok) return failed(createDirsCheck.message);
  const target = targetCheck.value as string;
  const content = contentCheck.value ?? '';

  const resolved = await resolveForWrite(options, target);
  if (!resolved.ok) {
    if (options.access === 'approval' && isOutsideDenial(resolved)) return denied(outsideWriteHint());
    return resolved.code === 'TOOL_DENIED' ? denied(resolved.message) : failed(resolved.message);
  }

  let created = false;
  try {
    await fs.access(resolved.path);
  } catch {
    created = true;
  }
  if (!created) {
    try {
      const stat = await fs.stat(resolved.path);
      if (stat.isDirectory()) return failed('目标是目录，不能写入文件：' + target);
    } catch {
      /* 交给下面 writeFile 报错 */
    }
  }

  if (createDirsCheck.value) {
    try {
      await fs.mkdir(path.dirname(resolved.path), { recursive: true });
    } catch (error) {
      return failed('创建目录失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  try {
    await fs.writeFile(resolved.path, content, 'utf8');
  } catch (error) {
    return failed('写入失败：' + (error instanceof Error ? error.message : String(error)));
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  return ok(
    {
      path: toDisplayPath(resolved.root, resolved.path),
      bytes,
      created,
      outside: resolved.outside,
    },
    created ? '已创建文件' : '已覆盖文件',
  );
}

/* ------------------------------- apply_patch ------------------------------ */

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 旧内容（上下文 + '-' 行，不含行首标记） */
  old: string[];
  /** 新内容（上下文 + '+' 行，不含行首标记） */
  next: string[];
  added: number;
  removed: number;
}

export type PatchParseResult =
  | { ok: true; filePath?: string; hunks: PatchHunk[] }
  | { ok: false; message: string };

/** 解析简化版 unified diff：支持 @@ 段头、上下文行、+/- 行与 a/ b/ 前缀 */
export function parseUnifiedPatch(patch: string): PatchParseResult {
  const rawLines = String(patch ?? '').replace(/\r\n?/g, '\n').split('\n');
  const hunks: PatchHunk[] = [];
  let filePath: string | undefined;
  let current: PatchHunk | null = null;
  let index = 0;

  const flush = () => {
    if (current) {
      hunks.push(current);
      current = null;
    }
  };

  while (index < rawLines.length) {
    const line = rawLines[index];
    const nextLine = rawLines[index + 1] ?? '';

    if (line.startsWith('--- ') && nextLine.startsWith('+++ ')) {
      flush();
      const target = nextLine.slice(4).trim().split('\t')[0];
      if (target && target !== '/dev/null') {
        const normalized = target.replace(/^[ab]\//, '');
        if (!filePath) filePath = normalized;
        else if (filePath !== normalized) {
          return { ok: false, message: '一个补丁里包含多个文件：' + filePath + ' 与 ' + normalized + '。请拆开分别应用。' };
        }
      }
      index += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      flush();
      const match = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(line);
      if (!match) return { ok: false, message: '无法解析 @@ 段头：' + line };
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        old: [],
        next: [],
        added: 0,
        removed: 0,
      };
      index += 1;
      continue;
    }

    if (current) {
      if (line.startsWith('diff --git') || line.startsWith('*** ') || (line.startsWith('--- ') && nextLine.startsWith('+++ '))) {
        flush();
        continue;
      }
      if (line === '\\ No newline at end of file') {
        index += 1;
        continue;
      }
      if (line === '') {
        if (index === rawLines.length - 1) {
          index += 1;
          continue;
        }
        current.old.push('');
        current.next.push('');
        index += 1;
        continue;
      }
      const marker = line.charAt(0);
      if (marker === ' ') {
        current.old.push(line.slice(1));
        current.next.push(line.slice(1));
      } else if (marker === '+') {
        current.next.push(line.slice(1));
        current.added += 1;
      } else if (marker === '-') {
        current.old.push(line.slice(1));
        current.removed += 1;
      } else {
        return { ok: false, message: '无法解析补丁行（应以空格 / + / - 开头）：' + line };
      }
      index += 1;
      continue;
    }

    // 段外的前导行（diff --git、index、*** Begin Patch 等）直接跳过
    index += 1;
  }

  flush();
  if (hunks.length === 0) return { ok: false, message: '补丁里没有有效的 @@ 段（格式：@@ -旧起,旧数 +新起,新数 @@）' };
  return { ok: true, filePath, hunks };
}

function linesEqual(a: string, b: string): boolean {
  return a === b || a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

function findSequence(lines: string[], pattern: string[], from: number): number {
  if (pattern.length === 0) return -1;
  const limit = lines.length - pattern.length;
  for (let start = Math.max(0, from); start <= limit; start += 1) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (!linesEqual(lines[start + offset], pattern[offset])) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/** 把 @@ 段应用到文本；保持原文件换行风格与末尾换行 */
export function applyHunksToText(
  text: string,
  hunks: PatchHunk[],
): { ok: true; text: string; added: number; removed: number } | { ok: false; message: string } {
  const source = String(text ?? '');
  const crlf = source.includes('\r\n');
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (hadFinalNewline) lines.pop();

  let cursor = 0;
  let added = 0;
  let removed = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    let at: number;
    if (hunk.old.length === 0) {
      at = Math.min(Math.max(0, hunk.oldStart), lines.length);
    } else {
      at = findSequence(lines, hunk.old, cursor);
      if (at < 0) at = findSequence(lines, hunk.old, 0);
      if (at < 0) {
        return {
          ok: false,
          message: '第 ' + (hunkIndex + 1) + ' 个 @@ 段在目标文件里找不到对应内容（以 ' + JSON.stringify(hunk.old[0] ?? '') + ' 开头的 ' + hunk.old.length + ' 行）。补丁可能与文件版本不一致。',
        };
      }
    }
    lines.splice(at, hunk.old.length, ...hunk.next);
    cursor = at + hunk.next.length;
    added += hunk.added;
    removed += hunk.removed;
  }

  let output = lines.join('\n');
  if (hadFinalNewline) output += '\n';
  if (crlf) output = output.replace(/\n/g, '\r\n');
  return { ok: true, text: output, added, removed };
}

export async function applyPatchTool(args: Record<string, unknown>, options: FsToolOptions): Promise<ToolResult> {
  const patchCheck = checkString(args, 'patch', { required: true, maxLength: PATCH_MAX_BYTES });
  if (!patchCheck.ok) return failed(patchCheck.message);
  const pathCheck = checkString(args, 'path', { required: false, maxLength: 4096 });
  if (!pathCheck.ok) return failed(pathCheck.message);

  const parsed = parseUnifiedPatch(patchCheck.value as string);
  if (!parsed.ok) return failed(parsed.message);

  const target = pathCheck.value ?? parsed.filePath;
  if (!target) return failed('补丁里没有 +++ 文件头，且未提供 path 参数。');

  const resolved = await resolveForWrite(options, target);
  if (!resolved.ok) {
    if (options.access === 'approval' && isOutsideDenial(resolved)) return denied(outsideWriteHint());
    return resolved.code === 'TOOL_DENIED' ? denied(resolved.message) : failed(resolved.message);
  }

  let original: string;
  try {
    original = await fs.readFile(resolved.path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return failed('目标文件不存在：' + target + '（新建文件请用 write_file）');
    return failed('读取目标文件失败：' + (error instanceof Error ? error.message : String(error)));
  }

  if (original.charCodeAt(0) === 0xfeff) original = original.slice(1);
  const applied = applyHunksToText(original, parsed.hunks);
  if (!applied.ok) return failed(applied.message);

  try {
    await fs.writeFile(resolved.path, applied.text, 'utf8');
  } catch (error) {
    return failed('写回补丁结果失败：' + (error instanceof Error ? error.message : String(error)));
  }

  return ok(
    {
      path: toDisplayPath(resolved.root, resolved.path),
      hunks: parsed.hunks.length,
      added: applied.added,
      removed: applied.removed,
      bytes: Buffer.byteLength(applied.text, 'utf8'),
      outside: resolved.outside,
    },
    '补丁已应用（+' + applied.added + ' / -' + applied.removed + '）',
  );
}
