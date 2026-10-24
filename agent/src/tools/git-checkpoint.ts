import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { appDataDir, ensureAppSubdir, sanitizeRunId } from './app-paths.ts';

/**
 * git 检查点（设计文档第 7 节）：
 * - 每个 run 一条独立分支 elaina/agent/<date>-<runId>，不推送
 * - 每次写操作前提交 [agent] step N: <摘要>；读操作不提交
 * - 运行上下文 JSON 落应用数据目录 agent-runs/<runId>.json，不进仓库
 * - 非 git 仓库时所有操作优雅返回 isRepo=false，绝不抛异常
 */

export interface GitCheckpointOptions {
  workspace: string;
  runId: string;
  /** 覆盖应用数据根目录（测试注入） */
  appDataDir?: string;
  now?: () => Date;
  gitBin?: string;
}

export interface GitState {
  isRepo: boolean;
  dirty: boolean;
  branch: string | null;
  root?: string;
  changedFiles?: number;
}

export interface GitOperationResult {
  ok: boolean;
  branch?: string | null;
  created?: boolean;
  committed?: boolean;
  commit?: string;
  message: string;
}

export interface AgentRunContext {
  runId?: string;
  createdAt?: string;
  updatedAt?: string;
  workspace?: string;
  branch?: string | null;
  git?: GitState;
  messages?: unknown[];
  toolCalls?: unknown[];
  approvals?: unknown[];
  /** reasoning 只保存 token 数，不落原文（设计文档第 10 节） */
  reasoningTokens?: number;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface GitCallResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function trimMessage(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 分支名：elaina/agent/YYYY-MM-DD-<runId>；git 分支禁用字符全部替换掉 */
export function branchNameFor(runId: string, date: Date): string {
  const day = new Date(date.getTime()).toISOString().slice(0, 10);
  const safeRun = sanitizeRunId(runId).replace(/[~^:?*[\]\\\s]+/g, '-').replace(/\.\.+/g, '.').replace(/^[.-]+|[.-]+$/g, '');
  return 'elaina/agent/' + day + '-' + (safeRun || 'run');
}

function sanitizeCommitSummary(summary: string): string {
  const text = trimMessage(summary || '自动检查点');
  return (text.length > 180 ? text.slice(0, 177) + '...' : text) || '自动检查点';
}

export class GitCheckpoint {
  readonly workspace: string;
  readonly runId: string;
  readonly appDataRoot: string;
  readonly gitBin: string;
  #now: () => Date;

  constructor(options: GitCheckpointOptions) {
    if (!options || !options.workspace) throw new Error('GitCheckpoint 需要 workspace');
    this.workspace = options.workspace;
    this.runId = options.runId || 'run';
    this.appDataRoot = options.appDataDir ?? appDataDir();
    this.gitBin = options.gitBin ?? 'git';
    this.#now = options.now ?? (() => new Date());
  }

  #runGit(args: string[], timeoutMs = 20000): Promise<GitCallResult> {
    return new Promise((resolve) => {
      execFile(
        this.gitBin,
        args,
        {
          cwd: this.workspace,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const errorCode = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
          const code = typeof errorCode === 'number' ? errorCode : error ? 1 : 0;
          resolve({
            ok: !error,
            code,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? (error ? error.message : '')),
          });
        },
      );
    });
  }

