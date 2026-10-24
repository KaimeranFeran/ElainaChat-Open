import { createAnthropicAdapter } from './anthropic.ts';
import { createOpenAiChatAdapter, createOpenAiResponsesAdapter } from './openai.ts';
import { withTextProtocol } from './text-protocol.ts';
import type { AdapterOptions, ModelAdapter } from './types.ts';

export type { AdapterOptions, ChatMessage, ModelAdapter, ModelTurn, ToolCall, ToolSpecForModel } from './types.ts';
export { createAnthropicAdapter } from './anthropic.ts';
export { createOpenAiChatAdapter, createOpenAiResponsesAdapter } from './openai.ts';
export { parseToolJson, stripToolJson, withTextProtocol } from './text-protocol.ts';

/** 按配置里的协议名创建适配器。textFallback=true 时包一层文本 JSON 协议（模型不支持原生工具时）。 */
export function createModelAdapter(protocol: string, opts: AdapterOptions, textFallback = false): ModelAdapter {
  let base: ModelAdapter;
  if (protocol === 'anthropic') base = createAnthropicAdapter(opts);
  else if (protocol === 'openai') base = createOpenAiChatAdapter(opts);
  else if (protocol === 'openai-responses') base = createOpenAiResponsesAdapter(opts);
  else throw new Error('不支持的模型协议：' + protocol);
  return textFallback ? withTextProtocol(base) : base;
}
