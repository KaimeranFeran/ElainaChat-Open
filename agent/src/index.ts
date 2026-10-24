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
import { AGENT_ERROR, fail, ok, type ToolResult } from './errors.ts';
import {
  createKernel,
  installPlugin,
  validatePluginManifest,
  type Context,
  type JsonSchema,
  type Kernel,
  type Plugin,
  type PluginApi,
  type PluginManifest,
  type ToolDisposer,
  type ToolSpec,
} from './kernel/index.ts';
import {
  AGENT_API_VERSION,
  manifestCommandDeclarations,
  normalizedToolDeclarations,
  type PluginApiOptions,
  type PluginToolDeclaration,
  type PluginToolHandler,
} from './kernel/plugin.ts';
import { createModelAdapter, type ModelAdapter } from './model/index.ts';
import { joinUrl, type ToolCall, type ToolSpecForModel } from './model/types.ts';
import { NdjsonDecoder, encodeMessage, type AgentMessage } from './protocol/ndjson.ts';
import { checkAgentBaseUrl } from './security/gateway-blocklist.ts';
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
  /** 模型列表查询用的 fetch（测试注入，避免联网；生产默认 globalThis.fetch） */
  modelsFetch?: typeof fetch;
  /** 插件目录 + 插件视图（ready / plugins_result 用） */
  pluginInfo?: () => PluginsSnapshot;
  /** 启停插件（进程序内状态）；返回是否成功 */
  setPluginEnabled?: (id: string, enabled: boolean) => { ok: boolean; message: string };
  /** 重新扫描插件目录 */
  rescanPlugins?: () => Promise<{ ok: boolean; message: string }>;
}

/** search_test 请求（UI 设置页传入当前表单值，不落盘） */
export interface SearchTestRequest {
  requestId: string;
  provider: 'tavily' | 'brave' | 'custom';
  apiKey?: string;
  endpoint?: string;
}

export type SearchTestRunner = (request: SearchTestRequest) => Promise<{ ok: boolean; message: string }>;

/** 模型列表查询超时（设计约定 15s） */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

