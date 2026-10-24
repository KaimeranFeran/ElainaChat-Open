/**
 * 插件管理 IPC 测试：ready.plugins / plugins_list / plugin_set_enabled / plugins_rescan。
 *
 * 临时目录 + 真实 PluginManager：验证启停对 ToolsService（= 模型工具列表）的影响、
 * 禁用后的 TOOL_DENIED、重扫增删、失败隔离、manifest enabled=false 默认禁用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentServer,
  PluginManager,
  readyToolList,
  type AgentMessage,
  type PluginView,
} from '../src/index.ts';
import { AGENT_ERROR } from '../src/errors.ts';
import { createKernel, type Kernel } from '../src/kernel/index.ts';

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'elaina-plugins-ipc-'));
}

async function writePlugin(root: string, dirName: string, manifest: unknown, entrySource?: string): Promise<string> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  if (entrySource !== undefined) await writeFile(path.join(dir, 'index.mjs'), entrySource, 'utf8');
  return dir;
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

function pluginsOf(message: AgentMessage | undefined): PluginView[] {
  if (!message || !Array.isArray(message.plugins)) return [];
  return message.plugins as PluginView[];
}

function viewOf(message: AgentMessage | undefined, id: string): PluginView | undefined {
  return pluginsOf(message).find((plugin) => plugin.id === id);
}

function toolNames(kernel: Kernel): string[] {
  return readyToolList(kernel, null).map((tool) => tool.name);
}

interface Harness {
  kernel: Kernel;
  manager: PluginManager;
  lines: string[];
  server: ReturnType<typeof createAgentServer>;
}

function createHarness(kernel: Kernel, manager: PluginManager): Harness {
  const lines: string[] = [];
  const server = createAgentServer({
    write: (line) => lines.push(line),
    createRun: async () => {},
    listTools: () => readyToolList(kernel, null),
    pluginInfo: () => manager.snapshot(),
    setPluginEnabled: (id, enabled) => manager.setEnabled(id, enabled),
    rescanPlugins: async () => {
      await manager.scan();
      return {
        ok: true,
        message: '已重新扫描插件目录：加载 ' + manager.loadedCount + ' 个，失败 ' + manager.failedCount + ' 个。',
      };
    },
  });
  return { kernel, manager, lines, server };
}

const GOOD_MANIFEST = {
  id: 'alpha',
  version: '1.2.3',
  agentApiVersion: '1',
  permissions: [],
  tools: ['alpha_tool'],
};

const GOOD_ENTRY = "export const tools = { alpha_tool: async () => 'alpha-ok' };\n";

test('ready 带 plugins/pluginsDir，plugins_list 返回同形状（坏插件带 error）', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: root, log: () => {} }));
  try {
    await writePlugin(root, 'alpha', GOOD_MANIFEST, GOOD_ENTRY);
    await writePlugin(root, 'broken', '{ this is not json');
    await harness.manager.scan();

    harness.server.handleLine('{"type":"hello","clientVersion":"test","agentApiVersion":"1"}');
    const ready = findLine(harness.lines, 'ready');
    assert.ok(ready);

    const alpha = viewOf(ready, 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.version, '1.2.3');
    assert.deepEqual(alpha.permissions, []);
    assert.deepEqual(alpha.tools, ['alpha_tool']);
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.error, undefined);

    const broken = viewOf(ready, 'broken');
    assert.ok(broken);
    assert.equal(broken.enabled, false);
    assert.ok(String(broken.error).length > 0);

    assert.equal(ready.pluginsDir, path.resolve(root));
    assert.ok(path.isAbsolute(String(ready.pluginsDir)));
    assert.ok((ready.tools as Array<{ name: string }>).some((tool) => tool.name === 'alpha_tool'));

    harness.server.handleLine('{"type":"plugins_list","requestId":"pl-1"}');
    const list = findLine(harness.lines, 'plugins_result');
    assert.ok(list);
    assert.equal(list.requestId, 'pl-1');
    assert.equal(list.ok, true);
    assert.equal(list.pluginsDir, path.resolve(root));
    assert.equal(pluginsOf(list).length, 2);
    assert.equal(viewOf(list, 'alpha')?.enabled, true);
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('禁用插件后工具从模型列表消失、调用返回 TOOL_DENIED；启用后恢复', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: root, log: () => {} }));
  try {
    await writePlugin(root, 'alpha', GOOD_MANIFEST, GOOD_ENTRY);
    await harness.manager.scan();
    assert.equal(kernel.ctx.tools.has('alpha_tool'), true);
    assert.ok(toolNames(kernel).includes('alpha_tool'));

    harness.server.handleLine('{"type":"plugin_set_enabled","requestId":"pe-1","id":"alpha","enabled":false}');
    const disabled = findLine(harness.lines, 'plugins_result');
    assert.ok(disabled);
    assert.equal(disabled.requestId, 'pe-1');
    assert.equal(disabled.ok, true);
    assert.equal(viewOf(disabled, 'alpha')?.enabled, false);

    // 模型工具列表里不可见；直接调用得到 TOOL_DENIED
    assert.equal(kernel.ctx.tools.has('alpha_tool'), false);
    assert.ok(!toolNames(kernel).includes('alpha_tool'));
    harness.server.handleLine('{"type":"hello","clientVersion":"test","agentApiVersion":"1"}');
    const ready = [...parseLines(harness.lines)].reverse().find((message) => message.type === 'ready');
    assert.ok(ready);
    assert.ok(!(ready.tools as Array<{ name: string }>).some((tool) => tool.name === 'alpha_tool'));

    const denied = await harness.manager.executeTool('alpha_tool', {}, { workspace: root });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, AGENT_ERROR.TOOL_DENIED);
    assert.equal(denied.denied, true);
    assert.ok(denied.message.includes('已禁用'));
    assert.equal(harness.manager.hasActiveTool('alpha_tool'), false);

    // 重新启用：工具回到列表，执行恢复
    harness.server.handleLine('{"type":"plugin_set_enabled","requestId":"pe-2","id":"alpha","enabled":true}');
    const enabled = parseLines(harness.lines).filter((message) => message.type === 'plugins_result').at(-1);
    assert.ok(enabled);
    assert.equal(enabled.ok, true);
    assert.equal(viewOf(enabled, 'alpha')?.enabled, true);
    assert.equal(kernel.ctx.tools.has('alpha_tool'), true);
    assert.ok(toolNames(kernel).includes('alpha_tool'));

    const allowed = await harness.manager.executeTool('alpha_tool', {}, { workspace: root });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.message, 'alpha-ok');
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('plugin_set_enabled 未知 id：ok:false 且不崩，后续消息照常处理', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: root, log: () => {} }));
  try {
    harness.server.handleLine('{"type":"plugin_set_enabled","requestId":"pe-unknown","id":"nope","enabled":true}');
    const result = findLine(harness.lines, 'plugins_result');
    assert.ok(result);
    assert.equal(result.requestId, 'pe-unknown');
    assert.equal(result.ok, false);
    assert.ok(String(result.message).includes('不存在'));

    // 进程没崩：后续 plugins_list 正常
    harness.server.handleLine('{"type":"plugins_list","requestId":"pl-after"}');
    const after = parseLines(harness.lines).filter((message) => message.type === 'plugins_result').at(-1);
    assert.ok(after);
    assert.equal(after.requestId, 'pl-after');
    assert.equal(after.ok, true);

    // 非法消息（缺 enabled）回 error
    harness.server.handleLine('{"type":"plugin_set_enabled","requestId":"pe-bad","id":"x"}');
    const errors = parseLines(harness.lines).filter((message) => message.type === 'error');
    assert.equal(errors.length, 1);
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('plugins_rescan：新增插件加载、删除插件消失、启停偏好保留、坏插件隔离', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: root, log: () => {} }));
  try {
    await writePlugin(root, 'alpha', GOOD_MANIFEST, GOOD_ENTRY);
    await harness.manager.scan();
    assert.deepEqual(harness.manager.loadedIds(), ['alpha']);

    // 关闭 alpha 并新增 beta + 坏插件
    harness.manager.setEnabled('alpha', false);
    await writePlugin(
      root,
      'beta',
      { id: 'beta', version: '0.1.0', agentApiVersion: '1', permissions: [], tools: ['beta_tool'] },
      "export const tools = { beta_tool: async () => 'beta-ok' };\n",
    );
    await writePlugin(root, 'bad', '{ nope');

    harness.server.handleLine('{"type":"plugins_rescan","requestId":"pr-1"}');
    await waitFor(() => Boolean(findLine(harness.lines, 'plugins_result')));
    const rescan = findLine(harness.lines, 'plugins_result');
    assert.ok(rescan);
    assert.equal(rescan.requestId, 'pr-1');
    assert.equal(rescan.ok, true);
    const ids = pluginsOf(rescan).map((plugin) => plugin.id);
    assert.deepEqual(ids, ['alpha', 'bad', 'beta']);
    assert.equal(viewOf(rescan, 'alpha')?.enabled, false, '启停偏好要在 rescan 后保留');
    assert.equal(viewOf(rescan, 'beta')?.enabled, true);
    assert.ok(String(viewOf(rescan, 'bad')?.error).length > 0);
    assert.equal(kernel.ctx.tools.has('beta_tool'), true);
    assert.equal(kernel.ctx.tools.has('alpha_tool'), false);

    // 删除 alpha 后再重扫：alpha 消失，beta 仍在
    await rm(path.join(root, 'alpha'), { recursive: true, force: true });
    harness.server.handleLine('{"type":"plugins_rescan","requestId":"pr-2"}');
    await waitFor(() => parseLines(harness.lines).filter((message) => message.type === 'plugins_result').length === 2);
    const second = parseLines(harness.lines).filter((message) => message.type === 'plugins_result').at(-1);
    assert.ok(second);
    const idsAfter = pluginsOf(second).map((plugin) => plugin.id);
    assert.deepEqual(idsAfter, ['bad', 'beta']);
    assert.equal(harness.manager.toolRuntime('alpha_tool'), undefined);
    assert.equal(kernel.ctx.tools.has('beta_tool'), true);
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('manifest enabled=false：默认禁用（工具不注册），启用后可用', async () => {
  const kernel = await createKernel();
  const root = await makeRoot();
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: root, log: () => {} }));
  try {
    await writePlugin(
      root,
      'gamma',
      { id: 'gamma', version: '1.0.0', agentApiVersion: '1', permissions: [], tools: ['gamma_tool'], enabled: false },
      "export const tools = { gamma_tool: async () => 'gamma-ok' };\n",
    );
    await harness.manager.scan();

    harness.server.handleLine('{"type":"hello","clientVersion":"test","agentApiVersion":"1"}');
    const ready = findLine(harness.lines, 'ready');
    assert.ok(ready);
    assert.equal(viewOf(ready, 'gamma')?.enabled, false);
    assert.equal(kernel.ctx.tools.has('gamma_tool'), false);
    assert.ok(!toolNames(kernel).includes('gamma_tool'));

    const disabledResult = await harness.manager.executeTool('gamma_tool', {}, { workspace: root });
    assert.equal(disabledResult.code, AGENT_ERROR.TOOL_DENIED);

    assert.equal(harness.manager.setEnabled('gamma', true).ok, true);
    assert.equal(kernel.ctx.tools.has('gamma_tool'), true);
    const result = await harness.manager.executeTool('gamma_tool', {}, { workspace: root });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'gamma-ok');
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await rm(root, { recursive: true, force: true });
    await kernel.dispose();
  }
});

test('插件目录不存在：plugins_list 返回空列表 + pluginsDir，不报错', async () => {
  const kernel = await createKernel();
  const missing = path.join(tmpdir(), 'elaina-no-plugins-' + Date.now());
  const harness = createHarness(kernel, new PluginManager({ kernel, directory: missing, log: () => {} }));
  try {
    await harness.manager.scan();
    harness.server.handleLine('{"type":"plugins_list","requestId":"pl-missing"}');
    const result = findLine(harness.lines, 'plugins_result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.deepEqual(pluginsOf(result), []);
    assert.equal(result.pluginsDir, path.resolve(missing));

    harness.server.handleLine('{"type":"hello","clientVersion":"test","agentApiVersion":"1"}');
    const ready = findLine(harness.lines, 'ready');
    assert.ok(ready);
    assert.deepEqual(pluginsOf(ready), []);
    assert.equal(ready.pluginsDir, path.resolve(missing));
  } finally {
    harness.server.dispose();
    harness.manager.dispose();
    await kernel.dispose();
  }
});
