/**
 * 第三方插件装载。
 *
 * 设计契约（docs/agent-design.md 第 8 节）：
 * - manifest.json 必须声明 id / version / agentApiVersion / permissions / tools；
 * - 插件只能调用 ctx.tools.register()，执行统一走审批与沙箱；
 * - 未声明权限直接报错；失败隔离（一个插件坏掉不能拖垮宿主）。
 *
 * 本文件只做「声明校验 + 受限注册面」；目录扫描、热加载、zip 解压属于宿主层
 * （stdio 层）职责，不在这里做，避免 kernel 反向依赖文件系统。
 *
 * 工具声明支持两种形态（C 方案双通道）：
 * - 字符串（旧版）：只有名字，工具由插件代码 export register/api.tools.register 提供 handler；
 * - 对象：{ name, description, parameters, command?, timeoutMs?, cwd? }
 *   · command 走宿主的 run_command 执行语义（审批/超时/杀树/截断/日志），必须声明 shell 权限；
 *   · 没有 command 的对象等同字符串声明，仍需插件代码注册 handler。
 */
import type { Context } from 'cordis';
import type { Kernel, MountResult } from './lifecycle.ts';
import { TOOL_NAME_PATTERN, type JsonSchema, type ToolDisposer, type ToolSpec } from './tools.ts';

/** 插件 API 版本：manifest 与本值不一致即拒绝装载（先做精确匹配，避免半兼容） */
export const AGENT_API_VERSION = '1';

