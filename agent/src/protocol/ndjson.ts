/** NDJSON 编解码：C# 外壳与 sidecar 之间的唯一传输格式（stdio，不开端口） */

export interface AgentMessage {
  type: string;
  [key: string]: unknown;
}

export function encodeMessage(message: AgentMessage): string {
  return JSON.stringify(message) + '\n';
}

/** 单行最大 4MB：超出视为协议错误（避免恶意/异常输入把内存打爆） */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class NdjsonDecoder {
  private buffer = '';
  private bytes = 0;

  /** 喂入一段数据，返回本次解析出的完整消息（可能 0~n 条） */
  push(chunk: string): AgentMessage[] {
    this.buffer += chunk;
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    const out: AgentMessage[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.bytes = Buffer.byteLength(this.buffer, 'utf8');
      if (line.trim()) out.push(parseLine(line));
      index = this.buffer.indexOf('\n');
    }
    if (this.bytes > MAX_LINE_BYTES) {
      this.buffer = '';
      this.bytes = 0;
      throw new Error('PROTOCOL_INVALID: 单行超过 ' + MAX_LINE_BYTES + ' 字节');
    }
    return out;
  }
}

function parseLine(line: string): AgentMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('PROTOCOL_INVALID: 不是合法 JSON：' + line.slice(0, 80));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as AgentMessage).type !== 'string') {
    throw new Error('PROTOCOL_INVALID: 消息缺少 type 字段');
  }
  return parsed as AgentMessage;
}
