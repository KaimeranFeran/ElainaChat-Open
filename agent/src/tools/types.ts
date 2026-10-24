import type { AgentLimits } from '../config.ts';
import type { ToolResult } from '../errors.ts';

/** 工具风险等级：审批层据此决定「自动放行 / 需审批 / 红色二次确认」 */
export type ToolRisk = 'safe' | 'mutating' | 'destructive';

/** 注入 fetch 的唯一目的：测试离线可跑；生产默认 globalThis.fetch */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 工具声明（可序列化部分）：名字/描述/参数 schema/风险，供 ready 握手与模型层使用 */
export interface ToolSpecBase {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  risk: ToolRisk | 'dynamic';
}

/** 工具定义：声明 + 执行体，供模型层生成 tool_calls 与审批层使用 */
export interface AgentTool extends ToolSpecBase {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** fs 类工具共用的上下文：只认工作区根 + 输出上限 */
export interface FsToolContext {
  workspace: string;
  limits?: Partial<AgentLimits>;
}

/**
 * 模型传来的参数可能是对象，也可能是被文本协议降级成 JSON 字符串的形态。
 * 这里统一成对象；无法解析时返回 null（调用方给 TOOL_FAILED，别抛异常）。
 */
export function normalizeArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      return normalizeArgs(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

/** 参数校验结果：失败是数据（message 直接回给模型），不抛异常 */
export interface ValueError {
  ok: false;
  message: string;
}

export type Checked<T> = { ok: true; value: T } | ValueError;

export function checkString(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number; allowEmpty?: boolean } = {},
): Checked<string | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) return { ok: false, message: '缺少必填参数 ' + key };
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, message: '参数 ' + key + ' 必须是字符串' };
  const value = raw;
  if (!options.allowEmpty && value.trim() === '') {
    if (options.required) return { ok: false, message: '参数 ' + key + ' 不能为空' };
    return { ok: true, value: undefined };
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    return { ok: false, message: '参数 ' + key + ' 过长（上限 ' + options.maxLength + ' 字符）' };
  }
  return { ok: true, value };
}

export function checkNumber(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; integer?: boolean } = {},
): Checked<number | undefined> {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) return { ok: false, message: '缺少必填参数 ' + key };
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false, message: '参数 ' + key + ' 必须是数字' };
  if (options.integer && !Number.isInteger(raw)) return { ok: false, message: '参数 ' + key + ' 必须是整数' };
  if (options.min !== undefined && raw < options.min) return { ok: false, message: '参数 ' + key + ' 不能小于 ' + options.min };
  if (options.max !== undefined && raw > options.max) return { ok: false, message: '参数 ' + key + ' 不能大于 ' + options.max };
  return { ok: true, value: raw };
}

export function checkBoolean(
  args: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): Checked<boolean> {
  const raw = args[key];
  if (raw === undefined || raw === null) return { ok: true, value: defaultValue };
  if (typeof raw !== 'boolean') return { ok: false, message: '参数 ' + key + ' 必须是布尔值' };
  return { ok: true, value: raw };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
