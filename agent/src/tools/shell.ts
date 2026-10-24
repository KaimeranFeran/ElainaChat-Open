import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { AGENT_ERROR, fail, ok, type ToolResult } from '../errors.ts';
import { DEFAULT_LIMITS, type AgentLimits } from '../config.ts';
import { formatCommandOutput, resolveOutputLimits, type FormattedOutput } from './output.ts';
import { detectInteractive } from './command-risk.ts';
import { checkNumber, checkString } from './types.ts';
import { sanitizeRunId, writeAgentLog } from './app-paths.ts';

/**
 * shell 执行器（设计文档第 4 节）：
 * - Windows 优先 pwsh -NoProfile -NonInteractive -Command，缺 pwsh 回退
 *   powershell.exe（5.1，同样参数），再缺回退 cmd /d /s /c
 * - stdin 关闭（stdio[0] = 'ignore'），交互命令在执行前就被拒绝
 * - 超时用 taskkill /T /F 杀整棵进程树；上限 10 分钟
 * - 头 200 + 尾 50 行、合计 ≤ 8KB；完整输出写日志文件并返回路径
 */

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'sh';
export type ShellPreference = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'sh';

export interface ExecCommandOptions {
  workspace: string;
  timeoutMs?: number;
  limits?: Partial<AgentLimits>;
  shell?: ShellPreference;
  /** 日志目录（测试注入）；默认应用数据目录 agent-logs */
  logDir?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface CommandExecution {
  /** 进程正常结束且退出码为 0（超时/启动失败为 false） */
  ok: boolean;
  /** 退出码；超时或启动失败为 null（data.code 也用它） */
  code: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  shell: ShellKind;
  /** 完整输出（未截断）落盘路径；写日志失败时不返回该字段 */
  logPath?: string;
  fullOutputBytes: number;
  /** 给模型的单行结论 */
  message: string;
}

export interface ShellToolOptions {
  workspace: string;
  limits?: Partial<AgentLimits>;
  logDir?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  shell?: ShellPreference;
}

const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_TIMEOUT_MS = 100;
/** 防止一条命令占满内存；超过后仍继续排空管道，只是不再收集 */
const MAX_COLLECT_BYTES = 32 * 1024 * 1024;
/** 子进程已 exit 但管道仍被孙进程占着时，等这么久后销毁管道强制收尾 */
const CLOSE_GRACE_MS = 500;
/** 超时/取消杀掉进程树后，等这么久还不 close 就强制收尾（防止永远挂住） */
const KILL_GRACE_MS = 1500;

let cachedPwsh: boolean | null = null;
let cachedWindowsPowerShell: boolean | null = null;

function detectWindowsShell(executable: string, namePattern: RegExp): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const result = spawnSync('where.exe', [executable], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return result.status === 0 && namePattern.test(String(result.stdout ?? ''));
  } catch {
    return false;
  }
}

/** 检测 pwsh（PowerShell 7）是否可用（结果缓存；resetShellCache 供测试用） */
export function hasPwsh(): boolean {
  if (cachedPwsh === null) cachedPwsh = detectWindowsShell('pwsh', /\bpwsh(\.exe)?\b/i);
  return cachedPwsh;
}

/** 检测 Windows PowerShell 5.1（powershell.exe）是否可用 */
export function hasWindowsPowerShell(): boolean {
  if (cachedWindowsPowerShell === null) {
    cachedWindowsPowerShell = detectWindowsShell('powershell', /\bpowershell(\.exe)?\b/i);
  }
  return cachedWindowsPowerShell;
}

export function resetShellCache(): void {
  cachedPwsh = null;
  cachedWindowsPowerShell = null;
}

/** 解析实际使用的 shell：pwsh → powershell.exe(5.1) → cmd.exe */
export function resolveShell(preference: ShellPreference = 'auto'): ShellKind {
  if (process.platform !== 'win32') return preference === 'sh' ? 'sh' : 'sh';
  if (preference === 'cmd') return 'cmd';
  if (preference === 'sh') return 'sh';
  if (preference === 'pwsh') return hasPwsh() ? 'pwsh' : hasWindowsPowerShell() ? 'powershell' : 'cmd';
  if (preference === 'powershell') return hasWindowsPowerShell() ? 'powershell' : hasPwsh() ? 'pwsh' : 'cmd';
  if (hasPwsh()) return 'pwsh';
  if (hasWindowsPowerShell()) return 'powershell';
  return 'cmd';
}