/** 把 OpenAI / Anthropic 两种 /models 返回归一成 [{id, name}] */
export function extractModelList(payload: unknown): Array<{ id: string; name: string }> {
  const source =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).models ?? null)
        : null;
  const list = Array.isArray(source) ? source : [];
  const models: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of list) {
    let id = '';
    let name = '';
    if (typeof item === 'string') {
      id = item.trim();
      name = id;
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      id =
        typeof record.id === 'string'
          ? record.id.trim()
          : typeof record.model === 'string'
            ? record.model.trim()
            : typeof record.name === 'string'
              ? record.name.trim()
              : '';
      name =
        typeof record.display_name === 'string'
          ? record.display_name.trim()
          : typeof record.name === 'string'
            ? record.name.trim()
            : id;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name || id });
  }
  return models;
}

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
    const info = options.pluginInfo ? options.pluginInfo() : { pluginsDir: '', plugins: [] };
    writeMessage({ type: 'ready', agentVersion, agentApiVersion, tools, pluginsDir: info.pluginsDir, plugins: info.plugins });
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

  const handleModelsRequest = (message: AgentMessage): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const baseUrl = typeof message.baseUrl === 'string' ? message.baseUrl.trim() : '';
    const apiKey = typeof message.apiKey === 'string' ? message.apiKey : '';
    const protocol = message.protocol;
    const protocolOk = protocol === 'openai' || protocol === 'openai-responses' || protocol === 'anthropic';
    if (!requestId || !baseUrl || !protocolOk) {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, 'models_request 非法：需要 requestId、baseUrl 与 protocol（openai / openai-responses / anthropic）。');
      return;
    }

    // 官方网关黑名单：绝不发请求（与 validateAgentConfig 同一判定）
    const blocked = checkAgentBaseUrl(baseUrl);
    if (blocked.blocked) {
      writeMessage({ type: 'models_result', requestId, ok: false, models: [], message: blocked.detail });
      return;
    }

    const fetchImpl = options.modelsFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      writeMessage({ type: 'models_result', requestId, ok: false, models: [], message: '当前运行环境没有 fetch，无法查询模型列表。' });
      return;
    }

    const isAnthropic = protocol === 'anthropic';
    const url = isAnthropic ? joinUrl(baseUrl, '/v1/models') : joinUrl(baseUrl, '/models');
    const headers: Record<string, string> = isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' }
      : { authorization: 'Bearer ' + apiKey, accept: 'application/json' };

    void (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
        const text = await response.text();
        if (!response.ok) {
          writeMessage({
            type: 'models_result',
            requestId,
            ok: false,
            models: [],
            message: redactSecrets('查询模型列表失败：HTTP ' + response.status + (text ? '：' + text.slice(0, 300) : ''), apiKey),
          });
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          writeMessage({ type: 'models_result', requestId, ok: false, models: [], message: '模型列表返回的不是 JSON。' });
          return;
        }
        const models = extractModelList(payload);
        writeMessage({ type: 'models_result', requestId, ok: true, models, message: '已获取 ' + models.length + ' 个模型。' });
      } catch (error) {
        const raw =
          error instanceof Error && error.name === 'AbortError'
            ? '查询模型列表超时（' + Math.round(MODEL_LIST_TIMEOUT_MS / 1000) + ' 秒）。'
            : '查询模型列表失败：' + errorMessage(error);
        writeMessage({ type: 'models_result', requestId, ok: false, models: [], message: redactSecrets(raw, apiKey) });
      } finally {
        clearTimeout(timer);
      }
    })();
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

  /** plugins_result 统一形状：requestId 可选（plugin_set_enabled 不强制带） */
  const writePluginsResult = (requestId: string | undefined, ok: boolean, message: string): void => {
    const info = options.pluginInfo ? options.pluginInfo() : { pluginsDir: '', plugins: [] };
    const payload: AgentMessage = {
      type: 'plugins_result',
      pluginsDir: info.pluginsDir,
      plugins: info.plugins,
      ok,
      message,
    };
    if (requestId) payload.requestId = requestId;
    writeMessage(payload);
  };

  const handlePluginsList = (message: AgentMessage): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (!requestId) {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, 'plugins_list 非法：需要 requestId。');
      return;
    }
    writePluginsResult(requestId, true, '已获取插件列表。');
  };

  const handlePluginSetEnabled = (message: AgentMessage): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const id = typeof message.id === 'string' ? message.id.trim() : '';
    const enabled = message.enabled;
    if (!id || typeof enabled !== 'boolean') {
      writeError(AGENT_ERROR.PROTOCOL_INVALID, 'plugin_set_enabled 非法：需要 id（非空）与 enabled（布尔）。');
      return;
    }
    const toggle = options.setPluginEnabled;
    if (!toggle) {
      writePluginsResult(requestId || undefined, false, '插件管理未接线（宿主未注入 setPluginEnabled）。');
      return;
    }
    let result: { ok: boolean; message: string };
    try {
      result = toggle(id, enabled);
    } catch (error) {
      result = { ok: false, message: '启停插件失败：' + errorMessage(error) };
    }
    writePluginsResult(requestId || undefined, Boolean(result.ok), String(result.message ?? ''));
  };

  const handlePluginsRescan = (message: AgentMessage): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const rescan = options.rescanPlugins;
    if (!rescan) {
      writePluginsResult(requestId || undefined, false, '插件管理未接线（宿主未注入 rescanPlugins）。');
      return;
    }
    void (async () => {
      try {
        const result = await rescan();
        writePluginsResult(requestId || undefined, Boolean(result.ok), String(result.message ?? ''));
      } catch (error) {
        writePluginsResult(requestId || undefined, false, '插件重扫失败：' + errorMessage(error));
      }
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
      case 'models_request':
        handleModelsRequest(message);
        return;
      case 'plugins_list':
        handlePluginsList(message);
        return;
      case 'plugin_set_enabled':
        handlePluginSetEnabled(message);
        return;
      case 'plugins_rescan':
        handlePluginsRescan(message);
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
    /** 插件 shell 工具用：ELAINA_AGENT_ARGS 等附加环境变量 */
    env?: NodeJS.ProcessEnv;
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

/** 插件工具的运行描述：handler 通道或 manifest command 通道（C 方案双通道） */
export interface PluginToolRuntime {
  /** 工具名（与 ToolsService 注册名一致） */
  name: string;
  pluginId: string;
  kind: 'handler' | 'command';
  handler?: PluginToolHandler;
  /** command 模板（{{arg}} 占位） */
  command?: string;
  timeoutMs?: number;
  /** command 执行目录（相对工作区，已校验不逃逸） */
  cwd?: string;
}

export interface PluginCommandRunOptions {
  workspace: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** 执行插件 shell 命令；生产用 createToolExecutor 的 run_command 语义，测试可注入 */
export type PluginCommandRunner = (command: string, options: PluginCommandRunOptions) => Promise<ToolResult>;

export const DEFAULT_PLUGIN_HANDLER_TIMEOUT_MS = 30_000;

export interface PluginLoadResult {
  directory: string;
  /** 加载成功的 manifest.id */
  loaded: string[];
  /** 加载失败的目录名（失败隔离：只写 stderr，不影响内置工具） */
  failed: string[];
  /** 可执行的插件工具（handler 或 manifest command） */
  tools: Map<string, PluginToolRuntime>;
  /** 解析成功的 manifest（宿主日志/调试用） */
  manifests: PluginManifest[];
}

export interface PluginLoadOptions {
  log?: (message: string) => void;
  /** 日志脱敏用的密钥（绝不把 Key 写进 stderr） */
  secret?: string;
  /** handler 默认超时；manifest 工具对象里的 timeoutMs 优先 */
  handlerTimeoutMs?: number;
}

function shellQuote(value: string): string {
  if (value === '') return "''";
  // Windows PowerShell / PowerShell 7：单引号包裹，内部单引号写两遍
  return "'" + value.replace(/'/g, "''") + "'";
}

/** {{name}} 参数替换：值用单引号包裹防注入；未知占位保留原样，便于插件作者排错 */
export function substituteCommandArgs(command: string, args: Record<string, unknown>): string {
  return String(command ?? '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(args, key)) return whole;
    const value = args[key];
    return shellQuote(value === undefined || value === null ? '' : String(value));
  });
}

function resolvePluginCwd(workspace: string, cwd?: string): { ok: true; path: string } | { ok: false; message: string } {
  const root = path.resolve(workspace);
  if (!cwd) return { ok: true, path: root };
  const target = path.resolve(root, cwd);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, message: '插件命令的 cwd 逃逸出工作区：' + cwd };
  }
  return { ok: true, path: target };
}

/** 插件返回值归一：ToolResult / string / object / null 都接受；非法结构按失败数据处理 */
export function normalizePluginToolResult(value: unknown): ToolResult {
  if (value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean') {
    const candidate = value as Partial<ToolResult>;
    const result: ToolResult = {
      ok: candidate.ok as boolean,
      code: (typeof candidate.code === 'string' ? candidate.code : candidate.ok ? 'OK' : AGENT_ERROR.TOOL_FAILED) as ToolResult['code'],
      message: typeof candidate.message === 'string' ? candidate.message : '',
    };
    if (candidate.data !== undefined) result.data = candidate.data;
    if (typeof candidate.retryable === 'boolean') result.retryable = candidate.retryable;
    if (typeof candidate.needs_user === 'boolean') result.needs_user = candidate.needs_user;
    if (typeof candidate.denied === 'boolean') result.denied = candidate.denied;
    return result;
  }
  if (typeof value === 'string') return ok(undefined, value);
  if (value === undefined || value === null) return ok(undefined, '');
  return ok(value, '');
}

class PluginToolTimeoutError extends Error {}
class PluginToolAbortError extends Error {}

function runWithPluginTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outer?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = (): void => {
      controller.abort();
      settle(() => reject(new PluginToolAbortError('插件工具执行被取消')));
    };
    timer = setTimeout(() => {
      controller.abort();
      settle(() => reject(new PluginToolTimeoutError('插件工具执行超时')));
    }, Math.max(1, Math.trunc(timeoutMs)));
    if (outer) {
      if (outer.aborted) onAbort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    try {
      run(controller.signal).then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    } catch (error) {
      // handler 同步抛错：走同一套 settle，保证超时定时器被清掉
      settle(() => reject(error));
    }
  });
}

