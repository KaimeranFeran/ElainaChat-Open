/**
 * sidecar 入口：stdio NDJSON 主循环（esbuild entry，见 scripts/build-agent.mjs）。
 *
 * 三层职责，刻意分开：
 * 1. 本文件只做「协议 ↔ runtime」的翻译：hello→ready、run→runAgent、cancel→abort、
 *    approval_response→resolve。非法消息回 error，绝不崩进程（设计文档第 3 节）。
 * 2. 工具/模型的具体接线放在 createDefaultRun（main() 里用），便于 P2 工具层落地后替换。
 * 3. stdout 只写 NDJSON；诊断信息一律写 stderr —— 否则会污染宿主解析。
 *
 * 即使用户在终端里直接 `node src/index.ts`，也走同一套协议（stdin 喂 JSON 行）。
 */
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIMITS, validateAgentConfig, type AgentAccess, type AgentConfig, type AgentModelConfig, type AgentProtocol } from './config.ts';
import { AGENT_ERROR, fail, type ToolResult } from './errors.ts';
import {
  createKernel,
  installPlugin,
  validatePluginManifest,
  type Context,
  type JsonSchema,
  type Kernel,
  type Plugin,
  type PluginManifest,
  type ToolSpec,
} from './kernel/index.ts';
import { AGENT_API_VERSION } from './kernel/plugin.ts';
import { createModelAdapter, type ModelAdapter } from './model/index.ts';
import type { ToolCall, ToolSpecForModel } from './model/types.ts';
import { NdjsonDecoder, encodeMessage, type AgentMessage } from './protocol/ndjson.ts';
import {
  describeCall,
  FINISH_TOOL_NAME,
  runAgent,
  type ApprovalDecision,
  type NeedsApproval,
  type RequestApproval,
  type RuntimeEvent,
  type ToolExecutor,
} from './runtime/runtime.ts';
import type { GitCheckpoint } from './tools/git-checkpoint.ts';
import type { AgentTool } from './tools/types.ts';

export {
  AGENT_ERROR,
  ok,
  fail,
  type AgentErrorCode,
  type ToolResult,
} from './errors.ts';

export {
  DEFAULT_LIMITS,
  validateAgentConfig,
  type AgentAccess,
  type AgentConfig,
  type AgentLimits,
  type AgentModelConfig,
  type AgentProtocol,
} from './config.ts';

export { MAX_LINE_BYTES, NdjsonDecoder, encodeMessage, type AgentMessage } from './protocol/ndjson.ts';

export { checkAgentBaseUrl, type BlocklistVerdict } from './security/gateway-blocklist.ts';

/** sidecar 版本；P4 打包时由 build-agent.mjs 写入 agent-version.json，这里是与 app 绑定的兜底值 */
export const AGENT_VERSION = '0.1.0';

/** run 消息（设计文档第 3 节：runId / goal / workspace / access / model / search） */
export interface RunRequest {
  runId: string;
  goal: string;
  workspace: string;
  access: AgentAccess;
  model?: Partial<AgentModelConfig>;
  search?: AgentConfig['search'];
}

export interface RunContext {
  onEvent: (event: RuntimeEvent) => void;
  requestApproval: RequestApproval;
  signal: AbortSignal;
}

/** 由 main() 注入：拿到 run 请求后创建 adapter/tools 并跑 runAgent */
export type CreateRun = (request: RunRequest, context: RunContext) => Promise<void>;

export interface AgentServerOptions {
  /** 写一行 NDJSON（生产：process.stdout.write；测试：数组） */
  write: (line: string) => void;
  createRun: CreateRun;
  agentVersion?: string;
  agentApiVersion?: string;
  /** 审批超时；超时按拒绝处理（设计文档第 5 节） */
  approvalTimeoutMs?: number;
  /** ready 里上报的工具清单 */
  listTools?: () => Array<{ name: string; description?: string }>;
  /** 设置页「测试连接」：注入搜索测试实现（main 里接 web-search.ts；测试可离线注入） */
  searchTest?: SearchTestRunner;
}

/** search_test 请求（UI 设置页传入当前表单值，不落盘） */
export interface SearchTestRequest {
  requestId: string;
  provider: 'tavily' | 'brave' | 'custom';
  apiKey?: string;
  endpoint?: string;
}

export type SearchTestRunner = (request: SearchTestRequest) => Promise<{ ok: boolean; message: string }>;

export interface AgentServer {
  /** 喂一行输入（可带/不带换行，内部统一按 NDJSON 处理） */
  handleLine(line: string): void;
  handleMessage(message: AgentMessage): void;
  dispose(): void;
  readonly activeRunId: string | null;
  readonly pendingApprovalCount: number;
}

