/**
 * Agent 运行循环（终止判定 B+C）。
 *
 * 契约（docs/agent-design.md 第 6 节）：
 * - 只有模型调用 finish(status, summary) 才算完成；状态原样交给用户；
 * - 一轮既无 tool_calls 也无 finish：先自动追问一次；连续 2 次无动作 → stalled；
 * - 硬上限：步数 40（按工具调用计）、单 run 10 分钟；同工具同参数连续失败 3 次 → stalled；
 * - 工具结果结构化且「拒绝是数据」：被拒绝不终止；needs_user 直接交回用户。
 *
 * 本文件只做编排：不读文件、不发请求、不弹对话框。所有副作用都通过注入的
 * adapter / executeTool / requestApproval / onEvent 完成，因此单测可以全离线跑。
 */
import { DEFAULT_LIMITS, type AgentAccess, type AgentConfig, type AgentLimits } from '../config.ts';
import { AGENT_ERROR, fail, type AgentErrorCode, type ToolResult } from '../errors.ts';
import type { JsonSchema } from '../kernel/tools.ts';
import type { ChatMessage, ModelAdapter, ToolCall, ToolSpecForModel } from '../model/types.ts';
import { normalizeArgs } from '../tools/types.ts';
import { buildSystemPrompt, type PromptGitState, type PromptToolInfo } from './prompt.ts';

/** finish 工具名：runtime 自己处理，不走 executeTool */
export const FINISH_TOOL_NAME = 'finish';

/** 同一工具同一参数连续失败达到该次数即 stalled */
export const MAX_CALL_FAILURES = 3;

/** 无工具动作时自动追问的文案（追问一次；连续两次无动作直接 stalled） */
export const NUDGE_TEXT =
  '你这一轮没有调用任何工具，也没有调用 finish。请继续：要么调用工具推进任务，要么调用 finish(status, summary) 结束任务；只回复文字不算完成。';

/** finish 的工具声明：始终暴露给模型，保证「完成」有显式出口 */
export const FINISH_TOOL: ToolSpecForModel = {
  name: FINISH_TOOL_NAME,
  description:
    '结束本次任务并向用户汇报。只有调用它才算完成。status=done 表示已完成，blocked 表示被权限/环境挡住，need_user 表示需要用户提供信息或决策。',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['done', 'blocked', 'need_user'],
        description: 'done=完成；blocked=被挡住；need_user=需要用户回答或决定',
      },
      summary: {
        type: 'string',
        description: '给用户的简要总结：做了什么、改了哪些文件、怎么验证的；或缺口/需要用户做什么。',
      },
    },
    required: ['status', 'summary'],
    additionalProperties: false,
  } as JsonSchema,
};

export type FinishStatus = 'done' | 'blocked' | 'need_user';
export type RunStatus = FinishStatus | 'stalled' | 'cancelled' | 'error';
export type StallReason = 'NO_ACTION' | 'STEP_LIMIT' | 'TIME_LIMIT' | 'REPEATED_FAILURE';

export type ApprovalDecision = 'once' | 'task' | 'always' | 'deny';

/** 审批请求：与 NDJSON 的 approval_request { id, tool, action, detail } 对齐 */
export interface ApprovalRequest {
  id: string;
  tool: string;
  action: string;
  detail: string;
  args: Record<string, unknown>;
}

/** 等待用户审批；超时/取消由实现方决定（宿主实现：60s 超时 = deny） */
export type RequestApproval = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

/** 该调用是否需要审批（宿主按工具 risk 判定；未注入时按档位保守处理） */
export type NeedsApproval = (call: ToolCall, access: AgentAccess) => boolean | Promise<boolean>;

/** 执行一次工具调用；抛错由 runtime 兜成 TOOL_FAILED，不会炸掉 run */
export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;

/** token 用量：reasoning 只计数，不落正文（设计文档第 10 节） */
export interface UsageTokens {
  input: number;
  output: number;
}

