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
 */
import type { Context } from 'cordis';
import type { Kernel, MountResult } from './lifecycle.ts';
import type { ToolDisposer, ToolSpec } from './tools.ts';

/** 插件 API 版本：manifest 与本值不一致即拒绝装载（先做精确匹配，避免半兼容） */
export const AGENT_API_VERSION = '1';

/** 允许插件声明的权限词表；未知权限 = manifest 写错，按失败处理（fail closed） */
export const PLUGIN_PERMISSIONS = ['fs:read', 'fs:write', 'shell', 'web', 'net'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginManifest {
  id: string;
  version: string;
  agentApiVersion: string;
  permissions: PluginPermission[];
  /** 本插件将要注册的工具名；未列出的名字一律拒绝注册 */
  tools: string[];
  name?: string;
  description?: string;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  if (!Array.isArray(manifest.permissions)) return new Error('manifest.permissions 必须是数组。');
  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  for (const permission of manifest.permissions) {
    if (typeof permission !== 'string' || !allowed.has(permission)) {
      return new Error('manifest.permissions 含未知权限：' + String(permission) + '（可用：' + PLUGIN_PERMISSIONS.join(' / ') + '）。');
    }
  }
  if (!Array.isArray(manifest.tools)) return new Error('manifest.tools 必须是数组。');
  for (const tool of manifest.tools) {
    if (typeof tool !== 'string' || !tool.trim()) return new Error('manifest.tools 必须是非空字符串数组。');
  }
  return null;
}

/** 插件能看到的全部能力面。刻意只给 tools.register：插件拿不到宿主 ctx 的其它服务。 */
export interface PluginApi {
  readonly manifest: Readonly<PluginManifest>;
  tools: {
    register(spec: ToolSpec): ToolDisposer;
  };
}

/**
 * 构造受限注册面。
 * 两道检查：工具名必须已在 manifest.tools 声明；工具自身声明的权限必须已被 manifest 授予。
 * 插件越权时抛错，由 kernel.install 的失败隔离捕获并上报，不会污染已注册的工具。
 */
export function createPluginApi(ctx: Context, manifest: PluginManifest): PluginApi {
  const registry = ctx.tools;
  const declaredTools = new Set(manifest.tools);
  const granted = new Set<string>(manifest.permissions);
  return {
    manifest,
    tools: {
      register(spec: ToolSpec): ToolDisposer {
        if (!declaredTools.has(spec.name)) {
          throw new Error('插件 ' + manifest.id + ' 试图注册未在 manifest.tools 声明的工具：' + spec.name);
        }
        for (const permission of spec.permissions ?? []) {
          if (!granted.has(permission)) {
            throw new Error('插件 ' + manifest.id + ' 的工具 ' + spec.name + ' 需要未授予的权限：' + String(permission));
          }
        }
        return registry.register(spec);
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
): Promise<MountResult> {
  const invalid = validatePluginManifest(manifest);
  if (invalid) return { name: 'plugin:' + String((manifest as { id?: unknown })?.id ?? 'invalid'), ok: false, error: invalid };
  return kernel.install({
    name: 'plugin:' + manifest.id,
    /* cordis 4：插件 fiber 里访问 ctx.tools 必须在 inject 里声明，否则报
     * "cannot get property tools without inject"。 */
    inject: ['tools'],
    apply(ctx: Context) {
      return apply(createPluginApi(ctx, manifest));
    },
  });
}