interface PendingApproval {
  settle: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  finished: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAccess(value: unknown): value is AgentAccess {
  return value === 'approval' || value === 'full';
}

function isDecision(value: unknown): value is ApprovalDecision {
  return value === 'once' || value === 'task' || value === 'always' || value === 'deny';
}

/** run 消息的字段校验：失败返回 null，由调用方回 error（非法消息不崩） */
export function parseRunRequest(message: AgentMessage): RunRequest | null {
  const runId = typeof message.runId === 'string' ? message.runId.trim() : '';
  const goal = typeof message.goal === 'string' ? message.goal : '';
  const workspace = typeof message.workspace === 'string' ? message.workspace.trim() : '';
  if (!runId || runId.length > 200) return null;
  if (!goal.trim()) return null;
  if (!workspace) return null;
  const access = message.access === undefined ? 'approval' : message.access;
  if (!isAccess(access)) return null;

  let model: Partial<AgentModelConfig> | undefined;
  if (message.model !== undefined) {
    if (!isRecord(message.model)) return null;
    model = {};
    const protocol = message.model.protocol;
    const baseUrl = message.model.baseUrl;
    const modelName = message.model.model;
    const apiKey = message.model.apiKey;
    if (protocol !== undefined) {
      if (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'openai-responses') return null;
      model.protocol = protocol as AgentProtocol;
    }
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string') return null;
      model.baseUrl = baseUrl;
    }
    if (modelName !== undefined) {
      if (typeof modelName !== 'string') return null;
      model.model = modelName;
    }
    if (apiKey !== undefined) {
      if (typeof apiKey !== 'string') return null;
      model.apiKey = apiKey;
    }
  }

  const search = message.search;
  if (search !== undefined && !isRecord(search)) return null;

  return {
    runId,
    goal,
    workspace,
    access,
    model,
    search: search as AgentConfig['search'],
  };
}

