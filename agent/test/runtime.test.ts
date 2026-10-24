/**
 * runtime 与 stdio 协议的离线测试。
 *
 * 全部用假 adapter（脚本化 turn）+ 假 executor：不联网、不写盘、不依赖 P2 的工具层。
 * 覆盖设计文档第 6 节的 B+C 终止判定与第 3 节的协议消息：
 * finish / 无工具追问 / stalled / 步数上限 / denied 继续 / cancel / 时间上限 / needs_user。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_ERROR, fail, ok, type ToolResult } from '../src/errors.ts';
import {
  createAgentServer,
  loadPluginsFromDirectory,
  readyToolList,
  registerBuiltinTools,
  type AgentMessage,
  type RunContext,
  type RunRequest,
} from '../src/index.ts';
import { createKernel } from '../src/kernel/index.ts';
import type { ChatMessage, ModelAdapter, ToolCall, ToolSpecForModel } from '../src/model/types.ts';
import { buildSystemPrompt, STABLE_PROMPT_LINES } from '../src/runtime/prompt.ts';
import {
  NUDGE_TEXT,
  runAgent,
  type ApprovalDecision,
  type RunAgentOptions,
  type RuntimeEvent,
} from '../src/runtime/runtime.ts';

const WORKSPACE = 'C:/tmp/elaina-agent-test';

const LIST_TOOL: ToolSpecForModel = {
  name: 'list_files',
  description: '列出工作区内的文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

const READ_TOOL: ToolSpecForModel = {
  name: 'read_file',
  description: '读取工作区内文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

const WRITE_TOOL: ToolSpecForModel = {
  name: 'write_file',
  description: '写入工作区内文件',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
};

interface ScriptCall {
  name: string;
  args?: Record<string, unknown>;
}

interface ScriptTurn {
  text?: string;
  calls?: ScriptCall[];
  throws?: Error;
  /** 模拟模型 usage 上报（reasoning 只计数，不落正文） */
  usage?: { promptTokens: number; completionTokens: number };
  onRun?: (hooks: { onTextDelta?: (text: string) => void; signal?: AbortSignal }) => void;
}

interface FakeAdapter {
  adapter: ModelAdapter;
  /** 每轮拿到的完整消息快照 */
  seen: ChatMessage[][];
  readonly turns: number;
}

/** 脚本化 adapter：轮次用完后重复最后一轮（便于「一直调用同一工具」这类用例） */
function makeAdapter(script: ScriptTurn[]): FakeAdapter {
  const seen: ChatMessage[][] = [];
  let turns = 0;
  const adapter: ModelAdapter = {
    protocol: 'fake',
    async run(messages, tools, hooks) {
      seen.push(messages.map((message) => ({ ...message })));
      if (script.length === 0) throw new Error('脚本为空');
      const turn = script[Math.min(turns, script.length - 1)];
      turns += 1;
      if (turn.throws) throw turn.throws;
      if (turn.onRun) turn.onRun(hooks);
      if (turn.text) hooks.onTextDelta?.(turn.text);
      const toolCalls: ToolCall[] = (turn.calls ?? []).map((call, index) => ({
        id: 'call-' + turns + '-' + index,
        name: call.name,
        args: call.args ?? {},
      }));
      return { text: turn.text ?? '', toolCalls, reasoningTokens: 0, usage: turn.usage };
    },
  };
  return {
    adapter,
    seen,
    get turns() {
      return turns;
    },
  };
}

interface FakeExecutor {
  calls: ToolCall[];
  execute: (call: ToolCall) => Promise<ToolResult>;
}

function makeExecutor(handler: (call: ToolCall) => ToolResult | Promise<ToolResult>): FakeExecutor {
  const calls: ToolCall[] = [];
  return {
    calls,
    async execute(call: ToolCall): Promise<ToolResult> {
      calls.push(call);
      return handler(call);
    },
  };
}

function baseOptions(overrides: Partial<RunAgentOptions>): RunAgentOptions {
  return {
    adapter: makeAdapter([{ calls: [{ name: 'finish', args: { status: 'done', summary: '默认完成' } }] }]).adapter,
    tools: [LIST_TOOL, READ_TOOL, WRITE_TOOL],
    access: 'full',
    workspace: WORKSPACE,
    executeTool: async () => ok({}),
    onEvent: () => {},
    ...overrides,
  };
}

