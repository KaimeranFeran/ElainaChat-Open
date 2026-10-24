/**
 * 插件执行通道（handler / manifest shell command）与 models_request IPC 的离线测试。
 *
 * 全部临时目录 + 注入 fetch / 注入 command runner：不联网、不执行真实 shell、不写用户目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentServer,
  executePluginTool,
  extractModelList,
  loadPluginsFromDirectory,
  substituteCommandArgs,
  type AgentMessage,
  type PluginToolRuntime,
} from '../src/index.ts';
import { AGENT_ERROR, ok } from '../src/errors.ts';
import { createKernel } from '../src/kernel/index.ts';

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'elaina-plugin-exec-'));
}

async function writePlugin(root: string, dirName: string, manifest: unknown, entrySource?: string): Promise<void> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  if (entrySource !== undefined) await writeFile(path.join(dir, 'index.mjs'), entrySource, 'utf8');
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

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------- 1. manifest command 权限 ----------------

test('manifest command 没有 shell 权限：插件加载失败并写 stderr，不注册工具', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const logs: string[] = [];
  try {
    await writePlugin(root, 'no-shell', {
      id: 'no-shell',
      version: '1.0.0',
      agentApiVersion: '1',
      permissions: [],
      tools: [{ name: 'bad_cmd', command: 'Write-Output hi' }],
    });

    const result = await loadPluginsFromDirectory(kernel, root, { log: (message) => logs.push(message) });

    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ['no-shell']);
    assert.equal(result.tools.size, 0);
    assert.equal(kernel.ctx.tools.has('bad_cmd'), false);
    assert.ok(logs.some((line) => line.includes('shell')), 'stderr 里要写明缺少 shell 权限');
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('substituteCommandArgs：{{arg}} 单引号转义，未知占位保留原样', () => {
  assert.equal(substituteCommandArgs('echo {{a}}', { a: "it's" }), "echo 'it''s'");
  assert.equal(substituteCommandArgs('echo {{ missing }}', {}), 'echo {{ missing }}');
  assert.equal(substituteCommandArgs('echo {{n}}', { n: 5 }), "echo '5'");
});

test('command 通道：{{arg}} 替换、ELAINA_AGENT_ARGS、cwd 与 timeoutMs 传给 runner', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(root, 'echo', {
      id: 'echo',
      version: '1.0.0',
      agentApiVersion: '1',
      permissions: ['shell'],
      tools: [
        {
          name: 'echo_args',
          description: '回显参数',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          command: 'Write-Output {{text}}; $env:ELAINA_AGENT_ARGS',
          timeoutMs: 5000,
          cwd: 'sub',
        },
      ],
    });

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    assert.deepEqual(result.loaded, ['echo']);
    const tool = result.tools.get('echo_args');
    assert.ok(tool);
    assert.equal(tool.kind, 'command');
    assert.equal(tool.cwd, 'sub');
    assert.equal(kernel.ctx.tools.has('echo_args'), true);

    const captured: Array<{ command: string; options: { workspace: string; timeoutMs?: number; env: NodeJS.ProcessEnv } }> = [];
    const runCommand = async (command: string, options: { workspace: string; timeoutMs?: number; env: NodeJS.ProcessEnv }) => {
      captured.push({ command, options });
      return ok({ stdout: 'hi' }, '命令已执行');
    };

    const args = { text: "hello 'world'", extra: 42 };
    const toolResult = await executePluginTool(tool, args, { workspace: root, runCommand });

    assert.equal(toolResult.ok, true);
    assert.equal(captured.length, 1);
    assert.ok(captured[0].command.includes("'hello ''world'''"), '参数要按单引号转义后替换');
    assert.equal(captured[0].options.env.ELAINA_AGENT_ARGS, JSON.stringify(args));
    assert.equal(captured[0].options.workspace, path.join(root, 'sub'));
    assert.equal(captured[0].options.timeoutMs, 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('command 通道：cwd 逃逸工作区被拒（TOOL_DENIED），不执行命令', async () => {
  const tool: PluginToolRuntime = {
    name: 'escape_cmd',
    pluginId: 'evil',
    kind: 'command',
    command: 'Write-Output hi',
    cwd: '..',
  };
  let called = false;
  const result = await executePluginTool(tool, {}, {
    workspace: path.join(tmpdir(), 'elaina-plugin-ws-' + Date.now()),
    runCommand: async () => {
      called = true;
      return ok({}, '');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_ERROR.TOOL_DENIED);
  assert.equal(called, false);
});

// ---------------- 2. handler 通道 ----------------

test('handler 通道：export const tools 映射可执行，string 返回值归一成 message', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(
      root,
      'table',
      {
        id: 'table',
        version: '1.0.0',
        agentApiVersion: '1',
        permissions: [],
        tools: [{ name: 'greet', description: '打招呼', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
      },
      "export const tools = { greet: async (args) => 'hi ' + args.name };\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    assert.deepEqual(result.loaded, ['table']);
    const tool = result.tools.get('greet');
    assert.ok(tool);
    assert.equal(tool.kind, 'handler');
    assert.equal(kernel.ctx.tools.has('greet'), true);

    const toolResult = await executePluginTool(tool, { name: 'bob' }, { workspace: root });
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.message, 'hi bob');
    assert.equal(toolResult.code, 'OK');
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('handler 通道：export function register(api) 可注册，object 返回值进 data', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(
      root,
      'register',
      {
        id: 'register',
        version: '1.0.0',
        agentApiVersion: '1',
        permissions: [],
        tools: [{ name: 'add', description: '加法', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }],
      },
      "export function register(api) {\n  api.tools.register({\n    name: 'add',\n    description: '加法',\n    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },\n    handler: async (args) => ({ sum: Number(args.a) + Number(args.b) }),\n  });\n}\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    assert.deepEqual(result.loaded, ['register']);
    const tool = result.tools.get('add');
    assert.ok(tool);

    const toolResult = await executePluginTool(tool, { a: 2, b: 3 }, { workspace: root });
    assert.equal(toolResult.ok, true);
    assert.deepEqual(toolResult.data, { sum: 5 });
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('handler 抛错隔离成 TOOL_FAILED（不向上抛）', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(
      root,
      'boom',
      {
        id: 'boom',
        version: '1.0.0',
        agentApiVersion: '1',
        permissions: [],
        tools: [{ name: 'boom_tool', description: '会爆炸', parameters: { type: 'object', properties: {} } }],
      },
      "export function register(api) { api.tools.register({ name: 'boom_tool', description: '会爆炸', parameters: { type: 'object', properties: {} }, handler: () => { throw new Error('插件内部爆炸'); } }); }\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    const tool = result.tools.get('boom_tool');
    assert.ok(tool);

    const toolResult = await executePluginTool(tool, {}, { workspace: root });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, AGENT_ERROR.TOOL_FAILED);
    assert.ok(toolResult.message.includes('插件内部爆炸'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('handler 超时隔离成 TOOL_TIMEOUT（manifest timeoutMs 生效）', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(
      root,
      'slow',
      {
        id: 'slow',
        version: '1.0.0',
        agentApiVersion: '1',
        permissions: [],
        tools: [{ name: 'slow_tool', description: '很慢', parameters: { type: 'object', properties: {} }, timeoutMs: 100 }],
      },
      "export function register(api) { api.tools.register({ name: 'slow_tool', description: '很慢', parameters: { type: 'object', properties: {} }, handler: () => new Promise(() => {}) }); }\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    const tool = result.tools.get('slow_tool');
    assert.ok(tool);
    assert.equal(tool.timeoutMs, 100);

    const toolResult = await executePluginTool(tool, {}, { workspace: root });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, AGENT_ERROR.TOOL_TIMEOUT);
    assert.ok(toolResult.message.includes('超时'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('handler 返回结构化 ToolResult 时原样接收（ok=false 透传）', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    await writePlugin(
      root,
      'structured',
      { id: 'structured', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['deny_me'] },
      "export const tools = { deny_me: async () => ({ ok: false, code: 'TOOL_DENIED', message: '插件自己拒绝', denied: true }) };\n",
    );
    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    const tool = result.tools.get('deny_me');
    assert.ok(tool);
    const toolResult = await executePluginTool(tool, {}, { workspace: root });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, AGENT_ERROR.TOOL_DENIED);
    assert.equal(toolResult.message, '插件自己拒绝');
    assert.equal(toolResult.denied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

// ---------------- 3. 失败隔离 ----------------

test('manifest 坏 JSON 与坏结构都隔离：好插件照常加载', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const logs: string[] = [];
  try {
    await writePlugin(root, 'bad-json', '{ not json');
    await writePlugin(root, 'bad-tools', { id: 'bad-tools', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: 'nope' });
    await writePlugin(
      root,
      'good',
      { id: 'good', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['good_tool'] },
      "export const tools = { good_tool: async () => 'ok' };\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: (message) => logs.push(message) });
    assert.deepEqual(result.loaded, ['good']);
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.includes('bad-json'));
    assert.ok(result.failed.includes('bad-tools'));
    assert.equal(kernel.ctx.tools.has('good_tool'), true);
    assert.ok(logs.filter((line) => line.includes('插件加载失败')).length === 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('工具名冲突：插件失败并回滚它注册的工具，已有工具不受影响', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  try {
    kernel.ctx.tools.register({ name: 'read_file', description: '内置读文件', parameters: { type: 'object', properties: {} } });
    await writePlugin(
      root,
      'conflict',
      { id: 'conflict', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['plugin_a', 'read_file'] },
      "export function register(api) {\n  api.tools.register({ name: 'plugin_a', description: 'a', parameters: { type: 'object', properties: {} }, handler: () => 'a' });\n  api.tools.register({ name: 'read_file', description: '冲突', parameters: { type: 'object', properties: {} }, handler: () => 'x' });\n}\n",
    );

    const result = await loadPluginsFromDirectory(kernel, root, { log: () => {} });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ['conflict']);
    assert.equal(kernel.ctx.tools.has('read_file'), true);
    assert.equal(kernel.ctx.tools.has('plugin_a'), false);
    assert.equal(result.tools.has('plugin_a'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

// ---------------- 4. models_request ----------------

test('models_request（openai）：请求 /models 并归一 [{id,name}]', async () => {
  const lines: string[] = [];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const modelsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return fakeResponse({ data: [{ id: 'm1', name: 'Model One' }, { id: 'm2' }] });
  }) as unknown as typeof fetch;

  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {}, modelsFetch });
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr1', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-1234567890', protocol: 'openai' }),
  );
  await waitFor(() => Boolean(findLine(lines, 'models_result')));

  const result = findLine(lines, 'models_result');
  assert.ok(result);
  assert.equal(result.requestId, 'mr1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'm2' }]);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test-1234567890');
  server.dispose();
});

test('models_request（anthropic）：请求 /v1/models + x-api-key + anthropic-version', async () => {
  const lines: string[] = [];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const modelsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return fakeResponse({ data: [{ id: 'claude-x', display_name: 'Claude X' }] });
  }) as unknown as typeof fetch;

  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {}, modelsFetch });
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr2', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-1234567890', protocol: 'anthropic' }),
  );
  await waitFor(() => Boolean(findLine(lines, 'models_result')));

  const result = findLine(lines, 'models_result');
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'claude-x', name: 'Claude X' }]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-1234567890');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  server.dispose();
});

test('models_request：失败也回 models_result，message 里的 Key 脱敏', async () => {
  const lines: string[] = [];
  const modelsFetch = (async () => {
    throw new Error('连接失败：sk-leak-1234567890');
  }) as unknown as typeof fetch;

  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {}, modelsFetch });
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr3', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-leak-1234567890', protocol: 'openai' }),
  );
  await waitFor(() => Boolean(findLine(lines, 'models_result')));
  const result = findLine(lines, 'models_result');
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, []);
  assert.ok(String(result.message).includes('查询模型列表失败'));
  assert.ok(!String(result.message).includes('sk-leak-1234567890'));
  assert.ok(String(result.message).includes('***'));
  server.dispose();
});

test('models_request：HTTP 非 2xx 也回 ok:false 并截断正文', async () => {
  const lines: string[] = [];
  const modelsFetch = (async () => fakeResponse('unauthorized sk-http-1234567890', 401)) as unknown as typeof fetch;
  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {}, modelsFetch });
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr5', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-http-1234567890', protocol: 'openai' }),
  );
  await waitFor(() => Boolean(findLine(lines, 'models_result')));
  const result = findLine(lines, 'models_result');
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.ok(String(result.message).includes('HTTP 401'));
  assert.ok(!String(result.message).includes('sk-http-1234567890'));
  server.dispose();
});

test('models_request：非法消息回 error，黑名单地址被拒且不发请求', async () => {
  const lines: string[] = [];
  let fetchCalls = 0;
  const modelsFetch = (async () => {
    fetchCalls += 1;
    return fakeResponse({ data: [] });
  }) as unknown as typeof fetch;
  const server = createAgentServer({ write: (line) => lines.push(line), createRun: async () => {}, modelsFetch });

  // 非法消息：缺 baseUrl → error
  server.handleLine(JSON.stringify({ type: 'models_request', requestId: 'mr6', protocol: 'openai' }));
  const error = findLine(lines, 'error');
  assert.ok(error);
  assert.equal(error.code, AGENT_ERROR.PROTOCOL_INVALID);

  // 官方网关：models_result ok:false，且不产生网络请求
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr7', baseUrl: 'http://106.14.16.68:8080/v1', apiKey: 'k', protocol: 'openai' }),
  );
  await waitFor(() => Boolean(findLine(lines, 'models_result')));
  const blocked = findLine(lines, 'models_result');
  assert.ok(blocked);
  assert.equal(blocked.ok, false);
  assert.ok(String(blocked.message).includes('官方网关'));
  assert.equal(fetchCalls, 0);

  // 本地反代 127.0.0.1:3500 同样拒绝
  server.handleLine(
    JSON.stringify({ type: 'models_request', requestId: 'mr8', baseUrl: 'http://127.0.0.1:3500/v1', apiKey: 'k', protocol: 'openai' }),
  );
  await waitFor(() => parseLines(lines).filter((message) => message.type === 'models_result').length === 2);
  const proxy = parseLines(lines).filter((message) => message.type === 'models_result')[1];
  assert.equal(proxy.ok, false);
  assert.ok(String(proxy.message).includes('127.0.0.1:3500'));
  assert.equal(fetchCalls, 0);

  server.dispose();
});

test('extractModelList：兼容 data/models/数组三种形态并去重', () => {
  assert.deepEqual(extractModelList({ data: [{ id: 'a' }, { id: 'a' }, { model: 'b' }, 'c'] }), [
    { id: 'a', name: 'a' },
    { id: 'b', name: 'b' },
    { id: 'c', name: 'c' },
  ]);
  assert.deepEqual(extractModelList(['x', 'y']), [{ id: 'x', name: 'x' }, { id: 'y', name: 'y' }]);
  assert.deepEqual(extractModelList(null), []);
  assert.deepEqual(extractModelList({ models: [{ name: 'n' }] }), [{ id: 'n', name: 'n' }]);
});