/**
 * 创建协议服务。不读写 stdio：输入靠 handleLine/handleMessage，输出靠 options.write，
 * 所以单测可以完全离线跑（见 test/runtime.test.ts 的协议部分）。
 */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const agentVersion = options.agentVersion ?? AGENT_VERSION;
  const agentApiVersion = options.agentApiVersion ?? AGENT_API_VERSION;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_LIMITS.approvalTimeoutMs;

  const decoder = new NdjsonDecoder();
  const pending = new Map<string, PendingApproval>();
  let activeRun: ActiveRun | null = null;
  let disposed = false;

  const writeMessage = (message: AgentMessage): void => {
    if (disposed) return;
    try {
      options.write(encodeMessage(message));
    } catch {
      /* 宿主管道断开：丢掉这一行，不让 sidecar 崩 */
    }
  };

  const writeError = (code: string, message: string, runId?: string): void => {
    writeMessage(runId ? { type: 'error', runId, code, message } : { type: 'error', code, message });
  };

  const settleApproval = (id: string, decision: ApprovalDecision): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.settle(decision);
    return true;
  };

  const cancelAllApprovals = (): void => {
    for (const id of [...pending.keys()]) settleApproval(id, 'deny');
  };

  const requestApproval: RequestApproval = (request, signal) =>
    new Promise<ApprovalDecision>((resolve) => {
      if (disposed || !activeRun || activeRun.finished) {
        resolve('deny');
        return;
      }
      const id = String(request.id);
      let settled = false;
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        resolve(decision);
      };
      const timer = setTimeout(() => {
        settleApproval(id, 'deny');
      }, approvalTimeoutMs);
      const onAbort = (): void => {
        settleApproval(id, 'deny');
      };
      pending.set(id, { settle, timer, signal, onAbort });
      if (signal) {
        if (signal.aborted) {
          settleApproval(id, 'deny');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      writeMessage({ type: 'approval_request', id, tool: request.tool, action: request.action, detail: request.detail });
    });

  /** runtime 事件 → NDJSON 行；迟到（旧 run）的事件直接丢弃 */
  const forwardEvent = (run: ActiveRun, event: RuntimeEvent): void => {
    // 终止事件之后不再转发：防止上层重复收尾（例如 error 之后又收到 finish）
    if (activeRun !== run || run.finished) return;
    switch (event.type) {
      case 'chunk':
        writeMessage({ type: 'chunk', runId: run.runId, text: event.text });
        return;
      case 'step':
        writeMessage({ type: 'step', runId: run.runId, index: event.index, tool: event.tool, argsSummary: event.argsSummary });
        return;
      case 'tool_result':
        writeMessage({
          type: 'tool_result',
          runId: run.runId,
          // index 与 step 事件一致，UI 用它精确匹配步骤条
          index: event.index,
          tool: event.tool,
          ok: event.ok,
          code: event.code,
          message: event.message,
          data: event.data,
          denied: event.denied,
          retryable: event.retryable,
        });
        return;
      case 'usage':
        writeMessage({ type: 'usage', runId: run.runId, tokens: event.tokens });
        return;
      case 'finish':
        run.finished = true;
        writeMessage({
          type: 'finish',
          runId: run.runId,
          status: event.status,
          summary: event.summary,
          steps: event.steps,
          durationMs: event.durationMs,
          usage: event.usage,
        });
        return;
      case 'stalled':
        run.finished = true;
        writeMessage({ type: 'stalled', runId: run.runId, reason: event.reason, message: event.message, steps: event.steps, durationMs: event.durationMs });
        // 宿主以 finish 作为终止信号：stalled 之后再补一条 finish，避免 UI 一直转圈
        writeMessage({ type: 'finish', runId: run.runId, status: 'blocked', summary: event.message, steps: event.steps, durationMs: event.durationMs });
        return;
      case 'cancelled':
        run.finished = true;
        writeMessage({ type: 'cancelled', runId: run.runId, message: event.message, steps: event.steps, durationMs: event.durationMs });
        writeMessage({ type: 'finish', runId: run.runId, status: 'blocked', summary: event.message, steps: event.steps, durationMs: event.durationMs });
        return;
      case 'error':
        run.finished = true;
        writeMessage({ type: 'error', runId: run.runId, code: event.code, message: event.message, steps: event.steps, durationMs: event.durationMs });
        writeMessage({ type: 'finish', runId: run.runId, status: 'blocked', summary: event.message, steps: event.steps, durationMs: event.durationMs });
        return;
      default:
        return;
    }
  };

  const handleHello = (message: AgentMessage): void => {
    const offered = typeof message.agentApiVersion === 'string' ? message.agentApiVersion : agentApiVersion;
    if (offered !== agentApiVersion) {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, 'agentApiVersion 不匹配：需要 ' + agentApiVersion + '，收到 ' + offered + '。');
      return;
    }
    const tools = options.listTools ? options.listTools() : [{ name: FINISH_TOOL_NAME, description: '显式结束并汇报。' }];
    writeMessage({ type: 'ready', agentVersion, agentApiVersion, tools });
  };

  const handleRun = (message: AgentMessage): void => {
    const request = parseRunRequest(message);
    if (!request) {
      writeError(
        AGENT_ERROR.PROTOCOL_INVALID,
        'run 消息非法：需要 runId（非空）、goal（非空）、workspace（非空），access 只能是 approval/full，model 字段类型必须正确。',
        typeof message.runId === 'string' ? message.runId : undefined,
      );
      return;
    }
    if (activeRun) {
      writeError('RUN_BUSY', '已有任务在运行（' + activeRun.runId + '）；先 cancel 或等它结束。', request.runId);
      return;
    }

    const run: ActiveRun = { runId: request.runId, controller: new AbortController(), finished: false };
    activeRun = run;
    const context: RunContext = {
      onEvent: (event) => {
        if (activeRun === run) forwardEvent(run, event);
      },
      requestApproval,
      signal: run.controller.signal,
    };

    void (async () => {
      try {
        await options.createRun(request, context);
        if (!run.finished && activeRun === run) {
          const summary = '任务结束但没有产生 finish/stalled/cancelled 事件（内部错误）。';
          writeError('RUN_FAILED', summary, request.runId);
          writeMessage({ type: 'finish', runId: request.runId, status: 'blocked', summary });
        }
      } catch (error) {
        if (!run.finished && activeRun === run) {
          const summary = '任务异常结束：' + errorMessage(error);
          writeError('RUN_FAILED', summary, request.runId);
          writeMessage({ type: 'finish', runId: request.runId, status: 'blocked', summary });
        }
      } finally {
        cancelAllApprovals();
        if (activeRun === run) {
          run.finished = true;
          activeRun = null;
        }
      }
    })();
  };

  const handleCancel = (message: AgentMessage): void => {
    const runId = typeof message.runId === 'string' ? message.runId : '';
    if (!activeRun) return; // 已经结束：cancel 静默忽略（宿主可能在 finish 之后才发）
    if (runId && runId !== activeRun.runId) return;
    activeRun.controller.abort();
  };

  const handleApprovalResponse = (message: AgentMessage): void => {
    const id = typeof message.id === 'string' ? message.id : '';
    const decision = message.decision;
    if (!id || !isDecision(decision)) {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, 'approval_response 非法：需要 id（非空）与 decision（once/task/always/deny）。');
      return;
    }
    if (!settleApproval(id, decision)) {
      writeError('APPROVAL_NOT_FOUND', '审批请求不存在或已超时：' + id);
    }
  };

  const handleSearchTest = (message: AgentMessage): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const provider = message.provider;
    if (!requestId || (provider !== 'tavily' && provider !== 'brave' && provider !== 'custom')) {
      // 失败也要回，不能静默：UI 靠 requestId 关掉 loading
      writeMessage({
        type: 'search_test_result',
        requestId,
        ok: false,
        message: 'search_test 消息非法：需要 requestId 与 provider（tavily / brave / custom）。',
      });
      return;
    }
    const request: SearchTestRequest = {
      requestId,
      provider,
      apiKey: typeof message.apiKey === 'string' ? message.apiKey : undefined,
      endpoint: typeof message.endpoint === 'string' ? message.endpoint : undefined,
    };
    const runner = options.searchTest;
    if (!runner) {
      writeMessage({ type: 'search_test_result', requestId, ok: false, message: '搜索测试未接线（宿主未注入 searchTest）。' });
      return;
    }
    void (async () => {
      let ok = false;
      let text = '';
      try {
        const result = await runner(request);
        ok = Boolean(result.ok);
        text = String(result.message ?? '');
      } catch (error) {
        ok = false;
        text = '搜索测试失败：' + errorMessage(error);
      }
      if (text) text = redactSecrets(text, request.apiKey);
      writeMessage({ type: 'search_test_result', requestId, ok, message: text });
    })();
  };

  const handleMessage = (message: AgentMessage): void => {
    if (disposed) return;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, '消息必须是带 type 字段的对象。');
      return;
    }
    switch (message.type) {
      case 'hello':
        handleHello(message);
        return;
      case 'run':
        handleRun(message);
        return;
      case 'cancel':
        handleCancel(message);
        return;
      case 'approval_response':
        handleApprovalResponse(message);
        return;
      case 'search_test':
        handleSearchTest(message);
        return;
      default:
        writeError(AGENT_ERROR.PROTOCOL_INVALID, '未知消息类型：' + message.type);
        return;
    }
  };

  /** 解码器抛错后把同批剩余行继续冲出来，避免一条坏行吃掉后面的好行 */
  const drainDecoder = (): void => {
    for (let guard = 0; guard < 64; guard += 1) {
      try {
        const rest = decoder.push('');
        if (rest.length === 0) return;
        for (const message of rest) {
          try {
            handleMessage(message);
          } catch (error) {
            writeError(AGENT_ERROR.PROTOCOL_INVALID, '消息处理失败：' + errorMessage(error), typeof message.runId === 'string' ? message.runId : undefined);
          }
        }
      } catch {
        /* 又一个坏行：已经消费掉，继续冲 */
      }
    }
  };

  return {
    handleLine(line: string): void {
      let messages: AgentMessage[];
      try {
        messages = decoder.push(String(line ?? '') + '\n');
      } catch (error) {
        writeError(AGENT_ERROR.PROTOCOL_INVALID, '无法解析的输入行：' + errorMessage(error));
        drainDecoder();
        return;
      }
      for (const message of messages) {
        try {
          handleMessage(message);
        } catch (error) {
          writeError(AGENT_ERROR.PROTOCOL_INVALID, '消息处理失败：' + errorMessage(error), typeof message.runId === 'string' ? message.runId : undefined);
        }
      }
    },
    handleMessage,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (activeRun) {
        activeRun.controller.abort();
        activeRun = null;
      }
      cancelAllApprovals();
    },
    get activeRunId(): string | null {
      return activeRun ? activeRun.runId : null;
    },
    get pendingApprovalCount(): number {
      return pending.size;
    },
  };
}