function collect(): { events: RuntimeEvent[]; onEvent: (event: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

function findEvent<T extends RuntimeEvent['type']>(events: RuntimeEvent[], type: T): Extract<RuntimeEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时');
    await wait(5);
  }
}

function parseLines(lines: string[]): AgentMessage[] {
  return lines.map((line) => JSON.parse(line) as AgentMessage);
}

function findLine(lines: string[], type: string): AgentMessage | undefined {
  return parseLines(lines).find((message) => message.type === type);
}

// ---------------- 1. finish 即完成 ----------------

test('只有 finish 算完成：状态/总结原样上报，不执行工具', async () => {
  const fake = makeAdapter([{ text: '任务完成。', calls: [{ name: 'finish', args: { status: 'done', summary: '已改好 a.txt' } }] }]);
  const executor = makeExecutor(() => ok({}));
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-finish', goal: '改一下 a.txt' },
    baseOptions({ adapter: fake.adapter, executeTool: executor.execute, onEvent: sink.onEvent }),
  );

  assert.equal(result.status, 'done');
  assert.equal(result.summary, '已改好 a.txt');
  assert.equal(result.runId, 'r-finish');
  assert.equal(result.steps, 0);
  assert.equal(executor.calls.length, 0);
  assert.deepEqual(types(sink.events), ['chunk', 'finish']);

  const finish = findEvent(sink.events, 'finish');
  assert.ok(finish);
  assert.equal(finish.status, 'done');
  assert.equal(finish.summary, '已改好 a.txt');

  // 系统提示词里必须给出 finish 契约与工具清单
  const system = result.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('finish(status, summary)'));
  assert.ok(system.content.includes('read_file'));
  assert.equal(result.messages[1].role, 'user');
  assert.equal(result.messages[1].content, '改一下 a.txt');
});

test('finish 的 status 非法时按 done 处理，空 summary 有兜底文案', async () => {
  const fake = makeAdapter([{ calls: [{ name: 'finish', args: { status: 'whatever', summary: '  ' } }] }]);
  const result = await runAgent({ runId: 'r-bad-status', goal: 'x' }, baseOptions({ adapter: fake.adapter }));
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '（模型未提供总结）');
});

// ---------------- 2. 无工具动作：追问一次 ----------------

test('无 tool_calls 且无 finish：先追问一次，模型恢复后正常完成', async () => {
  const fake = makeAdapter([
    { text: '我先想想。' },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '追问后完成' } }] },
  ]);
  const sink = collect();

  const result = await runAgent({ runId: 'r-nudge', goal: '查一下目录' }, baseOptions({ adapter: fake.adapter, onEvent: sink.onEvent }));

  assert.equal(result.status, 'done');
  assert.equal(result.summary, '追问后完成');
  assert.equal(fake.turns, 2);
  assert.ok(!types(sink.events).includes('stalled'));

  // 第二轮模型看到的最后一条 user 消息就是追问文案
  const secondCall = fake.seen[1];
  const lastMessage = secondCall[secondCall.length - 1];
  assert.equal(lastMessage.role, 'user');
  assert.equal(lastMessage.content, NUDGE_TEXT);
});

test('连续两次无工具动作 → stalled（NO_ACTION），不再继续追问', async () => {
  const fake = makeAdapter([{ text: '嗯。' }, { text: '再想想。' }, { text: '还在想。' }]);
  const sink = collect();

  const result = await runAgent({ runId: 'r-stalled', goal: '做点什么' }, baseOptions({ adapter: fake.adapter, onEvent: sink.onEvent }));

  assert.equal(result.status, 'stalled');
  assert.equal(fake.turns, 2);
  const stalled = findEvent(sink.events, 'stalled');
  assert.ok(stalled);
  assert.equal(stalled.reason, 'NO_ACTION');
  assert.ok(!types(sink.events).includes('finish'));
  assert.equal(result.code, AGENT_ERROR.STALLED);
});

// ---------------- 3. 硬上限与失败升级 ----------------

test('同工具同参数失败 3 次 → stalled（REPEATED_FAILURE）', async () => {
  const fake = makeAdapter([{ calls: [{ name: 'read_file', args: { path: 'missing.txt' } }] }]);
  const executor = makeExecutor(() => fail(AGENT_ERROR.TOOL_FAILED, '文件不存在'));
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-repeat', goal: '读 missing.txt' },
    baseOptions({ adapter: fake.adapter, executeTool: executor.execute, onEvent: sink.onEvent }),
  );

  assert.equal(result.status, 'stalled');
  assert.equal(executor.calls.length, 3);
  const stalled = findEvent(sink.events, 'stalled');
  assert.ok(stalled);
  assert.equal(stalled.reason, 'REPEATED_FAILURE');
  assert.equal(sink.events.filter((event) => event.type === 'tool_result').length, 3);
});