/** 允许插件声明的权限词表；未知权限 = manifest 写错，按失败处理（fail closed） */
export const PLUGIN_PERMISSIONS = ['fs:read', 'fs:write', 'shell', 'web', 'net'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** manifest.tools 的对象形态（C 方案的声明通道） */
export interface PluginToolDeclaration {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  /** shell 命令模板；{{arg}} 会被调用参数替换，完整参数另经 ELAINA_AGENT_ARGS 传入。需要 shell 权限 */
  command?: string;
  /** command 超时（毫秒，100~600000）；也作为 handler 的超时上限 */
  timeoutMs?: number;
  /** command 执行目录（相对工作区，禁止逃逸） */
  cwd?: string;
}

/** 兼容旧版：tools 里既可以是名字，也可以是对象声明 */
export type PluginToolEntry = string | PluginToolDeclaration;

export interface PluginManifest {
  id: string;
  version: string;
  agentApiVersion: string;
  permissions: PluginPermission[];
  /** 本插件将要注册的工具；未列出的名字一律拒绝注册 */
  tools: PluginToolEntry[];
  name?: string;
  description?: string;
  /** 默认启用状态；缺省 true，写 false 表示装好即禁用（进程内启停状态不落盘） */
  enabled?: boolean;
}

/** 插件 handler 的运行上下文：只给只读信息，不给宿主服务 */
export interface PluginToolContext {
  toolName: string;
  workspace?: string;
  signal?: AbortSignal;
}

export type PluginToolHandler = (
  args: Record<string, unknown>,
  context: PluginToolContext,
) => unknown | Promise<unknown>;

/** 插件注册工具时可带 handler（执行由宿主接走，不进 ToolSpec） */
export interface PluginToolSpec extends ToolSpec {
  handler?: PluginToolHandler;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 把 manifest.tools 归一成全对象形态（非法项在 validate 里已经拒绝） */
export function normalizedToolDeclarations(manifest: PluginManifest): Array<{ name: string; declaration: PluginToolDeclaration | null }> {
  const result: Array<{ name: string; declaration: PluginToolDeclaration | null }> = [];
  for (const entry of manifest.tools ?? []) {
    if (typeof entry === 'string') {
      result.push({ name: entry, declaration: null });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      result.push({ name: entry.name, declaration: entry });
    }
  }
  return result;
}

/** manifest 里声明了 command 的工具（宿主执行映射用） */
export function manifestCommandDeclarations(manifest: PluginManifest): PluginToolDeclaration[] {
  const result: PluginToolDeclaration[] = [];
  for (const { declaration } of normalizedToolDeclarations(manifest)) {
    if (declaration && typeof declaration.command === 'string' && declaration.command.trim()) result.push(declaration);
  }
  return result;
}

/** 相对工作区的 cwd 校验：禁止绝对路径、盘符、UNC 与 .. 逃逸 */
function validateDeclarationCwd(cwd: unknown): string | null {
  if (cwd === undefined) return null;
  if (typeof cwd !== 'string' || !cwd.trim()) return 'tools[].cwd 必须是非空字符串。';
  const value = cwd.trim();
  if (value.includes('\0')) return 'tools[].cwd 含非法字符（NUL）。';
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) {
    return 'tools[].cwd 必须是相对工作区的路径：' + value;
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return 'tools[].cwd 不能包含 ..：' + value;
  return null;
}

/** 校验 manifest。返回 Error 表示不可装载；返回 null 表示通过。 */
export function validatePluginManifest(raw: unknown): Error | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error('manifest.json 必须是对象。');
  const manifest = raw as Partial<PluginManifest>;
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    return new Error('manifest.id 不合法：只允许小写字母/数字/连字符，≤64 字符。');
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) return new Error('manifest.version 缺失。');
  if (manifest.agentApiVersion !== AGENT_API_VERSION) {
    return new Error('manifest.agentApiVersion 必须是 ' + AGENT_API_VERSION + '（实际：' + String(manifest.agentApiVersion) + '）。');
  }
  if (manifest.enabled !== undefined && typeof manifest.enabled !== 'boolean') {
    return new Error('manifest.enabled 必须是布尔值。');
  }
  if (!Array.isArray(manifest.permissions)) return new Error('manifest.permissions 必须是数组。');
  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  for (const permission of manifest.permissions) {
    if (typeof permission !== 'string' || !allowed.has(permission)) {
      return new Error('manifest.permissions 含未知权限：' + String(permission) + '（可用：' + PLUGIN_PERMISSIONS.join(' / ') + '）。');
    }
  }
  if (!Array.isArray(manifest.tools)) return new Error('manifest.tools 必须是数组。');

  const granted = new Set<string>(manifest.permissions);
  const names = new Set<string>();
  for (const entry of manifest.tools as unknown[]) {
    if (typeof entry === 'string') {
      if (!entry.trim()) return new Error('manifest.tools 里的工具名不能为空字符串。');
      if (!TOOL_NAME_PATTERN.test(entry)) return new Error('manifest.tools 工具名不合法：' + entry + '（只允许小写字母开头的小写字母/数字/下划线，≤64 字符）。');
      if (names.has(entry)) return new Error('manifest.tools 里工具名重复：' + entry);
      names.add(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return new Error('manifest.tools 的每一项必须是工具名字符串或对象声明。');
    }
    const declaration = entry as Partial<PluginToolDeclaration>;
    if (typeof declaration.name !== 'string' || !TOOL_NAME_PATTERN.test(declaration.name)) {
      return new Error('manifest.tools[].name 不合法：' + String(declaration.name));
    }
    if (names.has(declaration.name)) return new Error('manifest.tools 里工具名重复：' + declaration.name);
    names.add(declaration.name);
    if (declaration.description !== undefined && typeof declaration.description !== 'string') {
      return new Error('manifest.tools[' + declaration.name + '].description 必须是字符串。');
    }
    if (declaration.parameters !== undefined) {
      const parameters = declaration.parameters as { type?: unknown } | null;
      if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') {
        return new Error('manifest.tools[' + declaration.name + '].parameters 必须是 { type: "object" } 的 JSON Schema。');
      }
    }
    if (declaration.command !== undefined) {
      if (typeof declaration.command !== 'string' || !declaration.command.trim()) {
        return new Error('manifest.tools[' + declaration.name + '].command 必须是非空字符串。');
      }
      if (declaration.command.length > 8000) return new Error('manifest.tools[' + declaration.name + '].command 过长（上限 8000 字符）。');
      if (!granted.has('shell')) {
        return new Error('manifest.tools[' + declaration.name + '] 声明了 shell command，但 permissions 缺少 "shell"：拒绝加载。');
      }
    }
    if (declaration.timeoutMs !== undefined) {
      if (typeof declaration.timeoutMs !== 'number' || !Number.isInteger(declaration.timeoutMs) || declaration.timeoutMs < 100 || declaration.timeoutMs > 600000) {
        return new Error('manifest.tools[' + declaration.name + '].timeoutMs 必须是 100~600000 的整数。');
      }
    }
    const cwdError = validateDeclarationCwd(declaration.cwd);
    if (cwdError) return new Error('manifest.tools[' + declaration.name + '] ' + cwdError);
  }
  return null;
}