interface BuiltinToolSpecLike {
  name: string;
  description: string;
  parameters: unknown;
  risk?: string;
}

interface ExecutorLikeObject {
  execute?: (name: string, args: unknown, callOptions?: { signal?: AbortSignal }) => Promise<ToolResult>;
  specs?: AgentTool[];
  has?: (name: string) => boolean;
  riskFor?: (name: string, args?: unknown) => string;
}

/** P2 工具层的入口形状；版本差异在 createDefaultRun 里做兼容（对象执行器 / 函数执行器都支持） */
interface BuiltinToolModule {
  builtinToolSpecs?: BuiltinToolSpecLike[];
  createToolExecutor?: (options: {
    workspace: string;
    access: AgentAccess;
    search?: AgentConfig['search'];
    signal?: AbortSignal;
    runId?: string;
  }) => unknown;
  isSearchAvailable?: (search?: AgentConfig['search']) => boolean;
}

/** 工具层是 P2 的交付物：没就绪时降级为「只有 finish」，不要因此拒绝启动 */
async function loadToolsModule(): Promise<{ module: BuiltinToolModule | null; error: string | null }> {
  try {
    const loaded = (await import('./tools/index.ts')) as unknown as BuiltinToolModule;
    return { module: loaded, error: null };
  } catch (error) {
    return { module: null, error: errorMessage(error) };
  }
}

/** 插件目录：默认 <LOCALAPPDATA>\ElainaChat\agent-plugins；ELAINA_AGENT_PLUGINS 可覆盖（测试/便携版） */
export function resolvePluginDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.ELAINA_AGENT_PLUGINS ?? '').trim();
  if (override) return path.resolve(override);
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'ElainaChat', 'agent-plugins');
  }
  const base = env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'ElainaChat', 'agent-plugins');
}