  /** isRepo / dirty / branch 查询；非仓库不报错 */
  async getState(): Promise<GitState> {
    const inside = await this.#runGit(['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return { isRepo: false, dirty: false, branch: null };
    }
    const [rootResult, branchResult, statusResult] = await Promise.all([
      this.#runGit(['rev-parse', '--show-toplevel']),
      this.#runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.#runGit(['status', '--porcelain']),
    ]);
    const statusText = statusResult.ok ? statusResult.stdout.trim() : '';
    const changedFiles = statusText ? statusText.split(/\r?\n/).filter(Boolean).length : 0;
    return {
      isRepo: true,
      dirty: changedFiles > 0,
      branch: branchResult.ok ? branchResult.stdout.trim() || null : null,
      root: rootResult.ok ? rootResult.stdout.trim() : undefined,
      changedFiles,
    };
  }

  /** 确保当前在 elaina/agent/<date>-<runId> 分支上（已存在则切换，不存在则创建） */
  async ensureBranch(runId?: string): Promise<GitOperationResult> {
    const state = await this.getState();
    if (!state.isRepo) {
      return { ok: false, branch: null, created: false, message: '工作区不是 git 仓库，无法创建 agent 分支。' };
    }
    const branch = branchNameFor(runId ?? this.runId, this.#now());
    if (state.branch === branch) {
      return { ok: true, branch, created: false, message: '已在 agent 分支上：' + branch };
    }
    const existing = await this.#runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]);
    const checkout = existing.ok
      ? await this.#runGit(['checkout', branch])
      : await this.#runGit(['checkout', '-b', branch]);
    if (!checkout.ok) {
      return {
        ok: false,
        branch: null,
        created: false,
        message: '切换到 agent 分支失败：' + trimMessage(checkout.stderr || checkout.stdout),
      };
    }
    return {
      ok: true,
      branch,
      created: !existing.ok,
      message: existing.ok ? '已切换到已有 agent 分支：' + branch : '已创建 agent 分支：' + branch,
    };
  }

  /** 写操作前的检查点提交；没有改动时 committed=false 但 ok=true */
  async commitBeforeWrite(step: number, summary: string): Promise<GitOperationResult> {
    const state = await this.getState();
    if (!state.isRepo) {
      return { ok: false, committed: false, message: '工作区不是 git 仓库：跳过检查点提交。' };
    }
    const add = await this.#runGit(['add', '-A']);
    if (!add.ok) {
      return { ok: false, committed: false, message: 'git add 失败：' + trimMessage(add.stderr || add.stdout) };
    }
    const diff = await this.#runGit(['diff', '--cached', '--quiet']);
    if (diff.ok) {
      return { ok: true, committed: false, branch: state.branch, message: '没有需要提交的改动（检查点跳过）。' };
    }
    if (diff.code !== 1) {
      return { ok: false, committed: false, message: 'git diff 检查失败：' + trimMessage(diff.stderr || diff.stdout) };
    }
    const message = '[agent] step ' + Math.max(0, Math.trunc(step)) + ': ' + sanitizeCommitSummary(summary);
    const commit = await this.#runGit(['commit', '-m', message]);
    if (!commit.ok) {
      return { ok: false, committed: false, message: 'git commit 失败：' + trimMessage(commit.stderr || commit.stdout) };
    }
    const head = await this.#runGit(['rev-parse', 'HEAD']);
    return {
      ok: true,
      committed: true,
      commit: head.ok ? head.stdout.trim() : undefined,
      branch: state.branch,
      message: '已提交检查点：' + message,
    };
  }

  /** 上下文 JSON 路径（应用数据目录，不进仓库） */
  contextPath(): string {
    return path.join(this.appDataRoot, 'agent-runs', sanitizeRunId(this.runId) + '.json');
  }

  /** 保存运行上下文快照（消息/工具调用/审批/reasoning token 数），返回落盘路径 */
  async saveContext(context: AgentRunContext = {}): Promise<string> {
    const file = this.contextPath();
    let createdAt = context.createdAt;
    if (!createdAt) {
      try {
        const existing = JSON.parse(await fs.readFile(file, 'utf8')) as AgentRunContext;
        createdAt = typeof existing.createdAt === 'string' ? existing.createdAt : undefined;
      } catch {
        createdAt = undefined;
      }
    }
    const nowIso = this.#now().toISOString();
    const payload: AgentRunContext = {
      ...context,
      runId: this.runId,
      workspace: this.workspace,
      createdAt: createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await ensureAppSubdir('agent-runs', this.appDataRoot);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  /** 读取上下文快照；不存在或损坏返回 null */
  async loadContext(): Promise<AgentRunContext | null> {
    try {
      const text = await fs.readFile(this.contextPath(), 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? (parsed as AgentRunContext) : null;
    } catch {
      return null;
    }
  }
}

export function createGitCheckpoint(options: GitCheckpointOptions): GitCheckpoint {
  return new GitCheckpoint(options);
}