function buildInvocation(command: string, shell: ShellKind): { file: string; args: string[] } {
  if (shell === 'pwsh') {
    return { file: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (shell === 'powershell') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (shell === 'cmd') {
    // 与 Node 的 shell 模式一致：整条命令外面再包一层引号，/s 会剥掉最外层，
    // 这样以 "C:\Program Files\..." 开头的命令也不会被 cmd 的引号规则吃掉
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', '"' + command + '"'] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/** Windows 控制台命令常以 OEM 代码页（中文是 GBK）输出；先按 UTF-8 解，坏了再按 GBK/GB18030 */
export function decodeOutput(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const encoding of ['gb18030', 'gbk', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      if (decoded && !decoded.includes('\uFFFD')) return decoded;
    } catch {
      /* 该运行时没有此编码，继续尝试下一个 */
    }
  }
  return utf8;
}

/**
 * 杀整棵进程树。
 *
 * 两个关键点（都是卡死/漏杀的真因）：
 * 1. 用异步 spawn 而不是 spawnSync —— 超时/取消回调里同步等 taskkill 会阻塞事件循环，
 *    期间连取消事件都无法处理；
 * 2. **不要**在 taskkill 之前直接 child.kill：父 shell 一旦先退出，taskkill /T 就找不到
 *    它的子进程，孙进程（node 等）会漏杀并继续占着 stdout/stderr 与工作目录。
 *    所以先 taskkill /T /F，800ms 后仍未退出再退化直接杀父进程兜底。
 */
function killProcessTree(pid: number | undefined, child: import('node:child_process').ChildProcess): void {
  if (pid && process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        // taskkill 本身起不来：退回直接杀父进程
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      });
      killer.unref?.();
      const fallback = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      }, 800);
      fallback.unref?.();
      return;
    } catch {
      /* 落到下面的直接 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 进程可能已退出 */
  }
}

function clampTimeout(value: number | undefined, limits: Partial<AgentLimits> | undefined): number {
  const fallback = limits?.shellTimeoutMs ?? DEFAULT_LIMITS.shellTimeoutMs;
  const raw = value === undefined || value === null || !Number.isFinite(value) ? fallback : value;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(raw)));
}

interface SpawnOutcome {
  exitCode: number | null;
  spawnError?: Error;
  stdoutBuffer: Buffer;
  stderrBuffer: Buffer;
  timedOut: boolean;
  aborted: boolean;
  shell: ShellKind;
}