/** 与 kernel/plugin.ts 的 manifest 校验保持同一套规则：读文件 + JSON 解析只是宿主职责 */
export async function readPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const raw = await readFile(path.join(pluginDir, 'manifest.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('manifest.json 不是合法 JSON');
  }
  const invalid = validatePluginManifest(parsed);
  if (invalid) throw invalid;
  return parsed as PluginManifest;
}

const PLUGIN_ENTRY_FILES = ['index.mjs', 'index.js', 'main.mjs', 'main.js'];

async function findPluginEntry(pluginDir: string): Promise<string | null> {
  for (const name of PLUGIN_ENTRY_FILES) {
    const candidate = path.join(pluginDir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return null;
}

export interface PluginLoadResult {
  directory: string;
  /** 加载成功的 manifest.id */
  loaded: string[];
  /** 加载失败的目录名（失败隔离：只写 stderr，不影响内置工具） */
  failed: string[];
}

export interface PluginLoadOptions {
  log?: (message: string) => void;
  /** 日志脱敏用的密钥（绝不把 Key 写进 stderr） */
  secret?: string;
}

/**
 * 扫描插件目录并逐个安装。设计文档第 8 节：
 * - 目录即插件（zip 解压即可）：<dir>/<id>/manifest.json + index.mjs|index.js；
 * - 失败隔离：单个插件 manifest 非法 / 入口抛错，只记录到 failed 并写 stderr；
 * - 注册面由 kernel/plugin.ts 的 installPlugin 收窄（只能 ctx.tools.register，工具名与权限必须预声明）。
 */
export async function loadPluginsFromDirectory(
  kernel: Kernel,
  directory: string,
  options: PluginLoadOptions = {},
): Promise<PluginLoadResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(redactSecrets(message, options.secret) + '\n'));
  const result: PluginLoadResult = { directory, loaded: [], failed: [] };

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 没装插件是正常状态，不是错误
    if (code !== 'ENOENT') log('[agent] 插件目录不可读：' + directory + '（' + errorMessage(error) + '）');
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDir = path.join(directory, entry.name);
    try {
      const manifest = await readPluginManifest(pluginDir);
      const entryFile = await findPluginEntry(pluginDir);
      if (!entryFile) throw new Error('缺少入口文件（index.mjs / index.js / main.mjs / main.js）');
      const module = (await import(pathToFileURL(entryFile).href)) as { apply?: unknown; default?: unknown };
      const apply = typeof module.apply === 'function' ? module.apply : typeof module.default === 'function' ? module.default : null;
      if (!apply) throw new Error('插件入口必须导出 apply(api) 或 default 函数');
      const installed = await installPlugin(kernel, manifest, async (api) => {
        await (apply as (pluginApi: unknown) => unknown)(api);
      });
      if (!installed.ok) throw installed.error ?? new Error('插件安装失败');
      result.loaded.push(manifest.id);
    } catch (error) {
      result.failed.push(entry.name);
      log('[agent] 插件加载失败 ' + entry.name + '：' + errorMessage(error));
    }
  }
  return result;
}

/**
 * 内置工具以 cordis 插件形式注册进 ToolsService（设计文档第 8 节的内核落点）。
 * 注意：这里只注册「声明」，执行仍由 P2 的执行器（createToolExecutor）负责，不重复实现一遍。
 */
export async function registerBuiltinTools(
  kernel: Kernel,
  specs: BuiltinToolSpecLike[],
): Promise<{ ok: boolean; count: number; error?: string }> {
  const usable: BuiltinToolSpecLike[] = [];
  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string' || spec.name === FINISH_TOOL_NAME) continue;
    if (typeof spec.description !== 'string' || !spec.description.trim() || !spec.parameters) continue;
    usable.push(spec);
  }

  const plugin = {
    name: 'builtin-tools',
    inject: ['tools'],
    apply(ctx: Context): void {
      for (const spec of usable) {
        ctx.tools.register({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters as unknown as JsonSchema,
        });
      }
    },
  } as unknown as Plugin;

  const result = await kernel.install(plugin);
  return { ok: result.ok, count: result.ok ? usable.length : 0, error: result.error?.message };
}

/** 内核已注册工具的快照；内核/插件异常时返回空数组（ready 仍要能回） */
export function kernelToolSpecs(kernel: Kernel | null): ToolSpec[] {
  if (!kernel) return [];
  try {
    return kernel.ctx.tools.list();
  } catch {
    return [];
  }
}

