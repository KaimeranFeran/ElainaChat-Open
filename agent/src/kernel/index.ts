/**
 * kernel 对外出口：cordis 原生概念的直接 re-export + 本项目的薄封装。
 *
 * 下游（tools / runtime / stdio）统一从这里 import，而不是各自 import 'cordis'：
 * 换 cordis 版本时只需要改这一层。
 */
export { Context, Service } from 'cordis';
export type { Fiber, Plugin } from 'cordis';

export {
  ToolsService,
  TOOL_NAME_PATTERN,
  validateToolSpec,
  type ToolDisposer,
  type ToolSpec,
  type JsonSchema,
} from './tools.ts';

export {
  createKernel,
  type Kernel,
  type KernelOptions,
  type MountRecord,
  type MountResult,
} from './lifecycle.ts';

export {
  AGENT_API_VERSION,
  PLUGIN_PERMISSIONS,
  validatePluginManifest,
  createPluginApi,
  installPlugin,
  type PluginApi,
  type PluginManifest,
  type PluginPermission,
} from './plugin.ts';