async function runPluginCommandDefault(command: string, options: PluginCommandRunOptions): Promise<ToolResult> {
  try {
    const toolsModule = (await import('./tools/index.ts')) as unknown as BuiltinToolModule;
    if (typeof toolsModule.createToolExecutor !== 'function') {
      return fail(AGENT_ERROR.TOOL_FAILED, '工具层未就绪，无法执行插件命令。');
    }
    const created = toolsModule.createToolExecutor({
      workspace: options.workspace,
      access: 'full',
      signal: options.signal,
      env: options.env,
    }) as ExecutorLikeObject;
    if (!created || typeof created.execute !== 'function') {
      return fail(AGENT_ERROR.TOOL_FAILED, '执行器不支持插件命令通道。');
    }
    const args: Record<string, unknown> = { command };
    if (options.timeoutMs) args.timeoutMs = options.timeoutMs;
    return await created.execute('run_command', args, { signal: options.signal });
  } catch (error) {
    return fail(AGENT_ERROR.TOOL_FAILED, '插件命令执行失败：' + errorMessage(error));
  }
}

export interface PluginToolRunOptions {
  workspace: string;
  signal?: AbortSignal;
  /** 注入 command 执行器（测试）；缺省走 createToolExecutor 的 run_command */
  runCommand?: PluginCommandRunner;
}

