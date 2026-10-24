import type { AgentAccess, AgentLimits } from '../config.ts';
import { AGENT_ERROR, fail, type ToolResult } from '../errors.ts';
import type { AgentTool, FetchLike, JsonSchemaObject, ToolRisk } from './types.ts';
import { normalizeArgs } from './types.ts';
import { listFilesTool, readFileTool, writeFileTool, applyPatchTool, type FsToolOptions } from './fs.ts';
import { runCommandTool, type ShellToolOptions } from './shell.ts';
import { webFetchTool, type WebFetchToolOptions } from './web-fetch.ts';
import { webSearchTool, isSearchAvailable, type SearchConfig } from './web-search.ts';
import { analyzeCommand } from './command-risk.ts';

/**
 * 内置工具层入口（设计文档第 4 节）。
 *
 * - builtinToolSpecs：所有内置工具的可序列化声明（ready 握手/展示用，不含 handler）
 * - createToolExecutor：按运行参数（workspace/access/search）组装可执行工具集，
 *   统一返回 ToolResult；未配置搜索 Key 时 web_search 不出现在 specs 里
 * - 风险分类：fs 读/web 为 safe，写入为 mutating，run_command 由 command-risk 动态判定
 */

export type { SearchConfig } from './web-search.ts';
export { isSearchAvailable } from './web-search.ts';

export interface BuiltinToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  risk: ToolRisk | 'dynamic';
}

interface ToolDefinition extends BuiltinToolSpec {
  run: (args: Record<string, unknown>, context: ExecutorContext) => Promise<ToolResult>;
}

interface ExecutorContext extends FsToolOptions {
  limits?: Partial<AgentLimits>;
  search?: SearchConfig | null;
  fetch?: FetchLike;
  logDir?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ToolExecutorOptions {
  workspace: string;
  access: AgentAccess;
  search?: SearchConfig | null;
  limits?: Partial<AgentLimits>;
  /** 注入 fetch（测试离线可跑）；生产默认 globalThis.fetch */
  fetch?: FetchLike;
  /** shell 完整输出日志目录（默认应用数据目录 agent-logs） */
  logDir?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ToolExecutor {
  /** 当前 run 真正可调用的工具（已按 search 可用性过滤） */
  readonly specs: AgentTool[];
  list(): AgentTool[];
  has(name: string): boolean;
  get(name: string): AgentTool | undefined;
  /** 审批层用：run_command 按命令内容动态分类，其余按声明 */
  riskFor(name: string, args?: unknown): ToolRisk;
  execute(name: string, args: unknown, callOptions?: { signal?: AbortSignal }): Promise<ToolResult>;
}

const listFilesParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要列出的目录，相对工作区或工作区内绝对路径；省略为工作区根目录' },
    recursive: { type: 'boolean', description: '是否递归列出子目录（默认 false，最多 200 条、深度 6）' },
  },
  required: [],
  additionalProperties: false,
};

const readFileParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要读取的文件路径（工作区内）' },
    from: { type: 'integer', minimum: 1, description: '起始行号（1 起，默认 1）' },
    maxLines: { type: 'integer', minimum: 1, maximum: 2000, description: '最多返回多少行（默认 400）' },
  },
  required: ['path'],
  additionalProperties: false,
};

const writeFileParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目标文件路径（工作区内；approval 档位不能写工作区外）' },
    content: { type: 'string', description: '完整文件内容（整文件覆盖，不是补丁）' },
    createDirs: { type: 'boolean', description: '是否自动创建父目录（默认 true）' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const applyPatchParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    patch: {
      type: 'string',
      description:
        '简化版 unified diff。支持 ---/+++ 文件头与 @@ -旧起,旧数 +新起,新数 @@ 段；段内行以空格（上下文）、+（新增）、-（删除）开头。一次只改一个文件。',
    },
    path: { type: 'string', description: '目标文件路径；省略时从 +++ 文件头推断' },
  },
  required: ['patch'],
  additionalProperties: false,
};

const runCommandParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: '要执行的命令。Windows 依次尝试 pwsh -NoProfile -NonInteractive -Command → powershell.exe（5.1）→ cmd /s /c。必须是非交互命令；Read-Host/pause/more/无 -m 的 git commit 会被拒绝。',
    },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 600000, description: '超时毫秒（默认 60000，上限 600000）；超时会杀整棵进程树' },
  },
  required: ['command'],
  additionalProperties: false,
};

const webSearchParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '搜索关键词' },
    maxResults: { type: 'integer', minimum: 1, maximum: 10, description: '返回结果数（默认 5）' },
  },
  required: ['query'],
  additionalProperties: false,
};