/** 插件 API 的宿主侧接收器：handler 与注册释放函数都由宿主接走 */
export interface PluginApiOptions {
  /** 接收 handler；注册带 handler 的工具时未提供会报错（避免静默丢弃） */
  onHandler?: (name: string, handler: PluginToolHandler) => void;
  /** 接收每次注册的释放函数（带工具名，便于宿主按工具启停/回滚） */
  onRegister?: (dispose: ToolDisposer, name?: string) => void;
}

/** 插件能看到的全部能力面。刻意只给 tools.register：插件拿不到宿主 ctx 的其它服务。 */
export interface PluginApi {
  readonly manifest: Readonly<PluginManifest>;
  tools: {
    register(spec: PluginToolSpec): ToolDisposer;
  };
}

/**
 * 构造受限注册面。
 * 三道检查：工具名必须在 manifest.tools 声明；工具声明的权限必须已被授予；handler 必须有宿主接收器。
 * 插件越权时抛错，由 kernel.install 的失败隔离捕获并上报，不会污染已注册的工具。
 */
export function createPluginApi(ctx: Context, manifest: PluginManifest, options: PluginApiOptions = {}): PluginApi {
  const registry = ctx.tools;
  const declaredTools = new Set(normalizedToolDeclarations(manifest).map((item) => item.name));
  const granted = new Set<string>(manifest.permissions);
  return {
    manifest,
    tools: {
      register(spec: PluginToolSpec): ToolDisposer {
        if (!declaredTools.has(spec.name)) {
          throw new Error('插件 ' + manifest.id + ' 试图注册未在 manifest.tools 声明的工具：' + spec.name);
        }
        for (const permission of spec.permissions ?? []) {
          if (!granted.has(permission)) {
            throw new Error('插件 ' + manifest.id + ' 的工具 ' + spec.name + ' 需要未授予的权限：' + String(permission));
          }
        }
        const handler = spec.handler;
        if (handler !== undefined && typeof handler !== 'function') {
          throw new Error('插件 ' + manifest.id + ' 的工具 ' + spec.name + ' 的 handler 必须是函数。');
        }
        if (handler && !options.onHandler) {
          throw new Error('插件 ' + manifest.id + ' 的工具 ' + spec.name + ' 提供了 handler，但宿主没有接收器。');
        }
        // handler 不进 ToolSpec：注册面只暴露声明，执行走宿主映射
        const toolSpec: ToolSpec = {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          ...(spec.permissions ? { permissions: spec.permissions } : {}),
        };
        const dispose = registry.register(toolSpec);
        try {
          if (handler) options.onHandler?.(spec.name, handler);
          options.onRegister?.(dispose, spec.name);
        } catch (error) {
          dispose();
          throw error;
        }
        return dispose;
      },
    },
  };
}

/**
 * 装载一个插件：先校验 manifest，再把受限 API 交给插件代码。
 * plugin 的 apply 函数抛错会被 kernel 隔离成 MountResult.ok === false。
 */
export async function installPlugin(
  kernel: Kernel,
  manifest: PluginManifest,
  apply: (api: PluginApi) => void | Promise<void>,
  options: PluginApiOptions = {},
): Promise<MountResult> {
  const invalid = validatePluginManifest(manifest);
  if (invalid) return { name: 'plugin:' + String((manifest as { id?: unknown })?.id ?? 'invalid'), ok: false, error: invalid };
  return kernel.install({
    name: 'plugin:' + manifest.id,
    /* cordis 4：插件 fiber 里访问 ctx.tools 必须在 inject 里声明，否则报
     * "cannot get property tools without inject"。 */
    inject: ['tools'],
    apply(ctx: Context) {
      return apply(createPluginApi(ctx, manifest, options));
    },
  });
}