/** 真正拉起子进程并收集完整输出（不截断） */
async function spawnAndCollect(command: string, options: ExecCommandOptions, timeoutMs: number): Promise<SpawnOutcome> {
  const shell = resolveShell(options.shell);
  const invocation = buildInvocation(command, shell);
  const startedAt = Date.now();

  const emptyOutcome = (aborted: boolean): SpawnOutcome => ({
    exitCode: null,
    stdoutBuffer: Buffer.alloc(0),
    stderrBuffer: Buffer.alloc(0),
    timedOut: false,
    aborted,
    shell,
  });

  // 已经取消：连 shell 都不要拉起
  if (options.signal?.aborted) return emptyOutcome(true);

  const child = spawn(invocation.file, invocation.args, {
    cwd: options.workspace,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Windows 上命令串必须原样传给 cmd /s /c；Node 默认会把它整体加引号，导致 "C:\..." 开头的命令解析错位
    windowsVerbatimArguments: process.platform === 'win32',
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_COLLECT_BYTES) stdoutChunks.push(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_COLLECT_BYTES) stderrChunks.push(chunk);
    });
  }

  let timedOut = false;
  let aborted = false;
  let settled = false;
  let exitCode: number | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let killGraceTimer: ReturnType<typeof setTimeout> | null = null;

  let finish: (outcome: SpawnOutcome) => void = () => {};
  const resultPromise = new Promise<SpawnOutcome>((resolve) => {
    finish = resolve;
  });

  const destroyStreams = (): void => {
    try {
      child.stdout?.destroy();
    } catch {
      /* 已销毁 */
    }
    try {
      child.stderr?.destroy();
    } catch {
      /* 已销毁 */
    }
  };

  const settle = (code: number | null, spawnError?: Error): void => {
    if (settled) return;
    settled = true;
    if (hardTimer) clearTimeout(hardTimer);
    if (closeGraceTimer) clearTimeout(closeGraceTimer);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    finish({
      exitCode: code,
      spawnError,
      stdoutBuffer: Buffer.concat(stdoutChunks),
      stderrBuffer: Buffer.concat(stderrChunks),
      timedOut,
      aborted,
      shell,
    });
  };

  /**
   * 超时/取消：杀进程树，并且**必须**在宽限期后强制收尾。
   * 根因：命令可能拉起继承 stdout/stderr 的孙进程（Start-Process / detached），
   * 父 shell 先退出后管道仍被占着，Node 的 'close' 永远不来；此时 taskkill 打的是
   * 已退出的父 PID，杀不掉孙进程——旧实现就这样永久挂住。
   */
  const killAndForceSettle = (): void => {
    killProcessTree(child.pid, child);
    killGraceTimer = setTimeout(() => {
      destroyStreams();
      settle(exitCode);
    }, KILL_GRACE_MS);
  };

  const onAbort = (): void => {
    if (settled) return;
    aborted = true;
    killAndForceSettle();
  };

  const onTimeout = (): void => {
    if (settled) return;
    timedOut = true;
    killAndForceSettle();
  };

  child.once('error', (error) => settle(null, error as Error));
  child.once('exit', (code) => {
    if (settled) return;
    exitCode = typeof code === 'number' ? code : null;
    // 已退出但管道还被孙进程占着（Start-Process/detached）：短暂等 'close'，拿不到就拆管道收尾
    if (!closeGraceTimer) {
      closeGraceTimer = setTimeout(() => {
        destroyStreams();
        settle(exitCode);
      }, CLOSE_GRACE_MS);
    }
  });
  child.once('close', (code) => {
    if (exitCode === null) exitCode = typeof code === 'number' ? code : null;
    settle(exitCode);
  });

  // 硬超时从「开始执行」计时（spawn 之前记 startedAt，shell 启动慢也计入），
  // 且与 stdout/stderr 是否有输出无关：零输出/卡住照样按时超时。
  hardTimer = setTimeout(onTimeout, Math.max(1, timeoutMs - (Date.now() - startedAt)));
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  return resultPromise;
}

/** 执行一条命令并返回完整结果（已截断的模型视图 + 完整日志路径） */
export async function execCommand(command: string, options: ExecCommandOptions): Promise<CommandExecution> {
  const text = String(command ?? '');
  // 超时在「开始执行前」就生效：未传时用默认 60s（DEFAULT_LIMITS.shellTimeoutMs），
  // 显式传入则夹在 100ms ~ 10min；计时从 spawn 之前开始，shell 启动慢也计入。
  const timeoutMs = clampTimeout(options.timeoutMs, options.limits);
  const limits = resolveOutputLimits(options.limits);

  let outcome: SpawnOutcome;
  try {
    outcome = await spawnAndCollect(text, options, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      code: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      shell: resolveShell(options.shell),
      fullOutputBytes: 0,
      message: '无法启动 shell：' + (error instanceof Error ? error.message : String(error)),
    };
  }

  const fullStdout = decodeOutput(outcome.stdoutBuffer);
  const fullStderr = decodeOutput(outcome.stderrBuffer);
  const formatted: FormattedOutput = formatCommandOutput(fullStdout, fullStderr, limits);
  const fullOutputBytes = Buffer.byteLength(fullStdout, 'utf8') + Buffer.byteLength(fullStderr, 'utf8');

  let logPath: string | undefined;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = 'run-' + sanitizeRunId(options.runId ?? 'adhoc') + '-' + stamp + '-' + process.pid + '.log';
    const logContent = [
      '# command: ' + text,
      '# shell: ' + outcome.shell,
      '# cwd: ' + options.workspace,
      '# timeoutMs: ' + timeoutMs,
      '# timedOut: ' + outcome.timedOut,
      '# aborted: ' + outcome.aborted,
      '# exitCode: ' + String(outcome.exitCode),
      '# spawnError: ' + (outcome.spawnError ? outcome.spawnError.message : ''),
      '',
      '--- stdout ---',
      fullStdout,
      '--- stderr ---',
      fullStderr,
      '',
    ].join('\n');
    logPath = await writeAgentLog(logContent, name, options.logDir);
  } catch {
    logPath = undefined;
  }

  const spawnFailed = Boolean(outcome.spawnError);
  // 超时/取消时进程是被杀掉的，退出码没有参考价值；统一回 null，避免模型误判成业务失败
  const normalizedExitCode = outcome.timedOut || outcome.aborted ? null : outcome.exitCode;
  const okFlag = !spawnFailed && !outcome.timedOut && !outcome.aborted && outcome.exitCode === 0;
  let message: string;
  if (spawnFailed) message = '命令启动失败：' + (outcome.spawnError?.message ?? '未知原因');
  else if (outcome.timedOut) message = '命令超时（' + timeoutMs + 'ms），已终止进程树' + (logPath ? '；完整输出：' + logPath : '');
  else if (outcome.aborted) message = '命令已取消';
  else if (outcome.exitCode !== 0) message = '命令退出码 ' + String(outcome.exitCode) + (logPath ? '；完整输出：' + logPath : '');
  else message = '';

  return {
    ok: okFlag,
    code: normalizedExitCode,
    exitCode: normalizedExitCode,
    stdout: formatted.stdout,
    stderr: formatted.stderr,
    timedOut: outcome.timedOut,
    aborted: outcome.aborted,
    truncated: formatted.truncated,
    shell: outcome.shell,
    logPath,
    fullOutputBytes,
    message,
  };
}

