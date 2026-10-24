import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutor, builtinToolSpecs } from '../src/tools/index.ts';
import { analyzeCommand, classifyCommand, detectInteractive } from '../src/tools/command-risk.ts';
import { createGitCheckpoint } from '../src/tools/git-checkpoint.ts';
import { isSearchAvailable } from '../src/tools/web-search.ts';

/* 工具层验收测试：临时目录 + 注入 fetch，不碰仓库文件、不依赖外网 */

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function shellQuote(value: string): string {
  return '"' + value + '"';
}

function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/* ------------------------------- fs & paths ------------------------------- */

test('fs：路径穿越、工作区外与符号链接逃逸都被拒绝', async () => {
  const root = await makeTempDir('elaina-ws-');
  const outside = await makeTempDir('elaina-outside-');
  await fs.writeFile(path.join(root, 'inside.txt'), 'hello', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');

  const executor = createToolExecutor({ workspace: root, access: 'approval' });

  const traversal = await executor.execute('read_file', { path: '../../secret.txt' });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, 'TOOL_DENIED');

  const windowsTraversal = await executor.execute('read_file', { path: '..\\..\\secret.txt' });
  assert.equal(windowsTraversal.ok, false);
  assert.equal(windowsTraversal.code, 'TOOL_DENIED');

  const absoluteOutside = await executor.execute('read_file', { path: path.join(outside, 'secret.txt') });
  assert.equal(absoluteOutside.ok, false);
  assert.equal(absoluteOutside.code, 'TOOL_DENIED');

  const writeEscape = await executor.execute('write_file', { path: '..\\escape.txt', content: 'x' });
  assert.equal(writeEscape.ok, false);
  assert.equal(writeEscape.code, 'TOOL_DENIED');

  // full 档位允许工作区外写入
  const full = createToolExecutor({ workspace: root, access: 'full' });
  const fullWrite = await full.execute('write_file', { path: path.join(outside, 'allowed.txt'), content: 'ok' });
  assert.equal(fullWrite.ok, true);
  assert.equal(await fs.readFile(path.join(outside, 'allowed.txt'), 'utf8'), 'ok');

  // 目录 junction 逃逸：列表只显示链接，读写一律拒绝
  let symlinkCreated = false;
  try {
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    const viaLink = await executor.execute('read_file', { path: 'link/secret.txt' });
    assert.equal(viaLink.ok, false);
    assert.equal(viaLink.code, 'TOOL_DENIED');
    const writeViaLink = await executor.execute('write_file', { path: 'link/escape.txt', content: 'x' });
    assert.equal(writeViaLink.ok, false);
    assert.equal(writeViaLink.code, 'TOOL_DENIED');

    const list = await executor.execute('list_files', { path: '.' });
    assert.equal(list.ok, true);
    const entries = (list.data as { entries: Array<{ path: string; type: string }> }).entries;
    const linkEntry = entries.find((entry) => entry.path === 'link');
    assert.ok(linkEntry, '目录列表应包含符号链接条目');
    assert.equal(linkEntry?.type, 'symlink');
  }

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('fs：full 档位可读工作区外；approval 档仍拒绝；approval 外写返回 needs_user 说明', async () => {
  const root = await makeTempDir('elaina-access-ws-');
  const outside = await makeTempDir('elaina-access-outside-');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'line1\nline2\n', 'utf8');

  try {
    const full = createToolExecutor({ workspace: root, access: 'full' });

    // full：工作区外只读放行，并显式标记 outside
    const read = await full.execute('read_file', { path: path.join(outside, 'outside.txt') });
    assert.equal(read.ok, true);
    assert.equal((read.data as { text: string }).text, 'line1\nline2');
    assert.equal((read.data as { outside: boolean }).outside, true);

    const list = await full.execute('list_files', { path: outside });
    assert.equal(list.ok, true);
    assert.equal((list.data as { outside: boolean }).outside, true);
    const entries = (list.data as { entries: Array<{ path: string; type: string }> }).entries;
    assert.ok(entries.some((entry) => entry.path.endsWith('outside.txt')));

    // approval：工作区外只读仍拒绝
    const approval = createToolExecutor({ workspace: root, access: 'approval' });
    const deniedRead = await approval.execute('read_file', { path: path.join(outside, 'outside.txt') });
    assert.equal(deniedRead.ok, false);
    assert.equal(deniedRead.code, 'TOOL_DENIED');
    assert.ok(String(deniedRead.message).includes('工作区'));

    const deniedList = await approval.execute('list_files', { path: outside });
    assert.equal(deniedList.ok, false);
    assert.equal(deniedList.code, 'TOOL_DENIED');

    // approval：工作区外写入不能静默当普通错误 —— needs_user 讲清限制与出路
    const outsideWrite = await approval.execute('write_file', { path: path.join(outside, 'new.txt'), content: 'x' });
    assert.equal(outsideWrite.ok, false);
    assert.equal(outsideWrite.code, 'TOOL_DENIED');
    assert.equal(outsideWrite.needs_user, true);
    assert.ok(String(outsideWrite.message).includes('full 档位'));
    await assert.rejects(fs.access(path.join(outside, 'new.txt')), '被拒绝的写入不能落盘');

    const patch = [
      '--- a/outside.txt',
      '+++ b/outside.txt',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+line2b',
    ].join('\n');
    const outsidePatch = await approval.execute('apply_patch', { patch, path: path.join(outside, 'outside.txt') });
    assert.equal(outsidePatch.ok, false);
    assert.equal(outsidePatch.code, 'TOOL_DENIED');
    assert.equal(outsidePatch.needs_user, true);
    assert.ok(String(outsidePatch.message).includes('full 档位'));
    assert.equal(await fs.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'line1\nline2\n');

    // full：工作区外写入照常（既有契约）
    const fullWrite = await full.execute('write_file', { path: path.join(outside, 'new.txt'), content: 'ok' });
    assert.equal(fullWrite.ok, true);
    assert.equal(await fs.readFile(path.join(outside, 'new.txt'), 'utf8'), 'ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fs：读写、列目录与 apply_patch 往返', async () => {
  const root = await makeTempDir('elaina-fs-');
  const executor = createToolExecutor({ workspace: root, access: 'approval' });

  const write = await executor.execute('write_file', { path: 'notes.txt', content: 'alpha\nold\nbeta\n' });
  assert.equal(write.ok, true);
  assert.equal((write.data as { created: boolean }).created, true);

  const read = await executor.execute('read_file', { path: 'notes.txt' });
  assert.equal(read.ok, true);
  assert.equal((read.data as { text: string }).text, 'alpha\nold\nbeta');
  assert.equal((read.data as { totalLines: number }).totalLines, 3);

  const list = await executor.execute('list_files', { path: '.', recursive: true });
  assert.equal(list.ok, true);
  const entries = (list.data as { entries: Array<{ path: string; type: string }> }).entries;
  assert.ok(entries.some((entry) => entry.path === 'notes.txt' && entry.type === 'file'));

  const patch = [
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1,3 +1,4 @@',
    ' alpha',
    '-old',
    '+new',
    '+extra',
    ' beta',
  ].join('\n');
  const applied = await executor.execute('apply_patch', { patch });
  assert.equal(applied.ok, true);
  assert.equal((applied.data as { added: number }).added, 2);
  assert.equal((applied.data as { removed: number }).removed, 1);
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\nnew\nextra\nbeta\n');

  const badHunk = await executor.execute('apply_patch', {
    path: 'notes.txt',
    patch: '@@ -1,1 +1,1 @@\n-nope\n+yes',
  });
  assert.equal(badHunk.ok, false);
  assert.equal(badHunk.code, 'TOOL_FAILED');

  const multiFile = await executor.execute('apply_patch', {
    patch: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\n-c\n+d',
  });
  assert.equal(multiFile.ok, false);

  await fs.rm(root, { recursive: true, force: true });
});

/* -------------------------------- run_command ------------------------------ */

test('run_command：交互特征命令一律 INTERACTIVE_BLOCKED', async () => {
  const root = await makeTempDir('elaina-interactive-');
  const executor = createToolExecutor({ workspace: root, access: 'approval' });
  const commands = ['Read-Host "你的名字"', 'pause', 'type notes.txt | more', 'git commit', 'Out-GridView'];
  for (const command of commands) {
    const result = await executor.execute('run_command', { command });
    assert.equal(result.ok, false, command);
    assert.equal(result.code, 'INTERACTIVE_BLOCKED', command);
    assert.equal(result.denied, true, command);
  }
  assert.equal(detectInteractive('git commit -m "ok"'), null);
  assert.equal(detectInteractive('git commit --amend --no-edit'), null);
  assert.equal(detectInteractive('git commit -am "ok"'), null);
  assert.notEqual(detectInteractive('git commit -m "a" ; git commit'), null);
  await fs.rm(root, { recursive: true, force: true });
});

test('run_command：超时会杀掉整棵进程树', async () => {
  const root = await makeTempDir('elaina-timeout-');
  const script = path.join(root, 'slow.js');
  await fs.writeFile(script, 'setTimeout(() => {}, 30000);\n', 'utf8');
  const executor = createToolExecutor({ workspace: root, access: 'approval', runId: 'timeout-test', logDir: root });

  const started = Date.now();
  const result = await executor.execute('run_command', {
    command: shellQuote(process.execPath) + ' ' + shellQuote(script),
    timeoutMs: 400,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_TIMEOUT');
  const data = result.data as { timedOut: boolean; exitCode: number | null; logPath?: string };
  assert.equal(data.timedOut, true);
  assert.equal(data.exitCode, null);
  assert.ok(elapsed < 8000, '超时后应快速返回，实际耗时 ' + elapsed + 'ms');
  assert.ok(typeof data.logPath === 'string' && data.logPath.length > 0);

  await fs.rm(root, { recursive: true, force: true });
});

test('run_command：cancel（abort）杀掉整棵进程树并在 2s 内返回', async () => {
  const root = await makeTempDir('elaina-abort-');
  const script = path.join(root, 'sleep.js');
  await fs.writeFile(
    script,
    "require('node:fs').writeFileSync('pid.txt', String(process.pid));\nsetTimeout(() => {}, 30000);\n",
    'utf8',
  );
  const controller = new AbortController();
  const executor = createToolExecutor({ workspace: root, access: 'approval', runId: 'abort-test', logDir: root, signal: controller.signal });

  const pending = executor.execute('run_command', {
    command: shellQuote(process.execPath) + ' ' + shellQuote(script),
    timeoutMs: 60000,
  });

  // 等子进程真正起来并写出 PID（每秒 40 次，最多 5s）
  const pidFile = path.join(root, 'pid.txt');
  let pid = 0;
  for (let i = 0; i < 200; i += 1) {
    try {
      pid = Number(await fs.readFile(pidFile, 'utf8'));
    } catch {
      pid = 0;
    }
    if (pid > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(pid > 0, '子进程应已写出 PID');
  assert.equal(isProcessAlive(pid), true);

  const started = Date.now();
  controller.abort();
  const result = await pending;
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  assert.ok(elapsed < 2000, '取消后应在 2s 内返回，实际 ' + elapsed + 'ms');

  // 进程树在 2s 内消失（taskkill /T /F）
  let alive = true;
  for (let i = 0; i < 40; i += 1) {
    alive = isProcessAlive(pid);
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, '取消后子进程应已被杀掉');

  await fs.rm(root, { recursive: true, force: true });
});

test('run_command：孙进程占着管道（Start-Process）时超时/退出都能收尾，不再永久卡住', async () => {
  // 回归用例：旧实现等 'close'，但 detached 孙进程继承 stdout/stderr 后父 shell 已退出，
  // 'close' 永远不来，taskkill 打的是已退出的父 PID —— run_command 永久卡住。
  const root = await makeTempDir('elaina-nohang-');
  const executor = createToolExecutor({ workspace: root, access: 'approval', runId: 'nohang-test', logDir: root });

  const started = Date.now();
  const result = await executor.execute('run_command', {
    command:
      "Start-Process -NoNewWindow -WorkingDirectory $env:TEMP -FilePath powershell.exe " +
      "-ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 8'; Write-Output started",
    timeoutMs: 800,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, '孙进程占管道时也必须在秒级收尾，实际耗时 ' + elapsed + 'ms');
  // 父 shell 已退出（exit 0）或超时被强杀，两种结果都可接受；关键是**必须返回**
  assert.ok(result.code === 'OK' || result.code === 'TOOL_TIMEOUT' || result.code === 'TOOL_FAILED', '应返回结构化结果：' + String(result.code));

  await fs.rm(root, { recursive: true, force: true });
});

test('run_command：输出头部 200 + 尾部 50 行且 ≤8KB，完整输出落日志', async () => {
  const root = await makeTempDir('elaina-output-');
  const script = path.join(root, 'many.js');
  await fs.writeFile(
    script,
    'for (let i = 0; i < 400; i += 1) { console.log("line-" + i + "-" + "x".repeat(40)); }\n',
    'utf8',
  );
  const executor = createToolExecutor({ workspace: root, access: 'approval', runId: 'output-test', logDir: root });

  const result = await executor.execute('run_command', {
    command: shellQuote(process.execPath) + ' ' + shellQuote(script),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');

  const data = result.data as {
    stdout: string;
    stderr: string;
    truncated: boolean;
    exitCode: number | null;
    fullOutputBytes: number;
    logPath?: string;
  };
  assert.equal(data.exitCode, 0);
  assert.equal(data.truncated, true);
  assert.match(data.stdout, /已省略|已截断/, '超长输出应带省略/截断标记');
  assert.ok(Buffer.byteLength(data.stdout, 'utf8') <= 8 * 1024 + 512, '截断后应不超过 8KB');
  assert.ok(data.fullOutputBytes > 8 * 1024, '完整输出应大于 8KB');
  assert.ok(typeof data.logPath === 'string' && data.logPath.length > 0);

  const logText = await fs.readFile(data.logPath as string, 'utf8');
  assert.ok(logText.includes('line-0'), '日志应包含头部输出');
  assert.ok(logText.includes('line-399'), '日志应包含尾部输出');

  await fs.rm(root, { recursive: true, force: true });
});

/* ------------------------------ command risk ------------------------------ */

test('命令风险分类：safe / mutating / destructive，未知按 mutating', () => {
  const safe = [
    'git status --porcelain',
    'git log --oneline -5',
    'git branch',
    'Get-ChildItem -Force',
    'where.exe node',
    'node --version',
    'cat README.md',
    'rg "TODO" src',
  ];
  for (const command of safe) {
    assert.equal(classifyCommand(command), 'safe', command);
  }

  const mutating = [
    'npm install',
    'git commit -m "x"',
    'git branch feature/x',
    'git push origin main',
    'node scripts/build.mjs',
    'my-custom-exe --flag',
    'echo hi > out.txt',
    'Set-Content -Path a.txt -Value b',
  ];
  for (const command of mutating) {
    assert.equal(classifyCommand(command), 'mutating', command);
  }

  const destructive = [
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'Remove-Item -Recurse -Force .\\build',
    'rm -rf build',
    'del /f /s /q temp',
    'format D:',
    'git push --force origin main',
  ];
  for (const command of destructive) {
    assert.equal(classifyCommand(command), 'destructive', command);
  }

  assert.equal(analyzeCommand('').risk, 'mutating');
  assert.equal(classifyCommand('frobnicate --do-it'), 'mutating');
  assert.equal(classifyCommand('npm test'), 'mutating');
});

/* --------------------------------- search --------------------------------- */

test('web_search：无 key 不暴露；注入 fetch 后三家 provider 可离线跑', async () => {
  const root = await makeTempDir('elaina-search-');

  assert.equal(isSearchAvailable(undefined), false);
  assert.equal(isSearchAvailable(null), false);
  assert.equal(isSearchAvailable({ provider: 'tavily', apiKey: '' }), false);
  assert.equal(isSearchAvailable({ provider: 'brave' }), false);
  assert.equal(isSearchAvailable({ provider: 'custom', url: '' }), false);
  assert.equal(isSearchAvailable({ provider: 'tavily', apiKey: 'k' }), true);
  assert.equal(isSearchAvailable({ provider: 'custom', url: 'https://search.example.com/q?query={query}' }), true);

  const withoutKey = createToolExecutor({ workspace: root, access: 'approval' });
  assert.equal(withoutKey.has('web_search'), false);
  assert.equal(withoutKey.specs.some((spec) => spec.name === 'web_search'), false);
  const unavailable = await withoutKey.execute('web_search', { query: 'x' });
  assert.equal(unavailable.ok, false);

  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({ results: [{ title: 'Tavily T', url: 'https://example.com/t', content: 'tavily snippet' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const tavily = createToolExecutor({
    workspace: root,
    access: 'approval',
    search: { provider: 'tavily', apiKey: 'test-key' },
    fetch: fakeFetch,
  });
  assert.equal(tavily.has('web_search'), true);
  const searched = await tavily.execute('web_search', { query: 'elaina', maxResults: 3 });
  assert.equal(searched.ok, true);
  const searchData = searched.data as { provider: string; count: number; results: Array<{ title: string; url: string; snippet: string }> };
  assert.equal(searchData.provider, 'tavily');
  assert.equal(searchData.count, 1);
  assert.equal(searchData.results[0].url, 'https://example.com/t');
  assert.equal(searchData.results[0].snippet, 'tavily snippet');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('api.tavily.com'));
  assert.equal(JSON.parse(String(calls[0].init?.body)).query, 'elaina');

  const customFetch = async (): Promise<Response> =>
    new Response(
      JSON.stringify({ data: { items: [{ name: 'Custom T', link: 'https://example.com/c', description: 'custom snippet' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const custom = createToolExecutor({
    workspace: root,
    access: 'approval',
    search: { provider: 'custom', url: 'https://search.example.com/q?query={query}&count={count}' },
    fetch: customFetch,
  });
  const customResult = await custom.execute('web_search', { query: 'hello world' });
  assert.equal(customResult.ok, true);
  const customData = customResult.data as { results: Array<{ title: string; url: string }> };
  assert.equal(customData.results[0].url, 'https://example.com/c');
  assert.equal(customData.results[0].title, 'Custom T');

  await fs.rm(root, { recursive: true, force: true });
});

/* --------------------------------- web_fetch ------------------------------- */

test('web_fetch：拒绝非 http(s)、拒绝非 HTML/纯文本、剥标签转文本', async () => {
  const root = await makeTempDir('elaina-fetch-');
  const executor = createToolExecutor({ workspace: root, access: 'approval' });

  const fileUrl = await executor.execute('web_fetch', { url: 'file:///C:/Windows/win.ini' });
  assert.equal(fileUrl.ok, false);
  assert.equal(fileUrl.code, 'TOOL_DENIED');

  const ftpUrl = await executor.execute('web_fetch', { url: 'ftp://example.com/a.txt' });
  assert.equal(ftpUrl.ok, false);
  assert.equal(ftpUrl.code, 'TOOL_DENIED');

  const malformed = await executor.execute('web_fetch', { url: 'not a url' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'TOOL_DENIED');

  const jsonFetch = async (): Promise<Response> =>
    new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  const jsonExecutor = createToolExecutor({ workspace: root, access: 'approval', fetch: jsonFetch });
  const jsonResult = await jsonExecutor.execute('web_fetch', { url: 'https://example.com/api' });
  assert.equal(jsonResult.ok, false);
  assert.match(jsonResult.message, /text\/html|text\/plain/);

  const htmlFetch = async (): Promise<Response> =>
    new Response(
      '<html><head><title>标题页</title><style>.x{color:red}</style></head><body><h1>Hello</h1><script>evil()</script><p>World &amp; friends</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  const htmlExecutor = createToolExecutor({ workspace: root, access: 'approval', fetch: htmlFetch });
  const htmlResult = await htmlExecutor.execute('web_fetch', { url: 'https://example.com/' });
  assert.equal(htmlResult.ok, true);
  const htmlData = htmlResult.data as { title: string; text: string; contentType: string; truncated: boolean };
  assert.equal(htmlData.title, '标题页');
  assert.ok(htmlData.text.includes('Hello'));
  assert.ok(htmlData.text.includes('World & friends'));
  assert.ok(!htmlData.text.includes('evil()'), '脚本内容应被剥掉');
  assert.ok(!htmlData.text.includes('<h1>'), '标签应被剥掉');
  assert.equal(htmlData.truncated, false);

  await fs.rm(root, { recursive: true, force: true });
});

/* ------------------------------- git checkpoint ---------------------------- */

test('git 检查点：非仓库优雅降级，上下文 JSON 落应用数据目录', async () => {
  const root = await makeTempDir('elaina-git-');
  const appData = path.join(root, 'appdata');
  const checkpoint = createGitCheckpoint({ workspace: root, runId: 'run-1', appDataDir: appData });

  const state = await checkpoint.getState();
  assert.equal(state.isRepo, false);
  assert.equal(state.branch, null);

  const branch = await checkpoint.ensureBranch();
  assert.equal(branch.ok, false);
  assert.match(branch.message, /不是 git 仓库/);

  const contextPath = await checkpoint.saveContext({
    messages: [{ role: 'user', content: 'hi' }],
    reasoningTokens: 12,
  });
  assert.ok(contextPath.includes(path.join('agent-runs', 'run-1.json')));
  const loaded = await checkpoint.loadContext();
  assert.equal(loaded?.runId, 'run-1');
  assert.equal(loaded?.reasoningTokens, 12);
  assert.equal(Array.isArray(loaded?.messages), true);
  assert.equal((loaded as { workspace: string }).workspace, root);

  await fs.rm(root, { recursive: true, force: true });
});

test('git 检查点：可创建 agent 分支并在写操作前提交', async (t) => {
  const probe = runGit(process.cwd(), ['--version']);
  if (probe.status !== 0) {
    t.skip('本机没有 git，跳过仓库检查点测试');
    return;
  }
  const root = await makeTempDir('elaina-git-repo-');
  const init = runGit(root, ['init', '-q']);
  assert.equal(init.status, 0, init.stderr);
  runGit(root, ['config', 'user.email', 'agent-test@example.com']);
  runGit(root, ['config', 'user.name', 'Agent Test']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);

  await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');
  const checkpoint = createGitCheckpoint({ workspace: root, runId: 'repo-run', appDataDir: path.join(root, 'appdata') });

  const branch = await checkpoint.ensureBranch();
  assert.equal(branch.ok, true, branch.message);
  assert.match(String(branch.branch), /^elaina\/agent\//);

  await fs.writeFile(path.join(root, 'a.txt'), 'two\n', 'utf8');
  const commit = await checkpoint.commitBeforeWrite(1, '写入 a.txt');
  assert.equal(commit.ok, true, commit.message);
  assert.equal(commit.committed, true);
  assert.ok(typeof commit.commit === 'string' && commit.commit.length > 0);

  const after = await checkpoint.getState();
  assert.equal(after.isRepo, true);
  assert.equal(after.branch, branch.branch);
  assert.equal(after.dirty, false);

  const noop = await checkpoint.commitBeforeWrite(2, '没有改动');
  assert.equal(noop.ok, true);
  assert.equal(noop.committed, false);

  const log = runGit(root, ['log', '--oneline']);
  assert.match(log.stdout, /\[agent\] step 1: 写入 a\.txt/);

  await fs.rm(root, { recursive: true, force: true });
});

/* ---------------------------------- 其它 ---------------------------------- */

test('工具声明：名字唯一、都有 schema，未知工具返回结构化失败', async () => {
  const names = builtinToolSpecs.map((spec) => spec.name);
  assert.deepEqual(
    names.slice().sort(),
    ['apply_patch', 'list_files', 'read_file', 'run_command', 'web_fetch', 'web_search', 'write_file'],
  );
  assert.equal(new Set(names).size, names.length);

  const root = await makeTempDir('elaina-specs-');
  const executor = createToolExecutor({ workspace: root, access: 'approval' });
  for (const spec of executor.specs) {
    assert.equal(spec.parameters.type, 'object');
    assert.ok(spec.description.length > 0);
  }
  const unknown = await executor.execute('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'TOOL_FAILED');
  assert.match(unknown.message, /未知或当前不可用/);

  const badArgs = await executor.execute('read_file', 'not-json');
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, 'TOOL_FAILED');

  await fs.rm(root, { recursive: true, force: true });
});
