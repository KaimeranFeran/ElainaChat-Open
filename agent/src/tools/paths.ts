import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 路径安全边界（工具层唯一职责）：
 * - 相对路径按工作区根解析，绝对路径也必须在工作区内（除非调用方明确 allowOutside）
 * - 拒绝 ../ 穿越、Windows 设备路径/UNC/ADS、符号链接逃逸
 * - 工作区外的路径交给上层审批层决定（allowOutside + outside 标记），工具本身不弹审批
 *
 * 注意：这是「规范化 + 错误码」，不是完整的沙箱；真正的审批/权限由 kernel 在调用工具前完成。
 */

const IS_WIN = process.platform === 'win32';

export interface PathAllowed {
  ok: true;
  /** 解析后的绝对路径（工作区内时 = 规范化后的词法路径） */
  path: string;
  /** 工作区真实根（已解析符号链接） */
  root: string;
  /** 相对工作区的路径，根目录为 '' */
  relative: string;
  /** 是否在工作区之外（仅 allowOutside 时可能出现） */
  outside: boolean;
}

export interface PathDenied {
  ok: false;
  code: 'TOOL_DENIED' | 'TOOL_FAILED';
  message: string;
}

export type PathResolution = PathAllowed | PathDenied;

export interface ResolveOptions {
  /** 允许工作区外路径：结果带 outside=true，由上层审批决定是否放行 */
  allowOutside?: boolean;
}

function denied(code: 'TOOL_DENIED' | 'TOOL_FAILED', message: string): PathDenied {
  return { ok: false, code, message };
}

/** Windows 下大小写不敏感：比较前统一小写，但返回原始大小写 */
function comparable(value: string): string {
  return IS_WIN ? value.toLowerCase() : value;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(comparable(root), comparable(target));
  if (rel === '') return true;
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

/** 解析工作区根：必须存在且是目录，返回真实路径（解开根自身的符号链接） */
export async function resolveWorkspaceRoot(root: string): Promise<{ ok: true; root: string } | PathDenied> {
  const raw = String(root ?? '').trim();
  if (!raw) return denied('TOOL_FAILED', '工作区目录为空');
  try {
    const real = await fs.realpath(path.resolve(raw));
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return denied('TOOL_FAILED', '工作区不是目录：' + raw);
    return { ok: true, root: real };
  } catch {
    return denied('TOOL_FAILED', '工作区不存在或不可访问：' + raw);
  }
}

/** 校验非法路径形态（设备路径/UNC/盘符相对/ADS），返回 null 表示形态合法 */
function validatePathShape(input: string): string | null {
  if (input.includes('\0')) return '路径包含非法字符（NUL）';
  // \\.\ 与 \\?\ 是 Windows 设备命名空间，会绕过常规路径校验
  if (IS_WIN && /^\\\\[.?]\\/.test(input)) return '不支持 Windows 设备路径（\\\\.\\ 或 \\\\?\\）';
  if (IS_WIN && /^\\\\[^\\]/.test(input)) return '不支持 UNC 网络路径（\\\\server\\share）';
  if (IS_WIN && /^[a-zA-Z]:(?![\\/])/.test(input)) return '不支持盘符相对路径（如 C:foo）';
  // Windows 数据流 file.txt:stream —— 盘符后不允许再出现冒号
  if (IS_WIN) {
    const withoutDrive = input.replace(/^[a-zA-Z]:/, '');
    if (withoutDrive.includes(':')) return '不支持 Windows 数据流路径（路径中含冒号）';
  }
  return null;
}

/**
 * 把用户给的路径解析并校验到工作区内。
 * 返回 outside=true 只会在 allowOutside 时发生；默认一律拒绝。
 */
export async function resolveUserPath(
  root: string,
  input: string,
  options: ResolveOptions = {},
): Promise<PathResolution> {
  const rootRes = await resolveWorkspaceRoot(root);
  if (!rootRes.ok) return rootRes;
  const realRoot = rootRes.root;

  const raw = input === undefined || input === null ? '' : String(input);
  const trimmed = raw.trim();
  const candidate = trimmed === '' ? '.' : trimmed;

  if (candidate.includes('\0')) return denied('TOOL_DENIED', '路径包含非法字符（NUL）');
  const shapeError = validatePathShape(candidate);
  if (shapeError) return denied('TOOL_DENIED', shapeError);

  const absoluteInput = path.isAbsolute(candidate);
  const target = absoluteInput ? path.resolve(candidate) : path.resolve(realRoot, candidate);

  const inside = isInside(realRoot, target);
  const relative = path.relative(realRoot, target);

  if (!inside) {
    if (!options.allowOutside) {
      return denied(
        'TOOL_DENIED',
        '路径超出允许的工作区：' + candidate + '（工作区：' + realRoot + '）。如需访问工作区外的文件，请先申请审批。',
      );
    }
    return { ok: true, path: target, root: realRoot, relative, outside: true };
  }

  const symlinkCheck = await checkSymlinkEscape(realRoot, target);
  if (!symlinkCheck.ok) return symlinkCheck;

  return { ok: true, path: target, root: realRoot, relative: relative === '.' ? '' : relative, outside: false };
}

/** 逐段 lstat：任何已存在的符号链接都必须真实指向工作区内（悬空链接一律拒绝） */
async function checkSymlinkEscape(root: string, target: string): Promise<{ ok: true } | PathDenied> {
  const rel = path.relative(root, target);
  if (!rel) return { ok: true };
  const parts = rel.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: true }; // 尚未创建的部分不存在，无符号链接可逃逸
      return denied('TOOL_FAILED', '无法检查路径：' + current);
    }
    if (!stat.isSymbolicLink()) continue;
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch {
      return denied('TOOL_DENIED', '拒绝访问悬空符号链接：' + current);
    }
    if (!isInside(root, real)) {
      return denied('TOOL_DENIED', '符号链接逃逸出工作区：' + current + ' -> ' + real);
    }
    current = real;
  }
  return { ok: true };
}

/** 展示用相对路径（统一 / 分隔，跨平台一致） */
export function toDisplayPath(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath);
  return rel.split(path.sep).join('/') || '.';
}