/**
 * 执行一个插件工具。绝不抛异常：handler 抛错/超时/取消都归一成 ToolResult。
 * command 通道先做 cwd 逃逸校验，再替换 {{arg}} 并把完整参数放进 ELAINA_AGENT_ARGS。
 */
export async function executePluginTool(
  tool: PluginToolRuntime,
  args: Record<string, unknown>,
  options: PluginToolRunOptions,
): Promise<ToolResult> {
  const timeoutMs = tool.timeoutMs && tool.timeoutMs > 0 ? tool.timeoutMs : DEFAULT_PLUGIN_HANDLER_TIMEOUT_MS;
  try {
    if (tool.kind === 'handler') {
      const handler = tool.handler;
      if (typeof handler !== 'function') return fail(AGENT_ERROR.TOOL_FAILED, '插件工具 ' + tool.name + ' 没有 handler。');
      const value = await runWithPluginTimeout(
        (signal) => Promise.resolve(handler(args, { toolName: tool.name, workspace: options.workspace, signal })),
        timeoutMs,
        options.signal,
      );
      return normalizePluginToolResult(value);
    }

    const template = String(tool.command ?? '');
    if (!template.trim()) return fail(AGENT_ERROR.TOOL_FAILED, '插件工具 ' + tool.name + ' 没有 command 模板。');
    const cwd = resolvePluginCwd(options.workspace, tool.cwd);
    if (!cwd.ok) return fail(AGENT_ERROR.TOOL_DENIED, '插件工具 ' + tool.name + '：' + cwd.message, { denied: true });
    const command = substituteCommandArgs(template, args);
    const env: NodeJS.ProcessEnv = { ELAINA_AGENT_ARGS: JSON.stringify(args ?? {}) };
    const runner = options.runCommand ?? runPluginCommandDefault;
    return await runner(command, { workspace: cwd.path, timeoutMs: tool.timeoutMs, env, signal: options.signal });
  } catch (error) {
    if (error instanceof PluginToolTimeoutError) {
      return fail(AGENT_ERROR.TOOL_TIMEOUT, '插件工具 ' + tool.name + ' 执行超时（' + timeoutMs + 'ms）。');
    }
    if (error instanceof PluginToolAbortError) {
      return fail(AGENT_ERROR.CANCELLED, '插件工具 ' + tool.name + ' 执行被取消。');
    }
    return fail(AGENT_ERROR.TOOL_FAILED, '插件工具 ' + tool.name + ' 执行失败：' + errorMessage(error), { retryable: true });
  }
}

function declarationFor(manifest: PluginManifest, name: string): PluginToolDeclaration | null {
  for (const item of normalizedToolDeclarations(manifest)) {
    if (item.name === name) return item.declaration;
  }
  return null;
}

/** 插件入口导出形态：register(api) / tools 表 / apply(api) / default */
function pickPluginApply(module: Record<string, unknown>, manifest: PluginManifest): ((api: PluginApi) => Promise<void>) | null {
  const register = module.register;
  if (typeof register === 'function') {
    return async (api) => {
      await (register as (pluginApi: PluginApi) => unknown)(api);
    };
  }
  const table = module.tools;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    return async (api) => {
      for (const [name, handler] of Object.entries(table as Record<string, unknown>)) {
        if (typeof handler !== 'function') continue;
        const declaration = declarationFor(manifest, name);
        api.tools.register({
          name,
          description: declaration?.description || '插件 ' + manifest.id + ' 的工具 ' + name,
          parameters: (declaration?.parameters as JsonSchema) ?? { type: 'object', properties: {} },
          handler: handler as PluginToolHandler,
        });
      }
    };
  }
  const apply = typeof module.apply === 'function' ? module.apply : typeof module.default === 'function' ? module.default : null;
  if (apply) {
    return async (api) => {
      await (apply as (pluginApi: PluginApi) => unknown)(api);
    };
  }
  return null;
}