test('参数键顺序不同也算同一调用：失败计数不能被绕过', async () => {
  const sequence: ScriptTurn[] = [
    { calls: [{ name: 'read_file', args: { path: 'a.txt', encoding: 'utf8' } }] },
    { calls: [{ name: 'read_file', args: { encoding: 'utf8', path: 'a.txt' } }] },
    { calls: [{ name: 'read_file', args: { path: 'a.txt', encoding: 'utf8' } }] },
  ];
  const fake = makeAdapter(sequence);
  const executor = makeExecutor(() => fail(AGENT_ERROR.TOOL_FAILED, '读不了'));

  const result = await runAgent({ runId: 'r-repeat-order', goal: '读 a.txt' }, baseOptions({ adapter: fake.adapter, executeTool: executor.execute }));

  assert.equal(result.status, 'stalled');
  assert.equal(executor.calls.length, 3);
});

test('步数上限：第 N 次工具调用后不再执行，判 STEP_LIMIT', async () => {
  const fake = makeAdapter([{ calls: [{ name: 'list_files', args: { path: '.' } }] }]);
  const executor = makeExecutor(() => ok({ files: [] }));
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-steps', goal: '一直列目录' },
    baseOptions({ adapter: fake.adapter, executeTool: executor.execute, onEvent: sink.onEvent, limits: { maxSteps: 2 } }),
  );

  assert.equal(result.status, 'stalled');
  assert.equal(result.steps, 2);
  assert.equal(executor.calls.length, 2);
  assert.equal(sink.events.filter((event) => event.type === 'step').length, 2);
  const stalled = findEvent(sink.events, 'stalled');
  assert.ok(stalled);
  assert.equal(stalled.reason, 'STEP_LIMIT');
});

test('时间上限：超过 maxRunMs → stalled（TIME_LIMIT）', async () => {
  let clockMs = 0;
  const fake = makeAdapter([{ text: '开始。' }, { calls: [{ name: 'finish', args: { status: 'done', summary: '不该到这里' } }] }]);
  const sink = collect();
  const onEvent = (event: RuntimeEvent): void => {
    sink.onEvent(event);
    if (event.type === 'chunk') clockMs += 5000;
  };

  const result = await runAgent(
    { runId: 'r-time', goal: '慢慢来' },
    baseOptions({ adapter: fake.adapter, onEvent, now: () => clockMs, limits: { maxRunMs: 1000 } }),
  );

  assert.equal(result.status, 'stalled');
  assert.equal(fake.turns, 1);
  const stalled = findEvent(sink.events, 'stalled');
  assert.ok(stalled);
  assert.equal(stalled.reason, 'TIME_LIMIT');
});

// ---------------- 4. 审批：拒绝是数据 ----------------

test('denied 不终止任务：不执行工具、不计失败，模型可换方案后 finish', async () => {
  const fake = makeAdapter([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '被拒后换方案' } }] },
  ]);
  const executor = makeExecutor(() => ok({ written: true }));
  const sink = collect();
  const decisions: ApprovalDecision[] = ['deny'];

  const result = await runAgent(
    { runId: 'r-denied', goal: '写文件' },
    baseOptions({
      adapter: fake.adapter,
      executeTool: executor.execute,
      onEvent: sink.onEvent,
      access: 'approval',
      needsApproval: () => true,
      requestApproval: async () => decisions.shift() ?? 'deny',
    }),
  );

  assert.equal(result.status, 'done');
  assert.equal(result.summary, '被拒后换方案');
  assert.equal(executor.calls.length, 0);
  const denied = findEvent(sink.events, 'tool_result');
  assert.ok(denied);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, AGENT_ERROR.TOOL_DENIED);
  assert.equal(denied.denied, true);
  assert.equal(denied.index, 1);
  assert.equal(denied.tool, 'write_file');
  // 拒绝后模型第二轮的消息里能看到拒绝结果
  const secondCall = fake.seen[1];
  const toolMessage = secondCall[secondCall.length - 1];
  assert.equal(toolMessage.role, 'tool');
  assert.ok(String(toolMessage.content).includes(AGENT_ERROR.TOOL_DENIED));
});

