/**
 * 工具注册表（cordis 服务）。
 *
 * 为什么做成服务而不是模块级 Map：
 * 工具来自「内置工具层」和「第三方插件」两类来源，且插件可能被热移除。把注册表挂到
 * cordis 的 Service 上，注册表就随插件 fiber 一起创建/销毁；插件被卸载时它注册的
 * 工具自动消失，运行循环不会拿到悬空工具。这也是设计文档第 8 节「插件只能
 * ctx.tools.register()」的落点。
 */
import { Service, type Context } from 'cordis';
import { AGENT_ERROR, fail, type ToolResult } from '../errors.ts';

/** 工具参数的 JSON Schema（只用到 object 顶层，够三家协议共用） */
export interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** 工具声明：内置工具由 tools 层构造，插件工具必须在 manifest.tools 里预先声明 */
export interface ToolSpec {
  name: string;
  description: string;
  /** 参数 schema；无参数工具也要给 { type: 'object', properties: {} } */
  parameters: JsonSchema;
  /** 插件工具声明的权限（内置工具可省略）；由审批层消费 */
  permissions?: string[];
}

/** 工具名限制：会被拼进三家协议的 function name，必须是最保守的标识符形态 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 注册前校验。返回 null 表示合法；否则返回结构化 ToolResult。
 * 为什么要提前校验：一个坏 spec 会在某家协议请求里 400，或者让模型拿到没有
 * description 的工具乱猜参数——失败应该发生在注册时，而不是运行到一半。
 */
export function validateToolSpec(spec: ToolSpec): ToolResult | null {
  if (!spec || typeof spec !== 'object') return fail(AGENT_ERROR.TOOL_FAILED, '工具声明必须是对象。');
  if (typeof spec.name !== 'string' || !TOOL_NAME_PATTERN.test(spec.name)) {
    return fail(AGENT_ERROR.TOOL_FAILED, '工具名不合法：' + String(spec.name) + '（只允许小写字母开头的小写字母/数字/下划线，≤64 字符）。');
  }
  if (typeof spec.description !== 'string' || !spec.description.trim()) {
    return fail(AGENT_ERROR.TOOL_FAILED, '工具 ' + spec.name + ' 缺少 description：模型靠它决定是否调用。');
  }
  if (!spec.parameters || typeof spec.parameters !== 'object' || spec.parameters.type !== 'object') {
    return fail(AGENT_ERROR.TOOL_FAILED, '工具 ' + spec.name + ' 的 parameters 必须是 { type: "object" } 的 JSON Schema。');
  }
  if (spec.permissions !== undefined && !Array.isArray(spec.permissions)) {
    return fail(AGENT_ERROR.TOOL_FAILED, '工具 ' + spec.name + ' 的 permissions 必须是字符串数组。');
  }
  return null;
}

/** 单个工具注册后返回的释放函数：幂等，重复调用无副作用 */
export type ToolDisposer = () => void;

export class ToolsService extends Service {
  /* 必须用 TS private（运行时普通属性）而不是 #private：cordis 把服务包在 Proxy 里，
   * JS 私有字段经过 Proxy 访问会直接抛 "Cannot read private member"。 */
  private registry = new Map<string, ToolSpec>();

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  /** 注册工具；同名重复注册直接报错（插件冲突必须显式暴露，不能静默覆盖） */
  register(spec: ToolSpec): ToolDisposer {
    const invalid = validateToolSpec(spec);
    if (invalid) throw new Error(invalid.message);
    if (this.registry.has(spec.name)) throw new Error('工具名已被注册：' + spec.name);
    this.registry.set(spec.name, spec);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.registry.delete(spec.name);
    };
  }

  /** 批量注册，返回一个聚合释放函数（任一失败会回滚已注册的部分） */
  registerAll(specs: ToolSpec[]): ToolDisposer {
    const disposers: ToolDisposer[] = [];
    try {
      for (const spec of specs) disposers.push(this.register(spec));
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  get(name: string): ToolSpec | undefined {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** 返回快照数组：调用方可能在遍历时触发插件卸载，不能把内部 Map 暴露出去 */
  list(): ToolSpec[] {
    return [...this.registry.values()];
  }

  get size(): number {
    return this.registry.size;
  }
}

declare module 'cordis' {
  interface Context {
    tools: ToolsService;
  }
}