/** ready 上报的工具清单：以 kernel ToolsService 为唯一权威来源，内核不可用时退回静态声明 */
export function readyToolList(
  kernel: Kernel | null,
  toolsModule: BuiltinToolModule | null,
  search?: AgentConfig['search'],
): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  const list: Array<{ name: string; description: string }> = [];
  const add = (name: string, description: string): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    list.push({ name, description });
  };

  add(FINISH_TOOL_NAME, '显式结束并汇报。');

  const registered = kernelToolSpecs(kernel);
  if (registered.length > 0) {
    for (const spec of registered) add(spec.name, spec.description || '');
    return list;
  }

  // 兜底：kernel 未就绪（工具层缺失 / 注册失败）时用静态声明，并按搜索 Key 可用性过滤
  let searchAvailable = true;
  if (toolsModule && typeof toolsModule.isSearchAvailable === 'function') {
    try {
      searchAvailable = Boolean(toolsModule.isSearchAvailable(search));
    } catch {
      searchAvailable = false;
    }
  }
  const declared = toolsModule && Array.isArray(toolsModule.builtinToolSpecs) ? toolsModule.builtinToolSpecs : [];
  for (const spec of declared) {
    if (!spec || typeof spec.name !== 'string') continue;
    if (spec.name === 'web_search' && !searchAvailable) continue;
    add(spec.name, typeof spec.description === 'string' ? spec.description : '');
  }
  return list;
}

/** 密钥脱敏：stderr 诊断里绝不出现 key（官方 KEY 与用户 KEY 都不行） */
export function redactSecrets(text: string, secret?: string): string {
  let result = String(text ?? '');
  const trimmed = String(secret ?? '').trim();
  if (trimmed) result = result.split(trimmed).join('***');
  result = result.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  result = result.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***');
  return result;
}

/**
 * 设置页「测试连接」的真实实现：复用 tools/web-search.ts 的 provider 逻辑发一次最小查询，
 * 不写配置、不缓存 Key；失败必须返回 ok:false + 可读原因（UI 需要反馈）。
 */
export async function runSearchTest(request: SearchTestRequest): Promise<{ ok: boolean; message: string }> {
  const search: AgentConfig['search'] = {
    provider: request.provider,
    apiKey: request.apiKey,
    url: request.endpoint,
  };
  try {
    const webSearch = await import('./tools/web-search.ts');
    const result = await webSearch.webSearchTool(
      { query: 'ElainaChat search connectivity test', maxResults: 1 },
      { search, timeoutMs: 10000 },
    );
    if (result.ok) {
      const data = result.data as { count?: number } | undefined;
      const count = data && typeof data.count === 'number' ? data.count : 0;
      return { ok: true, message: '搜索连接正常（provider=' + request.provider + '，返回 ' + count + ' 条结果）。' };
    }
    return { ok: false, message: result.message };
  } catch (error) {
    return { ok: false, message: '搜索测试失败：' + errorMessage(error) };
  }
}