test('审批通过（once）后正常执行工具', async () => {
  const fake = makeAdapter([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '写好了' } }] },
  ]);
  const executor = makeExecutor(() => ok({ written: true }));

  const result = await runAgent(
    { runId: 'r-approved', goal: '写文件' },
    baseOptions({
      adapter: fake.adapter,
      executeTool: executor.execute,
      access: 'approval',
      needsApproval: () => true,
      requestApproval: async () => 'once',
    }),
  );

  assert.equal(result.status, 'done');
  assert.equal(executor.calls.length, 1);
});

test('needs_user 直接交回用户，不再让模型继续猜', async () => {
  const fake = makeAdapter([{ calls: [{ name: 'read_file', args: { path: 'which.txt' } }] }]);
  const executor = makeExecutor(() => fail(AGENT_ERROR.TOOL_FAILED, '需要用户确认要读哪个文件', { needs_user: true }));
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-needs-user', goal: '读一个文件' },
    baseOptions({ adapter: fake.adapter, executeTool: executor.execute, onEvent: sink.onEvent }),
  );

  assert.equal(result.status, 'need_user');
  assert.equal(result.summary, '需要用户确认要读哪个文件');
  const finish = findEvent(sink.events, 'finish');
  assert.ok(finish);
  assert.equal(finish.status, 'need_user');
  assert.equal(fake.turns, 1);
});

test('工具抛异常被兜成 TOOL_FAILED，不炸掉任务', async () => {
  const fake = makeAdapter([
    { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '异常后继续' } }] },
  ]);
  const executor = makeExecutor(() => {
    throw new Error('boom');
  });

  const result = await runAgent({ runId: 'r-throw', goal: '读文件' }, baseOptions({ adapter: fake.adapter, executeTool: executor.execute }));

  assert.equal(result.status, 'done');
  assert.ok(result.messages.filter((message) => message.role === 'tool').length >= 1);
});

// ---------------- 5. cancel ----------------

test('cancel（AbortSignal）→ cancelled 事件，不再处理后续 turn', async () => {
  const controller = new AbortController();
  const fake = makeAdapter([{ text: '开始处理。' }, { calls: [{ name: 'finish', args: { status: 'done', summary: '不该完成' } }] }]);
  const executor = makeExecutor(() => ok({}));
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-cancel', goal: '取消我' },
    baseOptions({
      adapter: fake.adapter,
      executeTool: executor.execute,
      signal: controller.signal,
      onEvent: (event) => {
        sink.onEvent(event);
        if (event.type === 'chunk') controller.abort();
      },
    }),
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(fake.turns, 1);
  assert.ok(types(sink.events).includes('cancelled'));
  assert.ok(!types(sink.events).includes('finish'));
  assert.equal(result.code, AGENT_ERROR.CANCELLED);
});

test('adapter 抛 AbortError 视为取消', async () => {
  const controller = new AbortController();
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  const fake = makeAdapter([{ throws: abortError }]);

  const run = runAgent({ runId: 'r-abort-error', goal: 'x' }, baseOptions({ adapter: fake.adapter, signal: controller.signal }));
  controller.abort();
  const result = await run;

  assert.equal(result.status, 'cancelled');
});

// ---------------- 6. 系统提示词分层 ----------------

test('提示词分层：稳定层在前、任务层在后，任务字段齐全', () => {
  const prompt = buildSystemPrompt({
    goal: '修一下登录报错',
    workspace: 'F:/work/demo',
    access: 'approval',
    tools: [
      { name: 'read_file', description: '读取工作区文件' },
      { name: 'finish', description: '结束任务' },
    ],
    git: { isRepo: true, branch: 'feature/login', dirty: true },
    runId: 'r-prompt',
    platform: 'win32',
  });

  const stableIndex = prompt.indexOf('# 1. 硬边界');
  const taskIndex = prompt.indexOf('# 本次任务');
  assert.ok(stableIndex >= 0, '稳定层缺失');
  assert.ok(taskIndex > stableIndex, '任务层必须在稳定层之后');
  assert.ok(STABLE_PROMPT_LINES.length >= 30, '稳定层不应被空行稀释成空数组');

  assert.ok(prompt.includes('106.14.16.68'));
  assert.ok(prompt.includes('elainachat.j3.ink'));
  assert.ok(prompt.includes('finish(status, summary)'));
  assert.ok(prompt.includes('修一下登录报错'));
  assert.ok(prompt.includes('F:/work/demo'));
  assert.ok(prompt.includes('feature/login'));
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('档位：approval'));
  assert.ok(!prompt.includes('档位：full'));
});

