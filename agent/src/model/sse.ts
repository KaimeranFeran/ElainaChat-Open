/** SSE 行解析（三套协议都用 text/event-stream）：只做「拆事件」这一件事，解码交给各适配器 */

export interface SseEvent { event: string; data: string; }

export class SseDecoder {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let idx = this.buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) out.push(ev);
      idx = this.buffer.indexOf('\n\n');
    }
    return out;
  }

  /** 流结束时冲刷残留（部分服务最后一个事件不带空行） */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const ev = parseBlock(rest);
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/** 逐行读 fetch 响应体（Node 18+ web stream） */
export async function readLines(res: Response): Promise<AsyncIterable<string>> {
  const body = res.body;
  if (!body) throw new Error('响应没有 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    },
  };
}
