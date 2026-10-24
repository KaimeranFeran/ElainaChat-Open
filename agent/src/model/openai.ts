import { SseDecoder, readLines } from './sse.ts';
import { joinUrl, type AdapterOptions, type ChatMessage, type ModelAdapter, type ModelTurn, type StreamHooks, type ToolCall, type ToolSpecForModel } from './types.ts';
import { httpError } from './anthropic.ts';

/** OpenAI Chat Completions：/v1/chat/completions（DeepSeek、OpenRouter、大多数中转都兼容这一套） */
export function createOpenAiChatAdapter(opts: AdapterOptions): ModelAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    protocol: 'openai',
    async run(messages, tools, hooks) {
      const body: Record<string, unknown> = { model: opts.model, messages: messages.map(toOpenAiMessage), stream: true };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

      const res = await fetchImpl(joinUrl(opts.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.apiKey },
        body: JSON.stringify(body),
        signal: hooks.signal,
      });
      if (!res.ok) throw httpError(res);

      const turn: ModelTurn = { text: '', toolCalls: [], reasoningTokens: 0 };
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const decoder = new SseDecoder();
      const handle = (ev: { event: string; data: string }) => {
        if (!ev.data || ev.data === '[DONE]') return;
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { return; }
        if (payload.usage) turn.usage = { promptTokens: payload.usage.prompt_tokens || 0, completionTokens: payload.usage.completion_tokens || 0 };
        const choice = payload.choices && payload.choices[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) { turn.text += delta.content; hooks.onTextDelta?.(delta.content); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = calls.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
        if (choice.finish_reason) turn.finishReason = choice.finish_reason;
      };
      for await (const chunk of await readLines(res)) for (const ev of decoder.push(chunk)) handle(ev);
      for (const ev of decoder.flush()) handle(ev);

      for (const c of calls.values()) {
        if (!c.name) continue;
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __raw: c.args }; }
        turn.toolCalls.push({ id: c.id || 'call_' + turn.toolCalls.length, name: c.name, args });
      }
      return turn;
    },
  };
}

export function toOpenAiMessage(m: ChatMessage): any {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId || '', content: m.content };
  if (m.role === 'assistant') {
    const out: any = { role: 'assistant', content: m.content || null };
    if (m.toolCalls && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    }
    return out;
  }
  return { role: m.role, content: m.content };
}

/** OpenAI Responses API：/v1/responses（新协议，工具与结果都是 input item） */
export function createOpenAiResponsesAdapter(opts: AdapterOptions): ModelAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    protocol: 'openai-responses',
    async run(messages, tools, hooks) {
      const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const body: Record<string, unknown> = { model: opts.model, input: toResponsesInput(messages), stream: true };
      if (instructions) body.instructions = instructions;
      if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
      if (tools.length) body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      const res = await fetchImpl(joinUrl(opts.baseUrl, '/responses'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.apiKey },
        body: JSON.stringify(body),
        signal: hooks.signal,
      });
      if (!res.ok) throw httpError(res);

      const turn: ModelTurn = { text: '', toolCalls: [], reasoningTokens: 0 };
      const calls = new Map<string, { id: string; name: string; args: string }>();
      const decoder = new SseDecoder();
      const handle = (ev: { event: string; data: string }) => {
        if (!ev.data) return;
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { return; }
        const type = payload.type || ev.event;
        if (type === 'response.output_text.delta' && payload.delta) { turn.text += payload.delta; hooks.onTextDelta?.(payload.delta); return; }
        if (type === 'response.output_item.added') {
          const item = payload.item || {};
          if (item.type === 'function_call') calls.set(item.id || item.call_id, { id: item.call_id || item.id, name: item.name || '', args: '' });
          return;
        }
        if (type === 'response.function_call_arguments.delta') {
          const cur = calls.get(payload.item_id || '');
          if (cur) cur.args += payload.delta || '';
          return;
        }
        if (type === 'response.completed') {
          const usage = payload.response?.usage;
          if (usage) turn.usage = { promptTokens: usage.input_tokens || 0, completionTokens: usage.output_tokens || 0 };
        }
      };
      for await (const chunk of await readLines(res)) for (const ev of decoder.push(chunk)) handle(ev);
      for (const ev of decoder.flush()) handle(ev);

      for (const c of calls.values()) {
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __raw: c.args }; }
        turn.toolCalls.push({ id: c.id, name: c.name, args });
      }
      return turn;
    },
  };
}

function toResponsesInput(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') { out.push({ type: 'function_call_output', call_id: m.toolCallId || '', output: m.content }); continue; }
    if (m.role === 'assistant') {
      for (const call of m.toolCalls || []) out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
      if (m.content) out.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
  }
  return out;
}