/**
 * 从环境读取 agent 配置：ELAINA_AGENT_CONFIG 既可以是 JSON 文本，也可以是 JSON 文件路径。
 * 凭据只从配置来；run 消息里的 model 只能覆盖 protocol/baseUrl/model。
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig | null {
  const raw = String(env.ELAINA_AGENT_CONFIG ?? '').trim();
  if (!raw) return null;
  let text = raw;
  if (!raw.startsWith('{')) {
    try {
      text = readFileSync(raw, 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return parsed as unknown as AgentConfig;
  } catch {
    return null;
  }
}

/** 默认接线：配置校验 → 模型 adapter → 工具层 → runAgent */
export async function createDefaultRun(
  request: RunRequest,
  context: RunContext,
  baseConfig: AgentConfig | null,
  toolsModule: BuiltinToolModule | null,
  kernel: Kernel | null = null,
): Promise<void> {
  const merged: AgentConfig = {
    enabled: true,
    access: request.access,
    workspace: request.workspace,
    model: {
      protocol: (request.model?.protocol ?? baseConfig?.model?.protocol ?? 'openai') as AgentProtocol,
      baseUrl: request.model?.baseUrl ?? baseConfig?.model?.baseUrl ?? '',
      /* run 消息里的 key 优先：宿主每次 run 都带完整凭据，环境变量只作为兜底 */
      apiKey: request.model?.apiKey ?? baseConfig?.model?.apiKey ?? '',
      model: request.model?.model ?? baseConfig?.model?.model ?? '',
      textProtocolFallback: baseConfig?.model?.textProtocolFallback,
    },
    search: request.search ?? baseConfig?.search,
  };

  const invalid = validateAgentConfig(merged);
  if (invalid) {
    // 配置缺失是「需要用户处理」，只发一个终止事件；多发 error 会让宿主收到两条收尾
    context.onEvent({ type: 'finish', runId: request.runId, status: 'need_user', summary: invalid.message, steps: 0, durationMs: 0 });
    return;
  }

  let adapter: ModelAdapter;
  try {
    adapter = createModelAdapter(
      merged.model.protocol,
      {
        baseUrl: merged.model.baseUrl,
        apiKey: merged.model.apiKey,
        model: merged.model.model,
      },
      Boolean(merged.model.textProtocolFallback),
    );
  } catch (error) {
    const summary = '模型适配器创建失败：' + errorMessage(error);
    context.onEvent({ type: 'finish', runId: request.runId, status: 'need_user', summary, steps: 0, durationMs: 0 });
    return;
  }

  let executeTool: ToolExecutor | null = null;
  let executorSpecs: AgentTool[] | null = null;
  let executorRisk: ((call: ToolCall) => string) | null = null;
  let executorHas: ((name: string) => boolean) | null = null;

  if (toolsModule && typeof toolsModule.createToolExecutor === 'function') {
    try {
      const created = toolsModule.createToolExecutor({
        workspace: merged.workspace,
        access: merged.access,
        search: merged.search,
        signal: context.signal,
        runId: request.runId,
      });
      if (typeof created === 'function') {
        // 兼容形态 A：createToolExecutor 直接返回 (call) => Promise<ToolResult>
        const callable = created as (call: ToolCall) => Promise<ToolResult>;
        executeTool = async (call) => callable(call);
      } else if (created && typeof created === 'object') {
        // 兼容形态 B（P2 实际交付）：执行器对象 { execute(name,args), specs, riskFor }
        const executor = created as ExecutorLikeObject;
        if (Array.isArray(executor.specs)) executorSpecs = executor.specs;
        if (typeof executor.execute === 'function') {
          executeTool = async (call) => executor.execute!(call.name, call.args, { signal: context.signal });
        }
        if (typeof executor.riskFor === 'function') {
          executorRisk = (call) => String(executor.riskFor!(call.name, call.args));
        }
        if (typeof executor.has === 'function') {
          executorHas = (name) => Boolean(executor.has!(name));
        }
      }
    } catch (error) {
      process.stderr.write(redactSecrets('[agent] 工具执行器创建失败：' + errorMessage(error), merged.model.apiKey) + '\n');
    }
  }
  if (!executeTool) {
    executeTool = async (call: ToolCall): Promise<ToolResult> =>
      fail(AGENT_ERROR.TOOL_FAILED, '工具层未就绪，暂时无法执行 ' + call.name + '。', { needs_user: true });
  }

  // 已注册但没有执行通道的工具（目前是第三方插件工具）给出明确结构化失败，而不是假装执行
  if (executorHas) {
    const runTool = executeTool;
    const hasTool = executorHas;
    executeTool = async (call: ToolCall): Promise<ToolResult> => {
      if (!hasTool(call.name)) {
        return fail(
          AGENT_ERROR.TOOL_FAILED,
          '工具 ' + call.name + ' 已注册但没有可用的执行通道（第三方插件执行在 MVP 之后接入）。请改用内置工具，或用 finish 说明缺口。',
        );
      }
      return runTool(call);
    };
  }

  // git 检查点（设计文档第 7 节）：写操作前 ensureBranch + commitBeforeWrite；
  // 任何 git 失败只写 stderr，绝不阻断任务。
  let checkpoint: GitCheckpoint | null = null;
  try {
    const gitModule = await import('./tools/git-checkpoint.ts');
    checkpoint = gitModule.createGitCheckpoint({ workspace: merged.workspace, runId: request.runId });
  } catch (error) {
    process.stderr.write(redactSecrets('[agent] git 检查点不可用（不影响任务）：' + errorMessage(error), merged.model.apiKey) + '\n');
  }
  const checkpointInstance = checkpoint;

  // 工具清单：内核 ToolsService 是权威来源（含插件声明）；内核不可用时退回执行器/静态声明
  const registered = kernelToolSpecs(kernel);
  const declared = toolsModule && Array.isArray(toolsModule.builtinToolSpecs) ? toolsModule.builtinToolSpecs : [];

  const riskByName = new Map<string, string>();
  for (const spec of declared) {
    if (!spec || typeof spec.name !== 'string') continue;
    riskByName.set(spec.name, String(spec.risk ?? 'mutating'));
  }

  const sourceSpecs: Array<{ name: string; description: string; parameters: unknown; risk?: string }> =
    registered.length > 0 ? registered : (executorSpecs ?? declared);

  const tools: ToolSpecForModel[] = [];
  for (const spec of sourceSpecs) {
    if (!spec || typeof spec.name !== 'string' || typeof spec.description !== 'string' || !spec.description) continue;
    if (!spec.parameters) continue;
    if (spec.name === FINISH_TOOL_NAME) continue;
    tools.push({
      name: spec.name,
      description: spec.description,
      // 工具层的 JsonSchemaObject 与模型层 JsonSchema 同形，只是索引签名写法不同
      parameters: spec.parameters as unknown as ToolSpecForModel['parameters'],
    });
  }

  // 审批判定：full 不逐次确认；approval 档位下只有 safe 工具自动放行，未知工具按变更类处理
  const needsApproval: NeedsApproval = (call) => {
    if (merged.access === 'full') return false;
    if (executorRisk) return executorRisk(call) !== 'safe';
    return (riskByName.get(call.name) ?? 'mutating') !== 'safe';
  };

  await runAgent(
    { runId: request.runId, goal: request.goal },
    {
      config: merged,
      adapter,
      tools,
      access: merged.access,
      workspace: merged.workspace,
      executeTool,
      requestApproval: context.requestApproval,
      needsApproval,
      onEvent: context.onEvent,
      getGitState: checkpointInstance
        ? async () => {
            const state = await checkpointInstance.getState();
            return {
              isRepo: state.isRepo,
              branch: state.branch ?? undefined,
              dirty: state.dirty,
              detail: state.isRepo ? undefined : '工作区不是 git 仓库',
            };
          }
        : () => null,
      beforeTool: async (call, step) => {
        if (!checkpointInstance) return;
        const risk = executorRisk ? executorRisk(call) : (riskByName.get(call.name) ?? 'mutating');
        // 设计文档第 7 节：读操作不提交，只有写/高危命令才做检查点
        if (risk !== 'mutating' && risk !== 'destructive') return;
        try {
          const branch = await checkpointInstance.ensureBranch(request.runId);
          if (!branch.ok) {
            process.stderr.write(redactSecrets('[agent] git 检查点：' + branch.message, merged.model.apiKey) + '\n');
            return;
          }
          const commit = await checkpointInstance.commitBeforeWrite(step, describeCall(call));
          if (!commit.ok) {
            process.stderr.write(redactSecrets('[agent] git 检查点提交失败：' + commit.message, merged.model.apiKey) + '\n');
          }
          return commit.commit ? { commit: commit.commit } : undefined;
        } catch (error) {
          process.stderr.write(redactSecrets('[agent] git 检查点失败（不影响任务）：' + errorMessage(error), merged.model.apiKey) + '\n');
          return;
        }
      },
      signal: context.signal,
    },
  );
}