/** 供 NDJSON 层直接转发的运行事件 */
export type RuntimeEvent =
  | { type: 'chunk'; runId: string; text: string }
  | { type: 'step'; runId: string; index: number; tool: string; argsSummary: string }
  | {
      type: 'tool_result';
      runId: string;
      /** 与 step 事件同一个 index：UI 用它精确匹配步骤条 */
      index: number;
      tool: string;
      ok: boolean;
      code: string;
      message: string;
      data?: unknown;
      denied?: boolean;
      retryable?: boolean;
    }
  | { type: 'usage'; runId: string; tokens: UsageTokens }
  | {
      type: 'finish';
      runId: string;
      status: FinishStatus;
      summary: string;
      steps: number;
      durationMs: number;
      usage?: UsageTokens;
    }
  | { type: 'error'; runId: string; code: string; message: string; steps: number; durationMs: number }
  | { type: 'stalled'; runId: string; reason: StallReason; message: string; steps: number; durationMs: number }
  | { type: 'cancelled'; runId: string; message: string; steps: number; durationMs: number };

/** 工具执行前钩子的返回值：commit 为检查点提交哈希（会附到 finish 摘要） */
export interface BeforeToolResult {
  commit?: string | null;
}

export interface RunAgentInput {
  runId: string;
  goal: string;
  /** 续跑/恢复时的历史消息（不含 system；runtime 会补 system prompt 与本次目标） */
  history?: ChatMessage[];
  /** 该工作区首次使用 Agent：提示先询问用户是否启用 git 检查点 */
  firstGitAsk?: boolean;
}

export interface RunAgentOptions {
  /** 会话配置；access/workspace 未单独传时作为兜底 */
  config?: AgentConfig;
  adapter: ModelAdapter;
  /** finish 除外的工具（runtime 会把 finish 追加到最后） */
  tools: ToolSpecForModel[];
  access?: AgentAccess;
  workspace?: string;
  executeTool: ToolExecutor;
  requestApproval?: RequestApproval;
  needsApproval?: NeedsApproval;
  onEvent: (event: RuntimeEvent) => void;
  getGitState?: () => PromptGitState | null | Promise<PromptGitState | null>;
  /**
   * 工具执行前的钩子（写操作 git 检查点）：抛错不影响任务，只是拿不到 commit。
   * 返回 { commit } 时，短哈希会附到 finish 摘要里。
   */
  beforeTool?: (call: ToolCall, step: number) => Promise<BeforeToolResult | void> | BeforeToolResult | void;
  signal?: AbortSignal;
  /** 覆盖硬上限（仅测试/调试用，生产用 DEFAULT_LIMITS） */
  limits?: Partial<AgentLimits>;
  /** 覆盖时钟（测试 10 分钟上限用）；默认 Date.now */
  now?: () => number;
}

/** 运行级错误码：共享码表之外，模型调用失败单独用 MODEL_FAILED（宿主日志更准确） */
export type RunErrorCode = AgentErrorCode | 'MODEL_FAILED';

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  summary: string;
  steps: number;
  durationMs: number;
  messages: ChatMessage[];
  reasoningTokens: number;
  usage?: UsageTokens;
  code?: RunErrorCode | 'OK';
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const named = error as { name?: unknown; message?: unknown };
  if (named.name === 'AbortError' || named.name === 'CanceledError') return true;
  return typeof named.message === 'string' && /abort|cancel/i.test(named.message);
}

/** 参数摘要：step 事件与审批卡都用它，保证单行、有上限 */
export function summarizeArgs(args: Record<string, unknown> | undefined, maxLength = 160): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = String(args);
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

/** 稳定序列化：同工具同参数（键顺序不同）必须得到同一个 key，否则失败计数会被绕过 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) parts.push(JSON.stringify(key) + ':' + stableStringify(record[key]));
  return '{' + parts.join(',') + '}';
}

function callKey(call: ToolCall): string {
  return call.name + '#' + stableStringify(call.args ?? {});
}

/** 审批卡里「要做什么」的人话描述：优先路径/命令，其次参数摘要 */
export function describeCall(call: ToolCall): string {
  const args = call.args ?? {};
  const pathValue = args.path ?? args.file ?? args.dir ?? args.cwd;
  if (typeof pathValue === 'string' && pathValue.trim()) return call.name + ' ' + pathValue.trim();
  const command = args.command ?? args.cmd;
  if (typeof command === 'string' && command.trim()) return call.name + ': ' + command.trim();
  const query = args.query;
  if (typeof query === 'string' && query.trim()) return call.name + ': ' + query.trim();
  return call.name + ' ' + summarizeArgs(args);
}