test('提示词任务层：full 档位 / 非 git 仓库 / 首次 git 询问 / 无工具 / git 未知', () => {
  const full = buildSystemPrompt({
    goal: 'g',
    workspace: 'F:/w',
    access: 'full',
    tools: [{ name: 'finish', description: '结束任务' }],
    git: { isRepo: false },
    platform: 'win32',
  });
  assert.ok(full.includes('档位：full'));
  assert.ok(full.includes('不是 git 仓库'));

  const first = buildSystemPrompt({
    goal: 'g',
    workspace: 'F:/w',
    access: 'approval',
    tools: [],
    git: null,
    firstGitAsk: true,
    platform: 'win32',
  });
  assert.ok(first.includes('首次使用 Agent'));
  assert.ok(first.includes('没有任何工具可用'));
  assert.ok(first.includes('未提供 git 状态'));
});

// ---------------- 7. stdio 协议（index.ts） ----------------

test('hello → ready：上报版本与工具清单', () => {
  const lines: string[] = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async () => {},
    agentVersion: 'test-0.1.0',
    listTools: () => [
      { name: 'finish', description: '结束' },
      { name: 'read_file', description: '读文件' },
    ],
  });

  server.handleLine('{"type":"hello","clientVersion":"2.3.0","agentApiVersion":"1"}');
  const ready = findLine(lines, 'ready');
  assert.ok(ready);
  assert.equal(ready.agentVersion, 'test-0.1.0');
  assert.equal(ready.agentApiVersion, '1');
  assert.equal((ready.tools as unknown[]).length, 2);

  // 版本不匹配：回 error 且不再 ready
  const before = lines.length;
  server.handleLine('{"type":"hello","clientVersion":"2.3.0","agentApiVersion":"9"}');
  assert.equal(lines.length, before + 1);
  assert.equal(JSON.parse(lines[lines.length - 1]).type, 'error');

  server.dispose();
});

test('非法消息不崩溃：坏 JSON / 未知类型都回 error，之后仍能 hello→ready', () => {
  const lines: string[] = [];
  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {} });

  server.handleLine('{oops');
  assert.equal(findLine(lines, 'error')?.code, AGENT_ERROR.PROTOCOL_INVALID);

  server.handleLine('{"type":"nonsense"}');
  const errors = parseLines(lines).filter((message) => message.type === 'error');
  assert.equal(errors.length, 2);

  server.handleLine('{"type":"hello","clientVersion":"2.3.0","agentApiVersion":"1"}');
  assert.ok(findLine(lines, 'ready'));

  // run 缺 workspace：error 而不是崩溃
  const before = lines.length;
  server.handleLine('{"type":"run","runId":"r-bad","goal":"g"}');
  assert.equal(lines.length, before + 1);
  const badRun = JSON.parse(lines[lines.length - 1]);
  assert.equal(badRun.type, 'error');
  assert.equal(badRun.runId, 'r-bad');

  server.dispose();
});

test('run → approval_request → approval_response → finish（决策传回 runtime）', async () => {
  const lines: string[] = [];
  let captured: RunContext | null = null;
  const server = createAgentServer({
    write: (line) => lines.push(line),
    approvalTimeoutMs: 1000,
    createRun: async (request: RunRequest, context: RunContext) => {
      captured = context;
      context.onEvent({ type: 'chunk', runId: request.runId, text: '开始' });
      const decision = await context.requestApproval({
        id: 'appr-1',
        tool: 'write_file',
        action: 'write_file',
        detail: 'write_file a.txt',
        args: { path: 'a.txt' },
      });
      context.onEvent({ type: 'finish', runId: request.runId, status: 'done', summary: '审批结果=' + decision, steps: 1, durationMs: 4 });
    },
  });

  server.handleLine('{"type":"run","runId":"r1","goal":"写文件","workspace":"C:/tmp","access":"approval"}');
  await waitFor(() => Boolean(findLine(lines, 'approval_request')));

  const approval = findLine(lines, 'approval_request');
  assert.ok(approval);
  assert.equal(approval.id, 'appr-1');
  assert.equal(approval.tool, 'write_file');
  assert.equal(approval.detail, 'write_file a.txt');
  assert.equal(server.activeRunId, 'r1');
  assert.equal(server.pendingApprovalCount, 1);

  server.handleLine('{"type":"approval_response","id":"appr-1","decision":"once"}');
  await waitFor(() => Boolean(findLine(lines, 'finish')));

  const finish = findLine(lines, 'finish');
  assert.ok(finish);
  assert.equal(finish.runId, 'r1');
  assert.equal(finish.status, 'done');
  assert.equal(finish.summary, '审批结果=once');
  assert.ok(captured);
  await waitFor(() => server.activeRunId === null);

  // 未知审批 id：回 error，不崩
  const before = lines.length;
  server.handleLine('{"type":"approval_response","id":"nope","decision":"once"}');
  assert.equal(lines.length, before + 1);
  assert.equal(JSON.parse(lines[lines.length - 1]).type, 'error');

  server.dispose();
});