/**
 * 进程入口：stdin 一行一条 NDJSON，stdout 一行一条 NDJSON。
 *
 * 内核（cordis）在这里落地：ToolsService 是「工具注册」的唯一权威来源，
 * 内置工具以插件形式装入，第三方插件目录逐个隔离安装；ready 的工具清单直接读内核。
 */
export async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const secret = config?.model?.apiKey;
  const loaded = await loadToolsModule();
  if (loaded.error) {
    process.stderr.write(redactSecrets('[agent] 工具层未就绪，降级为仅 finish：' + loaded.error, secret) + '\n');
  }

  const kernel = await createKernel();

  // 1. 内置工具：只注册声明，执行仍交给 P2 的 createToolExecutor
  const declaredSpecs = loaded.module && Array.isArray(loaded.module.builtinToolSpecs) ? loaded.module.builtinToolSpecs : [];
  let searchAvailable = true;
  if (loaded.module && typeof loaded.module.isSearchAvailable === 'function') {
    try {
      searchAvailable = Boolean(loaded.module.isSearchAvailable(config?.search));
    } catch {
      searchAvailable = false;
    }
  }
  const registrable = declaredSpecs.filter((spec) => spec.name !== 'web_search' || searchAvailable);
  const builtinRegistration = await registerBuiltinTools(kernel, registrable);
  if (!builtinRegistration.ok) {
    process.stderr.write(redactSecrets('[agent] 内置工具注册失败：' + (builtinRegistration.error ?? 'unknown'), secret) + '\n');
  }

  // 2. 第三方插件：目录即插件，单个失败只写 stderr，不影响内置工具
  const pluginDirectory = resolvePluginDirectory();
  const plugins = await loadPluginsFromDirectory(kernel, pluginDirectory, { secret });
  if (plugins.loaded.length > 0 || plugins.failed.length > 0) {
    process.stderr.write(
      redactSecrets(
        '[agent] 插件目录 ' + pluginDirectory + '：加载 ' + plugins.loaded.length + ' 个' +
          (plugins.loaded.length ? '（' + plugins.loaded.join(', ') + '）' : '') +
          '，失败 ' + plugins.failed.length + ' 个' +
          (plugins.failed.length ? '（' + plugins.failed.join(', ') + '）' : ''),
        secret,
      ) + '\n',
    );
  }

  const server = createAgentServer({
    write: (line) => {
      process.stdout.write(line);
    },
    agentVersion: AGENT_VERSION,
    approvalTimeoutMs: DEFAULT_LIMITS.approvalTimeoutMs,
    listTools: () => readyToolList(kernel, loaded.module, config?.search),
    searchTest: (request) => runSearchTest(request),
    createRun: (request, context) => createDefaultRun(request, context, config, loaded.module, kernel),
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    server.handleLine(line);
  });
  rl.on('close', () => {
    server.dispose();
    void kernel.dispose();
  });
}

/** 只有被当作入口执行时才启动主循环；被 import（测试/打包检查）时保持无副作用 */
const IS_ENTRY = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (IS_ENTRY) {
  void main().catch((error: unknown) => {
    process.stderr.write('[agent] 启动失败：' + errorMessage(error) + '\n');
    process.exitCode = 1;
  });
}
