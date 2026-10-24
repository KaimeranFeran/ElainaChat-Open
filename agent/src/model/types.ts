/** 模型层统一类型：三套协议（Anthropic / OpenAI chat / OpenAI responses）都归一到这组形状 */
import type { JsonSchema } from '../kernel/tools.ts';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** tool 消息：对应哪次调用 */
  toolCallId?: string;
  /** tool 消息：工具名（Anthropic 需要，OpenAI 不需要） */
  toolName?: string;
  /** assistant 消息里的工具调用（历史回放时用） */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolSpecForModel {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** 一轮模型输出的归一结果 */
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  /** 推理 token 计数（只计数，不返回内容：思考不落盘、不进上下文） */
  reasoningTokens: number;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
}

export interface StreamHooks {
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ModelAdapter {
  /** 协议名（日志与设置页展示用） */
  readonly protocol: string;
  /** 跑一轮：把 messages + tools 发给模型，流式回调文本，返回归一后的 turn */
  run(messages: ChatMessage[], tools: ToolSpecForModel[], hooks: StreamHooks): Promise<ModelTurn>;
}

export interface AdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** 注入 fetch，便于离线测试 */
  fetchImpl?: typeof fetch;
}

/** 统一在 baseUrl 上拼路径：用户可能填 `https://api.deepseek.com` 或 `.../v1`，两种都要能用 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const tail = path.startsWith('/') ? path : '/' + path;
  /* 已经以 /v1 结尾且路径以 /v1 开头：去掉重复，避免 /v1/v1/... */
  if (/\/v1$/.test(base) && tail.startsWith('/v1/')) return base + tail.slice(3);
  return base + tail;
}