test('审批 60s 超时（测试用短超时）等价于拒绝', async () => {
  const lines: string[] = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    approvalTimeoutMs: 20,
    createRun: async (request: RunRequest, context: RunContext) => {
      const decision = await context.requestApproval({ id: 'appr-timeout', tool: 'write_file', action: 'write_file', detail: 'x', args: {} });
      context.onEvent({ type: 'finish', runId: request.runId, status: 'done', summary: '决定=' + decision, steps: 0, durationMs: 1 });
    },
  });

  server.handleLine('{"type":"run","runId":"r-timeout","goal":"g","workspace":"C:/tmp"}');
  await waitFor(() => Boolean(findLine(lines, 'finish')));
  assert.equal(findLine(lines, 'finish')?.summary, '决定=deny');
  assert.equal(server.pendingApprovalCount, 0);

  server.dispose();
});

test('cancel → abort 运行中的 run，runtime 侧收到取消并回 cancelled + finish', async () => {
  const lines: string[] = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async (request: RunRequest, context: RunContext) => {
      if (context.signal.aborted) {
        context.onEvent({ type: 'cancelled', runId: request.runId, message: '已取消', steps: 0, durationMs: 0 });
        return;
      }
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          'abort',
          () => {
            context.onEvent({ type: 'cancelled', runId: request.runId, message: '用户已取消本次任务。', steps: 0, durationMs: 0 });
            resolve();
          },
          { once: true },
        );
      });
    },
  });

  server.handleLine('{"type":"run","runId":"r-cancel","goal":"g","workspace":"C:/tmp"}');
  await waitFor(() => server.activeRunId === 'r-cancel');
  server.handleLine('{"type":"cancel","runId":"r-cancel"}');
  await waitFor(() => Boolean(findLine(lines, 'finish')));

  assert.ok(findLine(lines, 'cancelled'));
  const finish = findLine(lines, 'finish');
  assert.equal(finish?.status, 'blocked');
  assert.equal(finish?.summary, '用户已取消本次任务。');
  await waitFor(() => server.activeRunId === null);

  server.dispose();
});

test('并发 run 被拒绝（RUN_BUSY），不破坏正在跑的任务', async () => {
  const lines: string[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async (request: RunRequest, context: RunContext) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      context.onEvent({ type: 'finish', runId: request.runId, status: 'done', summary: '完成', steps: 0, durationMs: 0 });
    },
  });

  server.handleLine('{"type":"run","runId":"r-a","goal":"a","workspace":"C:/tmp"}');
  await waitFor(() => server.activeRunId === 'r-a');

  const before = lines.length;
  server.handleLine('{"type":"run","runId":"r-b","goal":"b","workspace":"C:/tmp"}');
  assert.equal(lines.length, before + 1);
  const busy = JSON.parse(lines[lines.length - 1]);
  assert.equal(busy.code, 'RUN_BUSY');
  assert.equal(server.activeRunId, 'r-a');

  if (gate.release) gate.release();
  await waitFor(() => server.activeRunId === null);
  server.dispose();
});
// ---------------- 8. cordis 内核 / 插件 ----------------

