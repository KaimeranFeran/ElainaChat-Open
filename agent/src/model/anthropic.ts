import { SseDecoder, readLines } from './sse.ts';
import { joinUrl, type AdapterOptions, type ChatMessage, type ModelAdapter, type ModelTurn, type StreamHooks, type ToolCall, type ToolSpecForModel } from './types.ts';

/** Anthropic Messages API：/v1/messages。tool 结果必须放在 user 的 tool_result block 里（不能是独立 role）。 */
export function createAnthropicAdapter(opts: AdapterOptions): ModelAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    protocol: 'anthropic',
    async run(messages, tools, hooks) {
      const { system, turns } = toAnthropicMessages(messages);
      const body: Record<string, unknown> = { model: opts.model, max_tokens: opts.maxTokens ?? 4096, messages: turns, stream: true };
      if (system) body.system = system;
      if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      if (opts.temperature !== undefined) body.temperature = opts.temperature;

      const res = await fetchImpl(joinUrl(opts.baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: hooks.signal,
      });
      if (!res.ok) throw httpError(res);

      const turn: ModelTurn = { text: '', toolCalls: [], reasoningTokens: 0 };
      const blocks = new Map<number, { kind: string; id: string; name: string; json: string }>();
      const decoder = new SseDecoder();
      const handle = (ev: { event: string; data: string }) => {
        if (!ev.data || ev.data === '[DONE]') return;
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { return; }
        const type = payload.type || ev.event;
        if (type === 'message_start') {
          const usage = payload.message?.usage;
          if (usage) turn.usage = { promptTokens: usage.input_tokens || 0, completionTokens: 0 };
          return;
        }
        if (type === 'content_block_start') {
          const b = payload.content_block || {};
          blocks.set(payload.index, { kind: b.type, id: b.id || '', name: b.name || '', json: '' });
          if (b.type === 'text' && b.text) { turn.text += b.text; hooks.onTextDelta?.(b.text); }
          return;
        }
        if (type === 'content_block_delta') {
          const d = payload.delta || {};
          const b = blocks.get(payload.index);
          if (d.type === 'text_delta' && d.text) { turn.text += d.text; hooks.onTextDelta?.(d.text); }
          else if (d.type === 'input_json_delta' && b) b.json += d.partial_json || '';
          else if (d.type === 'thinking_delta' && d.thinking) turn.reasoningTokens += Math.ceil(String(d.thinking).length / 4);
          return;
        }
        if (type === 'message_delta') {
          if (payload.delta?.stop_reason) turn.finishReason = payload.delta.stop_reason;
          if (payload.usage?.output_tokens !== undefined) turn.usage = { promptTokens: turn.usage?.promptTokens || 0, completionTokens: payload.usage.output_tokens };
        }
      };
      for await (const chunk of await readLines(res)) for (const ev of decoder.push(chunk)) handle(ev);
      for (const ev of decoder.flush()) handle(ev);

      for (const b of blocks.values()) {
        if (b.kind !== 'tool_use') continue;
        let args: Record<string, unknown> = {};
        try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { __raw: b.json }; }
        turn.toolCalls.push({ id: b.id, name: b.name, args });
      }
      return turn;
    },
  };
}

/** Anthropic 的历史形状：system 单独传；assistant 的 tool_use 与 user 的 tool_result 必须成对出现 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; turns: any[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns: any[] = [];
  let pendingResults: any[] = [];
  const flushResults = () => {
    if (!pendingResults.length) return;
    turns.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pendingResults.push({ type: 'tool_result', tool_use_id: m.toolCallId || '', content: m.content });
      continue;
    }
    flushResults();
    if (m.role === 'user') { turns.push({ role: 'user', content: m.content }); continue; }
    const blocks: any[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const call of m.toolCalls || []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    turns.push({ role: 'assistant', content: blocks.length ? blocks : m.content });
  }
  flushResults();
  return { system, turns };
}

export function httpError(res: Response): Error {
  const err = new Error('模型请求失败：HTTP ' + res.status + '（' + String(res.statusText || '').slice(0, 40) + '）') as Error & { status?: number };
  err.status = res.status;
  return err;
}
