import type { ChatMessage, ModelAdapter, ModelTurn, StreamHooks, ToolCall, ToolSpecForModel } from './types.ts';

/**
 * 文本协议降级：模型不支持原生 tool_calls 时（部分中转/小模型），用提示词约定输出 JSON 来模拟。
 *
 * 为什么保留：开源版是 BYOK，用户接什么端点都有；没有 tool_calls 的模型如果直接禁用 agent，
 * 用户会觉得"功能坏了"。降级路径至少能跑文件读写这类简单任务，并且 finish 语义完全一致。
 */
export function withTextProtocol(base: ModelAdapter): ModelAdapter {
  return {
    protocol: base.protocol + '+text',
    async run(messages, tools, hooks) {
      const available = tools.map((t) => t.name).join(', ');
      const instruction = [
        '你现在必须用工具完成任务。可用工具：' + available + '。',
        '要调用工具时，只输出一个 JSON 对象（不要包在代码块里）：{"tool":"工具名","args":{...}}',
        '任务完成或无法继续时，调用 finish：{"tool":"finish","args":{"status":"done|blocked|need_user","summary":"..."}}',
        '不要输出任何其他 JSON；一次只调用一个工具。',
      ].join('\n');
      const patched: ChatMessage[] = messages.map((m) => m.role === 'system' ? { ...m, content: m.content + '\n\n' + instruction } : m);
      const turn: ModelTurn = await base.run(patched, [], hooks);
      const parsed = parseToolJson(turn.text);
      if (parsed) {
        const call: ToolCall = { id: 'text_' + Date.now().toString(36), name: parsed.tool, args: parsed.args };
        return { ...turn, text: stripToolJson(turn.text), toolCalls: [call] };
      }
      return turn;
    },
  };
}

export function parseToolJson(text: string): { tool: string; args: Record<string, unknown> } | null {
  const fences = text.match(/```(?:json)?\s*([\s\S]*?)```/g) || [];
  const candidates = [...fences.map((f) => f.replace(/```(?:json)?/g, '').replace(/```/g, '')), text];
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    for (let i = trimmed.indexOf('{'); i >= 0 && i < trimmed.length; i = trimmed.indexOf('{', i + 1)) {
      const obj = tryParseAt(trimmed, i);
      if (obj && typeof obj.tool === 'string' && (obj.args === undefined || (obj.args && typeof obj.args === 'object'))) {
        return { tool: obj.tool, args: (obj.args || {}) as Record<string, unknown> };
      }
    }
  }
  return null;
}

function tryParseAt(text: string, index: number): any | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(index, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function stripToolJson(text: string): string {
  return text
    .replace(/```(?:json)?\s*\{[\s\S]*?"tool"[\s\S]*?\}\s*```/g, '')
    .replace(/^\s*\{\s*"tool"[\s\S]*\}\s*$/gm, '')
    .trim();
}