test('cordis 内核：内置工具以插件形式注册，ready 从 ToolsService.list() 读取', async () => {
  const kernel = await createKernel();
  const registered = await registerBuiltinTools(kernel, [
    { name: 'demo_builtin', description: '演示内置工具', parameters: { type: 'object', properties: {} }, risk: 'safe' },
  ]);
  assert.equal(registered.ok, true);
  assert.equal(registered.count, 1);
  assert.equal(kernel.ctx.tools.has('demo_builtin'), true);

  const lines: string[] = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async () => {},
    listTools: () => readyToolList(kernel, null),
  });
  server.handleLine('{"type":"hello","clientVersion":"test","agentApiVersion":"1"}');
  const ready = findLine(lines, 'ready');
  assert.ok(ready);
  const names = (ready.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(names.includes('finish'));
  assert.ok(names.includes('demo_builtin'));

  // 注销后 ready 立即反映内核状态（没有旁路缓存）
  kernel.ctx.tools.unregister('demo_builtin');
  assert.equal(kernel.ctx.tools.list().length, 0);

  server.dispose();
  await kernel.dispose();
});

test('插件目录：坏 manifest / 抛错插件被隔离，好插件成功注册工具', async () => {
  const kernel = await createKernel();
  const root = await mkdtemp(path.join(tmpdir(), 'elaina-plugins-'));
  const logs: string[] = [];
  try {
    const good = path.join(root, 'good-plugin');
    await mkdir(good, { recursive: true });
    await writeFile(
      path.join(good, 'manifest.json'),
      JSON.stringify({ id: 'good-plugin', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['good_tool'] }),
      'utf8',
    );
    await writeFile(
      path.join(good, 'index.mjs'),
      "export function apply(api) { api.tools.register({ name: 'good_tool', description: '来自测试插件的工具', parameters: { type: 'object', properties: {} } }); }\n",
      'utf8',
    );

    const badManifest = path.join(root, 'bad-manifest');
    await mkdir(badManifest, { recursive: true });
    await writeFile(path.join(badManifest, 'manifest.json'), JSON.stringify({ id: 'bad-manifest' }), 'utf8');

    const throwing = path.join(root, 'throwing-plugin');
    await mkdir(throwing, { recursive: true });
    await writeFile(
      path.join(throwing, 'manifest.json'),
      JSON.stringify({ id: 'throwing-plugin', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['boom_tool'] }),
      'utf8',
    );
    await writeFile(path.join(throwing, 'index.mjs'), "export function apply() { throw new Error('插件内部爆炸'); }\n", 'utf8');

    const result = await loadPluginsFromDirectory(kernel, root, { log: (message) => logs.push(message) });
    assert.deepEqual(result.loaded, ['good-plugin']);
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.includes('bad-manifest'));
    assert.ok(result.failed.includes('throwing-plugin'));
    assert.equal(kernel.ctx.tools.has('good_tool'), true);
    assert.equal(kernel.ctx.tools.has('boom_tool'), false);
    assert.ok(logs.some((line) => line.includes('插件加载失败')));
    // 好插件注册的工具会出现在 ready 清单里
    const names = readyToolList(kernel, null).map((tool) => tool.name);
    assert.ok(names.includes('good_tool'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('插件目录不存在时不报错（没装插件是正常状态）', async () => {
  const kernel = await createKernel();
  const missing = path.join(tmpdir(), 'elaina-no-such-plugins-' + Date.now());
  const logs: string[] = [];
  const result = await loadPluginsFromDirectory(kernel, missing, { log: (message) => logs.push(message) });
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.failed, []);
  assert.equal(logs.length, 0);
  await kernel.dispose();
});
// ---------------- 9. usage / 检查点钩子 / search_test ----------------

test('usage 事件只发 token 数：finish 带累计 usage，reasoning 不发正文', async () => {
  const fake = makeAdapter([
    { text: '开始。', usage: { promptTokens: 12, completionTokens: 3 }, calls: [{ name: 'list_files', args: { path: '.' } }] },
    { text: '完成。', usage: { promptTokens: 30, completionTokens: 5 }, calls: [{ name: 'finish', args: { status: 'done', summary: '好了' } }] },
  ]);
  const sink = collect();
  const executor = makeExecutor(() => ok({ files: [] }));

  const result = await runAgent(
    { runId: 'r-usage', goal: '列目录' },
    baseOptions({ adapter: fake.adapter, executeTool: executor.execute, onEvent: sink.onEvent }),
  );

  const usageEvents = sink.events.filter((event) => event.type === 'usage');
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents[0], { type: 'usage', runId: 'r-usage', tokens: { input: 12, output: 3 } });
  assert.deepEqual(usageEvents[1], { type: 'usage', runId: 'r-usage', tokens: { input: 30, output: 5 } });

  const finish = findEvent(sink.events, 'finish');
  assert.ok(finish);
  assert.deepEqual(finish.usage, { input: 42, output: 8 });
  assert.deepEqual(result.usage, { input: 42, output: 8 });
  // 事件里不存在推理正文（只有 reasoningTokens 计数）
  assert.ok(!JSON.stringify(sink.events).includes('reasoningText'));
});

test('beforeTool 钩子：工具执行前调用，commit 短哈希附到 finish 摘要', async () => {
  const fake = makeAdapter([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '写好了' } }] },
  ]);
  const executor = makeExecutor(() => ok({ written: true }));
  const hooked: Array<{ step: number; tool: string }> = [];
  const sink = collect();

  const result = await runAgent(
    { runId: 'r-checkpoint', goal: '写文件' },
    baseOptions({
      adapter: fake.adapter,
      executeTool: executor.execute,
      access: 'approval',
      needsApproval: () => false,
      onEvent: sink.onEvent,
      beforeTool: async (call, step) => {
        hooked.push({ step, tool: call.name });
        return call.name === 'write_file' ? { commit: 'abcdef1234567890' } : undefined;
      },
    }),
  );

  assert.equal(result.status, 'done');
  assert.deepEqual(hooked, [{ step: 1, tool: 'write_file' }]);
  assert.ok(result.summary.includes('abcdef1'));
  assert.ok(result.summary.includes('写好了'));
  const finish = findEvent(sink.events, 'finish');
  assert.ok(finish);
  assert.ok(finish.summary.includes('abcdef1'));
});