interface PluginToolRecord {
  runtime: PluginToolRuntime;
  /** 注册声明（禁用后重新注册要用） */
  spec: ToolSpec;
  /** 启用状态下的注销函数；禁用时为 null */
  dispose: (() => void) | null;
}

interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  enabled: boolean;
  tools: PluginToolRecord[];
}

interface PluginFailure {
  directory: string;
  error: string;
}

/** 前端「插件管理」看到的单个插件 */
export interface PluginView {
  id: string;
  version: string;
  permissions: string[];
  tools: string[];
  enabled: boolean;
  /** 加载失败的原因（失败的目录也会出现在列表里，id 用目录名） */
  error?: string;
}

export interface PluginsSnapshot {
  pluginsDir: string;
  plugins: PluginView[];
}

type LoadedPluginRecord = { ok: true; record: PluginRecord } | { ok: false; error: string };

/** 加载单个插件目录：校验/注册/失败回滚都在这里，成功时返回可启停的记录 */
async function loadPluginRecord(
  kernel: Kernel,
  pluginDir: string,
  options: { log: (message: string) => void; handlerTimeoutMs: number },
): Promise<LoadedPluginRecord> {
  const disposers: ToolDisposer[] = [];
  const disposeByName = new Map<string, ToolDisposer>();
  const localHandlers = new Map<string, PluginToolHandler>();
  try {
    const manifest = await readPluginManifest(pluginDir);
    const entryFile = await findPluginEntry(pluginDir);
    const commandDeclarations = manifestCommandDeclarations(manifest);

    let apply: ((api: PluginApi) => Promise<void>) | null = null;
    if (entryFile) {
      const module = (await import(pathToFileURL(entryFile).href)) as Record<string, unknown>;
      apply = pickPluginApply(module, manifest);
      if (!apply && commandDeclarations.length === 0) {
        throw new Error('插件入口必须导出 register(api) / apply(api) / tools 映射，或在 manifest.tools 里声明 command');
      }
    } else if (commandDeclarations.length === 0) {
      throw new Error('缺少入口文件（index.mjs / index.js / main.mjs / main.js）');
    }

    if (apply) {
      const installed = await installPlugin(kernel, manifest, async (api) => {
        await apply!(api);
      }, {
        onHandler: (name, handler) => {
          localHandlers.set(name, handler);
        },
        onRegister: (dispose, name) => {
          disposers.push(dispose);
          if (name) disposeByName.set(name, dispose);
        },
      });
      if (!installed.ok) throw installed.error ?? new Error('插件安装失败');
    }

    const declaredTimeouts = new Map<string, number | undefined>();
    for (const item of normalizedToolDeclarations(manifest)) declaredTimeouts.set(item.name, item.declaration?.timeoutMs);

    const tools: PluginToolRecord[] = [];
    for (const [name, handler] of localHandlers) {
      const spec = kernel.ctx.tools.get(name);
      if (!spec) throw new Error('插件工具注册后找不到声明：' + name);
      tools.push({
        runtime: {
          name,
          pluginId: manifest.id,
          kind: 'handler',
          handler,
          timeoutMs: declaredTimeouts.get(name) ?? options.handlerTimeoutMs,
        },
        spec,
        dispose: disposeByName.get(name) ?? null,
      });
    }

    for (const declaration of commandDeclarations) {
      const spec: ToolSpec = {
        name: declaration.name,
        description: declaration.description || '插件 ' + manifest.id + ' 的 shell 工具',
        parameters: (declaration.parameters as JsonSchema) ?? { type: 'object', properties: {} },
      };
      const dispose = kernel.ctx.tools.register(spec);
      disposers.push(dispose);
      tools.push({
        runtime: {
          name: declaration.name,
          pluginId: manifest.id,
          kind: 'command',
          command: declaration.command,
          timeoutMs: declaration.timeoutMs,
          cwd: declaration.cwd,
        },
        spec,
        dispose,
      });
    }

    const record: PluginRecord = {
      id: manifest.id,
      manifest,
      // manifest.enabled === false 表示默认禁用
      enabled: manifest.enabled !== false,
      tools,
    };
    if (!record.enabled) {
      for (const tool of tools) {
        try {
          tool.dispose?.();
        } catch {
          /* 注销失败不影响记录本身 */
        }
        tool.dispose = null;
      }
    }
    return { ok: true, record };
  } catch (error) {
    // 回滚该插件已注册的工具，保证失败隔离
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 回滚失败不影响其它插件 */
      }
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 插件管理器：目录扫描 + 进程内启停 + 执行查找。
 *
 * - 启停只影响 ToolsService 注册与模型工具列表；handler 仍在内存里，重新启用即恢复；
 * - 状态不落盘：重启后回到 manifest 默认（enabled 缺省 true，可写 false）；
 * - rescan 全量重扫（新插件加载、已删插件消失），单个失败只进列表的 error，不阻断其它插件。
 */
export class PluginManager {
  readonly directory: string;
  #kernel: Kernel;
  #log: (message: string) => void;
  #handlerTimeoutMs: number;
  #records: PluginRecord[] = [];
  #failures: PluginFailure[] = [];
  #enabledOverrides = new Map<string, boolean>();

  constructor(options: {
    kernel: Kernel;
    directory: string;
    log?: (message: string) => void;
    secret?: string;
    handlerTimeoutMs?: number;
  }) {
    this.#kernel = options.kernel;
    this.directory = path.resolve(options.directory);
    this.#log = options.log ?? ((message: string) => process.stderr.write(redactSecrets(message, options.secret) + '\n'));
    this.#handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_PLUGIN_HANDLER_TIMEOUT_MS;
  }

  get loadedCount(): number {
    return this.#records.length;
  }

  get failedCount(): number {
    return this.#failures.length;
  }

  /** 全量重扫：先卸下所有已注册工具，再按目录重新加载；进程内启停偏好会覆盖 manifest 默认 */
  async scan(): Promise<void> {
    for (const record of this.#records) this.#unregister(record);
    this.#records = [];
    this.#failures = [];

    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 没装插件是正常状态，不是错误
      if (code !== 'ENOENT') this.#log('[agent] 插件目录不可读：' + this.directory + '（' + errorMessage(error) + '）');
      return;
    }

    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of directories) {
      const loaded = await loadPluginRecord(this.#kernel, path.join(this.directory, entry.name), {
        log: this.#log,
        handlerTimeoutMs: this.#handlerTimeoutMs,
      });
      if (!loaded.ok) {
        this.#failures.push({ directory: entry.name, error: loaded.error });
        this.#log('[agent] 插件加载失败 ' + entry.name + '：' + loaded.error);
        continue;
      }
      const record = loaded.record;
      const override = this.#enabledOverrides.get(record.id);
      if (override !== undefined && override !== record.enabled) this.#applyEnabled(record, override);
      this.#records.push(record);
    }
  }

  list(): PluginView[] {
    const plugins: PluginView[] = [];
    for (const record of this.#records) {
      plugins.push({
        id: record.id,
        version: record.manifest.version,
        permissions: [...record.manifest.permissions],
        tools: record.tools.map((tool) => tool.runtime.name),
        enabled: record.enabled,
      });
    }
    for (const failure of this.#failures) {
      plugins.push({
        id: failure.directory,
        version: '',
        permissions: [],
        tools: [],
        enabled: false,
        error: failure.error,
      });
    }
    // 稳定排序：UI 列表不会因加载顺序抖动
    plugins.sort((a, b) => a.id.localeCompare(b.id));
    return plugins;
  }

  snapshot(): PluginsSnapshot {
    return { pluginsDir: this.directory, plugins: this.list() };
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
    const record = this.#records.find((item) => item.id === id);
    if (!record) return { ok: false, message: '插件不存在：' + id };
    this.#enabledOverrides.set(id, enabled);
    if (record.enabled === enabled) {
      return { ok: true, message: '插件 ' + id + ' 已经是' + (enabled ? '启用' : '禁用') + '状态。' };
    }
    const applied = this.#applyEnabled(record, enabled);
    if (!applied) return { ok: false, message: '插件 ' + id + ' 的工具重新注册失败（可能与其他工具重名），已保持禁用。' };
    return { ok: true, message: '插件 ' + id + ' 已' + (enabled ? '启用' : '禁用') + '。' };
  }

  /** 查找插件工具（含禁用插件），供执行映射判断是否 TOOL_DENIED */
  toolRuntime(name: string): { runtime: PluginToolRuntime; enabled: boolean; pluginId: string } | undefined {
    for (const record of this.#records) {
      for (const tool of record.tools) {
        if (tool.runtime.name === name) return { runtime: tool.runtime, enabled: record.enabled, pluginId: record.id };
      }
    }
    return undefined;
  }

  /** 只有启用中的插件工具才需要审批；禁用工具直接 TOOL_DENIED，不弹审批 */
  hasActiveTool(name: string): boolean {
    return Boolean(this.toolRuntime(name)?.enabled);
  }

  async executeTool(name: string, args: Record<string, unknown>, options: PluginToolRunOptions): Promise<ToolResult> {
    const found = this.toolRuntime(name);
    if (!found) return fail(AGENT_ERROR.TOOL_FAILED, '未知插件工具：' + name + '。');
    if (!found.enabled) {
      return fail(
        AGENT_ERROR.TOOL_DENIED,
        '插件 ' + found.pluginId + ' 已禁用，工具 ' + name + ' 不可用。请让用户在「设置 → Agent → 插件」里启用后重试。',
        { denied: true },
      );
    }
    return executePluginTool(found.runtime, args, options);
  }

  /** 兼容 loadPluginsFromDirectory 的只读视图 */
  loadedIds(): string[] {
    return this.#records.map((record) => record.id);
  }

  failedDirs(): string[] {
    return this.#failures.map((failure) => failure.directory);
  }

  allTools(): Map<string, PluginToolRuntime> {
    const tools = new Map<string, PluginToolRuntime>();
    for (const record of this.#records) for (const tool of record.tools) tools.set(tool.runtime.name, tool.runtime);
    return tools;
  }

  manifests(): PluginManifest[] {
    return this.#records.map((record) => record.manifest);
  }

  /** 进程退出/测试清理：卸下所有插件工具（不影响插件目录） */
  dispose(): void {
    for (const record of this.#records) this.#unregister(record);
    this.#records = [];
    this.#failures = [];
  }

  #unregister(record: PluginRecord): void {
    for (const tool of record.tools) {
      try {
        tool.dispose?.();
      } catch {
        /* 注销失败不影响其它工具 */
      }
      tool.dispose = null;
    }
    record.enabled = false;
  }

  #applyEnabled(record: PluginRecord, enabled: boolean): boolean {
    if (!enabled) {
      this.#unregister(record);
      return true;
    }
    const registered: Array<() => void> = [];
    try {
      for (const tool of record.tools) {
        // 可能已经注册（例如从 manifest enabled=false 切到启用）——先尽力注销再注册
        try {
          tool.dispose?.();
        } catch {
          /* 忽略 */
        }
        tool.dispose = this.#kernel.ctx.tools.register(tool.spec);
        registered.push(tool.dispose);
      }
      record.enabled = true;
      return true;
    } catch (error) {
      for (const dispose of registered.reverse()) {
        try {
          dispose();
        } catch {
          /* 忽略 */
        }
      }
      for (const tool of record.tools) tool.dispose = null;
      record.enabled = false;
      this.#log('[agent] 插件 ' + record.id + ' 启用失败：' + errorMessage(error));
      return false;
    }
  }
}