const webFetchParameters: JsonSchemaObject = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'http/https URL（仅 text/html 或 text/plain；≤2MB；20 秒超时）' },
  },
  required: ['url'],
  additionalProperties: false,
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: '列出工作区内的目录内容（只读）。默认不递归，最多返回 200 条；符号链接只显示不跟随。',
    parameters: listFilesParameters,
    risk: 'safe',
    run: (args, context) => listFilesTool(args, { workspace: context.workspace, access: context.access }),
  },
  {
    name: 'read_file',
    description: '读取工作区内文本文件的内容（只读，含行号范围）。二进制与超过 2MB 的文件会被拒绝。',
    parameters: readFileParameters,
    risk: 'safe',
    run: (args, context) => readFileTool(args, { workspace: context.workspace, access: context.access }),
  },
  {
    name: 'write_file',
    description: '用完整内容创建或覆盖工作区内的文件（写入前需审批）。修改已有文件更推荐 apply_patch。',
    parameters: writeFileParameters,
    risk: 'mutating',
    run: (args, context) => writeFileTool(args, { workspace: context.workspace, access: context.access }),
  },
  {
    name: 'apply_patch',
    description: '按简化版 unified diff 修改工作区内已有的文本文件（写入前需审批）。支持 @@ 段与 +/- 行，一次只改一个文件。',
    parameters: applyPatchParameters,
    risk: 'mutating',
    run: (args, context) => applyPatchTool(args, { workspace: context.workspace, access: context.access }),
  },
  {
    name: 'run_command',
    description: '在 workspace 目录执行非交互 shell 命令（pwsh → powershell.exe 5.1 → cmd）。stdin 已关闭；交互命令会直接被拒。返回头 200 行 + 尾 50 行（≤8KB），完整输出写入日志文件并返回 logPath。',
    parameters: runCommandParameters,
    risk: 'dynamic',
    run: (args, context) =>
      runCommandTool(args, {
        workspace: context.workspace,
        limits: context.limits,
        logDir: context.logDir,
        runId: context.runId,
        env: context.env,
        signal: context.signal,
      }),
  },
  {
    name: 'web_search',
    description: '联网搜索（Tavily/Brave/自定义），返回标题、URL 与摘要。未配置搜索 Key 时该工具不会出现。',
    parameters: webSearchParameters,
    risk: 'safe',
    run: (args, context) =>
      webSearchTool(args, {
        search: context.search,
        fetch: context.fetch,
      }),
  },
  {
    name: 'web_fetch',
    description: '抓取 http/https 网页正文并转为纯文本（仅 text/html、text/plain；≤2MB；20 秒超时）。',
    parameters: webFetchParameters,
    risk: 'safe',
    run: (args, context) =>
      webFetchTool(args, {
        fetch: context.fetch,
        signal: context.signal,
      }),
  },
];

/** 所有内置工具的可序列化声明（不按 Key 过滤；实际可调用集请看 executor.specs） */
export const builtinToolSpecs: BuiltinToolSpec[] = TOOL_DEFINITIONS.map((definition) => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
  risk: definition.risk,
}));

/** 组装当前 run 的工具执行器；所有失败都以 ToolResult 返回，不抛异常 */
export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  if (!options || typeof options.workspace !== 'string' || options.workspace.trim() === '') {
    throw new Error('createToolExecutor 需要有效的 workspace');
  }
  const access: AgentAccess = options.access === 'full' ? 'full' : 'approval';
  const searchAvailable = isSearchAvailable(options.search);
  const definitions = TOOL_DEFINITIONS.filter((definition) => definition.name !== 'web_search' || searchAvailable);
  const byName = new Map<string, ToolDefinition>(definitions.map((definition) => [definition.name, definition]));

  const buildSpecs = (): AgentTool[] =>
    definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      risk: definition.risk,
      handler: (args: Record<string, unknown>) => definition.run(args, contextFor(options, access)),
    }));

  const specs = buildSpecs();

  return {
    specs,
    list: () => specs.slice(),
    has: (name: string) => byName.has(String(name ?? '')),
    get: (name: string) => specs.find((spec) => spec.name === name),
    riskFor(name: string, args?: unknown): ToolRisk {
      const definition = byName.get(String(name ?? ''));
      if (!definition) return 'mutating';
      if (definition.risk !== 'dynamic') return definition.risk;
      const parsed = normalizeArgs(args);
      const command = parsed && typeof parsed.command === 'string' ? parsed.command : '';
      if (!parsed || parsed.command === undefined) return 'mutating';
      return analyzeCommand(command).risk;
    },
    async execute(name: string, args: unknown, callOptions?: { signal?: AbortSignal }): Promise<ToolResult> {
      const toolName = String(name ?? '').trim();
      const definition = byName.get(toolName);
      if (!definition) {
        const available = definitions.map((item) => item.name).join(' / ');
        return fail(AGENT_ERROR.TOOL_FAILED, '未知或当前不可用的工具：' + (toolName || '(空)') + '。可用工具：' + available + '。', {
          needs_user: false,
        });
      }
      const parsed = normalizeArgs(args);
      if (!parsed) {
        return fail(AGENT_ERROR.TOOL_FAILED, '工具 ' + toolName + ' 的参数不是合法 JSON 对象。');
      }
      const context: ExecutorContext = {
        ...contextFor(options, access),
        signal: callOptions?.signal ?? options.signal,
      };
      try {
        return await definition.run(parsed, context);
      } catch (error) {
        return fail(AGENT_ERROR.TOOL_FAILED, '工具 ' + toolName + ' 执行异常：' + (error instanceof Error ? error.message : String(error)), {
          retryable: true,
        });
      }
    },
  };
}

function contextFor(options: ToolExecutorOptions, access: AgentAccess): ExecutorContext {
  return {
    workspace: options.workspace,
    access,
    limits: options.limits,
    search: options.search,
    fetch: options.fetch,
    logDir: options.logDir,
    runId: options.runId,
    env: options.env,
    signal: options.signal,
  };
}