test('beforeTool 抛错不阻断任务，也不计入工具失败', async () => {
  const fake = makeAdapter([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
    { calls: [{ name: 'finish', args: { status: 'done', summary: '写完' } }] },
  ]);
  const executor = makeExecutor(() => ok({ written: true }));

  const result = await runAgent(
    { runId: 'r-checkpoint-throw', goal: '写文件' },
    baseOptions({
      adapter: fake.adapter,
      executeTool: executor.execute,
      needsApproval: () => false,
      beforeTool: () => {
        throw new Error('git 炸了');
      },
    }),
  );

  assert.equal(result.status, 'done');
  assert.equal(executor.calls.length, 1);
  assert.equal(result.summary, '写完');
});

test('search_test：成功/失败/异常/非法消息都回 search_test_result（含 requestId）', async () => {
  const lines: string[] = [];
  const seen: Array<{ provider: string; apiKey?: string }> = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async () => {},
    searchTest: async (request) => {
      seen.push({ provider: request.provider, apiKey: request.apiKey });
      if (request.provider === 'tavily') return { ok: true, message: '搜索连接正常' };
      if (request.provider === 'custom') throw new Error('网络炸了');
      return { ok: false, message: '未填写 brave API Key（' + String(request.apiKey ?? '') + '）' };
    },
  });

  const results = (): AgentMessage[] => parseLines(lines).filter((message) => message.type === 'search_test_result');

  server.handleLine('{"type":"search_test","requestId":"s1","provider":"tavily","apiKey":"tvly-secret"}');
  await waitFor(() => results().length === 1);
  assert.equal(results()[0].requestId, 's1');
  assert.equal(results()[0].ok, true);
  assert.ok(String(results()[0].message).includes('搜索连接正常'));
  assert.equal(seen[0].apiKey, 'tvly-secret');

  // 失败也要回，且消息里的 Key 必须脱敏
  server.handleLine('{"type":"search_test","requestId":"s2","provider":"brave","apiKey":"brave-secret"}');
  await waitFor(() => results().length === 2);
  assert.equal(results()[1].ok, false);
  assert.ok(String(results()[1].message).includes('brave'));
  assert.ok(!String(results()[1].message).includes('brave-secret'));
  assert.ok(String(results()[1].message).includes('***'));

  // 实现方抛异常：转成 ok:false，不沉默
  server.handleLine('{"type":"search_test","requestId":"s3","provider":"custom","apiKey":"c-secret","endpoint":"https://example.com/search?q={query}"}');
  await waitFor(() => results().length === 3);
  assert.equal(results()[2].ok, false);
  assert.ok(String(results()[2].message).includes('网络炸了'));

  // 非法消息：也回一条，UI 才能结束 loading
  server.handleLine('{"type":"search_test","requestId":"s4"}');
  await waitFor(() => results().length === 4);
  assert.equal(results()[3].requestId, 's4');
  assert.equal(results()[3].ok, false);
  assert.ok(String(results()[3].message).includes('非法'));

  server.dispose();
});
