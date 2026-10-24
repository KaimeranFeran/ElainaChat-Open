import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 应用数据目录约定（与 docs/agent-design.md 第 7 节一致）：
 * - 运行上下文：<appData>/agent-runs/<runId>.json（不进仓库）
 * - shell 完整输出日志：<appData>/agent-logs/*.log
 */

export const APP_DIR_NAME = 'ElainaChat';

/** 应用数据根目录：Windows 用 %LOCALAPPDATA%\\ElainaChat，其余平台用 XDG 数据目录 */
export function appDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_DIR_NAME);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_DIR_NAME);
}

/** runId 只允许安全字符：既做文件名也做 git 分支名的一部分 */
export function sanitizeRunId(runId: string): string {
  const cleaned = String(runId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return cleaned || 'run';
}

/** 确保应用数据下的子目录存在，返回绝对路径 */
export async function ensureAppSubdir(name: string, baseDir?: string): Promise<string> {
  const dir = path.join(baseDir ?? appDataDir(), name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 写 shell 完整输出日志；失败由调用方吞掉（日志不该影响命令结果） */
export async function writeAgentLog(content: string, fileName: string, baseDir?: string): Promise<string> {
  const dir = await ensureAppSubdir('agent-logs', baseDir);
  const full = path.join(dir, path.basename(fileName));
  await fs.writeFile(full, content, 'utf8');
  return full;
}