/** 兼容旧接口（P2/P3 测试与调用方）：一次性扫描，返回已加载/失败清单与全部插件工具 */
export async function loadPluginsFromDirectory(
  kernel: Kernel,
  directory: string,
  options: PluginLoadOptions = {},
): Promise<PluginLoadResult> {
  const manager = new PluginManager({ kernel, directory, ...options });
  await manager.scan();
  return {
    directory: manager.directory,
    loaded: manager.loadedIds(),
    failed: manager.failedDirs(),
    tools: manager.allTools(),
    manifests: manager.manifests(),
  };
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
  pluginManager: PluginManager | null = null,
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

  // 执行映射：内置执行器优先 → 插件（含禁用判定）→ 结构化失败
  const builtinExecute = executeTool;

  // 插件 shell 命令复用 createToolExecutor 的 run_command 语义（超时/杀树/截断/日志），
  // 只是额外注入 env（ELAINA_AGENT_ARGS）与命令自身的 cwd（= workspace 覆盖）。
  const runPluginCommand: PluginCommandRunner = async (command, commandOptions) => {
    if (!toolsModule || typeof toolsModule.createToolExecutor !== 'function') {
      return fail(AGENT_ERROR.TOOL_FAILED, '工具层未就绪，无法执行插件命令。');
    }
    try {
      const created = toolsModule.createToolExecutor({
        workspace: commandOptions.workspace,
        access: merged.access,
        signal: context.signal,
        runId: request.runId,
        env: commandOptions.env,
      }) as ExecutorLikeObject;
      if (!created || typeof created.execute !== 'function') {
        return fail(AGENT_ERROR.TOOL_FAILED, '执行器不支持插件命令通道。');
      }
      const commandArgs: Record<string, unknown> = { command };
      if (commandOptions.timeoutMs) commandArgs.timeoutMs = commandOptions.timeoutMs;
      return await created.execute('run_command', commandArgs, { signal: context.signal });
    } catch (error) {
      return fail(AGENT_ERROR.TOOL_FAILED, '插件命令执行失败：' + errorMessage(error));
    }
  };

  executeTool = async (call: ToolCall): Promise<ToolResult> => {
    if (executorHas && executorHas(call.name)) return builtinExecute(call);
    if (pluginManager && pluginManager.toolRuntime(call.name)) {
      // 禁用插件的工具在这里直接 TOOL_DENIED（不执行、不弹审批）
      return pluginManager.executeTool(call.name, call.args, {
        workspace: merged.workspace,
        signal: context.signal,
        runCommand: runPluginCommand,
      });
    }
    if (executorHas) {
      return fail(
        AGENT_ERROR.TOOL_FAILED,
        '工具 ' + call.name + ' 已注册但没有可用的执行通道（插件需要 manifest command 或 handler）。请改用内置工具，或用 finish 说明缺口。',
      );
    }
    return builtinExecute(call);
  };

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

  // 审批判定：full 不逐次确认；approval 档位下插件工具一律需要审批，
  // 内置工具按 risk 判定（只有 safe 自动放行，未知工具按变更类处理）
  const needsApproval: NeedsApproval = (call) => {
    if (merged.access === 'full') return false;
    if (pluginManager?.hasActiveTool(call.name)) return true;
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
        const pluginRuntime = pluginManager?.toolRuntime(call.name);
        // 内置工具按 risk 判定；插件 handler 是进程内函数，是否写盘无法判定，交给审批；
        // 插件 shell command 与内置命令一样按写操作处理。
        const builtinKnown = executorHas ? executorHas(call.name) : true;
        if (!builtinKnown && pluginRuntime?.runtime.kind !== 'command') return;
        const risk = executorRisk ? executorRisk(call) : (riskByName.get(call.name) ?? 'mutating');
        // 设计文档第 7 节：读操作不提交，只有写/高危命令才做检查点
        if (risk !== 'mutating' && risk !== 'destructive') return;
        try {
          const state = await checkpointInstance.getState();
          if (!state.isRepo) return; // 非仓库没有检查点可用，也不必刷 stderr
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

  // 2. 第三方插件：目录即插件，单个失败只写 stderr，不影响内置工具；
  //    PluginManager 持有进程内启停状态（不落盘），前端可 list/setEnabled/rescan。
  const pluginDirectory = resolvePluginDirectory();
  const pluginManager = new PluginManager({ kernel, directory: pluginDirectory, secret });
  await pluginManager.scan();
  const loadedPlugins = pluginManager.loadedIds();
  const failedPlugins = pluginManager.failedDirs();
  if (loadedPlugins.length > 0 || failedPlugins.length > 0) {
    process.stderr.write(
      redactSecrets(
        '[agent] 插件目录 ' + pluginManager.directory + '：加载 ' + loadedPlugins.length + ' 个' +
          (loadedPlugins.length ? '（' + loadedPlugins.join(', ') + '）' : '') +
          '，失败 ' + failedPlugins.length + ' 个' +
          (failedPlugins.length ? '（' + failedPlugins.join(', ') + '）' : ''),
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
    pluginInfo: () => pluginManager.snapshot(),
    setPluginEnabled: (id, enabled) => pluginManager.setEnabled(id, enabled),
    rescanPlugins: async () => {
      await pluginManager.scan();
      return {
        ok: true,
        message: '已重新扫描插件目录：加载 ' + pluginManager.loadedCount + ' 个，失败 ' + pluginManager.failedCount + ' 个。',
      };
    },
    createRun: (request, context) => createDefaultRun(request, context, config, loaded.module, kernel, pluginManager),
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    server.handleLine(line);
  });
  rl.on('close', () => {
    server.dispose();
    pluginManager.dispose();
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