/**
 * run_command 工具实现：先拦交互命令，再执行，最后把退出码/超时映射成结构化 ToolResult。
 * data 形状（与设计文档对齐）：{ ok, code, stdout, stderr, timedOut, truncated, exitCode, logPath }
 */
export async function runCommandTool(args: Record<string, unknown>, options: ShellToolOptions): Promise<ToolResult> {
  const commandCheck = checkString(args, 'command', { required: true, maxLength: 20000 });
  if (!commandCheck.ok) return fail(AGENT_ERROR.TOOL_FAILED, commandCheck.message);
  const command = commandCheck.value as string;

  const timeoutCheck = checkNumber(args, 'timeoutMs', { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS, integer: true });
  if (!timeoutCheck.ok) return fail(AGENT_ERROR.TOOL_FAILED, timeoutCheck.message);

  const interactive = detectInteractive(command);
  if (interactive) {
    return fail(
      AGENT_ERROR.INTERACTIVE_BLOCKED,
      '拒绝执行交互式命令：' + interactive + '。请改用非交互写法（例如 git commit -m "..."、加 --yes 或 -NonInteractive）。',
      {
        retryable: false,
        denied: true,
        data: { command, interactive },
      },
    );
  }

  const execution = await execCommand(command, {
    workspace: options.workspace,
    timeoutMs: timeoutCheck.value,
    limits: options.limits,
    shell: options.shell,
    logDir: options.logDir,
    runId: options.runId,
    env: options.env,
    signal: options.signal,
  });

  const data = {
    ok: execution.ok,
    code: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    timedOut: execution.timedOut,
    truncated: execution.truncated,
    exitCode: execution.exitCode,
    logPath: execution.logPath,
    shell: execution.shell,
    fullOutputBytes: execution.fullOutputBytes,
  };

  if (execution.aborted) {
    return fail(AGENT_ERROR.CANCELLED, '命令已取消（用户中止或任务超时）。', { retryable: false, data });
  }
  if (execution.timedOut) {
    return fail(AGENT_ERROR.TOOL_TIMEOUT, execution.message || '命令超时，已终止进程树。', { retryable: true, data });
  }
  if (execution.exitCode === null) {
    return fail(AGENT_ERROR.TOOL_FAILED, execution.message || '命令启动失败。', { retryable: true, data });
  }
  if (execution.exitCode !== 0) {
    return fail(AGENT_ERROR.TOOL_FAILED, execution.message || '命令执行失败（退出码 ' + String(execution.exitCode) + '）。', { retryable: true, data });
  }
  return ok(data, '');
}

/** 供上层构造日志文件名用 */
export function shellLogBaseName(runId: string): string {
  return 'run-' + sanitizeRunId(runId) + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
}

/** 相对路径常量导出，方便调用方构造日志目录 */
export const AGENT_LOG_SUBDIR = path.join('agent-logs');