function isFinishStatus(value: unknown): value is FinishStatus {
  return value === 'done' || value === 'blocked' || value === 'need_user';
}

/**
 * 运行一次 agent 任务。
 * 返回 RunOutcome（含完整消息历史，宿主可落 agent-runs/<runId>.json），
 * 同时通过 onEvent 逐步上报事件。
 */
export async function runAgent(input: RunAgentInput | string, options: RunAgentOptions): Promise<RunOutcome> {
  const runId = typeof input === 'string' ? 'run-' + Date.now().toString(36) : String(input.runId || 'run');
  const goal = typeof input === 'string' ? input : String(input.goal ?? '');
  const history = typeof input === 'string' ? [] : (input.history ?? []);
  const firstGitAsk = typeof input === 'string' ? false : Boolean(input.firstGitAsk);

  const workspace = String(options.workspace ?? options.config?.workspace ?? '').trim();
  const access: AgentAccess = options.access ?? options.config?.access ?? 'approval';
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const clock = options.now ?? (() => Date.now());
  const started = clock();

  const messages: ChatMessage[] = [];
  const failures = new Map<string, number>();
  let steps = 0;
  let reasoningTokens = 0;
  let idleTurns = 0;
  const usageTotals: UsageTokens = { input: 0, output: 0 };
  /** 最近一次写操作检查点的 commit（finish 摘要里给短哈希） */
  let lastCommit: string | null = null;

  const emit = (event: RuntimeEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      /* 宿主回调抛错不能拖垮任务：事件只是上报通道 */
    }
  };

  const elapsed = (): number => Math.max(0, clock() - started);

  const outcome = (status: RunStatus, summary: string, code?: RunErrorCode | 'OK'): RunOutcome => ({
    runId,
    status,
    summary,
    steps,
    durationMs: elapsed(),
    messages,
    reasoningTokens,
    usage: { ...usageTotals },
    code,
  });

  const finishRun = (status: FinishStatus, summary: string): RunOutcome => {
    const withCheckpoint = lastCommit
      ? summary + '\n\n（本次检查点提交：' + lastCommit.slice(0, 7) + '）'
      : summary;
    emit({
      type: 'finish',
      runId,
      status,
      summary: withCheckpoint,
      steps,
      durationMs: elapsed(),
      usage: { ...usageTotals },
    });
    return outcome(status, withCheckpoint, 'OK');
  };

  const stallRun = (reason: StallReason, summary: string): RunOutcome => {
    emit({ type: 'stalled', runId, reason, message: summary, steps, durationMs: elapsed() });
    return outcome('stalled', summary, AGENT_ERROR.STALLED);
  };

  const cancelRun = (summary: string): RunOutcome => {
    emit({ type: 'cancelled', runId, message: summary, steps, durationMs: elapsed() });
    return outcome('cancelled', summary, AGENT_ERROR.CANCELLED);
  };

  const errorRun = (code: RunErrorCode, summary: string): RunOutcome => {
    emit({ type: 'error', runId, code, message: summary, steps, durationMs: elapsed() });
    return outcome('error', summary, code);
  };

  const rememberToolResult = (call: ToolCall, result: ToolResult, index: number): void => {
    emit({
      type: 'tool_result',
      runId,
      index,
      tool: call.name,
      ok: result.ok,
      code: result.code,
      message: result.message,
      data: result.data,
      denied: result.denied,
      retryable: result.retryable,
    });
    messages.push({
      role: 'tool',
      content: JSON.stringify({
        ok: result.ok,
        code: result.code,
        message: result.message,
        data: result.data,
        denied: result.denied,
        retryable: result.retryable,
        needs_user: result.needs_user,
      }),
      toolCallId: call.id,
      toolName: call.name,
    });
  };

  const approvalFor = async (call: ToolCall): Promise<{ allowed: boolean; denied?: ToolResult }> => {
    let required: boolean;
    try {
      required = options.needsApproval ? Boolean(await options.needsApproval(call, access)) : access !== 'full';
    } catch {
      // 审批判定本身失败时按「需要审批」处理（fail closed），但不能炸掉任务
      required = true;
    }
    if (!required) return { allowed: true };

    const request: ApprovalRequest = {
      // 带上 runId：同一工作区连续 run 时模型可能复用 call id，避免旧审批 id 串到新 run
      id: 'appr-' + runId + '-' + call.id,
      tool: call.name,
      action: call.name,
      detail: describeCall(call),
      args: call.args,
    };
    let decision: ApprovalDecision = 'deny';
    if (options.requestApproval) {
      try {
        decision = await options.requestApproval(request, options.signal);
      } catch {
        decision = 'deny';
      }
    }
    if (decision === 'deny') {
      return {
        allowed: false,
        denied: fail(
          AGENT_ERROR.TOOL_DENIED,
          '用户拒绝了这次操作：' + request.detail + '。这是数据不是异常：不要重复请求同一操作；换一条不需要该权限的路径，或 finish 说明缺口。',
          { denied: true },
        ),
      };
    }
    return { allowed: true };
  };

  // ---- 1. 组装提示词与模型工具表 ----
  const git = await (async (): Promise<PromptGitState | null> => {
    if (!options.getGitState) return null;
    try {
      return await options.getGitState();
    } catch (error) {
      return { isRepo: false, detail: 'git 状态读取失败：' + errorMessage(error) };
    }
  })();

  const modelTools: ToolSpecForModel[] = [];
  for (const tool of options.tools ?? []) {
    if (tool.name === FINISH_TOOL_NAME) continue;
    modelTools.push(tool);
  }
  modelTools.push(FINISH_TOOL);

  const toolInfo: PromptToolInfo[] = modelTools.map((tool) => ({ name: tool.name, description: tool.description }));

  messages.push({
    role: 'system',
    content: buildSystemPrompt({
      goal,
      workspace,
      access,
      tools: toolInfo,
      git,
      runId,
      firstGitAsk,
      platform: process.platform,
    }),
  });
  for (const message of history) messages.push(message);
  messages.push({ role: 'user', content: goal });

  // ---- 2. 主循环 ----
  while (true) {
    if (options.signal?.aborted) return cancelRun('用户已取消本次任务。');

    const spent = elapsed();
    if (spent > limits.maxRunMs) {
      return stallRun(
        'TIME_LIMIT',
        '超过单次任务时间上限（' + Math.round(limits.maxRunMs / 60000) + ' 分钟，已用 ' + Math.round(spent / 1000) + ' 秒），已停止。',
      );
    }

    let streamed = false;
    let turn: {
      text: string;
      toolCalls: ToolCall[];
      reasoningTokens: number;
      usage?: { promptTokens: number; completionTokens: number };
    };
    try {
      turn = await options.adapter.run(messages, modelTools, {
        onTextDelta: (text: string) => {
          if (!text) return;
          streamed = true;
          emit({ type: 'chunk', runId, text });
        },
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) return cancelRun('用户已取消本次任务。');
      return errorRun('MODEL_FAILED', '模型调用失败：' + errorMessage(error));
    }

    if (options.signal?.aborted) return cancelRun('用户已取消本次任务。');
    if (turn.reasoningTokens > 0) reasoningTokens += turn.reasoningTokens;
    if (!streamed && turn.text) emit({ type: 'chunk', runId, text: turn.text });
    if (turn.usage) {
      const input = Math.max(0, Math.trunc(Number(turn.usage.promptTokens) || 0));
      const output = Math.max(0, Math.trunc(Number(turn.usage.completionTokens) || 0));
      usageTotals.input += input;
      usageTotals.output += output;
      // 只发 token 数：reasoning 正文不落盘、不进事件
      emit({ type: 'usage', runId, tokens: { input, output } });
    }

    const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];

    // 2a. finish 优先：只有它算完成，其余调用同轮出现时丢弃（finish 是终止信号）
    const finishCall = toolCalls.find((call) => call.name === FINISH_TOOL_NAME);
    if (finishCall) {
      const args = normalizeArgs(finishCall.args) ?? {};
      const rawStatus = args.status;
      const status: FinishStatus = isFinishStatus(rawStatus) ? rawStatus : 'done';
      const rawSummary = typeof args.summary === 'string' ? args.summary.trim() : '';
      const summary = rawSummary || '（模型未提供总结）';
      const finishId = finishCall.id || 'finish-' + steps;
      messages.push({ role: 'assistant', content: turn.text, toolCalls: [{ ...finishCall, id: finishId }] });
      messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: true, code: 'OK', message: '任务已结束，等待用户查看总结。' }),
        toolCallId: finishId,
        toolName: FINISH_TOOL_NAME,
      });
      return finishRun(status, summary);
    }

    // 2b. 无工具动作：追问一次；连续两次 → stalled（B+C 的 C 部分）
    if (toolCalls.length === 0) {
      idleTurns += 1;
      messages.push({ role: 'assistant', content: turn.text || '' });
      if (idleTurns >= 2) {
        return stallRun(
          'NO_ACTION',
          '连续 ' + idleTurns + ' 轮既没有调用工具也没有 finish，任务停在这里，交回用户决定下一步。',
        );
      }
      messages.push({ role: 'user', content: NUDGE_TEXT });
      continue;
    }
    idleTurns = 0;

    messages.push({ role: 'assistant', content: turn.text, toolCalls });
    for (const rawCall of toolCalls) {
      if (options.signal?.aborted) return cancelRun('用户已取消本次任务。');

      if (steps >= limits.maxSteps) {
        return stallRun('STEP_LIMIT', '达到单次任务步数上限（' + limits.maxSteps + ' 次工具调用），已停止。');
      }

      const parsedArgs = normalizeArgs(rawCall.args);
      const call: ToolCall = {
        id: rawCall.id || 'call-' + (steps + 1),
        name: rawCall.name,
        args: parsedArgs ?? {},
      };
      steps += 1;
      emit({ type: 'step', runId, index: steps, tool: call.name, argsSummary: summarizeArgs(call.args) });

      if (!parsedArgs) {
        const invalid = fail(AGENT_ERROR.TOOL_FAILED, '工具参数不是合法的 JSON 对象：' + summarizeArgs(call.args));
        rememberToolResult(call, invalid, steps);
        failures.set(callKey(call), (failures.get(callKey(call)) ?? 0) + 1);
        if ((failures.get(callKey(call)) ?? 0) >= MAX_CALL_FAILURES) {
          return stallRun('REPEATED_FAILURE', '同一工具同一参数连续失败 ' + MAX_CALL_FAILURES + ' 次（' + call.name + '），已停止并把问题交回用户。');
        }
        continue;
      }

      const approval = await approvalFor(call);
      if (!approval.allowed) {
        // 拒绝是数据：不执行、不计失败、不终止
        rememberToolResult(call, approval.denied as ToolResult, steps);
        continue;
      }

      // 执行前钩子（写操作 git 检查点）：抛错不阻断，也不计入工具失败
      if (options.beforeTool) {
        try {
          const hooked = await options.beforeTool(call, steps);
          const commit = hooked && typeof hooked === 'object' ? hooked.commit : null;
          if (typeof commit === 'string' && commit.trim()) lastCommit = commit.trim();
        } catch {
          /* 检查点失败由注入方写 stderr；run 继续 */
        }
      }

      let result: ToolResult;
      try {
        result = await options.executeTool(call);
      } catch (error) {
        result = fail(AGENT_ERROR.TOOL_FAILED, '工具执行抛错：' + errorMessage(error));
      }
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        result = fail(AGENT_ERROR.TOOL_FAILED, '工具返回了非法结果（应为 { ok, code, message }）。');
      }

      rememberToolResult(call, result, steps);

      // needs_user 直接交回：不再让模型猜
      if (!result.ok && result.needs_user) {
        return finishRun('need_user', result.message || '需要用户提供信息或决策。');
      }

      if (result.ok) {
        failures.delete(callKey(call));
        continue;
      }
      if (result.denied) continue; // 工具层自己拒绝的也是数据

      const key = callKey(call);
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count >= MAX_CALL_FAILURES) {
        return stallRun('REPEATED_FAILURE', '同一工具同一参数连续失败 ' + MAX_CALL_FAILURES + ' 次（' + call.name + '），已停止并把问题交回用户。');
      }
    }
  }
}
